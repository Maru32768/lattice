// Fails when React Compiler leaves a function of src/ uncompiled. The compiler skips what it cannot
// handle (try/finally, a ternary inside try, ++ on a captured variable, …) without a warning, and the
// skipped component silently loses its memoization. Run by `npm run lint`.
import { globSync, readFileSync } from "node:fs";
import { transformSync } from "@babel/core";

const files = globSync("src/**/*.{ts,tsx}").filter((f) => !f.endsWith(".test.ts") && !f.includes("overlay"));
const skipped = [];
let compiled = 0;
for (const file of files) {
  const logger = {
    logEvent(_filename, e) {
      if (e.kind === "CompileSuccess") {
        compiled++;
      } else if (e.kind === "CompileError" || e.kind === "PipelineError") {
        const reason = e.detail?.reason ?? e.detail?.options?.reason ?? e.data ?? "";
        skipped.push(`${file}:${e.fnLoc?.start?.line ?? "?"} ${reason}`);
      }
    },
  };
  transformSync(readFileSync(file, "utf8"), {
    filename: file,
    babelrc: false,
    configFile: false,
    code: false,
    parserOpts: { plugins: file.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"] },
    plugins: [["babel-plugin-react-compiler", { logger, panicThreshold: "none" }]],
  });
}
if (skipped.length) {
  console.error(`React Compiler skipped ${skipped.length} function(s):\n${skipped.join("\n")}`);
  process.exit(1);
}
console.log(`React Compiler: ${compiled} functions compiled, none skipped`);
