//! Tailscale Serve for the phone's server (G47): whether it forwards this PC's `.ts.net` address to the server's port,
//! and turning that on or off. The `tailscale` command does the work. Lattice does it only when the reader presses the
//! button: Serve's settings belong to Tailscale and outlive the app.

use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use ts_rs::TS;

use crate::msg;

/// The HTTPS port Serve listens on. A `.ts.net` address has one root per port, so the development build takes another
/// one and both apps reach the phone at once.
pub const HTTPS_PORT: u16 = if cfg!(debug_assertions) {
    8443
} else {
    443
};

/// `tailscale serve` waits while the tailnet has not allowed HTTPS: by then it has printed where to allow it.
const TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct TailscaleStatus {
    /// What Serve answers at for this PC, `https://<name>.ts.net/`. None when Tailscale is not installed or not running.
    pub address: Option<String>,
    /// Serve forwards that address to the server's port.
    pub serves_port: bool,
}

/// The installer puts it on PATH; an older install may not have, nor a process started before it was installed.
const EXES: [&str; 2] = ["tailscale", r"C:\Program Files\Tailscale\tailscale.exe"];

/// The output of a finished run, or of one stopped at `TIMEOUT`. Apart: a warning on stderr (a client and daemon of
/// different versions) must not spoil the JSON on stdout.
struct Ran {
    ok: bool,
    timed_out: bool,
    stdout: String,
    stderr: String,
}

async fn run(args: &[&str]) -> Result<Ran, String> {
    let mut last = String::new();
    for exe in EXES {
        let mut cmd = Command::new(exe);
        cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flash from the GUI app
        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(e) => {
                last = e.to_string();
                continue;
            }
        };
        let (Some(mut stdout), Some(mut stderr)) = (child.stdout.take(), child.stderr.take()) else {
            return Err("no output pipes".into());
        };
        // Read while it runs: a run stopped at the timeout has printed what the reader needs.
        let reading = tokio::spawn(async move {
            let (mut out, mut err) = (String::new(), String::new());
            let _ = tokio::join!(stdout.read_to_string(&mut out), stderr.read_to_string(&mut err));
            (out, err)
        });
        let (ok, timed_out) = match tokio::time::timeout(TIMEOUT, child.wait()).await {
            Ok(Ok(exit)) => (exit.success(), false),
            Ok(Err(e)) => return Err(e.to_string()),
            Err(_) => {
                let _ = child.kill().await;
                (false, true)
            }
        };
        let (stdout, stderr) = reading.await.unwrap_or_default();
        return Ok(Ran { ok, timed_out, stdout, stderr });
    }
    Err(last)
}

/// `https://<name>.ts.net[:https]/` from `tailscale status --json`, while Tailscale runs.
fn address_of(status: &Value, https: u16) -> Option<String> {
    if status["BackendState"] != "Running" {
        return None;
    }
    let name = status["Self"]["DNSName"].as_str()?.trim_end_matches('.');
    let port = if https == 443 {
        String::new()
    } else {
        format!(":{https}")
    };
    (!name.is_empty()).then(|| format!("https://{name}{port}/"))
}

/// The root handler of each site Serve has on port `https`, from `tailscale serve status --json`.
fn roots(serve: &Value, https: u16) -> impl Iterator<Item = &Value> {
    let at = format!(":{https}");
    serve["Web"].as_object().into_iter().flatten().filter(move |(host, _)| host.ends_with(&at)).map(|(_, site)| &site["Handlers"]["/"])
}

fn proxies_to(root: &Value, port: u16) -> bool {
    root["Proxy"].as_str().is_some_and(|proxy| {
        let proxy = proxy.trim_end_matches('/');
        ["http://127.0.0.1", "http://localhost", "127.0.0.1", "localhost"].iter().any(|h| proxy == format!("{h}:{port}")) || proxy == port.to_string()
    })
}

/// Whether Serve forwards the root of port `https` to `port` on this PC.
fn serves(serve: &Value, https: u16, port: u16) -> bool {
    roots(serve, https).any(|root| proxies_to(root, port))
}

/// Why forwarding the root of port `https` to `port` would take over what the reader already has there. Serve keeps one
/// root per port, and Funnel opens a whole port to the internet, Lattice included once it is on it.
fn refusal(serve: &Value, https: u16, port: u16) -> Option<String> {
    let at = format!(":{https}");
    if serve["AllowFunnel"].as_object().is_some_and(|f| f.iter().any(|(host, on)| host.ends_with(&at) && on == true)) {
        return Some(msg!("tailscale.funnel", port = https.to_string()));
    }
    if let Some(forward) = serve["TCP"][https.to_string()]["TCPForward"].as_str() {
        return Some(msg!("tailscale.taken", port = https.to_string(), target = forward));
    }
    roots(serve, https).find(|root| !root.is_null() && !proxies_to(root, port)).map(|root| {
        let target = root["Proxy"].as_str().or(root["Path"].as_str()).map_or_else(|| root.to_string(), str::to_string);
        msg!("tailscale.taken", port = https.to_string(), target = target)
    })
}

async fn json(args: &[&str]) -> Option<Value> {
    let ran = run(args).await.ok()?;
    ran.ok.then(|| serde_json::from_str(&ran.stdout).ok()).flatten()
}

pub async fn status(port: u16) -> TailscaleStatus {
    let Some(address) = json(&["status", "--json"]).await.as_ref().and_then(|s| address_of(s, HTTPS_PORT)) else {
        return TailscaleStatus { address: None, serves_port: false };
    };
    let serves_port = json(&["serve", "status", "--json"]).await.is_some_and(|s| serves(&s, HTTPS_PORT, port));
    TailscaleStatus { address: Some(address), serves_port }
}

/// The first `https://` address in what `tailscale` printed: where to allow HTTPS for the tailnet.
fn link_in(output: &str) -> Option<&str> {
    let start = output.find("https://")?;
    output[start..].split_whitespace().next()
}

/// Forwards the root of this PC's `.ts.net` address to `port`, or stops that. Only the root, which `serves` checks: other
/// paths the reader serves on that port are theirs, and a root they set up is left alone.
pub async fn serve(port: u16, on: bool) -> Result<(), String> {
    let ran = run(&["serve", "status", "--json"]).await.map_err(|e| msg!("tailscale.notFound", error = e))?;
    let current: Value = match serde_json::from_str(&ran.stdout) {
        Ok(current) if ran.ok => current,
        _ => return Err(msg!("tailscale.failed", error = format!("{}{}", ran.stdout, ran.stderr).trim())),
    };
    if on && let Some(refused) = refusal(&current, HTTPS_PORT, port) {
        return Err(refused);
    }
    if !on && !serves(&current, HTTPS_PORT, port) {
        return Ok(());
    }
    let (port, https) = (port.to_string(), format!("--https={HTTPS_PORT}"));
    let args: &[&str] = if on {
        &["serve", "--bg", &https, &port]
    } else {
        &["serve", &https, "--set-path=/", "off"]
    };
    let ran = run(args).await.map_err(|e| msg!("tailscale.notFound", error = e))?;
    if ran.ok {
        return Ok(());
    }
    Err(match (link_in(&format!("{}{}", ran.stdout, ran.stderr)), ran.timed_out) {
        (Some(link), _) => msg!("tailscale.allowHttps", link = link),
        (None, true) => msg!("tailscale.timedOut"),
        (None, false) => msg!("tailscale.failed", error = format!("{}{}", ran.stdout, ran.stderr).trim()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_fallback_is_the_installers_path() {
        assert!(EXES[1].ends_with(r"\Tailscale\tailscale.exe") && !EXES[1].contains('\t'), "{:?}", EXES[1]);
    }

    #[test]
    fn the_address_is_this_pcs_name_while_tailscale_runs() {
        let status = json!({ "BackendState": "Running", "Self": { "DNSName": "desktop.tail1234.ts.net." } });
        assert_eq!(address_of(&status, 443).as_deref(), Some("https://desktop.tail1234.ts.net/"));
        assert_eq!(address_of(&status, 8443).as_deref(), Some("https://desktop.tail1234.ts.net:8443/"));
        assert_eq!(address_of(&json!({ "BackendState": "Stopped", "Self": { "DNSName": "desktop.tail1234.ts.net." } }), 443), None);
        assert_eq!(address_of(&json!({ "BackendState": "Running", "Self": { "DNSName": "" } }), 443), None);
    }

    #[test]
    fn serve_counts_only_when_its_root_on_the_https_port_goes_to_this_port() {
        let at = |proxy: &str| json!({ "Web": { "desktop.tail1234.ts.net:443": { "Handlers": { "/": { "Proxy": proxy } } } } });
        assert!(serves(&at("http://127.0.0.1:8787"), 443, 8787));
        assert!(serves(&at("http://localhost:8787/"), 443, 8787));
        assert!(!serves(&at("http://127.0.0.1:8788"), 443, 8787));
        assert!(!serves(&at("http://127.0.0.1:18787"), 443, 8787));
        assert!(!serves(&at("http://127.0.0.1:8787"), 8443, 8787));
        let on_8443 = json!({ "Web": { "desktop.tail1234.ts.net:8443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:8787" } } } } });
        assert!(!serves(&on_8443, 443, 8787));
        assert!(serves(&on_8443, 8443, 8787));
        assert!(!serves(&json!({}), 443, 8787));
    }

    #[test]
    fn serve_refuses_to_take_over_what_the_reader_has_on_the_port() {
        let host = "desktop.tail1234.ts.net:443";
        let root = |handler: Value| json!({ "Web": { host: { "Handlers": { "/": handler } } } });
        assert_eq!(refusal(&json!({}), 443, 8787), None);
        assert_eq!(refusal(&root(json!({ "Proxy": "http://127.0.0.1:8787" })), 443, 8787), None, "already Lattice's");
        let mine = json!({ "Web": { host: { "Handlers": { "/blog": { "Path": r"C:\blog" } } } } });
        assert_eq!(refusal(&mine, 443, 8787), None, "another path stays beside it");
        let theirs = refusal(&root(json!({ "Proxy": "http://127.0.0.1:3000" })), 443, 8787).unwrap();
        assert!(theirs.contains("tailscale.taken") && theirs.contains("http://127.0.0.1:3000"), "{theirs}");
        assert!(refusal(&root(json!({ "Text": "hi" })), 443, 8787).unwrap().contains("tailscale.taken"));
        assert!(refusal(&json!({ "TCP": { "443": { "TCPForward": "127.0.0.1:22" } } }), 443, 8787).unwrap().contains("127.0.0.1:22"));
        let funnel = json!({ "Web": mine["Web"].clone(), "AllowFunnel": { host: true } });
        assert!(refusal(&funnel, 443, 8787).unwrap().contains("tailscale.funnel"));
        assert_eq!(refusal(&root(json!({ "Proxy": "http://127.0.0.1:3000" })), 8443, 8787), None, "another port's");
    }

    #[test]
    fn the_link_to_allow_https_is_taken_from_what_tailscale_printed() {
        let out = "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=abc\n";
        assert_eq!(link_in(out), Some("https://login.tailscale.com/f/serve?node=abc"));
        assert_eq!(link_in("error: nope"), None);
    }
}
