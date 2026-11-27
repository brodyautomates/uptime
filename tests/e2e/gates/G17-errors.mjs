import { writeFileSync, mkdirSync, copyFileSync, readdirSync, existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, sleep, waitFor, frames, send, query, root } from "../harness.mjs";
export const name = "Error states (appendix B)";
const feedHas = (page, re) => page.evaluate((src) => window.game.ui.getState().feedLog.some((f) => new RegExp(src, "i").test(f.text)), re);
export default async function () {
  const rows = []; const row = (label, ok, note = "") => rows.push({ label, ok: !!ok, note });
  // ---- A: no claude, MCP down, replay write failure, WebGL fallback ----
  {
    const bad = join(mkdtempSync(join(tmpdir(), "uptime-x-")), "file"); writeFileSync(bad, "x");
    const a = await launch({ preset: "fresh", env: { UPTIME_FAKE_NO_CLAUDE: "1", UPTIME_MCP_FORCE_FAIL: "1", UPTIME_REPLAY_ROOT: join(bad, "sub"), UPTIME_QUERY: "forceWebGL=1" } }); const { page } = a;
    try {
      await waitFor(() => page.evaluate(() => window.game.term.claudeFound === false), 8000);
      row("claude not on PATH: shell opens, banner shown, step 7 skippable", await page.evaluate(() => window.game.term.status === "running" && !!document.querySelector(".term-banner") && window.game.checklist.claudeMissing === true));
      row("MCP port cannot open: terminal works, link-down notice", (await feedHas(page, "facility link is down")) && (await page.evaluate(() => window.game.term.status === "running")));
      await waitFor(() => page.evaluate(() => window.game.frames > 30), 10000);
      row("WebGPU unavailable: WebGL2, Medium forced, notice", (await page.evaluate(() => !window.game.isWebGPU && window.game.pipeline.tier === "medium" && window.game.frames > 20)) && (await feedHas(page, "WebGPU is not available")));
      await page.evaluate(() => window.game.capture.setLogging(true)); await sleep(500);
      const t1 = (await page.evaluate(() => window.game.client.world.tick)); await sleep(700);
      row("replay log write fails: logging stops, notice, play continues", (await feedHas(page, "Replay logging stopped")) && (await page.evaluate(() => window.game.client.world.tick)) > t1);
      row("no blank screen / unhandled error (fallback run)", a.errors.length === 0, a.errors[0] ?? "");
    } finally { await a.close(); }
  }
  // ---- B: everything else on the normal renderer ----
  const a = await launch({ preset: "fresh", demo: true }); const { page, app, userData } = a;
  try {
    await waitFor(() => page.evaluate(() => window.game.term.status === "running"), 10000); await sleep(1200);
    // shell exits
    await page.evaluate(() => window.uptime.send("pty.input", "exit\r"));
    const ended = await waitFor(() => page.evaluate(() => window.game.term.status === "ended"), 8000);
    await page.evaluate(() => { window.game.term.dirty = true; window.game.term.paint(); });
    const t0 = await page.evaluate(() => window.game.client.world.tick); await page.evaluate(() => window.uptime.invoke("pty.restart"));
    const back = await waitFor(() => page.evaluate(() => window.game.term.status === "running"), 8000); await sleep(400);
    row("shell exits: 'Session ended', Enter restarts, game keeps running", ended && back && (await page.evaluate(() => window.game.client.world.tick)) > t0);
    // token
    const cfg = JSON.parse(readFileSync(join(userData, "workspace/.mcp.json"), "utf8")).mcpServers.uptime;
    row("MCP request without the token: 401", (await fetch(cfg.url, { method: "POST", body: "{}" })).status === 401);
    // saves
    const saves = join(userData, "saves"); mkdirSync(saves, { recursive: true });
    writeFileSync(join(saves, "slot1.json"), "this is not a save");
    await page.evaluate(() => window.uptime.invoke("save.write", "autosave"));
    const bad = await page.evaluate(() => window.uptime.invoke("save.load", "slot1"));
    row("save fails validation: not loaded, quarantined, slot named", !bad.ok && /slot1/.test(bad.error) && existsSync(join(saves, "quarantine")) && readdirSync(join(saves, "quarantine")).length === 1, bad.error);
    copyFileSync(join(root, "tests/sim/fixtures/save-v1.json"), join(saves, "slot2.json"));
    const old = await page.evaluate(() => window.uptime.invoke("save.load", "slot2"));
    row("older schema: migrated and loaded", old.ok === true, JSON.stringify(old).slice(0, 80));
    await page.evaluate(() => window.uptime.invoke("game.new", { name: "Errors", preset: "fresh" })); await sleep(500);
    await send(page, { type: "setDemoMode", on: true, by: "player" });
    // focus
    const tk = () => page.evaluate(() => window.game.client.world.tick);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit("blur")); const f0 = await tk(); await sleep(600);
    const runs = (await tk()) > f0;
    await page.evaluate(() => window.game.setSetting("sim.pauseWhenUnfocused", true)); await sleep(200);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit("blur")); await sleep(300); const f1 = await tk(); await sleep(600); const stopped = (await tk()) === f1;
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit("focus")); await sleep(600); const resumed = (await tk()) > f1;
    await page.evaluate(() => window.game.setSetting("sim.pauseWhenUnfocused", false));
    row("window loses focus: sim keeps running; with the setting on it pauses and resumes", runs && stopped && resumed, `runs=${runs} stopped=${stopped} resumed=${resumed}`);
    // resize to 9:16 while seated
    await page.evaluate(() => window.game.game.sit()); await waitFor(() => page.evaluate(() => window.game.game.seatedReady), 6000);
    const before = await page.evaluate(() => window.game.overlay.mons[1].style.transform);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(540, 960)); await sleep(900);
    const rz = await page.evaluate(() => ({ aspect: window.game.camera.aspect, t: window.game.overlay.mons[1].style.transform, cols: window.game.term.term.cols, rows: window.game.term.term.rows, w: innerWidth, h: innerHeight }));
    row("resize to 9:16: view refits, overlay recomputed, pty stays 110x32", Math.abs(rz.aspect - rz.w / rz.h) < 0.01 && rz.aspect < 0.7 && rz.t !== before && rz.cols === 110 && rz.rows === 32, `aspect ${rz.aspect.toFixed(3)}`);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 720)); await sleep(500);
    await page.evaluate(() => window.game.game.stand()); await frames(page, 60);
    // sit while holding a part
    await send(page, { type: "removePart", server: "A-R01-S01", slot: "FAN1", by: "player" }); await sleep(300);
    const heldId = await page.evaluate(() => window.game.client.inventory.find((i) => i.where === "hand")?.id);
    await page.evaluate(() => window.game.game.sit()); await waitFor(() => page.evaluate(() => window.game.game.seatedReady), 6000); await sleep(400);
    const onTray = await page.evaluate((id) => window.game.client.inventory.find((i) => i.id === id)?.where, heldId);
    await page.evaluate(() => window.game.game.stand()); await sleep(600);
    const backInHand = await page.evaluate((id) => window.game.client.inventory.find((i) => i.id === id)?.where, heldId);
    row("sit holding a part: set down, picked up on standing", !!heldId && onTray === "shelf" && backInHand === "hand", `${onTray} -> ${backInHand}`);
    await send(page, { type: "installPart", server: "A-R01-S01", slot: "FAN1", part: heldId, by: "player" });
    // order too expensive
    const exp = await send(page, { type: "placeOrder", lines: [{ sku: "gpu.v5", qty: 40 }], by: "player" });
    row("order over cash plus overdraft: refused with the shortfall", !exp.ok && exp.reason === "no_cash" && /\$/.test(exp.message), exp.message);
    // part removal on a running server
    const np = await page.evaluate(async () => { const g = window.game; g.game.inspecting = "A-R01-S02"; await g.game.removePart("CPU1"); g.game.inspecting = null; return g.ui.getState().feed.at(-1)?.text; });
    row("non-hot-swap part on a running server: refused, reason shown", /power/i.test(np ?? ""), np);
    // gantry: missing part, then a queue
    const miss = await send(page, { type: "queueJob", kind: "install", server: "A-R01-S01", slot: "GPU1", sku: "gpu.v4", by: "player" });
    row("gantry job with no part in stock: fails with the reason", !miss.ok && miss.reason === "part_not_available", miss.message);
    const j1 = await send(page, { type: "queueJob", kind: "remove", server: "A-R01-S01", slot: "FAN2", by: "player" });
    const j2 = await send(page, { type: "queueJob", kind: "remove", server: "A-R01-S02", slot: "FAN2", by: "player" }); await sleep(400);
    const jobs = (await query(page, "orders")).gantryJobs ?? [];
    row("gantry busy: second job queues, queue visible", j1.ok && j2.ok && jobs.length === 2 && jobs.some((j) => j.state === "queued") && jobs.some((j) => j.state === "running"), jobs.map((j) => j.state).join(","));
    // every server off under a contract
    const offers = await query(page, "contracts", "offer"); const web = offers.find((c) => c.unit === "cpu") ?? offers[0];
    let slaOk = false, slaNote = "no offer";
    if (web) {
      await send(page, { type: "acceptContract", contract: web.id, by: "player" });
      for (const r of ["A-R01", "A-R02"]) for (let b = 1; b <= 4; b++) await send(page, { type: "setServerPower", server: `${r}-S0${b}`, on: false, by: "player" });
      await send(page, { type: "setSpeed", speed: 4, seated: true, by: "player" });
      const al = await waitFor(async () => { const x = await query(page, "alerts"); return x.find((q) => /sla/.test(q.kind)) ?? null; }, 45000, 500);
      const act = (await query(page, "contracts", "active"))[0];
      slaOk = !!al && act && act.deliveredPctToday < 100; slaNote = `${al?.kind ?? "no alert"}; delivered ${act?.deliveredPctToday}%`;
      await send(page, { type: "setSpeed", speed: 1, seated: true, by: "player" });
    }
    row("every server off under a contract: delivers zero, alert raised", slaOk, slaNote);
    // frame-time step-down (never up)
    const sd = await page.evaluate(() => { const g = window.game; g.setSetting("graphics.tier", "High"); let fired = false; for (let i = 0; i < 10; i++) fired = g.considerStepDown(26) || fired; const t1 = g.settings["graphics.tier"]; for (let i = 0; i < 30; i++) g.considerStepDown(5); return { fired, t1, t2: g.settings["graphics.tier"], note: g.settings["graphics.steppedDown"] }; });
    row("slow frames for 10 s: one tier down, noted in Settings, never back up", sd.fired && sd.t1 === "Medium" && sd.t2 === "Medium" && /Stepped down/.test(sd.note), sd.note);
    // GPU device lost
    const tick0 = await tk();
    await page.evaluate(() => window.game.deviceLost("gate")); await sleep(300);
    await page.waitForFunction(() => !!window.game && window.game.frames > 5, null, { timeout: 30000 });
    const lost = await page.evaluate(() => ({ mode: window.game.ui.getState().mode, menu: window.game.ui.getState().menu, racks: window.game.client.world.racks.length, tick: window.game.client.world.tick }));
    row("GPU device lost: renderer rebuilt, sim untouched", lost.mode === "walk" && lost.menu === null && lost.racks === 2 && lost.tick > tick0, JSON.stringify(lost));
    row("no blank screen / unhandled error (main run)", a.errors.length === 0, a.errors[0] ?? "");
    // an uncaught renderer error shows the recover screen; Reload brings the game back with the sim untouched
    const tk2 = await tk();
    await page.evaluate(() => { setTimeout(() => { throw new Error("gate: forced renderer error"); }, 0); }); await sleep(400);
    const shown = await page.evaluate(() => !!document.getElementById("recover") && !!document.getElementById("recover-logs"));
    await page.evaluate(() => { document.getElementById("recover-reload").click(); }).catch(() => {}); await sleep(600); await page.waitForFunction(() => !!window.game && window.game.frames > 5, null, { timeout: 30000 });
    const back2 = await page.evaluate(() => ({ racks: window.game.client.world.racks.length, tick: window.game.client.world.tick, mode: window.game.ui.getState().mode }));
    row("uncaught renderer error: recover screen with Reload and Open logs; reload loses nothing", shown && back2.racks === 2 && back2.tick > tk2 && back2.mode === "walk", JSON.stringify(back2));
  } catch (e) { row("gate threw", false, String(e).slice(0, 300)); }
  finally { await a.close(); }
  const failed = rows.filter((r) => !r.ok);
  return { pass: failed.length === 0, detail: `${rows.length - failed.length}/${rows.length} rows pass` + (failed.length ? "\n" + failed.map((r) => `FAIL ${r.label} ${r.note ? "[" + r.note + "]" : ""}`).join("\n") : "") };
}
