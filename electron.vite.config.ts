import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const alias = { "@sim": resolve(__dirname, "src/sim"), "@shared": resolve(__dirname, "src/shared") };

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: { rollupOptions: { input: { index: resolve(__dirname, "src/main/index.ts") } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve(__dirname, "src/preload/index.ts") }, output: { format: "cjs", entryFileNames: "[name].cjs" } } },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    resolve: { alias },
    plugins: [react()],
    build: { target: "esnext", rollupOptions: { input: { index: resolve(__dirname, "src/renderer/index.html") } } },
  },
});
