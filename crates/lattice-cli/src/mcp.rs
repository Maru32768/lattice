//! `lattice-cli mcp`: the MCP protocol (`lattice_server::mcp`) over stdio, as newline-delimited JSON-RPC 2.0.

use std::io::{self, BufRead, Write};
use std::path::Path;

use serde_json::Value;
use tokio::runtime::Runtime;

use lattice_core::location;
use lattice_server::mcp::{Message, Step, step, tool_reply};
use lattice_server::ops::{self, Ctx, Op, Out};

fn run(ctx: &Ctx, detected_dir: Option<&Path>, rt: &Runtime, op: Op) -> Result<Out, String> {
    // The server outlives a move of the library: answering from the old copy would mislead the agent, and
    // what it saves there no app would ever process.
    if let Some(dir) = detected_dir
        && location::detect().is_ok_and(|now| now.dir != dir)
    {
        return Err("The Lattice data folder has changed. Restart this MCP server.".into());
    }
    rt.block_on(ops::run(ctx, op))
}

/// The reply to one message; `None` for notifications.
pub fn handle(ctx: &Ctx, detected_dir: Option<&Path>, rt: &Runtime, line: &str) -> Option<Value> {
    let message = match Message::parse(line.as_bytes()) {
        Ok(m) => m,
        Err(reply) => return Some(reply),
    };
    match step(&message, ctx.role) {
        Step::Silent => None,
        Step::Reply(reply) => Some(reply),
        Step::Call { id, op } => Some(tool_reply(id, run(ctx, detected_dir, rt, op))),
    }
}

pub fn serve(ctx: &Ctx, detected_dir: Option<&Path>, rt: &Runtime, mut input: impl BufRead, mut out: impl Write) -> io::Result<()> {
    let mut buf = Vec::new();
    // Not `lines()`: one invalid UTF-8 byte (a pasted title) would end the server instead of one request.
    while input.read_until(b'\n', &mut buf)? != 0 {
        let line = String::from_utf8_lossy(&buf);
        if !line.trim().is_empty()
            && let Some(reply) = handle(ctx, detected_dir, rt, &line)
        {
            writeln!(out, "{reply}")?;
            out.flush()?;
        }
        buf.clear();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use lattice_core::chain::{self, LlmChain};
    use lattice_core::embed::LocalE5;
    use lattice_core::jobs::Providers;
    use lattice_core::mcp::Role;
    use lattice_core::store::Store;
    use serde_json::json;

    fn ctx() -> Ctx {
        let store = Store::open_in_memory().unwrap();
        let llm = LlmChain::new(chain::load(&store).unwrap());
        let embedder = LocalE5::offline(std::env::temp_dir().join("lattice-cli-test-models"));
        Ctx { store: Arc::new(store), providers: Arc::new(Providers { llm, embedder, http: lattice_core::fetch::client() }), role: Role::Edit }
    }

    #[test]
    fn invalid_utf8_on_stdin_does_not_end_the_server() {
        let (ctx, rt) = (ctx(), tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap());
        let input =
            b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\",\"params\":{\"title\":\"\xff\xfe\"}}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\"}\n";
        let mut out = Vec::new();
        serve(&ctx, None, &rt, &input[..], &mut out).unwrap();
        let replies: Vec<Value> = String::from_utf8(out).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(replies.iter().map(|r| r["id"].clone()).collect::<Vec<_>>(), [json!(1), json!(2)], "{replies:?}");
    }

    #[test]
    fn a_tool_runs_and_its_failure_is_a_tool_error() {
        let (ctx, rt) = (ctx(), tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap());
        let call = |arguments: Value| {
            let line = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "get", "arguments": arguments } });
            handle(&ctx, None, &rt, &line.to_string()).unwrap()
        };
        assert_eq!(call(json!({ "id": 999 }))["result"]["isError"], true, "a tool that ran and failed");
        assert_eq!(handle(&ctx, None, &rt, "[]").unwrap()["error"]["code"], -32600);
    }
}
