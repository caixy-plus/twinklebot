import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  publicDir: false,
  base: "./",
  build: {
    outDir: path.resolve(ROOT_DIR, "public/dist"),
    emptyOutDir: true,
    target: "es2023",
    sourcemap: false,
    minify: true,
    rollupOptions: {
      preserveEntrySignatures: "exports-only",
      external: [
        "/skills-catalog.js",
        "/accounts-store.js",
        /^\/shared\//,
      ],
      input: {
        app: path.resolve(ROOT_DIR, "src/web/main.tsx"),
        "preview-utils": path.resolve(ROOT_DIR, "src/web/preview-utils.ts"),
        "markdown-utils": path.resolve(ROOT_DIR, "src/web/markdown-utils.ts"),
        avatars: path.resolve(ROOT_DIR, "src/web/avatars.ts"),
        "mobile-bridge": path.resolve(ROOT_DIR, "src/web/mobile-bridge.ts"),
        "mobile-ui": path.resolve(ROOT_DIR, "src/web/mobile-ui.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
        manualChunks(id) {
          if (id.includes("node_modules")) {
            return "vendor-react";
          }
          return undefined;
        },
      },
    },
  },
});
