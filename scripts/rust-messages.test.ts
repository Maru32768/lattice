import { test } from "node:test";
import assert from "node:assert/strict";
import { rustMessageUsage } from "./rust-messages.ts";

test("Rust message uses exclude comments, literal lookalikes and cfg(test) items", () => {
  const usage = rustMessageUsage(String.raw`
    // msg!("comment.code");
    /* outer /* msg!("nested.comment"); */ still a comment */
    const DECOY: &str = r###"msg!("literal.code", extra = 1)"###;
    #[cfg(test)]
    mod tests { fn fake() { msg!("test.only"); } }
    fn live() { msg!("live.code", count = f(1, 2), path = "}"); }
    fn nested() { msg!("outer.code", error = msg!("inner.code", max = 10)); }
  `);
  assert.deepEqual(usage.calls, [
    { code: "live.code", params: ["count", "path"] },
    { code: "outer.code", params: ["error"] },
    { code: "inner.code", params: ["max"] },
  ]);
  assert.equal(usage.strings.has("test.only"), false);
  assert.equal(usage.strings.has("comment.code"), false);
});

test("Rust message scan keeps production cfg branches and excludes gated helper methods", () => {
  const usage = rustMessageUsage(String.raw`
    impl Store {
      #[cfg(test)]
      pub fn helper(&self) -> Option<&'static str> { Some(msg!("helper.only")) }
    }
    #[cfg(windows)] fn live() { msg!(r#"windows.code"#, error = format!("{}, {}", a, b)); }
    let field = "instructions.summary";
    crate::msg::coded(field, Default::default());
  `);
  assert.deepEqual(usage.calls, [{ code: "windows.code", params: ["error"] }]);
  assert.equal(usage.dynamicField, true);
  assert.equal(usage.strings.has("helper.only"), false);
});
