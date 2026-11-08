//! `lattice-cli`: the Lattice library from a terminal or an agent, over the database the app
//! uses (WAL, so the app may be running). Reads by default; changes need `--allow-write`.
//! `serve` also creates the phone's token if the library has none: nothing else can read with it.
//! Not named `lattice` because the app's own binary is `lattice.exe` (and Windows file names
//! ignore case, so `Lattice.exe` in the portable zip would clash too).

mod mcp;
mod ops;

use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand, ValueEnum};
use lattice_core::chain::{self, LlmChain};
use lattice_core::embed::LocalE5;
use lattice_core::fetch::HttpClient;
use lattice_core::jobs::Providers;
use lattice_core::location::{self, DB_FILE};
use lattice_core::mobile;
use lattice_core::msg;
use lattice_core::network;
use lattice_core::store::Store;
use serde_json::{Value, json};

use ops::{Ctx, Op};

#[derive(Parser)]
#[command(name = "lattice-cli", version, about = "Search, read and save to your Lattice library; `mcp` serves it to agents")]
struct Cli {
    /// The data folder (default: the one the app uses, portable mode included)
    #[arg(long, global = true)]
    data_dir: Option<PathBuf>,
    #[arg(long, global = true, value_enum, default_value_t = Format::Json)]
    format: Format,
    /// Allow saving, tagging and marking articles (or set LATTICE_ALLOW_WRITE=1)
    #[arg(long, global = true)]
    allow_write: bool,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Clone, Copy, PartialEq, ValueEnum)]
enum Format {
    Json,
    Text,
}

#[derive(Subcommand)]
enum Cmd {
    #[command(flatten)]
    Op(Op),
    /// Serve the library to agents as an MCP server over stdio
    Mcp,
    /// Serve the library to a phone's browser, as the app's 設定 › スマホで読む does
    Serve {
        /// Listen on every network interface, not just this PC's own
        #[arg(long)]
        lan: bool,
        #[arg(long, default_value_t = lattice_core::mobile::DEFAULT_PORT)]
        port: u16,
    },
}

fn open(cli: &Cli) -> Result<Ctx, String> {
    let detected_dir = match &cli.data_dir {
        Some(_) => None,
        None => {
            let loc = location::detect().map_err(|e| e.to_string())?;
            if let Some(w) = &loc.warning {
                eprintln!("{}", render(cli.format, "warning", w));
            }
            Some(loc.dir)
        }
    };
    let dir = cli.data_dir.clone().or_else(|| detected_dir.clone()).ok_or("no data folder")?;
    let db = dir.join(DB_FILE);
    if !db.is_file() {
        return Err(format!("no Lattice database at {}: start the app once, or pass --data-dir", db.display()));
    }
    let store = Store::open(&db).map_err(|e| format!("opening {}: {e}", db.display()))?;
    let llm = LlmChain::new(chain::load(&store)?);
    let http = HttpClient::configured(&network::settings(&store)?)?;
    let providers = Providers { llm, embedder: LocalE5::offline(dir.join("models")), http };
    let allow_write = cli.allow_write || std::env::var("LATTICE_ALLOW_WRITE").is_ok_and(|v| v == "1");
    Ok(Ctx { store, providers, allow_write, detected_dir })
}

/// A `warning` or `error` line. Backend messages are coded JSON (`msg!`, `{"code","params"}`):
/// kept structured in JSON output, `code (k=v, ...)` in text.
fn render(format: Format, kind: &str, msg: &str) -> String {
    let coded = serde_json::from_str::<Value>(msg).ok().filter(Value::is_object);
    match (format, coded) {
        (Format::Json, coded) => json!({ kind: coded.unwrap_or_else(|| json!(msg)) }).to_string(),
        (Format::Text, None) => format!("{kind}: {msg}"),
        (Format::Text, Some(m)) => {
            let params: Vec<String> = m["params"]
                .as_object()
                .into_iter()
                .flatten()
                .map(|(k, v)| match v {
                    Value::String(s) => format!("{k}={s}"),
                    v => format!("{k}={v}"),
                })
                .collect();
            let code = m["code"].as_str().unwrap_or_default();
            if params.is_empty() {
                format!("{kind}: {code}")
            } else {
                format!("{kind}: {code} ({})", params.join(", "))
            }
        }
    }
}

fn fail(format: Format, e: &str) -> ExitCode {
    eprintln!("{}", render(format, "error", e));
    ExitCode::FAILURE
}

/// Runs until the process is stopped or the library moves. Jobs that the served requests queue wait for
/// the app's runners (design-review §23). Only the real library is served, as in the app: a stand-in would
/// show a phone old articles and turn away its token.
async fn serve(store: Store, detected_dir: Option<PathBuf>, allow_write: bool, lan: bool, port: u16) -> Result<(), String> {
    if detected_dir.is_some() && location::detect().is_ok_and(|now| now.warning.is_some()) {
        return Err(msg!("mobile.fellBack"));
    }
    // The server's errors go to its log, and nothing else shows them here.
    let _ = log::set_logger(&StderrLogger).map(|()| log::set_max_level(log::LevelFilter::Warn));
    let store = std::sync::Arc::new(store);
    let url_store = store.clone();
    let ip = if lan {
        Ipv4Addr::UNSPECIFIED
    } else {
        Ipv4Addr::LOCALHOST
    };
    // What the phone sends is only stored and queued here, so there is nothing further to tell anyone.
    let on_applied: Option<lattice_server::OnApplied> = allow_write.then(|| std::sync::Arc::new(|_: &mobile::Effects| {}) as lattice_server::OnApplied);
    let server = lattice_server::start((ip, port).into(), lattice_server::router(store, on_applied)).await.map_err(|e| e.to_string())?;
    let reachable = if lan {
        mobile::lan_ip()
    } else {
        Some(server.addr.ip())
    };
    let shown = reachable.and_then(|ip| mobile::base_of(ip, server.addr.port())).unwrap_or_else(|| "http://<this PC's address>".to_string());
    println!("{}", mobile::phone_url(&url_store, &shown)?);
    // The server outlives a move of the library, as the MCP server does (mcp.rs): the old copy would keep answering.
    loop {
        tokio::time::sleep(MOVE_CHECK).await;
        if let Some(dir) = &detected_dir
            && location::detect().is_ok_and(|now| now.dir != *dir)
        {
            server.stop().await;
            return Err("The Lattice data folder has changed. Restart lattice-cli serve.".into());
        }
    }
}

const MOVE_CHECK: std::time::Duration = std::time::Duration::from_secs(30);

struct StderrLogger;

impl log::Log for StderrLogger {
    fn enabled(&self, _: &log::Metadata) -> bool {
        true
    }
    fn log(&self, record: &log::Record) {
        eprintln!("{}: {}", record.level(), record.args());
    }
    fn flush(&self) {}
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    // Off unless asked for: stderr carries the `warning`/`error` lines a caller may parse, and stdout the MCP protocol.
    if std::env::var_os("RUST_LOG").is_some() {
        let _ = tracing_subscriber::fmt().with_writer(std::io::stderr).with_env_filter(tracing_subscriber::EnvFilter::from_default_env()).try_init();
    }
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("a tokio runtime");
    let ctx = match open(&cli) {
        Ok(ctx) => ctx,
        Err(e) => return fail(cli.format, &e),
    };
    match cli.cmd {
        Cmd::Mcp => match mcp::serve(&ctx, &rt, std::io::stdin().lock(), std::io::stdout().lock()) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => fail(cli.format, &e.to_string()),
        },
        Cmd::Serve { lan, port } => match rt.block_on(serve(ctx.store, ctx.detected_dir, ctx.allow_write, lan, port)) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => fail(cli.format, &e),
        },
        Cmd::Op(op) => match rt.block_on(ops::run(&ctx, op)) {
            Ok(out) => {
                match cli.format {
                    Format::Json => println!("{}", serde_json::to_string_pretty(&out.json).expect("JSON values serialize")),
                    Format::Text => println!("{}", out.text),
                }
                ExitCode::SUCCESS
            }
            Err(e) => fail(cli.format, &e),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coded_messages_stay_structured_in_json_and_read_as_code_and_params_in_text() {
        let coded = r#"{"code":"net.proxy","params":{"host":"p.example","port":8080}}"#;
        let parse = |s: String| serde_json::from_str::<Value>(&s).unwrap();
        assert_eq!(parse(render(Format::Json, "error", coded)), json!({ "error": { "code": "net.proxy", "params": { "host": "p.example", "port": 8080 } } }));
        assert_eq!(parse(render(Format::Json, "warning", "no article 3")), json!({ "warning": "no article 3" }));
        assert_eq!(parse(render(Format::Json, "error", "42")), json!({ "error": "42" }));
        assert_eq!(render(Format::Text, "warning", coded), "warning: net.proxy (host=p.example, port=8080)");
        assert_eq!(render(Format::Text, "error", r#"{"code":"chat.badQuestion","params":{}}"#), "error: chat.badQuestion");
        assert_eq!(render(Format::Text, "error", "no article 3"), "error: no article 3");
    }
}
