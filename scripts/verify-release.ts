import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyUpdater } from "./verify-updater.ts";

const PORTABLE_FILES = ["Lattice.exe", "lattice-cli.exe", "portable", "LICENSE", "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_LICENSES"];

export interface ReleaseFacts {
  version: string;
  manifest: { version: string; platforms: Record<string, { url: string; signature: string }> };
  installerUrl: string;
  signature: string;
  publicKey: string;
  previousPublicKey: string;
  licenses: string;
  portableFiles: string[];
}

export function releaseProblems(f: ReleaseFacts): string[] {
  const problems: string[] = [];
  if (f.manifest.version !== f.version) {
    problems.push(`latest.json names version ${f.manifest.version}, not ${f.version}`);
  }
  const platforms = Object.entries(f.manifest.platforms);
  if (platforms.length === 0) {
    problems.push("latest.json lists no platform");
  }
  for (const [name, platform] of platforms) {
    if (platform.url !== f.installerUrl) {
      problems.push(`latest.json's ${name} points to ${platform.url}, not the uploaded installer ${f.installerUrl}`);
    }
    if (platform.signature.trim() !== f.signature.trim()) {
      problems.push(`latest.json's ${name} signature differs from the .sig file`);
    }
  }
  if (f.publicKey !== f.previousPublicKey) {
    problems.push("The updater public key changed since the previous tag: installed copies would reject this update");
  }
  if (!f.licenses.includes(`lattice ${f.version}`)) {
    problems.push(`THIRD_PARTY_LICENSES does not list lattice ${f.version}`);
  }
  for (const file of PORTABLE_FILES) {
    if (!f.portableFiles.includes(file)) {
      problems.push(`The portable zip has no ${file}`);
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [tag, dir] = process.argv.slice(2);
    if (!tag || !dir) {
      throw new Error("Usage: node scripts/verify-release.ts <tag> <folder with the release files and the extracted portable zip>");
    }
    const version = tag.slice(1);
    const installer = `Lattice_${version}_x64-setup.exe`;
    const run = (command: string, ...args: string[]) => execFileSync(command, args, { encoding: "utf8" }).trim();
    const publicKeyAt = (ref: string) => {
      const config = JSON.parse(run("git", "show", `${ref}:src-tauri/tauri.conf.json`)) as { plugins: { updater: { pubkey: string } } };
      return config.plugins.updater.pubkey;
    };
    const { assets } = JSON.parse(run("gh", "release", "view", tag, "--json", "assets")) as { assets: { name: string; apiUrl: string }[] };
    const signature = readFileSync(join(dir, `${installer}.sig`), "utf8");
    const publicKey = publicKeyAt(tag);
    const problems = releaseProblems({
      version,
      manifest: JSON.parse(readFileSync(join(dir, "latest.json"), "utf8")) as ReleaseFacts["manifest"],
      installerUrl: assets.find((asset) => asset.name === installer)?.apiUrl ?? "(no uploaded installer)",
      signature,
      publicKey,
      previousPublicKey: publicKeyAt(run("git", "describe", "--tags", "--abbrev=0", `${tag}^`)),
      licenses: readFileSync(join(dir, "THIRD_PARTY_LICENSES"), "utf8"),
      portableFiles: readdirSync(join(dir, `Lattice_${version}_x64-portable`)),
    });
    verifyUpdater(publicKey, signature, readFileSync(join(dir, installer)));
    if (problems.length > 0) {
      throw new Error(problems.join("\n"));
    }
    console.log(`Release ${version}: manifest, signature, public key, licenses and portable zip checked`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
