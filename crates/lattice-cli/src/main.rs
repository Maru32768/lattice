//! `lattice-cli`: the Lattice library from a terminal or an agent, over the database the app
//! uses (WAL, so the app may be running). Reads by default; changes need `--allow-write`.
//! Not named `lattice` because the app's own binary is `lattice.exe` (and Windows file names
//! ignore case, so `Lattice.exe` in the portable zip would clash too).

mod mcp;
mod ops;

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand, ValueEnum};
use lattice_core::chain::{self, LlmChain};
use lattice_core::embed::LocalE5;
use lattice_core::fetch::HttpClient;
use lattice_core::jobs::Providers;
use lattice_core::location::{self, DB_FILE};
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
}

fn open(cli: &Cli) -> Result<Ctx, String> {
    let dir = match &cli.data_dir {
        Some(d) => d.clone(),
        None => {
            let loc = location::detect().map_err(|e| e.to_string())?;
            if let Some(w) = &loc.warning {
                eprintln!("{}", render(cli.format, "warning", w));
            }
            loc.dir
        }
    };
    let db = dir.join(DB_FILE);
    if !db.is_file() {
        return Err(format!("no Lattice database at {}: start the app once, or pass --data-dir", db.display()));
    }
    let store = Store::open(&db).map_err(|e| format!("opening {}: {e}", db.display()))?;
    let llm = LlmChain::new(chain::load(&store)?);
    let http = HttpClient::configured(&network::settings(&store)?)?;
    let providers = Providers { llm, embedder: LocalE5::offline(dir.join("models")), http };
    let allow_write = cli.allow_write || std::env::var("LATTICE_ALLOW_WRITE").is_ok_and(|v| v == "1");
    Ok(Ctx { store, providers, allow_write })
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

fn main() -> ExitCode {
    let cli = Cli::parse();
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
