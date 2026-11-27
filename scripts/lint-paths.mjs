#!/usr/bin/env node
// Lint rule for gate G19: no unvalidated path into the simulation, the MCP tools, saves or the IPC boundary.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : []; });
const files = walk(join(root, "src")).map((p) => ({ p: relative(root, p), s: readFileSync(p, "utf8") }));
const problems = []; const bad = (rule, where, why) => problems.push(`${rule}: ${where}: ${why}`);
const src = (p) => files.find((f) => f.p === p)?.s ?? "";

// 1. The command bus is the only way to change state: applyCommand is called only inside the sim and by the sim host.
for (const f of files) if (/\bapplyCommand\s*\(/.test(f.s) && !f.p.startsWith("src/sim/") && f.p !== "src/main/simHost.ts") bad("command-bus", f.p, "calls applyCommand outside the sim host");
// 2. Every command is parsed by its zod schema before it is applied.
const cmds = src("src/sim/commands.ts");
if (!/CommandSchema\s*\.\s*safeParse\(|CommandSchema\s*\.\s*parse\(/.test(cmds)) bad("command-schema", "src/sim/commands.ts", "applyCommand does not parse its input with CommandSchema");
// 3. Nothing outside the sim writes simulation fields directly.
for (const f of files) { if (f.p.startsWith("src/sim/")) continue; const m = f.s.match(/\bstate\.(cash|reputation|racks|servers|parts|contracts|orders|jobs|alerts|halls|powerCapKw|coolingCapKw)\b[^=\n;]*[^=!<>]=[^=]/); if (m) bad("no-direct-writes", f.p, `writes sim state directly: "${m[0].trim().slice(0, 60)}"`); }
// 4. Every MCP tool is registered with an input schema, and the registry matches the published list.
const tools = src("src/main/mcp/tools.ts");
const names = [...tools.matchAll(/\b(?:read|write)\(\s*"([a-z_]+)"/g), ...tools.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
const listed = (tools.match(/TOOL_NAMES = \[([^\]]+)\]/)?.[1] ?? "").match(/[a-z_]+/g) ?? [];
for (const n of listed) if (!names.includes(n)) bad("tool-registry", "src/main/mcp/tools.ts", `tool ${n} is listed but not registered`);
for (const n of names) if (!listed.includes(n)) bad("tool-registry", "src/main/mcp/tools.ts", `tool ${n} is registered but not listed`);
if ((tools.match(/registerTool\(/g) ?? []).length !== (tools.match(/inputSchema/g) ?? []).length) bad("tool-schema", "src/main/mcp/tools.ts", "a registerTool call has no inputSchema");
if (/registerTool\(/.test(files.filter((f) => f.p !== "src/main/mcp/tools.ts").map((f) => f.s).join("\n"))) bad("tool-registry", "src", "a tool is registered outside the registry file");
// 5. Saves and the balance file only enter through their validators.
for (const f of files) { if (f.p.startsWith("src/sim/")) continue; if (/JSON\.parse\([^)]*(save|slot|state0|balance)/i.test(f.s) && !/deserialize|unpackSave|parseBalance/.test(f.s)) bad("save-validation", f.p, "parses a save or balance file without its validator"); }
if (!/parseBalance\(balanceJson\)/.test(src("src/main/simHost.ts"))) bad("balance-validation", "src/main/simHost.ts", "balance.json is not validated at boot");
if (!/StateSchema|\.parse\(|safeParse\(/.test(src("src/sim/save.ts"))) bad("save-validation", "src/sim/save.ts", "deserialize does not validate");
if (!/ReplayMeta\.parse\(/.test(src("src/main/simHost.ts")) || !/ReplayCmd\.parse\(/.test(src("src/main/simHost.ts"))) bad("replay-validation", "src/main/simHost.ts", "a replay log is loaded without its schemas");
// 6. The IPC allowlist in the preload matches what the main process serves, in both directions.
const pre = src("src/preload/index.ts"); const set = (name) => new Set((pre.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]+)\\]`, "s"))?.[1] ?? "").match(/"[^"]+"/g)?.map((x) => x.slice(1, -1)) ?? []);
const INVOKE = set("INVOKE"), SEND = set("SEND"), ON = set("ON");
const mainSrc = files.filter((f) => f.p.startsWith("src/main/")).map((f) => f.s).join("\n");
const handled = new Set([...mainSrc.matchAll(/ipcMain\.handle\(\s*"([^"]+)"/g)].map((m) => m[1])), listened = new Set([...mainSrc.matchAll(/ipcMain\.on\(\s*"([^"]+)"/g)].map((m) => m[1]));
const sent = new Set([...mainSrc.matchAll(/(?:\.send|this\.send|webContents\.send)\(\s*"([^"]+)"/g)].map((m) => m[1]));
for (const c of INVOKE) if (!handled.has(c)) bad("ipc-allowlist", "src/preload/index.ts", `invoke channel ${c} has no handler`);
for (const c of handled) if (!INVOKE.has(c)) bad("ipc-allowlist", "src/main", `handler ${c} is not on the preload allowlist`);
for (const c of SEND) if (!listened.has(c)) bad("ipc-allowlist", "src/preload/index.ts", `send channel ${c} has no listener`);
for (const c of listened) if (!SEND.has(c)) bad("ipc-allowlist", "src/main", `listener ${c} is not on the preload allowlist`);
for (const c of sent) if (!ON.has(c)) bad("ipc-allowlist", "src/main", `main sends ${c}, which the preload does not allow`);
// 7. The renderer has no Node access.
if (!/contextIsolation: true/.test(mainSrc) || !/nodeIntegration: false/.test(mainSrc) || !/sandbox: true/.test(mainSrc)) bad("renderer-sandbox", "src/main/index.ts", "the window is not sandboxed with context isolation");
for (const f of files) if (f.p.startsWith("src/renderer/") && /from "(node:|electron|fs|child_process)/.test(f.s)) bad("renderer-sandbox", f.p, "imports a Node or Electron module");

console.log(problems.length ? problems.join("\n") : `lint-paths: ${files.length} files, 7 rules, no problems (${names.length} tools, ${INVOKE.size + SEND.size + ON.size} IPC channels)`);
process.exit(problems.length ? 1 : 0);
