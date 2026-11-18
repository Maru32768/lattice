import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultRow, filterSections, follow, labelOf, pickRows, stepRow, type PickSection } from "./pickRows.ts";

const SECTIONS: PickSection[] = [
  {
    label: "",
    options: [
      { key: "article", label: "この記事(記事を開いていません)", disabled: true },
      { key: "all", label: "全記事" },
    ],
  },
  { label: "グループ", options: [{ key: "g1", label: "MVCC(2件)" }] },
  {
    label: "タグ",
    options: [
      { key: "t1", label: "#Rust(3件)" },
      { key: "t2", label: "#rustls(1件)", disabled: true },
      { key: "t3", label: "#wal(1件)" },
    ],
  },
];
const ROWS = pickRows(SECTIONS);
const shape = (rows: typeof ROWS) => rows.map((r) => (r.kind === "head" ? `[${r.label}]` : `${r.o.key}#${r.n}`));

test("rows: a labeled section opens with its head, an unlabeled one does not; options count from 1 past the heads", () => {
  assert.deepEqual(shape(ROWS), ["article#1", "all#2", "[グループ]", "g1#3", "[タグ]", "t1#4", "t2#5", "t3#6"]);
});

test("filtering keeps the options whose label holds the query, in either case, and drops the sections left empty", () => {
  const rust = filterSections(SECTIONS, "  RUST ");
  assert.deepEqual(shape(pickRows(rust)), ["[タグ]", "t1#1", "t2#2"]);
  assert.deepEqual(filterSections(SECTIONS, "none of these"), []);
  assert.equal(filterSections(SECTIONS, " "), SECTIONS, "a blank query filters nothing");
});

test("within a section, an option where the query comes earlier comes first, so Enter on a typed name picks that name", () => {
  const tags: PickSection[] = [
    {
      label: "タグ",
      options: [
        { key: "a", label: "#adaptive-agents(1件)" },
        { key: "b", label: "#agent(3件)" },
        { key: "c", label: "#agent memory(6件)" },
        { key: "d", label: "#llm-agent(2件)" },
      ],
    },
  ];
  assert.deepEqual(
    filterSections(tags, "agent")[0].options.map((o) => o.key),
    ["b", "c", "d", "a"],
  );
});

test("a step passes over heads and disabled options and stops at either end", () => {
  assert.equal(stepRow(ROWS, 1, 1), 3, "全記事 → MVCC, past the グループ head");
  assert.equal(stepRow(ROWS, 3, 1), 5, "MVCC → #Rust, past the タグ head");
  assert.equal(stepRow(ROWS, 5, 1), 7, "#Rust → #wal, past the disabled #rustls");
  assert.equal(stepRow(ROWS, 7, 1), 7, "the last option stays: no wrap");
  assert.equal(stepRow(ROWS, 1, -1), 1, "the disabled この記事 above 全記事 is not a stop");
  assert.equal(stepRow(ROWS, 5, -1), 3);
});

test("a page step lands on the nearest enabled option, further on first, and is clamped", () => {
  assert.equal(stepRow(ROWS, 1, 12), 7, "past the end: the last enabled option");
  assert.equal(stepRow(ROWS, 3, 3), 7, "on the disabled #rustls: the next one on");
  assert.equal(stepRow(ROWS, 7, -12), 1, "past the top: the first enabled option, not the disabled one above it");
  const tail = pickRows([
    {
      label: "",
      options: [
        { key: "a", label: "a" },
        { key: "b", label: "b" },
        { key: "c", label: "c", disabled: true },
      ],
    },
  ]);
  assert.equal(stepRow(tail, 0, 12), 1, "nothing enabled further on: back towards the start");
  assert.equal(stepRow(pickRows([{ label: "", options: [{ key: "a", label: "a", disabled: true }] }]), -1, 1), -1, "nothing enabled: no move");
});

test("the list opens on the selected option, or on the first enabled one when searching or when that one is disabled", () => {
  assert.equal(defaultRow(ROWS, "", "t3"), 7);
  assert.equal(defaultRow(ROWS, "", "gone"), 1);
  assert.equal(defaultRow(ROWS, "", "article"), 1, "a disabled selection");
  assert.equal(defaultRow(ROWS, "wal", "t3"), 1, "a query starts at the first match");
  assert.equal(defaultRow(pickRows([{ label: "", options: [{ key: "a", label: "a", disabled: true }] }]), "", "a"), -1);
});

test("a key's label is its first option's, disabled or not", () => {
  const twice: PickSection[] = [
    { label: "", options: [{ key: "g1", label: "このグループ: MVCC" }] },
    { label: "グループ", options: [{ key: "g1", label: "MVCC(2件)" }] },
  ];
  assert.equal(labelOf(twice, "g1"), "このグループ: MVCC");
  assert.equal(labelOf(SECTIONS, "article"), "この記事(記事を開いていません)");
  assert.equal(labelOf(SECTIONS, "gone"), undefined);
});

test("the active option is followed when rows come or go before it, and the copy of a repeated key stays the one it was", () => {
  assert.equal(follow(ROWS, { i: 5, key: "t1" }), 5, "nothing moved");
  const grown = pickRows([SECTIONS[0], { label: "グループ", options: [{ key: "g0", label: "Kafka(1件)" }, ...SECTIONS[1].options] }, SECTIONS[2]]);
  assert.equal(follow(grown, { i: 5, key: "t1" }), 6, "a group added above: #Rust is one row down");
  assert.equal(follow(pickRows([SECTIONS[2]]), { i: 5, key: "t1" }), 1, "the sections above it gone");
  assert.equal(follow(pickRows([SECTIONS[0], SECTIONS[1]]), { i: 5, key: "t1" }), -1, "the option itself gone");
  const twice = pickRows([
    {
      label: "",
      options: [
        { key: "all", label: "全記事" },
        { key: "g1", label: "このグループ: MVCC" },
      ],
    },
    {
      label: "グループ",
      options: [
        { key: "g0", label: "Kafka(1件)" },
        { key: "g1", label: "MVCC(2件)" },
      ],
    },
  ]);
  assert.equal(follow(twice, { i: 4, key: "g1" }), 4, "on the second copy, still the second");
  assert.equal(follow(twice, { i: 3, key: "g1" }), 4, "shifted by one: the nearer copy, not the first");
});
