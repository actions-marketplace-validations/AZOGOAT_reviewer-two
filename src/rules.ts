import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as core from "@actions/core";
import picomatch from "picomatch";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export interface RuleFile {
  name: string;
  content: string;
}

export interface LoadedRules {
  description?: string;
  ruleFiles: RuleFile[];
  source: "manifest" | "fallback";
}

const manifestSchema = z.object({
  context: z.string().optional(),
  always: z.array(z.string()).default([]),
  rules: z
    .array(z.object({ file: z.string(), paths: z.array(z.string()) }))
    .default([]),
});

const FALLBACK_FILES = [
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
];

/** Reads a file if it exists and is a regular file, otherwise undefined. */
function readIfExists(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const stats = statSync(path);
  return stats.isFile() ? readFileSync(path, "utf8") : undefined;
}

/**
 * Loads review rules for a PR. Manifest mode reads .github/ai-review/manifest.yml
 * and includes only rule files whose globs match a changed path; fallback mode
 * auto-detects conventional context files.
 */
export function loadRules(
  repoRoot: string,
  changedPaths: string[],
): LoadedRules {
  const configDir = join(repoRoot, ".github", "ai-review");
  const manifestPath = join(configDir, "manifest.yml");
  if (existsSync(manifestPath)) {
    try {
      return loadFromManifest(configDir, manifestPath, changedPaths);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      core.warning(
        `Invalid .github/ai-review/manifest.yml, falling back to zero-config: ${msg}`,
      );
      return loadFallback(repoRoot);
    }
  }
  return loadFallback(repoRoot);
}

function loadFromManifest(
  configDir: string,
  manifestPath: string,
  changedPaths: string[],
): LoadedRules {
  const manifest = manifestSchema.parse(
    parseYaml(readFileSync(manifestPath, "utf8")) ?? {},
  );
  const ruleFiles: RuleFile[] = [];
  const add = (name: string) => {
    const content = readIfExists(join(configDir, name));
    if (content !== undefined) ruleFiles.push({ name, content });
  };
  for (const name of manifest.always) add(name);
  for (const rule of manifest.rules) {
    const matches = picomatch(rule.paths, { dot: true });
    if (changedPaths.some((p) => matches(p))) add(rule.file);
  }
  const description = manifest.context
    ? readIfExists(join(configDir, manifest.context))
    : undefined;
  return { description, ruleFiles, source: "manifest" };
}

function loadFallback(repoRoot: string): LoadedRules {
  const ruleFiles: RuleFile[] = [];
  for (const name of FALLBACK_FILES) {
    const content = readIfExists(join(repoRoot, name));
    if (content !== undefined) ruleFiles.push({ name, content });
  }
  const cursorRules = join(repoRoot, ".cursor", "rules");
  if (existsSync(cursorRules)) {
    if (statSync(cursorRules).isDirectory()) {
      for (const entry of readdirSync(cursorRules)) {
        const content = readIfExists(join(cursorRules, entry));
        if (content !== undefined)
          ruleFiles.push({ name: `.cursor/rules/${entry}`, content });
      }
    } else {
      ruleFiles.push({
        name: ".cursor/rules",
        content: readFileSync(cursorRules, "utf8"),
      });
    }
  }
  return { ruleFiles, source: "fallback" };
}
