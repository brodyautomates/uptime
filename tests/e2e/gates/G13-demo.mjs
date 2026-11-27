import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, sleep, waitFor, frames, send, query, root } from "../harness.mjs";
export const name = "The 75-second demo run: director keys and a live Claude session, every beat inside its window";
const TOL = 2;
export default async function () {
  const a = await launch({ preset: "demo", demo: true, env: { UPTIME_SHOW: "1" } }); const { page } = a;
  await waitFor(() => page.evaluate(() => window.game.term.status === "running"), 10000); await sleep(1500);
  const replayDir = await page.evaluate(() => window.game.capture.setLogging(true));       // the whole run is logged so it can be re-rendered (SPEC section 20)
  const T0 = Date.now(); const at = () => (Date.now() - T0) / 1000; const beats = [];
  const beat = (n, win, began, doneAt, ok, note) => beats.push({ n, win, began, doneAt, ok: !!ok, inWin: began >= win[0] - TOL && began <= win[1] + TOL && doneAt <= win[1] + TOL, note });
  const holdUntil = async (s) => { const d = s - at(); if (d > 0) await sleep(d * 1000); };
  try {
    // 0-8 s: walk into Hall A
    let b0 = at();
    await page.evaluate(async () => { const p = window.game.player; p.setPose(0.6, 4.2, -Math.PI / 2, -0.02); p.keys.add("KeyW"); await new Promise((r) => setTimeout(r, 1700)); p.keys.delete("KeyW"); });
    beat(1, [0, 8], b0, at(), await page.evaluate(() => window.game.player.pos.x > 3), "walked the cold aisle");
    // 8-20 s: a rack goes amber then red; alarm; income drops
    await page.evaluate(() => window.game.player.setPose(4.5, 4.35, 0, -0.35)); await frames(page, 10);
    const income0 = (await query(page, "overview")).incomePerHour;
    await holdUntil(8); b0 = at(); await page.keyboard.press("Shift+F2"); await sleep(150); await page.keyboard.press("F1");
    const hot = await waitFor(async () => { const r = await query(page, "rack", "A-R01"); return r.servers.some((s) => s.power === "shutdown_thermal") || r.maxTempC > 85; }, 11000, 200);
    const alarm = await waitFor(async () => (await query(page, "alerts")).some((x) => x.kind === "thermal"), 3000, 200);
    const income1 = (await query(page, "overview")).incomePerHour;
    beat(2, [8, 20], b0, at(), hot && alarm && income1 < income0, `A-R01 overheated ${(at() - b0).toFixed(1)} s after F1, alarm ${!!alarm}, income ${Math.round(income0)} -> ${Math.round(income1)}`);
    // 20-32 s: open the rack, pull the server, exploded view, the failed fan shows red
    const fanAlert = await waitFor(async () => (await query(page, "alerts")).find((q) => /part_(degraded|failed)/.test(q.kind) && String(q.target).startsWith("A-R01") && /fan/i.test(q.text)), 9000, 200);
    const victim = String(fanAlert?.target ?? "A-R01-S03").slice(0, 9);
    await holdUntil(20); b0 = at();
    await page.keyboard.press("e"); await frames(page, 40);
    await page.evaluate((id) => window.game.game.openInspect(id), victim);
    await waitFor(() => page.evaluate(() => !!window.game.ui.getState().inspect?.server?.slots), 5000); await frames(page, 65);
    await page.keyboard.press("x"); await frames(page, 45);
    const seen = await waitFor(() => page.evaluate(() => { const st = window.game.ui.getState(); const e = Object.entries(st.inspect?.server?.slots ?? {}).find(([k, p]) => p && p.status === "failed"); return st.inspect?.exploded && e ? { slot: e[0], name: e[1].name, labels: st.labels.length } : null; }), 9000, 200);
    beat(3, [20, 32], b0, at(), seen && seen.slot.startsWith("FAN"), `pulled ${victim}, exploded view, failed part shown red: ${seen ? seen.name + " in " + seen.slot : "none"}`);
    await page.keyboard.press("q"); await waitFor(() => page.evaluate(() => window.game.game.inspecting === null), 5000);
    // 32-52 s: sit, type claude, ask it to fix the rack and add GPU capacity; tool calls land
    await holdUntil(32); b0 = at();
    await page.evaluate(() => window.game.game.sit()); await waitFor(() => page.evaluate(() => window.game.game.seatedReady), 5000);
    await page.keyboard.press("Meta+2"); await frames(page, 15);
    const n0 = await page.evaluate(() => window.game.ui.getState().feedLog.filter((f) => f.kind === "claude").length);
    const slot = seen?.slot ?? "FAN1";
    const tools = ["install_part", "shop_order"].map((t) => "mcp__uptime__" + t).join(",");
    const cmdline = `claude -p 'Fix rack A-R01 and add GPU capacity. Call install_part with server ${victim}, slot ${slot}, sku fan.z2 to swap the failed fan. Call shop_order with 2 of gpu.v2 and express true. Make both calls at once, then reply done.' --mcp-config .mcp.json --strict-mcp-config --allowedTools ${tools} --model haiku`;
    await page.keyboard.type("claude", { delay: 20 }); await page.evaluate((rest) => window.game.term.term.paste(rest), cmdline.slice(6)); await page.keyboard.press("Enter");
    const sent = at();
    const acted = await waitFor(() => page.evaluate((n) => { const f = window.game.ui.getState().feedLog.filter((x) => x.kind === "claude").slice(n).map((x) => x.text); return f.some((t) => /gantry_job/.test(t) && !/refused/.test(t)) && f.some((t) => /shop_order/.test(t) && !/refused/.test(t)); }, n0), 19000, 150);
    const actedAt = at();
    const calls = await page.evaluate((n) => window.game.ui.getState().feedLog.filter((f) => f.kind === "claude").slice(n).map((f) => f.text.replace("Claude · ", "")), n0);
    beat(4, [32, 52], b0, actedAt, acted, `prompt sent at ${sent.toFixed(1)} s; Claude's fan swap and GPU order had both landed by ${actedAt.toFixed(1)} s (${calls.join(", ")})`);
    // 52-64 s: stand and walk out; the gantry is swapping the fan; cyan rings; the rack returns to green
    await holdUntil(52); b0 = at();
    const incLow = (await query(page, "overview")).incomePerHour;
    await page.keyboard.press("Meta+e"); await frames(page, 45);
    await page.evaluate(() => window.game.player.setPose(2.6, 4.2, -Math.PI / 2, -0.04));
    const gantry = await page.evaluate(() => { const g = window.game; const j = (g.client.extra.jobs ?? []).find((x) => x.state === "running" || x.state === "queued"); return { job: j ? `${j.kind} ${j.server} ${j.slot} (${j.state})` : null }; });
    const done = await waitFor(async () => { const s = await query(page, "server", victim); const f = s.slots.find((x) => x.slot === slot); return f.part && f.part.sku === "fan.z2" && f.part.status === "ok"; }, 14000, 200);
    const fanAt = at();
    const green = await waitFor(async () => { const r = await query(page, "rack", "A-R01"); return r.worstStatus === "ok" && r.servers.every((s) => s.power === "on" || s.power === "booting") ? r : null; }, Math.max(500, (66 - at()) * 1000), 200);
    beat(5, [52, 64], b0, at(), done && green, `gantry seen working: ${gantry.job ?? "already finished"}; new fan seated at ${fanAt.toFixed(1)} s; rack A-R01 back to green at ${at().toFixed(1)} s`);
    // 64-75 s: the delivery arrives, Hall B's wall opens, lights strike on, income climbs
    await holdUntil(64); b0 = at();
    const buy = await send(page, { type: "buyUpgrade", kind: "hall", target: "B", by: "player" });
    const opened = await waitFor(() => page.evaluate(() => window.game.client.world.halls.B.owned && !!window.game.shell.areaSlots.B.length), 4000);
    const delivered = await waitFor(() => page.evaluate(() => window.game.client.extra.orders.some((o) => o.state === "delivered") || window.game.client.inventory.filter((i) => i.sku === "gpu.v2").length >= 4), Math.max(500, (75 - at()) * 1000), 200);
    const delAt = at();
    await holdUntil(74.5);
    const inc1 = (await query(page, "overview")).incomePerHour;
    beat(6, [64, 75], b0, Math.max(delAt, 74.5), buy.ok && opened && delivered && inc1 > incLow, `Hall B bought and opened: ${buy.ok && !!opened}; Claude's GPU delivery in the bay at ${delAt.toFixed(1)} s: ${!!delivered}; income climbed from ${Math.round(incLow)} per hour with the rack down (52 s) to ${Math.round(inc1)}`);
    const total = at();
    await page.evaluate(() => window.game.capture.setLogging(false)); if (replayDir) writeFileSync(join(root, "tests/visual/last-demo-replay.txt"), String(replayDir));
    const pass = beats.length === 6 && beats.every((b) => b.ok && b.inWin) && a.errors.length === 0;
    return { pass, detail: beats.map((b) => `${b.ok && b.inWin ? "ok  " : "FAIL"} beat ${b.n} [${b.win.join("-")} s] ${b.began.toFixed(1)} to ${b.doneAt.toFixed(1)} s${b.inWin ? "" : " OUTSIDE ITS WINDOW"}: ${b.note}`).join("\n") + `\nterminal: ${(await page.evaluate(() => window.game.term.text().split("\n").filter((l) => l.trim()).slice(-4).join(" | "))).slice(0, 300)}\nrun length ${total.toFixed(1)} s; console errors ${a.errors.length}${a.errors[0] ? " " + a.errors[0].slice(0, 160) : ""}` };
  } catch (e) { return { pass: false, detail: beats.map((b) => `${b.ok ? "ok" : "FAIL"} beat ${b.n}: ${b.note}`).join("\n") + `\nthrew at ${at().toFixed(0)} s: ${String(e).slice(0, 300)}` }; }
  finally { await a.close(); }
}
