import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

// The decoders pdf.js fetches at run time, for JPEG 2000 and JBIG2 images and ICC colors.
const WASM = ["openjpeg.wasm", "jbig2.wasm", "qcms_bg.wasm"];

// The Page view's PDF viewer: src-tauri embeds these files and serves them to the page webview,
// which holds only the overlay's commands. pdf.js runs a PDF's untrusted data there, not in the app UI.
export default defineConfig({
  publicDir: false,
  plugins: [
    {
      name: "pdfjs-wasm",
      generateBundle() {
        for (const fileName of WASM) {
          this.emitFile({ type: "asset", fileName, source: readFileSync(`node_modules/pdfjs-dist/wasm/${fileName}`) });
        }
      },
    },
  ],
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
