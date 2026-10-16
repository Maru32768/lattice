import { defineConfig } from "vite";

// The page overlay is injected into remote pages by the in-app browser, so it is a single
// self-contained IIFE that src-tauri embeds with include_str!.
export default defineConfig({
  build: {
    lib: { entry: "src/overlay/index.ts", formats: ["iife"], name: "LatticeOverlay", fileName: () => "overlay.js" },
    outDir: "src-tauri/overlay-dist",
    emptyOutDir: true,
    target: "es2020",
  },
});
