// Regenerates src-tauri/icons and the title bar logo from the SVG sources in src-tauri/icons, and the
// debug build's blue copies of icon.ico and the logo (icons/dev/icon.ico, src/app/logo-dev.svg).
//   node scripts/icons.ts
// `tauri icon` scales one source to every size, which blurs the 1px gaps of the weave below 64px,
// so the small sizes come from their own pixel-grid sources (icon-16/24/32/48.svg) and are packed
// into icon.ico here. icon.svg is drawn on a 32px grid, so 64/128/256/512 stay sharp too.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const icons = join(root, "src-tauri", "icons");
const tauri = join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");

/** Each size in icon.ico and the source drawn for it. */
const ICO: [size: number, svg: string][] = [
  [16, "icon-16.svg"],
  [24, "icon-24.svg"],
  [32, "icon-32.svg"],
  [48, "icon-48.svg"],
  [64, "icon.svg"],
  [256, "icon.svg"],
];

// A debug build keeps its data apart from the release build (src-tauri/src/location.rs), so its icon
// swaps the amber bars for blue to tell the two apart (src-tauri/build.rs).
const AMBER = "#EF9F27";
const DEV_BLUE = "#378ADD";

const run = (...args: string[]) => execFileSync(process.execPath, [tauri, "icon", ...args], { cwd: root, stdio: "ignore" });

function render(svg: string, size: number, dir: string): Buffer {
  run(svg, "-o", dir, "-p", String(size));
  return readFileSync(join(dir, `${size}x${size}.png`));
}

/** An ICO whose entries are PNGs (read by Windows Vista and later). */
function ico(images: [size: number, png: Buffer][]): Buffer {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(([size, png], i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size % 256, e);
    header.writeUInt8(size % 256, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(png.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(([, png]) => png)]);
}

/** Packs the ICO sources in `src` into `out`, and returns the 32px PNG. */
function packIco(src: string, out: string, tmp: string): Buffer {
  const images = ICO.map(([size, svg]): [number, Buffer] => [size, render(join(src, svg), size, tmp)]);
  writeFileSync(out, ico(images));
  return images.find(([size]) => size === 32)![1];
}

run(join(icons, "icon.svg"));
// Windows-only app: drop what `tauri icon` makes for mobile.
for (const extra of ["android", "ios", "64x64.png"]) {
  rmSync(join(icons, extra), { recursive: true, force: true });
}
const tmp = mkdtempSync(join(tmpdir(), "lattice-icons-"));
try {
  writeFileSync(join(icons, "32x32.png"), packIco(icons, join(icons, "icon.ico"), tmp));
  const dev = join(tmp, "dev");
  mkdirSync(dev);
  for (const svg of new Set(ICO.map(([, svg]) => svg))) {
    writeFileSync(join(dev, svg), readFileSync(join(icons, svg), "utf8").replaceAll(AMBER, DEV_BLUE));
  }
  mkdirSync(join(icons, "dev"), { recursive: true });
  packIco(dev, join(icons, "dev", "icon.ico"), tmp);
  copyFileSync(join(dev, "icon-16.svg"), join(root, "src", "app", "logo-dev.svg"));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
copyFileSync(join(icons, "icon-16.svg"), join(root, "src", "app", "logo.svg"));
