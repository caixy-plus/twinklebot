import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  publicDir: false,
  resolve: {
    alias: [
      {
        find: "/skills-catalog.js",
        replacement: path.resolve(__dirname, "src/shared/skills-catalog.ts"),
      },
      {
        find: "/accounts-store.js",
        replacement: path.resolve(__dirname, "src/shared/accounts-store.ts"),
      },
      {
        find: /^\/shared\/(.+)\.js$/,
        replacement: `${path.resolve(__dirname, "src/shared")}/$1.ts`,
      },
    ],
  },
  ssr: {
    noExternal: true,
  },
  build: {
    ssr: path.resolve(__dirname, "src/web/ssr-entry.tsx"),
    outDir: path.resolve(__dirname, "dist-server/web-ssr"),
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      output: {
        format: "es",
        entryFileNames: "ssr-entry.js",
      },
    },
  },
});
