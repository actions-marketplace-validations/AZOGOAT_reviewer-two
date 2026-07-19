import { defineConfig } from "tsup";

// Action runtime expects dist/main.mjs; tsup's default esm extension is
// .js when package.json already says "type": "module", so force .mjs here.
export default defineConfig({
  entry: ["src/main.ts"],
  format: "esm",
  target: "node20",
  outDir: "dist",
  outExtension: () => ({ js: ".mjs" }),
});
