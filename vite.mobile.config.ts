import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";

const ICONS = [
  { file: "icon-256.png", source: "src-tauri/icons/128x128@2x.png", sizes: "256x256" },
  { file: "icon-512.png", source: "src-tauri/icons/icon.png", sizes: "512x512" },
];

// The page for the phone (design-review §32). crates/lattice-server embeds these files by name,
// so the names carry no hash; its test fails on a built file that it does not serve.
export default defineConfig({
  root: "src/mobile",
  base: "./",
  publicDir: false,
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    {
      name: "pwa-files",
      generateBundle() {
        for (const { file, source } of ICONS) {
          this.emitFile({ type: "asset", fileName: file, source: readFileSync(source) });
        }
        const manifest = {
          name: "Lattice",
          start_url: "./",
          display: "standalone",
          background_color: "#18191B",
          icons: ICONS.map(({ file, sizes }) => ({ src: file, sizes, type: "image/png" })),
        };
        this.emitFile({ type: "asset", fileName: "manifest.webmanifest", source: JSON.stringify(manifest) });
      },
    },
  ],
  build: {
    outDir: "../../crates/lattice-server/mobile-dist",
    emptyOutDir: true,
    target: "es2022",
    rolldownOptions: { output: { entryFileNames: "mobile.js", assetFileNames: "mobile[extname]" } },
  },
});
