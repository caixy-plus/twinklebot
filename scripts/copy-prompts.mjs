import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = path.join(ROOT, "src", "agent", "prompts");
const OUT_DIR = path.join(ROOT, "dist-server", "src", "agent", "prompts");

if (fs.existsSync(SRC_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const entry of fs.readdirSync(SRC_DIR)) {
    if (!entry.endsWith(".md")) continue;
    fs.copyFileSync(path.join(SRC_DIR, entry), path.join(OUT_DIR, entry));
  }
}
