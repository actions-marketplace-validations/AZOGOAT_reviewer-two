import { defineConfig } from "tsup";

// Action runtime expects dist/main.mjs; tsup's default esm extension is
// .js when package.json already says "type": "module", so force .mjs here.
export default defineConfig({
  entry: ["src/main.ts"],
  format: "esm",
  target: "node20",
  platform: "node",
  outDir: "dist",
  outExtension: () => ({ js: ".mjs" }),
  splitting: false,
  noExternal: [/.*/],
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});
