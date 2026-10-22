import { test } from "node:test";
import assert from "node:assert/strict";
import { initialVim, vimKey, type Vim } from "./vim.ts";

/** Types `keys` (`<Esc>` for Escape) into `start`, where `|` marks the cursor; returns the same notation. */
function type(start: string, keys: string, mode: Vim["mode"] = "normal") {
  let vim: Vim = { ...initialVim(), mode };
  let buf = { text: start.replace("|", ""), cursor: start.indexOf("|") };
  for (const key of keys.match(/<Esc>|./gsu) ?? []) {
    const r = vimKey(vim, buf, key === "<Esc>" ? "Escape" : key);
    // An unhandled key in insert mode is typed by the textarea.
    if (!r.handled && vim.mode === "insert") buf = { text: buf.text.slice(0, buf.cursor) + key + buf.text.slice(buf.cursor), cursor: buf.cursor + 1 };
    else ({ vim, buf } = r);
  }
  return `${buf.text.slice(0, buf.cursor)}|${buf.text.slice(buf.cursor)}${vim.mode === "insert" ? " -- INSERT" : ""}`;
}

test("motions: h l stay on the line, j k keep the column, w b e by word class", () => {
  assert.equal(type("ab|c\nxy", "l"), "ab|c\nxy", "l stops on the last character");
  assert.equal(type("a|bc\nxy", "hh"), "|abc\nxy");
  assert.equal(type("ab|c\nxy", "j"), "abc\nx|y", "j clamps the column to the shorter line");
  assert.equal(type("abc\nx|y", "k"), "a|bc\nxy");
  assert.equal(type("|foo.bar baz", "w"), "foo|.bar baz");
  assert.equal(type("|foo.bar baz", "ww"), "foo.|bar baz");
  assert.equal(type("|foo.bar baz", "www"), "foo.bar |baz");
  assert.equal(type("foo bar ba|z", "w"), "foo bar ba|z", "no next word: stays on the last character");
  assert.equal(type("foo bar|", "b"), "foo |bar");
  assert.equal(type("foo b|ar", "bb"), "|foo bar");
  assert.equal(type("|foo bar", "e"), "fo|o bar");
  assert.equal(type("|foo bar", "ee"), "foo ba|r");
  assert.equal(type("|日本語の、説明", "w"), "日本語の|、説明", "Japanese letters form one word up to punctuation");
});

test("motions: 0 $ gg G", () => {
  assert.equal(type("ab\nc|de", "0"), "ab\n|cde");
  assert.equal(type("ab\n|cde", "$"), "ab\ncd|e");
  assert.equal(type("ab\ncd|e", "gg"), "|ab\ncde");
  assert.equal(type("a|b\ncd\nef", "G"), "ab\ncd\n|ef");
});

test("entering insert: i a I A o O; Esc steps back one like Vim", () => {
  assert.equal(type("a|bc", "iX<Esc>"), "a|Xbc");
  assert.equal(type("a|bc", "aX<Esc>"), "ab|Xc");
  assert.equal(type("  ab|c", "IX<Esc>"), "  |Xabc");
  assert.equal(type("a|bc\nd", "AX<Esc>"), "abc|X\nd");
  assert.equal(type("a|bc\nd", "oX<Esc>"), "abc\n|X\nd");
  assert.equal(type("abc\n|d", "OX<Esc>"), "abc\n|X\nd");
  assert.equal(type("a|bc", "i"), "a|bc -- INSERT");
});

test("edits: x dd dw cw yy p", () => {
  assert.equal(type("a|bc", "x"), "a|c");
  assert.equal(type("ab|c", "x"), "a|b", "x on the last character moves back");
  assert.equal(type("one\nt|wo\nthree", "dd"), "one\n|three");
  assert.equal(type("one\nthr|ee", "dd"), "|one", "dd on the last line removes the newline before it");
  assert.equal(type("|foo bar", "dw"), "|bar");
  assert.equal(type("foo |bar\nnext", "dw"), "foo| \nnext", "dw stops at the end of the line");
  assert.equal(type("f|oo bar", "cwX<Esc>"), "f|X bar", "cw keeps the blank after the word");
  assert.equal(type("o|ne\ntwo", "yyjp"), "one\ntwo\n|one");
  assert.equal(type("o|ne\ntwo", "ddp"), "two\n|one");
  assert.equal(type("|ab", "xp"), "b|a");
  assert.equal(type("a|b", "dx"), "a|b", "an unknown two-key command does nothing");
});

test("u undoes one change at a time; an insert that typed nothing is not a change", () => {
  assert.equal(type("a|bc", "xxu"), "a|c");
  assert.equal(type("a|bc", "xxuu"), "a|bc");
  assert.equal(type("a|bc", "iXY<Esc>u"), "a|bc");
  assert.equal(type("a|bc", "xi<Esc>u"), "a|bc", "the empty insert left no undo step");
  assert.equal(type("a|bc", "u"), "a|bc");
});

test("normal mode swallows other printable keys; Esc, arrows and Tab are left to the page", () => {
  assert.equal(type("a|bc", "zq!"), "a|bc");
  const vim = { ...initialVim(), mode: "normal" as const };
  const buf = { text: "abc", cursor: 1 };
  for (const key of ["Escape", "ArrowLeft", "Tab", "Home"]) assert.equal(vimKey(vim, buf, key).handled, false, key);
  for (const key of ["Enter", "Backspace", "Process"]) assert.equal(vimKey(vim, buf, key).handled, true, key);
  assert.equal(vimKey({ ...vim, pending: "d" }, buf, "Escape").vim.pending, "", "Esc cancels a pending operator");
});
