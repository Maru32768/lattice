import { defineConfig } from "oxlint";

export default defineConfig({
  env: { browser: true },
  categories: { correctness: "error", suspicious: "error" },
  options: { typeAware: true },
  plugins: ["typescript", "react", "promise", "unicorn", "import"],
  ignorePatterns: ["dist/**", "src-tauri/**", "test-results/**", "playwright-report/**"],
  rules: {
    "react/rules-of-hooks": "error",
    "react/exhaustive-deps": "error",
    // An IPC call that rejects with nobody listening loses the error the UI should show.
    "typescript/no-floating-promises": "error",
    "typescript/no-misused-promises": ["error", { checksVoidReturn: { attributes: false } }],
    "typescript/await-thenable": "error",
    "typescript/no-unsafe-argument": "error",
    "typescript/no-unsafe-assignment": "error",
    "typescript/no-unsafe-call": "error",
    "typescript/no-unsafe-member-access": "error",
    "typescript/no-unsafe-return": "error",
    "typescript/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: true }],

    // The new JSX transform needs no React in scope; CSS and font imports are side effects.
    "react/react-in-jsx-scope": "off",
    "import/no-unassigned-import": "off",
    // React Compiler rules; the app does not use the compiler, and exhaustive-deps covers effects.
    "react/exhaustive-effect-dependencies": "off",
    "react/set-state-in-effect": "off",
    "react/refs": "off",
    "react/immutability": "off",
    // DOM narrowing (`e.target as HTMLElement`) and effects that return a cleanup only sometimes are the norm here.
    "typescript/no-unsafe-type-assertion": "off",
    "typescript/consistent-return": "off",
    // Every sort is on a fresh array; spreading a string for code points is intended.
    "unicorn/no-array-sort": "off",
    "typescript/no-misused-spread": "off",
    // Style, not bugs.
    "eslint/no-shadow": "off",
    "eslint/no-underscore-dangle": "off",
    "promise/always-return": "off",
    "unicorn/consistent-function-scoping": "off",
  },
  overrides: [
    {
      // node:test tracks the promise test() returns.
      files: ["src/**/*.test.ts", "e2e/*.test.ts"],
      rules: { "typescript/no-floating-promises": "off" },
    },
  ],
});
