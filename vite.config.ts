import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    // Every Tauri webview reads woff2; dropping fontsource's woff fallbacks halves the bundled fonts.
    {
      name: "woff2-only",
      enforce: "pre" as const,
      transform: (code: string, id: string) => (/@fontsource.*\.css$/.test(id) ? code.replace(/,\s*url\([^)]+\.woff\) format\('woff'\)/g, "") : undefined),
    },
  ],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`, the Rust workspace build output and agent worktrees
      ignored: ["**/src-tauri/**", "**/target/**", "**/crates/**", "**/.claude/**"],
    },
  },
}));
