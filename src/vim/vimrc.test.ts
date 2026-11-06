import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Vim } from "@replit/codemirror-vim";
import { ENGINE_EX, ENGINE_OPTIONS, KNOWN, mappedKeys, parseVimrc, type VimrcEntry } from "./vimrc.ts";

const parse = (text: string) => parseVimrc(text, KNOWN);
const exOf = (entries: VimrcEntry[]) => entries.flatMap((e) => (e.kind === "ex" ? [e.ex] : e.kind === "free" ? [`unmap ${e.lhs}`] : []));
const skips = (entries: VimrcEntry[]) => entries.flatMap((e) => (e.kind === "skip" ? [[e.line, e.reason]] : []));

test("the mappings a vimrc of habits relies on apply, in the engine's key spelling", () => {
  const entries = parse(
    [
      "noremap ; :",
      "nnoremap j gj",
      "nnoremap H ^",
      "xnoremap H ^",
      "inoremap <c-h> <left>",
      "nnoremap <esc><esc> :noh<cr>",
      "vmap <C-S-x> d",
      "imap jk <Esc>:w<cr>a",
    ].join("\n"),
  );
  assert.deepEqual(exOf(entries), [
    "noremap ; :",
    "nnoremap j gj",
    "nnoremap H ^",
    "vnoremap H ^",
    "inoremap <C-h> <Left>",
    "nnoremap <Esc><Esc> :noh<CR>",
    "vmap <C-S-X> d",
    "imap jk <Esc>:w<CR>a",
  ]);
  assert.deepEqual(skips(entries), []);
});

test("the leader is substituted first, and its own key gives up the command it has", () => {
  assert.deepEqual(exOf(parse('let mapleader = "\\<space>"\nnnoremap <leader>w :w<cr>\nnnoremap <Leader>q :q<cr>')), [
    "unmap <Space>",
    "nnoremap <Space>w :w<CR>",
    "nnoremap <Space>q :q<CR>",
  ]);
  assert.deepEqual(exOf(parse(`let g:mapleader=','\nnmap <leader>x y`)), ["unmap ,", "nmap ,x y"]);
  assert.deepEqual(exOf(parse('let mapleader = " "\nnmap <leader>x y')), ["unmap <Space>", "nmap <Space>x y"]);
  assert.deepEqual(exOf(parse("nmap <leader>x y")), ["nmap \\x y"], "Vim's default leader");
  assert.deepEqual(exOf(parse('let maplocalleader = ","\nnmap <localleader>x y\nnmap <leader>x z')), ["unmap ,", "nmap ,x y", "nmap \\x z"]);
});

test("a leader's line can end in a comment, and its value can be a quote of the other kind", () => {
  assert.deepEqual(exOf(parse('let mapleader = " " " space as leader\nnnoremap <leader>x dd')), ["unmap <Space>", "nnoremap <Space>x dd"]);
  assert.deepEqual(exOf(parse(`let mapleader = '"'\nnnoremap <leader>x dd`)), ['unmap "', 'nnoremap "x dd']);
  assert.deepEqual(exOf(parse('let mapleader = "\\""\nnnoremap <leader>x dd')), ['unmap "', 'nnoremap "x dd'], "an escaped quote in double quotes");
  assert.deepEqual(exOf(parse('let mapleader = "\\\\" " a backslash\nnnoremap <leader>x dd')), ["unmap \\", "nnoremap \\x dd"]);
});

test("a colon a motion or a register takes is no Ex command", () => {
  assert.deepEqual(skips(parse('nnoremap Q f:lD\nnnoremap R t:x\nnnoremap S ":p')), []);
  assert.deepEqual(skips(parse("nnoremap Q gt:nosuch<cr>\nnnoremap R zt:nosuch<cr>\nnnoremap S :nosuch<cr>")), [
    [1, "unknownEx"],
    [2, "unknownEx"],
    [3, "unknownEx"],
  ]);
});

test("an unmap undoes the mappings above it, and with none takes the key's own command", () => {
  assert.deepEqual(parse("nnoremap x y\nvnoremap x z\nunmap x"), []);
  assert.deepEqual(parse("unmap x\nnnoremap x y"), [
    { kind: "free", line: 1, lhs: "x", modes: ["normal", "visual"] },
    { kind: "ex", line: 2, ex: "nnoremap x y" },
  ]);
  assert.deepEqual(parse("inoremap x y\nunmap x"), [
    { kind: "ex", line: 1, ex: "inoremap x y" },
    { kind: "free", line: 2, lhs: "x", modes: ["normal", "visual"] },
  ]);
  assert.deepEqual(parse("nnoremap x <nop>\nunmap x"), []);
});

test("a key gives up its command only in the modes of the <nop> that leads, and in insert mode has none to give up", () => {
  assert.deepEqual(parse("vnoremap s <Nop>\nvnoremap sa y")[0], { kind: "free", line: 1, lhs: "s", modes: ["visual"] });
  assert.deepEqual(parse("noremap s <Nop>\nnoremap sa y")[0], { kind: "free", line: 1, lhs: "s", modes: ["normal", "visual"] });
  assert.deepEqual(parse("inoremap j <nop>\ninoremap jk <esc>"), [{ kind: "ex", line: 2, ex: "inoremap jk <Esc>" }]);
});

test("a clear command takes the mappings above it from what counts as mapped, by its mode", () => {
  const mapped = (text: string) => {
    const m = mappedKeys(parse(text));
    return { normal: [...m.normal], visual: [...m.visual], insert: [...m.insert] };
  };
  assert.deepEqual(mapped("nnoremap <c-p> x\nmapclear"), { normal: [], visual: [], insert: [] });
  assert.deepEqual(mapped("nnoremap <c-p> x\nnmapc"), { normal: [], visual: [], insert: [] });
  assert.deepEqual(mapped("nnoremap Q x\nvnoremap W x\ninoremap E x\nnnoremap R <nop>\nvmapclear"), { normal: ["Q", "R"], visual: [], insert: ["E"] });
  assert.deepEqual(mapped("nnoremap Q x\nmapclear\nnnoremap W x"), { normal: ["W"], visual: [], insert: [] }, "what comes after stays");
  assert.deepEqual(exOf(parse("nnoremap Q x\nmapclear")), ["mapclear"], "the engine still runs it");
  assert.deepEqual(exOf(parse("noremap Q x\nnmapclear")), ["noremap Q x", "nmapclear"], "the n of noremap is no mode: the engine keeps it for the other modes");
});

test("an unmap with no key does nothing, and says so", () => {
  assert.deepEqual(skips(parse("nnoremap Q x\nunmap")), [[2, "script"]]);
  assert.deepEqual(exOf(parse("nnoremap Q x\nunmap")), ["nnoremap Q x"]);
});

test("a key that names an Ex command is left out: the engine throws on freeing one", () => {
  assert.deepEqual(skips(parse("unmap :x")), [[1, "script"]]);
  assert.deepEqual(skips(parse('let mapleader = ":x"')), [[1, "script"]]);
  assert.deepEqual(parse("unmap :"), [{ kind: "free", line: 1, lhs: ":", modes: ["normal", "visual"] }], "a lone colon is an ordinary key");
});

test("no vimrc text throws: Settings and the editor parse it as they come up, and it is stored", () => {
  for (const leader of ["mapleader", "maplocalleader"]) {
    const entries = parse(`let ${leader} = ""\n<leader>\n<localleader>\nnmap <leader>x y\nnmap <localleader>x z`);
    assert.deepEqual(exOf(entries).slice(1), ["nmap \\x y", "nmap \\x z"], "as in Vim, an empty leader is the default one");
  }
  assert.deepEqual(skips(parse('let mapleader = ""\n<leader>')), [[2, "unknownEx"]], "the line is listed as left out");
  assert.deepEqual(skips(parse('let mapleader = "  "\n<leader>')), [[2, "unknownEx"]]);
  assert.deepEqual(skips(parse("imap a <le\rft>")), [[1, "script"]], "a lone CR inside a line");
  assert.deepEqual(exOf(parse("imap a  b")), ["imap a b"]);
});

test("a key name is not looked up on Object.prototype", () => {
  assert.deepEqual(exOf(parse("map <constructor> <__proto__>")), ["map <constructor> <__proto__>"]);
});

test("map arguments are stripped, <expr> is not understood", () => {
  assert.deepEqual(exOf(parse("nnoremap <silent> <unique> <nowait> <buffer> <script> x :w<cr>")), ["nnoremap x :w<CR>"]);
  assert.deepEqual(skips(parse("nnoremap <expr> x foo()")), [[1, "expr"]]);
  assert.deepEqual(skips(parse("nnoremap <silent> <expr> x foo()")), [[1, "expr"]]);
});

test("<nop> is its own entry with its mode", () => {
  assert.deepEqual(parse("nnoremap Q <nop>\nnoremap <c-a> <Nop>\nimap <F1> <NOP>\nxnoremap x <nop>"), [
    { kind: "nop", line: 1, lhs: "Q", context: "normal" },
    { kind: "nop", line: 2, lhs: "<C-a>", context: null },
    { kind: "nop", line: 3, lhs: "<F1>", context: "insert" },
    { kind: "nop", line: 4, lhs: "x", context: "visual" },
  ]);
  assert.deepEqual(skips(parse("onoremap x <nop>")), [[1, "mode"]], "no such context in the entry's type");
});

test("a <nop> on a key that leads other mappings gives the key up instead, or the engine would stop at it", () => {
  assert.deepEqual(parse("nnoremap <space> <nop>\nnnoremap <space>w :w<cr>"), [
    { kind: "free", line: 1, lhs: "<Space>", modes: ["normal"] },
    { kind: "ex", line: 2, ex: "nnoremap <Space>w :w<CR>" },
  ]);
  assert.equal(parse("inoremap <c-x> <nop>\nnnoremap <c-x>y z")[0].kind, "nop", "the longer mapping is in another mode");
});

test("a right-hand side that runs an unknown command skips the whole mapping, so the earlier one survives", () => {
  const entries = parse(
    [
      "noremap ; :",
      "nnoremap ; :set norelativenumber<cr>:",
      "nnoremap gc :Commentary<cr>j",
      "nnoremap <leader>r :so $MYVIMRC<cr>",
      "nnoremap <leader>l :let @/ = ''<cr>",
      "nnoremap <leader>c :<c-u>call Foo()<cr>",
    ].join("\n"),
  );
  assert.deepEqual(exOf(entries), ["noremap ; :"]);
  assert.deepEqual(skips(entries), [
    [2, "unknownOption"],
    [3, "unknownEx"],
    [4, "unknownEx"],
    [5, "unknownEx"],
    [6, "unknownEx"],
  ]);
});

test("a right-hand side's known commands pass: short names, ranges, set options, a prompt left open", () => {
  assert.deepEqual(exOf(parse("nnoremap a :noh<cr>")), ["nnoremap a :noh<CR>"]);
  assert.deepEqual(exOf(parse("nnoremap a :%s/x/y/g<cr>")), ["nnoremap a :%s/x/y/g<CR>"]);
  assert.deepEqual(exOf(parse("vnoremap a :'<,'>sort<cr>")), ["vnoremap a :'<,'>sort<CR>"]);
  assert.deepEqual(exOf(parse("nnoremap a :set nopcre<cr>")), ["nnoremap a :set nopcre<CR>"]);
  assert.deepEqual(exOf(parse("nnoremap a :wincmd h<cr>")), ["nnoremap a :wincmd h<CR>"]);
  assert.deepEqual(exOf(parse("nnoremap a :tabnew<cr>")), ["nnoremap a :tabnew<CR>"]);
  assert.deepEqual(exOf(parse("nnoremap a :%s/")), ["nnoremap a :%s/"]);
  assert.deepEqual(exOf(parse("vnoremap a :<c-u>w<cr>")), ["vnoremap a :w<CR>"], "the engine would type <C-u> into the command");
});

test("a colon is text in insert mode until the mapping leaves it", () => {
  assert.deepEqual(exOf(parse("inoremap <c-d> std::vector")), ["inoremap <C-d> std::vector"]);
  assert.deepEqual(skips(parse("inoremap jk <esc>:Foo<cr>")), [[1, "unknownEx"]]);
  assert.deepEqual(skips(parse("inoremap jk <c-o>:Foo<cr>")), [[1, "unknownEx"]]);
});

test("a bracket that names no key is text", () => {
  assert.deepEqual(exOf(parse("inoremap <c-b> <B>x</B>")), ["inoremap <C-b> <B>x</B>"]);
});

test('`"` starts a comment on set lines and on its own line, never inside a mapping', () => {
  assert.deepEqual(exOf(parse('" a comment\nnnoremap x "zyiw\nset pcre " regexes\n   " indented')), ['nnoremap x "zyiw', "set pcre"]);
});

test("set: one entry per option, each validated; clipboard's += becomes a plain value", () => {
  const entries = parse(
    "set nopcre number textwidth=72\nset clipboard+=unnamed\nset clipboard^=unnamedplus\nset cb=unnamed\nset clipboard-=unnamed\nset tw+=2",
  );
  assert.deepEqual(exOf(entries), ["set nopcre", "set textwidth=72", "set clipboard=unnamed", "set clipboard=unnamedplus", "set cb=unnamed"]);
  assert.deepEqual(skips(entries), [
    [1, "unknownOption"],
    [5, "unknownOption"],
    [6, "unknownOption"],
  ]);
  assert.deepEqual(exOf(parse("se pcre | setlocal nopcre")), ["set pcre", "set nopcre"]);
  assert.deepEqual(skips(parse("set pcre | syntax on")), [[1, "script"]]);
});

test("blocks are skipped whole, one entry at their first line, nesting and one-liners included", () => {
  const entries = parse(
    [
      "if has('win32')",
      "  nnoremap a b",
      "  if 1",
      "    nnoremap c d",
      "  endif",
      "endif",
      "function! Foo() abort",
      "  set pcre",
      "endfunction",
      "augroup mine",
      "  autocmd!",
      "  autocmd BufRead * set pcre",
      "augroup END",
      "if 1 | set pcre | endif",
      "nnoremap e f",
    ].join("\n"),
  );
  assert.deepEqual(exOf(entries), ["nnoremap e f"]);
  assert.deepEqual(skips(entries), [
    [1, "script"],
    [7, "script"],
    [10, "script"],
    [14, "script"],
  ]);
});

test("continuation lines fold into the line they continue, keeping its number", () => {
  assert.deepEqual(parse('" one\nnnoremap a\n  \\ b\nset pcre'), [
    { kind: "ex", line: 2, ex: "nnoremap a b" },
    { kind: "ex", line: 4, ex: "set pcre" },
  ]);
});

test("the reasons a line is left out", () => {
  const cases: [string, string][] = [
    ["Plug 'tpope/vim-surround'", "plugin"],
    ["call plug#begin()", "plugin"],
    ["nmap gc <Plug>Commentary", "plugin"],
    ["tnoremap <esc> x", "mode"],
    ["cnoremap x y", "mode"],
    ["sunmap x", "mode"],
    ["snoremap x y", "mode"],
    ["autocmd BufRead * set pcre", "script"],
    ["let g:foo = 1", "script"],
    ["call Foo()", "script"],
    ["colorscheme desert", "script"],
    ["highlight Normal guibg=NONE", "script"],
    ["syntax on", "script"],
    ["nohlsearch", "script"],
    ["FooBar baz", "unknownEx"],
    ["set number", "unknownOption"],
    ["nnoremap <c-w>x y", "app"],
    ["nnoremap x <C-w>w", "app"],
    ["nnoremap x", "script"],
  ];
  for (const [line, reason] of cases) {
    assert.deepEqual(skips(parse(line)), [[1, reason]], line);
    assert.equal(parse(line).length, 1, line);
  }
  assert.equal((parse("  FooBar  ")[0] as { text: string }).text, "FooBar", "the text is what the user wrote");
});

test("mappedKeys lists each mapping's first key by the modes it works in", () => {
  const keys = mappedKeys(
    parse("inoremap <c-h> <left>\nnnoremap <c-j>x y\nvmap <c-k> y\nmap <c-l> y\nonoremap <c-o> y\nnoremap Q <nop>\nimap <c-a> <nop>\nset pcre"),
  );
  assert.deepEqual([...keys.insert], ["<C-h>", "<C-a>"]);
  assert.deepEqual([...keys.normal], ["<C-j>", "<C-l>", "<C-o>", "Q"]);
  assert.deepEqual([...keys.visual], ["<C-k>", "<C-l>", "Q"]);
});

test("the Ex and option tables match the engine", () => {
  const source = readFileSync(new URL("../../node_modules/@replit/codemirror-vim-core/vim.js", import.meta.url), "utf8");
  const map = /var defaultExCommandMap = \[([\s\S]*?)\n\s*\];/.exec(source)![1];
  const engineEx = [...map.matchAll(/name: '(\w+)'(?:, shortName: '(\w+)')?/g)].map((m) => (m[2] ? [m[1], m[2]] : [m[1]]));
  const defined = [...source.matchAll(/vimApi\.defineEx\("(\w+)", "(\w+)"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(ENGINE_EX, [...engineEx, ...defined]);

  const options = [...source.matchAll(/defineOption\('(\w+)', [^,]+, '\w+'(?:, \[([^\]]*)\])?/g)].flatMap((m) => [
    m[1],
    ...[...(m[2] ?? "").matchAll(/'(\w+)'/g)].map((a) => a[1]),
  ]);
  assert.deepEqual(new Set(ENGINE_OPTIONS), new Set(options));
  for (const name of ENGINE_OPTIONS) {
    assert.ok(!(Vim.getOption(name) instanceof Error), name);
  }
  assert.ok(Vim.getOption("nosuch") instanceof Error, "the engine does report an unknown option");
});
