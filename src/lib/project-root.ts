import fs from "node:fs";
import path from "node:path";

/**
 * Resolves the repository root regardless of whether code runs from `src/` or `dist-server/src/`.
 */
export function resolveProjectRoot(fromDir: string): string {
  let cur = path.resolve(fromDir);
  while (true) {
    if (path.basename(cur) === "dist-server") return path.dirname(cur);
    if (fs.existsSync(path.join(cur, "package.json"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(fromDir);
    cur = parent;
  }
}
