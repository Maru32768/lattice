//! `lattice-cli mcp`: a Model Context Protocol server over stdio (newline-delimited JSON-RPC 2.0).
//! Only the three methods a tools-only server needs (`initialize`, `tools/list`, `tools/call`,
//! plus `ping`); an SDK would bring more dependencies than this whole file. Article content is
//! untrusted text from the web: every result says so, and none of it is ever executed.

use std::io::{self, BufRead, Write};
use std::path::Path;

use serde_json::{Value, json};
use tokio::runtime::Runtime;

use lattice_core::location;
use lattice_server::mcp::{UNTRUSTED, result_text, tools};
use lattice_server::ops::{self, Ctx, Op};

/// The newest first; a client asking for another gets the newest (tools work the same in all).
const PROTOCOL_VERSIONS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
/// A tool result; `Err` is an unknown tool or bad arguments (a protocol error, not a tool failure).
fn call(ctx: &Ctx, detected_dir: Option<&Path>, rt: &Runtime, params: &Value) -> Result<Value, String> {
    let arguments = if params["arguments"].is_object() {
        params["arguments"].clone()
    } else {
        json!({})
    };
    let op = serde_json::from_value::<Op>(json!({ "name": params["name"], "arguments": arguments })).map_err(|e| e.to_string())?;
    // The server outlives a move of the library: answering from the old copy would mislead the agent, and
    // what it saves there no app would ever process.
    if let Some(dir) = detected_dir
        && location::detect().is_ok_and(|now| now.dir != dir)
    {
        return Ok(json!({ "content": [{ "type": "text", "text": "The Lattice data folder has changed. Restart this MCP server." }], "isError": true }));
    }
    // Errors can quote untrusted content too (a page's text in a provider error, a feed title).
    let (text, is_error) = match rt.block_on(ops::run(ctx, op)) {
        Ok(out) => (out.json.to_string(), false),
        Err(e) => (e, true),
    };
    Ok(json!({ "content": [{ "type": "text", "text": result_text(&text) }], "isError": is_error }))
}

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// The reply to one message; `None` for notifications.
pub fn handle(ctx: &Ctx, detected_dir: Option<&Path>, rt: &Runtime, line: &str) -> Option<Value> {
    let req: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return Some(error(Value::Null, -32700, &e.to_string())),
    };
    if !req.is_object() {
        return Some(error(Value::Null, -32600, "invalid request"));
    }
    let id = req.get("id")?.clone();
    let params = &req["params"];
    let result = match req["method"].as_str().unwrap_or_default() {
        "initialize" => {
            let asked = params["protocolVersion"].as_str().filter(|v| PROTOCOL_VERSIONS.contains(v));
            json!({
                "protocolVersion": asked.unwrap_or(PROTOCOL_VERSIONS[0]),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "lattice", "version": env!("CARGO_PKG_VERSION") },
                "instructions": UNTRUSTED,
            })
        }
        "ping" => json!({}),
        "tools/list" => json!({ "tools": tools(ctx.role) }),
        "tools/call" => match call(ctx, detected_dir, rt, params) {
            Ok(result) => result,
            Err(e) => return Some(error(id, -32602, &e)),
        },
        m => return Some(error(id, -32601, &format!("method not found: {m}"))),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
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
    use lattice_core::chain::{self, LlmChain};
    use lattice_core::embed::LocalE5;
    use lattice_core::jobs::Providers;
    use lattice_core::mcp::Role;
    use lattice_core::store::Store;

    fn ctx() -> Ctx {
        let store = Store::open_in_memory().unwrap();
        let llm = LlmChain::new(chain::load(&store).unwrap());
        let embedder = LocalE5::offline(std::env::temp_dir().join("lattice-cli-test-models"));
        Ctx { store, providers: Providers { llm, embedder, http: lattice_core::fetch::client() }, role: Role::Edit }
    }

    #[test]
    fn a_batch_or_a_bare_value_is_an_invalid_request_not_a_notification() {
        let (ctx, rt) = (ctx(), tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap());
        for line in [r#"[{"jsonrpc":"2.0","id":1,"method":"ping"}]"#, r#""ping""#, "7"] {
            let reply = handle(&ctx, None, &rt, line).unwrap_or_else(|| panic!("{line} got no reply"));
            assert_eq!((reply["error"]["code"].clone(), reply["id"].clone()), (json!(-32600), Value::Null), "{line}");
        }
        assert_eq!(handle(&ctx, None, &rt, r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#), None);
    }

    #[test]
    fn an_unknown_tool_or_bad_arguments_are_invalid_params_not_a_tool_error() {
        let (ctx, rt) = (ctx(), tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap());
        let call = |name: &str, arguments: Value| {
            handle(
                &ctx,
                None,
                &rt,
                &json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": name, "arguments": arguments } }).to_string(),
            )
            .unwrap()
        };
        assert_eq!(call("nope", json!({}))["error"]["code"], -32602);
        assert_eq!(call("get", json!({}))["error"]["code"], -32602, "a missing argument");
        assert_eq!(call("get", json!({ "id": 999 }))["result"]["isError"], true, "a tool that ran and failed");
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
}
