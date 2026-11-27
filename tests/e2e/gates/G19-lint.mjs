import { spawnSync } from "node:child_process";
import { root } from "../harness.mjs";
export const name = "Lint: no unvalidated path into the sim, MCP tools, saves or IPC";
export default async function () {
  const r = spawnSync("node", ["scripts/lint-paths.mjs"], { cwd: root, encoding: "utf8" });
  return { pass: r.status === 0, detail: (r.stdout + r.stderr).trim().slice(0, 600) };
}
