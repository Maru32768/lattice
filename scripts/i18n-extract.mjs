// Moves Japanese UI text out of src/ into the catalogs (src/i18n/ja.ts, en.ts), G51.
//   node scripts/i18n-extract.mjs scan <files…> > map.json   list the text, one entry per call site
//   (fill each entry's "en", optionally "key", or set "skip": true)
//   node scripts/i18n-extract.mjs apply map.json             rewrite the call sites, append the catalogs
// Text in a component becomes `t(…)` from `const t = useT()`; elsewhere the global `t`. Entries the
// rewrite cannot do safely carry a "note" (module-level constants, comparisons, nested markup).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, relative } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const JAPANESE = /[　-ヿ㐀-鿿＀-￯]/;
const CATALOG_DIR = "src/i18n";
const APPEND = "  // @i18n-append";

const parse = (file) =>
  ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/** JSX text as React renders it (Babel's cleanJSXElementLiteralChild). */
export function jsxText(raw) {
  const lines = raw.split(/\r\n|\n|\r/);
  const last = lines.findLastIndex((l) => /[^ \t]/.test(l));
  let out = "";
  lines.forEach((line, i) => {
    let s = line.replace(/\t/g, " ");
    if (i > 0) {
      s = s.replace(/^ +/, "");
    }
    if (i < lines.length - 1) {
      s = s.replace(/ +$/, "");
    }
    if (s) {
      out += i === last ? s : s + " ";
    }
  });
  return out;
}

const hasJapanese = (node) => {
  let found = false;
  const visit = (n) => {
    if (found) {
      return;
    }
    if ((ts.isStringLiteralLike(n) || ts.isJsxText(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) && JAPANESE.test(n.text)) {
      found = true;
    } else {
      ts.forEachChild(n, visit);
    }
  };
  visit(node);
  return found;
};

const fnName = (fn) => {
  if (fn.name && ts.isIdentifier(fn.name)) {
    return fn.name.text;
  }
  const p = fn.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) {
    return p.name.text;
  }
  return null;
};

/** The component the node renders in (outermost function named in PascalCase), else "function" or "module". */
function scopeOf(node) {
  let component = null;
  let inFunction = false;
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
      inFunction = true;
      const name = fnName(n);
      if (name && /^[A-Z]/.test(name)) {
        component = n;
      }
    }
  }
  return component ? { scope: "component", fn: component } : { scope: inFunction ? "function" : "module", fn: null };
}

const isTCall = (node) => {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isCallExpression(n)) {
      const c = n.expression.getText();
      return c === "t" || c === "t.rich" || c === "t.msg";
    }
    if (!ts.isObjectLiteralExpression(n) && !ts.isPropertyAssignment(n)) {
      return false;
    }
  }
  return false;
};

function suspicious(node) {
  const p = node.parent;
  if (ts.isCaseClause(p)) {
    return "case label";
  }
  if (ts.isBinaryExpression(p) && /^[!=]==?$/.test(p.operatorToken.getText())) {
    return "comparison";
  }
  if (ts.isLiteralTypeNode(p)) {
    return "type";
  }
  if (ts.isPropertyAssignment(p) && p.name === node) {
    return "property name";
  }
  if (ts.isElementAccessExpression(p)) {
    return "index";
  }
  return null;
}

/** A param name for an interpolated expression. */
function paramName(expr, taken) {
  let base = "x";
  if (ts.isIdentifier(expr)) {
    base = expr.text;
  } else if (ts.isPropertyAccessExpression(expr)) {
    base = expr.name.text;
  } else if (ts.isCallExpression(expr)) {
    base = (ts.isPropertyAccessExpression(expr.expression) ? expr.expression.name : expr.expression).getText();
  } else if (ts.isJsxElement(expr) || ts.isJsxSelfClosingElement(expr)) {
    base = (ts.isJsxElement(expr) ? expr.openingElement : expr).tagName.getText().toLowerCase();
  }
  // `t` would read as the translator: a translated label passed in, or a loop variable.
  if (base === "t") {
    base = ts.isCallExpression(expr) ? "label" : "value";
  }
  base = base.replace(/\W/g, "") || "x";
  let name = base;
  for (let i = 2; taken.has(name); i++) {
    name = `${base}${i}`;
  }
  taken.add(name);
  return name;
}

const isSimple = (e) =>
  ts.isIdentifier(e) ||
  ts.isPropertyAccessExpression(e) ||
  ts.isElementAccessExpression(e) ||
  ts.isCallExpression(e) ||
  (ts.isBinaryExpression(e) && ["+", "-", "*", "/"].includes(e.operatorToken.getText()) && !hasJapanese(e)) ||
  ts.isNumericLiteral(e);

/** One entry per Japanese text site in `file`. */
export function scan(file) {
  const sf = parse(file);
  const entries = [];
  const add = (node, start, end, kind, ja, params, extra = {}) => {
    const { scope, fn } = scopeOf(node);
    entries.push({
      file,
      start,
      end,
      line: sf.getLineAndCharacterOfPosition(start).line + 1,
      kind,
      ja,
      params,
      scope,
      component: fn ? fnName(fn) : null,
      key: "",
      en: "",
      ...extra,
    });
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      return;
    }
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      jsxChildren(node.children);
      // attributes and nested elements are visited below; children text is handled as runs
      if (ts.isJsxElement(node)) {
        visit(node.openingElement);
      }
      node.children.forEach((c) => (ts.isJsxText(c) ? null : visitChild(c)));
      return;
    }
    if (ts.isStringLiteralLike(node) && JAPANESE.test(node.text) && !isTCall(node)) {
      const attr = ts.isJsxAttribute(node.parent);
      const note = suspicious(node);
      add(node, node.getStart(), node.getEnd(), attr ? "attr" : "string", node.text, [], note ? { note } : {});
      return;
    }
    if (ts.isTemplateExpression(node) && hasJapaneseSpans(node) && !isTCall(node)) {
      const taken = new Set();
      let ja = node.head.text;
      const params = [];
      for (const span of node.templateSpans) {
        const name = paramName(span.expression, taken);
        params.push({ name, expr: span.expression.getText() });
        ja += `{${name}}${span.literal.text}`;
      }
      // Text inside an interpolation would be a second, overlapping rewrite: left to the hand pass.
      const nested = node.templateSpans.some((s) => hasJapanese(s.expression));
      add(node, node.getStart(), node.getEnd(), "template", ja, params, nested ? { note: "nested text", skip: true } : {});
      return;
    }
    ts.forEachChild(node, visit);
  };
  const visitChild = (c) => {
    if (ts.isJsxExpression(c)) {
      if (c.expression) {
        visit(c.expression);
      }
    } else {
      visit(c);
    }
  };

  /** Children runs between child elements that hold Japanese themselves; a run with Japanese text becomes one message. */
  function jsxChildren(children) {
    let run = [];
    const flush = () => {
      if (run.some((c) => ts.isJsxText(c) && JAPANESE.test(c.text))) {
        emitRun(run);
      }
      run = [];
    };
    for (const c of children) {
      const element = ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c) || ts.isJsxFragment(c);
      if ((element || ts.isJsxExpression(c)) && hasJapanese(c)) {
        flush();
      } else {
        run.push(c);
      }
    }
    flush();
  }

  function emitRun(run) {
    // Markup at the edges stays outside the message, and so does blank text (layout, not content).
    const edge = (c) => (ts.isJsxText(c) ? !/\S/.test(c.text) : !ts.isJsxExpression(c) || !c.expression || !isSimple(c.expression));
    while (run.length && edge(run[0])) {
      run.shift();
    }
    while (run.length && edge(run.at(-1))) {
      run.pop();
    }
    const taken = new Set();
    const params = [];
    let ja = "";
    let rich = false;
    run.forEach((c) => {
      if (ts.isJsxText(c)) {
        ja += jsxText(c.text);
      } else if (ts.isJsxExpression(c)) {
        if (!c.expression) {
          return;
        }
        const name = paramName(c.expression, taken);
        if (!isSimple(c.expression)) {
          rich = true;
        }
        params.push({ name, expr: c.expression.getText() });
        ja += `{${name}}`;
      } else {
        rich = true;
        const name = paramName(c, taken);
        params.push({ name, expr: c.getText() });
        ja += `{${name}}`;
      }
    });
    const first = run[0];
    const last = run.at(-1);
    // JsxText spans from `pos` (getStart() would skip its leading blanks); layout blanks stay outside.
    const start = ts.isJsxText(first) ? first.pos + (first.text.length - first.text.replace(/^\s*\n\s*/, "").length) : first.getStart();
    const end = ts.isJsxText(last) ? last.end - (last.text.length - last.text.replace(/\s*\n\s*$/, "").length) : last.getEnd();
    add(first, start, end, rich ? "jsxRich" : "jsx", ja, params);
  }

  const hasJapaneseSpans = (tpl) => JAPANESE.test(tpl.head.text) || tpl.templateSpans.some((s) => JAPANESE.test(s.literal.text));
  visit(sf);
  return entries;
}

/** Every UI source file: src/ but the catalogs and the tests. */
export function sourceFiles(dir = "src") {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const path = `${dir}/${d.name}`;
    if (d.isDirectory()) {
      return path === CATALOG_DIR ? [] : sourceFiles(path);
    }
    return /\.tsx?$/.test(d.name) && !d.name.endsWith(".test.ts") && !d.name.endsWith(".d.ts") ? [path] : [];
  });
}

const camel = (s) => s.replace(/^[A-Z]/, (c) => c.toLowerCase());

/** A key from the English text: the file's namespace and the first words, camelCased. */
function proposeKey(entry, common) {
  const ns = common.has(entry.ja) ? "common" : camel(basename(entry.file).replace(/\.(tsx?|mjs)$/, ""));
  const words = entry.en
    .replace(/^\(p\) =>|\{\w+\}|p\.\w+/g, " ")
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? ["text"];
  return `${ns}.${words
    .slice(0, 4)
    .map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w))
    .join("")}`;
}

const quote = (s) => JSON.stringify(s);
const call = (fn, key, params) => {
  if (!params.length) {
    return `${fn}(${quote(key)})`;
  }
  const obj = params.map((p) => (p.expr === p.name ? p.name : `${p.name}: ${p.expr}`)).join(", ");
  return `${fn}(${quote(key)}, { ${obj} })`;
};

function replacement(e) {
  switch (e.kind) {
    case "attr":
      return `{${call("t", e.key, [])}}`;
    case "string":
    case "template":
      return call("t", e.key, e.params);
    case "jsx":
      return `{${call("t", e.key, e.params)}}`;
    case "jsxRich":
      return `{${call("t.rich", e.key, e.params)}}`;
    default:
      throw new Error(`unknown kind ${e.kind}`);
  }
}

/** The catalog module as `file` imports it; .ts modules also run under node --test, which resolves no directories. */
function importFrom(file) {
  const rel = relative(dirname(file), CATALOG_DIR).replace(/\\/g, "/");
  const dir = rel.startsWith(".") ? rel : `./${rel}`;
  return file.endsWith(".ts") ? `${dir}/index.ts` : dir;
}

/** Adds `name` to the file's import from the catalog module. */
function ensureImport(src, file, name) {
  const from = importFrom(file);
  const re = new RegExp(`import \\{([^}]*)\\} from "${from.replace(/[./]/g, "\\$&")}";`);
  const m = src.match(re);
  if (m) {
    const names = m[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (names.includes(name)) {
      return src;
    }
    return src.replace(re, `import { ${[...names, name].sort((a, b) => a.localeCompare(b)).join(", ")} } from "${from}";`);
  }
  const imports = [...src.matchAll(/^import [^;]+;\r?\n/gm)];
  const at = imports.length ? imports.at(-1).index + imports.at(-1)[0].length : 0;
  return `${src.slice(0, at)}import { ${name} } from "${from}";\n${src.slice(at)}`;
}

/** `const t = useT();` as the first statement of each component that now uses `t`. */
function addHooks(src, file, components) {
  if (!components.size) {
    return src;
  }
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const inserts = [];
  const visit = (n) => {
    if ((ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && components.has(fnName(n))) {
      components.delete(fnName(n));
      if (n.body && ts.isBlock(n.body)) {
        if (!n.body.statements.some((s) => /const t = useT\(\)/.test(s.getText()))) {
          const indent = n.body.statements[0] ? " ".repeat(sf.getLineAndCharacterOfPosition(n.body.statements[0].getStart()).character) : "  ";
          inserts.push({ at: n.body.getStart() + 1, text: `\n${indent}const t = useT();` });
        }
      } else if (n.body) {
        const indent = " ".repeat(sf.getLineAndCharacterOfPosition(n.getStart()).character);
        inserts.push({ at: n.body.getStart(), text: `{\n${indent}  const t = useT();\n${indent}  return `, end: n.body.getEnd(), close: `;\n${indent}}` });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  for (const i of inserts.sort((a, b) => b.at - a.at)) {
    if (i.end !== undefined) {
      src = src.slice(0, i.end) + i.close + src.slice(i.end);
    }
    src = src.slice(0, i.at) + i.text + src.slice(i.at);
  }
  return src;
}

function appendCatalog(lang, entries) {
  const path = `${CATALOG_DIR}/${lang}.ts`;
  let src = readFileSync(path, "utf8");
  const lines = [];
  for (const e of entries) {
    if (src.includes(`  ${quote(e.key)}:`) || lines.some((l) => l.startsWith(`  ${quote(e.key)}:`))) {
      continue;
    }
    // English given as `(p) => …` (plurals) is code, not text.
    const value = lang === "ja" ? quote(e.ja) : e.en.startsWith("(p) =>") ? e.en : quote(e.en);
    lines.push(`  ${quote(e.key)}: ${value},`);
  }
  if (!src.includes(APPEND)) {
    throw new Error(`${path} has no "${APPEND.trim()}" line`);
  }
  src = src.replace(APPEND, [...lines, APPEND].join("\n"));
  writeFileSync(path, src);
}

function apply(mapFile) {
  const map = JSON.parse(readFileSync(mapFile, "utf8")).filter((e) => !e.skip);
  const missing = map.filter((e) => !e.en);
  if (missing.length) {
    throw new Error(`no "en" for: ${missing.map((e) => `${e.file}:${e.line}`).join(", ")}`);
  }
  const files = new Map();
  for (const e of map) {
    files.set(e.file, [...(files.get(e.file) ?? []), e]);
  }
  // The same Japanese in two files (of all of src/) is one shared "common" message; text the
  // catalog already has keeps its key.
  const byText = new Map();
  for (const e of sourceFiles().flatMap(scan)) {
    byText.set(e.ja, new Set([...(byText.get(e.ja) ?? []), e.file]));
  }
  const common = new Set([...byText].filter(([, f]) => f.size > 1).map(([ja]) => ja));
  const existing = new Map(
    [...readFileSync(`${CATALOG_DIR}/ja.ts`, "utf8").matchAll(/^ {2}("[^"]+"): ("(?:[^"\\]|\\.)*"),$/gm)].map((m) => [JSON.parse(m[2]), JSON.parse(m[1])]),
  );
  const keys = new Map(); // key → ja
  for (const e of map) {
    let key = e.key || existing.get(e.ja) || proposeKey(e, common);
    for (let i = 2; keys.has(key) && keys.get(key) !== e.ja; i++) {
      key = `${e.key || proposeKey(e, common)}${i}`;
    }
    keys.set(key, e.ja);
    e.key = key;
  }
  for (const [file, entries] of files) {
    let src = readFileSync(file, "utf8");
    for (const e of [...entries].sort((a, b) => b.start - a.start)) {
      src = src.slice(0, e.start) + replacement(e) + src.slice(e.end);
    }
    const components = new Set(entries.filter((e) => e.scope === "component").map((e) => e.component));
    src = addHooks(src, file, components);
    if (entries.some((e) => e.scope === "component")) {
      src = ensureImport(src, file, "useT");
    }
    if (entries.some((e) => e.scope !== "component")) {
      src = ensureImport(src, file, "t");
    }
    writeFileSync(file, src);
  }
  appendCatalog("ja", map);
  appendCatalog("en", map);
  for (const e of map.filter((e) => e.note || e.scope === "module")) {
    console.log(`check ${e.file}:${e.line} (${e.note ?? "module-level"}): ${e.ja}`);
  }
}

const [cmd, ...args] = import.meta.url === pathToFileURL(process.argv[1] ?? "").href ? process.argv.slice(2) : [];
if (cmd === "scan") {
  console.log(JSON.stringify(args.flatMap(scan), null, 1));
} else if (cmd === "apply") {
  apply(args[0]);
} else if (cmd) {
  console.error("usage: i18n-extract.mjs scan <files…> | apply <map.json>");
  process.exit(1);
}
