import { defineConfig, mergeConfig } from "vite";
import app from "../vite.config.ts";

// The app's own config, served from e2e/ (index.html loads the mocks first) on a port of its own.
export default defineConfig((env) =>
  mergeConfig(app(env), { root: "e2e", publicDir: "../public", server: { port: 1430, strictPort: true, warmup: { clientFiles: ["./setup.ts", "../src/main.tsx"] } } }));
