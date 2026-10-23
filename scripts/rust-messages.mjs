// A token scan for the Rust message contract. Literals/comments cannot masquerade as macro calls;
// cfg(test) items are excluded before collecting production uses.
function tokens(source) {
  const out = [];
  for (let i = 0; i < source.length;) {
    const tail = source.slice(i);
    if (/^\s/.test(tail)) {
      i++;
    } else if (tail.startsWith("//")) {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end + 1;
    } else if (tail.startsWith("/*")) {
      let depth = 1;
      i += 2;
      while (i < source.length && depth) {
        if (source.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (source.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      if (depth) {
        throw new Error("Unclosed Rust block comment");
      }
    } else {
      const raw = /^(?:b|c)?r(#{0,255})"/.exec(tail);
      const quoted = /^(?:b|c)?"/.exec(tail);
      const char = /^(?:b)?'(?:\\(?:u\{[0-9a-fA-F_]+\}|.)|[^'\\])'/u.exec(tail);
      const word = /^[A-Za-z_]\w*/.exec(tail);
      if (raw) {
        const start = i + raw[0].length;
        const end = source.indexOf('"' + raw[1], start);
        if (end < 0) {
          throw new Error("Unclosed Rust raw string");
        }
        out.push({ kind: "string", value: source.slice(start, end) });
        i = end + 1 + raw[1].length;
      } else if (quoted) {
        const start = i + quoted[0].length;
        i = start;
        while (i < source.length && source[i] !== '"') {
          i += source[i] === "\\" ? 2 : 1;
        }
        if (i >= source.length) {
          throw new Error("Unclosed Rust string");
        }
        out.push({ kind: "string", value: source.slice(start, i) });
        i++;
      } else if (char) {
        i += char[0].length;
      } else if (word) {
        out.push({ kind: "word", value: word[0] });
        i += word[0].length;
      } else {
        out.push({ kind: "punct", value: source[i++] });
      }
    }
  }
  return out;
}

const matches = (ts, i, sequence) => sequence.every((value, n) => ts[i + n]?.value === value && ts[i + n]?.kind !== "string");
function groupEnd(ts, start) {
  const stack = [];
  const pairs = { "(": ")", "[": "]", "{": "}" };
  for (let i = start; i < ts.length; i++) {
    if (ts[i].kind !== "punct") {
      continue;
    }
    const value = ts[i].value;
    if (value in pairs) {
      stack.push(pairs[value]);
    } else if (value === stack.at(-1)) {
      stack.pop();
      if (!stack.length) {
        return i;
      }
    }
  }
  throw new Error("Unclosed Rust token group");
}

function production(ts) {
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    if (matches(ts, i, ["#", "[", "cfg", "(", "test", ")", "]"])) {
      i += 7;
      // Skip attributes/signature groups, then the gated item's body or semicolon.
      for (; i < ts.length; i++) {
        if (ts[i].kind !== "punct") {
          continue;
        }
        if (ts[i].value === ";") {
          break;
        }
        if (ts[i].value === "{") {
          i = groupEnd(ts, i);
          break;
        }
        if (ts[i].value === "(" || ts[i].value === "[") {
          i = groupEnd(ts, i);
        }
      }
    } else {
      out.push(ts[i]);
    }
  }
  return out;
}

export function rustMessageUsage(source) {
  const ts = production(tokens(source));
  const calls = [];
  for (let i = 0; i < ts.length; i++) {
    if (!matches(ts, i, ["msg", "!", "("])) {
      continue;
    }
    const end = groupEnd(ts, i + 2);
    const code = ts[i + 3];
    if (code?.kind !== "string") {
      throw new Error("Dynamic msg! code needs an explicit contract");
    }
    const params = [];
    for (let j = i + 4; j < end; j++) {
      const token = ts[j];
      if (token.kind !== "punct") {
        continue;
      }
      if ("([{".includes(token.value)) {
        j = groupEnd(ts, j);
      } else if (token.value === "," && ts[j + 1]?.kind === "word" && ts[j + 2]?.value === "=") {
        params.push(ts[j + 1].value);
      }
    }
    calls.push({ code: code.value, params: params.sort((a, b) => a.localeCompare(b)) });
  }
  return {
    calls,
    strings: new Set(ts.filter((t) => t.kind === "string").map((t) => t.value)),
    dynamicField: ts.some((_, i) => matches(ts, i, ["msg", ":", ":", "coded", "(", "field", ","])),
  };
}
