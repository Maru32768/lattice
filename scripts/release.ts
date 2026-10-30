import { readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkVersions } from "./version.ts";

export function releaseNotes(changelog: string, version: string, file = "CHANGELOG.md"): string {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start < 0) {
    throw new Error(`${file} has no section for ${version}`);
  }
  if (!new RegExp(`^## \\[${version.replaceAll(".", "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}$`).test(lines[start])) {
    throw new Error(`Date the ${file} section for ${version} before tagging the release`);
  }
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## ["));
  const body = lines
    .slice(start + 1, end < 0 ? undefined : end)
    .filter((line) => !/^\[[^\]]+\]: /.test(line))
    .join("\n")
    .trim();
  if (!body || !body.split("\n").some((line) => line.trim() && !line.startsWith("#"))) {
    throw new Error(`${file} has no release notes for ${version}`);
  }
  return body;
}

interface TauriConfig {
  plugins?: { updater?: { pubkey?: string } };
}

export function checkSigning(config: TauriConfig, env: Record<string, string | undefined>): void {
  const key = config.plugins?.updater?.pubkey?.trim();
  if (!key || key.startsWith("NOT_CONFIGURED")) {
    throw new Error("Configure the updater public key before releasing");
  }
  for (const name of ["TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"]) {
    if (!env[name]?.trim()) {
      throw new Error(`Set the GitHub Actions secret ${name} before releasing`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const version = checkVersions(root);
    if (process.argv[2] !== `v${version}`) {
      throw new Error(`tag ${process.argv[2] ?? "(missing)"} does not match version ${version}`);
    }
    const notes = (file: string) => releaseNotes(readFileSync(join(root, file), "utf8"), version, file);
    // The UI ships in Japanese too, so the release page carries both languages.
    const body = `${notes("CHANGELOG.md")}\n\n---\n\n## 日本語\n\n${notes("CHANGELOG.ja.md")}`;
    checkSigning(JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8")) as TauriConfig, process.env);
    if (process.env.GITHUB_OUTPUT) {
      const delimiter = `LATTICE_NOTES_${crypto.randomUUID()}`;
      appendFileSync(process.env.GITHUB_OUTPUT, `body<<${delimiter}\n${body}\n${delimiter}\n`);
    }
    console.log(`Release ${version}: version, notes and signing prerequisites checked`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
