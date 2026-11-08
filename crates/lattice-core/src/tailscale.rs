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

/// The output of a finished run, or of one stopped at `TIMEOUT`.
struct Ran {
    ok: bool,
    timed_out: bool,
    output: String,
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
            out + &err
        });
        let (ok, timed_out) = match tokio::time::timeout(TIMEOUT, child.wait()).await {
            Ok(Ok(exit)) => (exit.success(), false),
            Ok(Err(e)) => return Err(e.to_string()),
            Err(_) => {
                let _ = child.kill().await;
                (false, true)
            }
        };
        return Ok(Ran { ok, timed_out, output: reading.await.unwrap_or_default() });
    }
    Err(last)
}

/// `https://<name>.ts.net/` from `tailscale status --json`, while Tailscale runs.
fn address_of(status: &Value) -> Option<String> {
    if status["BackendState"] != "Running" {
        return None;
    }
    let name = status["Self"]["DNSName"].as_str()?.trim_end_matches('.');
    (!name.is_empty()).then(|| format!("https://{name}/"))
}

/// Whether `tailscale serve status --json` forwards the root of port 443 to `port` on this PC.
fn serves(serve: &Value, port: u16) -> bool {
    let Some(sites) = serve["Web"].as_object() else {
        return false;
    };
    sites.iter().any(|(host, site)| {
        host.ends_with(":443")
            && site["Handlers"]["/"]["Proxy"].as_str().is_some_and(|proxy| {
                let proxy = proxy.trim_end_matches('/');
                ["http://127.0.0.1", "http://localhost", "127.0.0.1", "localhost"].iter().any(|h| proxy == format!("{h}:{port}")) || proxy == port.to_string()
            })
    })
}

async fn json(args: &[&str]) -> Option<Value> {
    let ran = run(args).await.ok()?;
    ran.ok.then(|| serde_json::from_str(&ran.output).ok()).flatten()
}

pub async fn status(port: u16) -> TailscaleStatus {
    let Some(address) = json(&["status", "--json"]).await.as_ref().and_then(address_of) else {
        return TailscaleStatus { address: None, serves_port: false };
    };
    let serves_port = json(&["serve", "status", "--json"]).await.is_some_and(|s| serves(&s, port));
    TailscaleStatus { address: Some(address), serves_port }
}

/// The first `https://` address in what `tailscale` printed: where to allow HTTPS for the tailnet.
fn link_in(output: &str) -> Option<&str> {
    let start = output.find("https://")?;
    output[start..].split_whitespace().next()
}

/// Forwards this PC's `.ts.net` address to `port`, or stops forwarding port 443.
pub async fn serve(port: u16, on: bool) -> Result<(), String> {
    let port = port.to_string();
    let args: &[&str] = if on {
        &["serve", "--bg", &port]
    } else {
        &["serve", "--https=443", "off"]
    };
    let ran = run(args).await.map_err(|e| msg!("tailscale.notFound", error = e))?;
    if ran.ok {
        return Ok(());
    }
    Err(match (link_in(&ran.output), ran.timed_out) {
        (Some(link), _) => msg!("tailscale.allowHttps", link = link),
        (None, true) => msg!("tailscale.timedOut"),
        (None, false) => msg!("tailscale.failed", error = ran.output.trim()),
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
        assert_eq!(address_of(&status).as_deref(), Some("https://desktop.tail1234.ts.net/"));
        assert_eq!(address_of(&json!({ "BackendState": "Stopped", "Self": { "DNSName": "desktop.tail1234.ts.net." } })), None);
        assert_eq!(address_of(&json!({ "BackendState": "Running", "Self": { "DNSName": "" } })), None);
    }

    #[test]
    fn serve_counts_only_when_its_root_on_443_goes_to_this_port() {
        let at = |proxy: &str| json!({ "Web": { "desktop.tail1234.ts.net:443": { "Handlers": { "/": { "Proxy": proxy } } } } });
        assert!(serves(&at("http://127.0.0.1:8787"), 8787));
        assert!(serves(&at("http://localhost:8787/"), 8787));
        assert!(!serves(&at("http://127.0.0.1:8788"), 8787));
        assert!(!serves(&at("http://127.0.0.1:18787"), 8787));
        assert!(!serves(&json!({ "Web": { "desktop.tail1234.ts.net:8443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:8787" } } } } }), 8787));
        assert!(!serves(&json!({}), 8787));
    }

    #[test]
    fn the_link_to_allow_https_is_taken_from_what_tailscale_printed() {
        let out = "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=abc\n";
        assert_eq!(link_in(out), Some("https://login.tailscale.com/f/serve?node=abc"));
        assert_eq!(link_in("error: nope"), None);
    }
}
