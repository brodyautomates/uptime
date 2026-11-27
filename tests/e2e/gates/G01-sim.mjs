import { spawnSync } from "node:child_process";
import { root } from "../harness.mjs";
export const name = "Sim suite: determinism, invariants, balance, saves, scale, schemas (G1-G4, G18, G19)";
export default async function () {
  const r = spawnSync("npx", ["vitest", "run", "--reporter=dot"], { cwd: root, encoding: "utf8", timeout: 300000 });
  const out = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "");
  const files = /Test Files\s+(.*)/.exec(out)?.[1] ?? "", tests = /Tests\s+(.*)/.exec(out)?.[1] ?? "";
  return { pass: r.status === 0, detail: `files: ${files.trim()}; tests: ${tests.trim()}` };
}
