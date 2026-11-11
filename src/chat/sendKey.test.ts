import { test } from "node:test";
import assert from "node:assert/strict";
import { plainEnterSends, sendsOn, type SendKey } from "./sendKey.ts";

const press = (mods: Partial<Record<"ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "isComposing", boolean>> = {}, key = "Enter") => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  isComposing: false,
  ...mods,
});

const ONE = "one line";
const TWO = "first\nsecond";
const presses = {
  enter: press(),
  shiftEnter: press({ shiftKey: true }),
  altEnter: press({ altKey: true }),
  ctrlEnter: press({ ctrlKey: true }),
  metaEnter: press({ metaKey: true }),
  composing: press({ isComposing: true }),
  imeProcess: press({ isComposing: true }, "Process"),
  letter: press({ ctrlKey: true }, "a"),
};

/** Which presses send `text` in `mode`, by name. */
const sending = (mode: SendKey, text: string) => Object.entries(presses).flatMap(([name, e]) => (sendsOn(mode, text, e) ? [name] : []));

test("sendsOn: Ctrl+Enter sends in every mode; plain Enter as the mode says; Shift / Alt+Enter, the IME and other keys never", () => {
  assert.deepEqual(sending("ctrlEnter", ONE), ["ctrlEnter", "metaEnter"]);
  assert.deepEqual(sending("ctrlEnter", TWO), ["ctrlEnter", "metaEnter"]);
  assert.deepEqual(sending("enter", ONE), ["enter", "ctrlEnter", "metaEnter"]);
  assert.deepEqual(sending("enter", TWO), ["enter", "ctrlEnter", "metaEnter"]);
  assert.deepEqual(sending("enterOneLine", ONE), ["enter", "ctrlEnter", "metaEnter"]);
  assert.deepEqual(sending("enterOneLine", TWO), ["ctrlEnter", "metaEnter"], "two lines: Enter is a newline");
});

test("sendsOn: Ctrl+Enter that confirms a conversion does not send either", () => {
  assert.equal(sendsOn("ctrlEnter", ONE, press({ ctrlKey: true, isComposing: true })), false);
});

test("plainEnterSends: what the hint under the box shows", () => {
  assert.equal(plainEnterSends("ctrlEnter", ONE), false);
  assert.equal(plainEnterSends("enter", TWO), true);
  assert.equal(plainEnterSends("enterOneLine", ONE), true);
  assert.equal(plainEnterSends("enterOneLine", ""), true, "an empty box is one line");
  assert.equal(plainEnterSends("enterOneLine", TWO), false);
});
