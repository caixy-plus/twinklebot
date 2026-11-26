import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function copyMarkdownAssets(srcDir, outDir) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(outDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir)) {
    if (!entry.endsWith(".md")) continue;
    fs.copyFileSync(path.join(srcDir, entry), path.join(outDir, entry));
  }
}

copyMarkdownAssets(
  path.join(ROOT, "src", "agent", "prompts"),
  path.join(ROOT, "dist-server", "src", "agent", "prompts")
);
copyMarkdownAssets(
  path.join(ROOT, "src", "agent", "knowledge"),
  path.join(ROOT, "dist-server", "src", "agent", "knowledge")
);
