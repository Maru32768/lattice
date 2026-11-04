import { defineConfig } from "vite";

// The Page view's PDF viewer: src-tauri embeds these two files and serves them to the page webview,
// which holds only the overlay's commands. pdf.js runs a PDF's untrusted data there, not in the app UI.
export default defineConfig({
  publicDir: false,
  build: {
    lib: {
      entry: { viewer: "src/pdfview/index.ts", "pdf.worker": "node_modules/pdfjs-dist/build/pdf.worker.min.mjs" },
      formats: ["es"],
      fileName: (_, name) => `${name}.js`,
    },
    outDir: "src-tauri/pdfview-dist",
    emptyOutDir: true,
    target: "es2022",
  },
});
