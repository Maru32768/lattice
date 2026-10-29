// The app version lives in package.json, package-lock.json, the workspace Cargo.toml (the
// crates inherit it, and tauri.conf.json has no version so Tauri reads Cargo's) and Cargo.lock.
//   node scripts/version.ts              print each file's version
//   node scripts/version.ts 1.2.3        set every file to 1.2.3
//   node scripts/version.ts --check [v1.2.3]   fail on drift (and on a tag that differs)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const WORKSPACE_VERSION = /(\[workspace\.package\][^[]*?\nversion = ")([^"]+)(")/;
const LOCK_VERSION = /(\nname = "(?:lattice|lattice-core|lattice-cli)"\r?\nversion = ")([^"]+)(")/g;

interface Doc {
  [key: string]: Doc | string | undefined;
}

const json = {
  read: (text: string, path: string[]) =>
    path.reduce<Doc | string | undefined>((o, k) => (typeof o === "object" ? o[k] : undefined), JSON.parse(text) as Doc) as string | undefined,
  write(text: string, path: string[], v: string) {
    const doc = JSON.parse(text) as Doc;
    path.slice(0, -1).reduce((o, k) => o[k] as Doc, doc)[path.at(-1)!] = v;
    return JSON.stringify(doc, null, 2) + "\n";
  },
};

/** A file that keeps the version: `read` returns every copy in it, `write` sets them all. */
interface Source {
  file: string;
  read: (text: string) => (string | undefined)[];
  write: (text: string, version: string) => string;
}

const SOURCES: Source[] = [
  { file: "package.json", read: (t) => [json.read(t, ["version"])], write: (t, v) => json.write(t, ["version"], v) },
  {
    file: "package-lock.json",
    read: (t) => [json.read(t, ["version"]), json.read(t, ["packages", "", "version"])],
    write: (t, v) => json.write(json.write(t, ["version"], v), ["packages", "", "version"], v),
  },
  { file: "Cargo.toml", read: (t) => [t.match(WORKSPACE_VERSION)?.[2]], write: (t, v) => t.replace(WORKSPACE_VERSION, `$1${v}$3`) },
  {
    file: "Cargo.lock",
    read: (t) => {
      const found = [...t.matchAll(LOCK_VERSION)].map((m) => m[2]);
      return found.length === 3 ? found : [undefined];
    },
    write: (t, v) => t.replace(LOCK_VERSION, `$1${v}$3`),
  },
];

/** `[{ file, versions }]` for the repository at `root`. */
export function readVersions(root: string): { file: string; versions: (string | undefined)[] }[] {
  return SOURCES.map((s) => ({ file: s.file, versions: s.read(readFileSync(join(root, s.file), "utf8")) }));
}

/** The one version every file agrees on; throws listing the files on drift. */
export function checkVersions(root: string): string {
  const all = readVersions(root);
  const distinct = new Set(all.flatMap((f) => f.versions));
  if (distinct.size !== 1 || distinct.has(undefined)) {
    throw new Error(`version drift: ${all.map((f) => `${f.file}=${f.versions.join("/")}`).join(", ")}`);
  }
  return [...distinct][0]!;
}

export function setVersion(root: string, version: string): string {
  if (!SEMVER.test(version)) {
    throw new Error(`not a semver version: ${version}`);
  }
  for (const s of SOURCES) {
    const path = join(root, s.file);
    writeFileSync(path, s.write(readFileSync(path, "utf8"), version));
  }
  return checkVersions(root);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const [arg, tag] = process.argv.slice(2);
  try {
    if (arg === "--check") {
      const v = checkVersions(root);
      if (tag && tag !== `v${v}`) {
        throw new Error(`tag ${tag} does not match version ${v}`);
      }
      console.log(v);
    } else if (arg) {
      console.log(`version set to ${setVersion(root, arg)}`);
    } else {
      for (const f of readVersions(root)) {
        console.log(`${f.file}: ${f.versions.join(", ")}`);
      }
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
