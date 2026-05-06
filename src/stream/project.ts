import * as fs from "node:fs";
import * as path from "node:path";

let projectContextCache: { cwd: string; result: string } | null = null;

export function invalidateProjectContextCache(): void {
  projectContextCache = null;
}

export function buildProjectContextSnippet(cwd: string): string {
  if (projectContextCache && projectContextCache.cwd === cwd) {
    return projectContextCache.result;
  }
  const parts: string[] = ["## Project context (auto-injected for legacy models with no tools)"];
  try {
    const entries = walkDir(cwd, 2, 80);
    if (entries.length > 0) {
      parts.push("Directory structure:");
      parts.push("```");
      parts.push(entries.join("\n"));
      parts.push("```");
    }
  } catch { /* best effort */ }
  parts.push("");
  parts.push("NOTE: You do NOT have tool access in this mode. You cannot read files or run commands.");
  parts.push("If you need file contents, say so and the user can re-run with a model that has tools.");
  const result = parts.join("\n");
  projectContextCache = { cwd, result };
  return result;
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", "__pycache__", ".next", ".turbo", "dist", "build", ".cache"]);

function walkDir(root: string, maxDepth: number, maxEntries: number): string[] {
  const results: string[] = [];
  let count = 0;

  function walk(dir: string, depth: number, prefix: string) {
    if (depth > maxDepth || count >= maxEntries) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count >= maxEntries) break;
      const name = entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        results.push(`${prefix}${name}/`);
        count++;
        walk(path.join(dir, name), depth + 1, `${prefix}${name}/`);
      } else {
        results.push(`${prefix}${name}`);
        count++;
      }
    }
  }

  walk(root, 0, "");
  return results;
}
