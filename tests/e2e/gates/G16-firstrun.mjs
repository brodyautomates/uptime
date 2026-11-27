import { launch, sleep, waitFor, frames, send } from "../harness.mjs";
export const name = "First run: notices, menu, new game, the seven checklist steps";
export default async function () {
  const a = await launch({ noTest: true, env: { UPTIME_SHOW: "1" } }); const { page } = a; const t0 = Date.now(); const notes = [];
  const step = () => page.evaluate(() => window.game.ui.getState().checklist.step);
  const until = (n, ms = 20000) => waitFor(async () => (await step()) >= n, ms);
  try {
    // first launch: two notices, then the main menu
    const m0 = await page.evaluate(() => window.game.ui.getState().menu); notes.push(`opens on ${m0}`);
    await page.click("[data-continue]"); await page.click("[data-continue]");
    await page.click('[data-menu="new"]'); await page.fill("[data-name]", "Gate Sixteen"); await page.click("[data-start]");
    await waitFor(() => page.evaluate(() => window.game.ui.getState().mode === "walk"), 8000);
    const fac = await page.evaluate(() => window.game.client.world.facilityName);
    // 1 walk to A-R01 (hold W toward it)
    await page.evaluate(async () => { const p = window.game.player; p.setPose(1.0, 4.2, -Math.PI / 2, 0); p.keys.add("KeyW"); await new Promise((r) => setTimeout(r, 1500)); p.keys.delete("KeyW"); });
    await until(1); 
    // 2 open the door with E, pull a server with E (look straight at the rack)
    await page.evaluate(() => { const p = window.game.player; p.setPose(4.5, 4.35, 0, -0.81); });
    await frames(page, 10); await page.keyboard.press("e"); await frames(page, 45); await page.keyboard.press("e");
    await until(2, 8000); await frames(page, 80);
    // 3 exploded view with X
    await page.keyboard.press("x"); await until(3, 6000); await frames(page, 40);
    await page.keyboard.press("q"); await waitFor(() => page.evaluate(() => window.game.game.inspecting === null), 6000);
    // 4 sit
    await page.evaluate(() => window.game.player.setPose(-2.5, 4.5, -Math.PI / 2, -0.95)); await frames(page, 10); await page.keyboard.press("e");
    await until(4, 8000); await waitFor(() => page.evaluate(() => window.game.game.seatedReady), 5000);
    // 5 order a tier-1 GPU, express, through the ops app
    await page.keyboard.press("Meta+1"); await frames(page, 40);
    await page.click('[data-tab-btn="Shop"]'); await page.click('[data-add="gpu.v1"]'); await page.check("[data-express]"); await page.click("[data-order]");
    await until(5, 8000);
    // 6 collect and install by hand
    const order = await waitFor(() => page.evaluate(() => window.game.client.extra.orders.find((o) => o.state === "delivered")?.id), 40000);
    await page.keyboard.press("Meta+e"); await waitFor(() => page.evaluate(() => window.game.ui.getState().mode === "walk"), 5000);
    await frames(page, 60);
    await page.evaluate(() => window.game.player.setPose(-1.4, 7.25, Math.PI / 2, -0.85)); await frames(page, 15);
    const prompt = await page.evaluate(() => window.game.ui.getState().prompt); notes.push(`crate prompt: "${prompt}"`);
    await page.keyboard.press("e"); await sleep(500);
    const gpu = await waitFor(() => page.evaluate(() => window.game.client.inventory.find((i) => i.sku === "gpu.v1")?.id), 5000);
    await page.evaluate(() => { const p = window.game.player; p.setPose(4.5, 4.35, 0, -0.81); }); await frames(page, 10);
    await page.keyboard.press("e"); await waitFor(() => page.evaluate(() => !!window.game.ui.getState().inspect?.server?.slots), 8000); await frames(page, 70);
    { const b = await page.locator("[data-power]").boundingBox(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down(); await sleep(1150); await page.mouse.up(); } await sleep(500);                 // hold the power button for one second
    // click the empty GPU1 slot on the model, then the install option
    const pt = await page.evaluate(() => { const g = window.game; const v = g.game.model.slotWorld("GPU1", undefined, true).project(g.camera); return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight }; });
    await page.mouse.move(pt.x, pt.y); await frames(page, 5); await page.mouse.click(pt.x, pt.y); await sleep(300);
    await page.click(".menu .it"); 
    await until(6, 8000);
    await sleep(1400); { const b = await page.locator("[data-power]").boundingBox(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down(); await sleep(1150); await page.mouse.up(); } await page.keyboard.press("q"); await waitFor(() => page.evaluate(() => window.game.game.inspecting === null), 6000);
    // 7 run claude in the real terminal
    await page.evaluate(() => window.game.player.setPose(-2.5, 4.5, -Math.PI / 2, -0.95)); await frames(page, 10); await page.keyboard.press("e");
    await waitFor(() => page.evaluate(() => window.game.game.seatedReady), 6000); await page.keyboard.press("Meta+2"); await frames(page, 30);
    const hasClaude = await page.evaluate(() => window.game.term.claudeFound !== false);
    if (hasClaude) { await page.keyboard.type("claude -p 'Use the uptime tools: call get_overview and give me a two line status report.' --mcp-config .mcp.json --allowedTools mcp__uptime__get_overview,mcp__uptime__list_alerts --model haiku", { delay: 2 }); await page.keyboard.press("Enter"); await until(7, 120000); }
    else { await page.keyboard.press("Meta+e"); await sleep(800); await page.click(".check .btn"); await until(7, 4000); }
    const st = await page.evaluate(() => ({ c: window.game.ui.getState().checklist, hints: window.game.checklist.hintCount, feed: window.game.ui.getState().feedLog.slice(-5).map((f) => f.text).join(" / "), term: window.game.term.text().split("\n").filter((l) => l.trim()).slice(-4).join(" | ") }));
    const secs = (Date.now() - t0) / 1000;
    const pass = st.c.done.every(Boolean) && secs < 360 && st.hints.every((h) => h <= 1) && fac === "Gate Sixteen" && m0 === "notice1" && !!order && !!gpu;
    return { pass, detail: `${st.c.done.filter(Boolean).length}/7 steps in ${secs.toFixed(0)} s; hints shown per step ${st.hints.join("")}; facility "${fac}"; ${notes.join("; ")}; claude ${hasClaude ? "ran in the in-game terminal" : "missing (step skipped)"}; feed: ${st.feed.slice(0, 300)}; terminal tail: ${st.term.slice(0, 120)}; errors ${a.errors.length}${a.errors[0] ? " " + a.errors[0].slice(0, 150) : ""}` };
  } catch (e) {
    const s = await step().catch(() => -1); return { pass: false, detail: `stopped at step ${s}: ${String(e).slice(0, 300)}; ${notes.join("; ")}; errors: ${a.errors.slice(0, 2).join(" / ").slice(0, 300)}` };
  } finally { await a.close(); }
}
