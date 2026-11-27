#!/usr/bin/env node
// Gate runner (SPEC section 17). usage: node scripts/gates.mjs [G5 G8 ...]   Writes gates-report.md.
import { readdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { root } from "../tests/e2e/harness.mjs";

const want = process.argv.slice(2).filter((a) => /^G\d+$/.test(a));
const dir = join(root, "tests/e2e/gates");
const files = readdirSync(dir).filter((f) => /^G\d+.*\.mjs$/.test(f)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
const results = [];
for (const f of files) {
  const id = "G" + Number(f.match(/^G(\d+)/)[1]); if (want.length && !want.includes(id)) continue;
  const mod = await import(pathToFileURL(join(dir, f)).href);
  const t0 = Date.now(); let res;
  try { res = await mod.default(); } catch (e) { res = { pass: false, detail: `threw: ${e?.stack ?? e}` }; }
  results.push({ id, name: mod.name ?? f, ...res, s: ((Date.now() - t0) / 1000).toFixed(1) });
  console.log(`${res.pass ? "PASS" : "FAIL"}  ${id}  ${mod.name ?? ""}  (${results.at(-1).s}s)\n      ${String(res.detail).split("\n").join("\n      ")}`);
}
const prev = existsSync(join(root, "gates-report.md")) && want.length ? readFileSync(join(root, "gates-report.md"), "utf8") : "";
const keep = new Map(); for (const m of prev.matchAll(/^\| (G\d+) \|.*$/gm)) keep.set(m[1], m[0]);
for (const r of results) keep.set(r.id, `| ${r.id} | ${r.name} | ${r.pass ? "PASS" : "FAIL"} | ${String(r.detail).replace(/\n/g, "; ").replace(/\|/g, "/").slice(0, 400)} |`);
const rows = [...keep.entries()].sort((a, b) => Number(a[0].slice(1)) - Number(b[0].slice(1))).map((x) => x[1]);
writeFileSync(join(root, "gates-report.md"), `# Gates report\n\n${new Date().toISOString()}\n\n| Gate | Check | Result | Detail |\n|---|---|---|---|\n${rows.join("\n")}\n`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
