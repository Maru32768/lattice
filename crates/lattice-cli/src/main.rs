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
            let loc = location::detect(&location::default_dir().ok_or("cannot find the app data folder: pass --data-dir")?);
            if let Some(w) = &loc.warning {
                eprintln!("warning: {w}");
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

/// Backend messages are coded JSON (`msg!`); keep them structured in JSON output.
fn error_json(e: &str) -> Value {
    json!({ "error": serde_json::from_str::<Value>(e).ok().filter(Value::is_object).unwrap_or_else(|| json!(e)) })
}

fn fail(format: Format, e: &str) -> ExitCode {
    match format {
        Format::Json => eprintln!("{}", error_json(e)),
        Format::Text => eprintln!("error: {e}"),
    }
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
    fn coded_errors_stay_structured() {
        assert_eq!(error_json(r#"{"code":"chat.badQuestion","params":{}}"#), json!({ "error": { "code": "chat.badQuestion", "params": {} } }));
        assert_eq!(error_json("no article 3"), json!({ "error": "no article 3" }));
        assert_eq!(error_json("42"), json!({ "error": "42" }));
    }
}
