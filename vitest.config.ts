import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
export default defineConfig({
  resolve: { alias: { "@sim": resolve(__dirname, "src/sim"), "@shared": resolve(__dirname, "src/shared") } },
  test: { include: ["tests/sim/**/*.test.ts"], testTimeout: 60000 },
});
