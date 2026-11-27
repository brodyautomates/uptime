// Shared helpers for the gate runner: launch the built app with an isolated profile and drive it through window.game.
import { _electron as electron } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** With UPTIME_GATES_PACKAGED=1 every gate drives the packaged app in dist/ instead of the dev build. */
const PACKAGED = process.env.UPTIME_GATES_PACKAGED ? resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/mac-arm64/UPTIME.app/Contents/MacOS/UPTIME") : null;
export async function launch(opts = {}) {
  if (PACKAGED && !opts.executablePath) opts = { ...opts, executablePath: PACKAGED };
  const userData = opts.userData ?? mkdtempSync(join(tmpdir(), "uptime-test-"));
  const env = { ...process.env, UPTIME_TEST: "1", UPTIME_USERDATA: userData, UPTIME_W: String(opts.w ?? 1280), UPTIME_H: String(opts.h ?? 720), ...(opts.preset ? { UPTIME_PRESET: opts.preset } : {}), ...(opts.demo ? { UPTIME_DEMO: "1" } : {}), ...(opts.env ?? {}) };
  if (opts.noTest) delete env.UPTIME_TEST;
  const t0 = Date.now();
  const app = await electron.launch({ args: opts.executablePath ? [] : [opts.appPath ?? "."], cwd: opts.executablePath ? tmpdir() : root, env, executablePath: opts.executablePath });
  const page = await app.firstWindow();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.waitForFunction(() => !!window.game && window.game.frames > 5, null, { timeout: 30000 });
  return { app, page, userData, errors, bootMs: Date.now() - t0, close: async () => { try { await app.close(); } catch {} } };
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const frames = (page, n) => page.evaluate((n) => window.game.wait(n), n);
export const send = (page, cmd) => page.evaluate((c) => window.game.client.send(c), cmd);
export const query = (page, view, ...args) => page.evaluate(([v, a]) => window.game.client.query(v, ...a), [view, args]);
export const world = (page) => page.evaluate(() => { const w = window.game.client.world; return { tick: w.tick, cash: w.cash, speed: w.speed, racks: w.racks.length, halls: w.halls, alertCount: w.alertCount, incomePerHour: w.incomePerHour, time: w.time }; });
export async function waitFor(fn, ms = 15000, step = 100) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); } }
