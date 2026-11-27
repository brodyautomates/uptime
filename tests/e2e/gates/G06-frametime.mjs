import { launch, sleep } from "../harness.mjs";
export const name = "Frame time at 1440p (High and Ultra), scripted walk through a full Hall A";
/** Something on the desktop (a window manager, macOS tiling) sometimes resizes the test window. Force it back to 1440p before each measurement. */
async function fit(a) { for (let i = 0; i < 5; i++) { await a.app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; if (w.isMaximized()) w.unmaximize(); if (w.isFullScreen()) w.setFullScreen(false); w.setContentSize(1280, 688); }); await sleep(500); const px = await a.page.evaluate(() => [window.game.renderer.domElement.width, window.game.renderer.domElement.height]); if (px[0] === 2560 && px[1] === 1376) return true; } return false; }
async function walk(page, tier, preset) {
  await page.evaluate((t) => { window.game.setSetting("graphics.tier", t); }, tier);
  await sleep(1500);
  return page.evaluate(async () => {
    const g = window.game, p = g.player;
    g.stats.dt.length = 0;
    // down the cold aisle, turn, back up the hot aisle
    const legs = [{ x: 0.8, z: 4.2, yaw: -Math.PI / 2, ms: 3500 }, { x: 10.5, z: 4.2, yaw: Math.PI / 2, ms: 3500 }, { x: 2.0, z: 1.0, yaw: -Math.PI / 2, ms: 3000 }];
    for (const l of legs) { p.setPose(l.x, l.z, l.yaw, -0.03); p.keys.add("KeyW"); await new Promise((r) => setTimeout(r, l.ms)); p.keys.delete("KeyW"); }
    const d = [...g.stats.dt].sort((a, b) => a - b); const r = g.renderer.info.render;
    return { n: d.length, p50: d[Math.floor(d.length / 2)], p95: d[Math.floor(d.length * 0.95)], p99: d[Math.floor(d.length * 0.99)], calls: r.drawCalls ?? r.calls, tris: r.triangles, px: [g.renderer.domElement.width, g.renderer.domElement.height] };
  });
}
export default async function () {
  const a = await launch({ preset: "showcase", w: 1280, h: 720, env: { UPTIME_QUERY: "unlock=1" } });      // hidden window (nothing on the desktop can resize it), 60 Hz lock off so the true frame cost is measured
  try {
    await fit(a); const hi = await walk(a.page, "High"); await fit(a); const ul = await walk(a.page, "Ultra");
    // the full campus: 60 racks, 600 servers, walking Hall C
    await a.page.evaluate(() => window.uptime.invoke("game.new", { name: "Mega", preset: "mega" })); await sleep(7000);        // let the new world finish loading (shader builds, probe bakes)
    await a.page.evaluate(() => window.game.setSetting("graphics.tier", "High")); await sleep(1500); const sized = await fit(a);
    const mega = await a.page.evaluate(async () => {
      const g = window.game, p = g.player; g.stats.dt.length = 0;
      const legs = [{ x: 1.0, z: 13.2, yaw: -Math.PI / 2, ms: 3500 }, { x: 16.5, z: 18.6, yaw: Math.PI / 2, ms: 3500 }, { x: 0.8, z: 4.2, yaw: -Math.PI / 2, ms: 3000 }];
      for (const l of legs) { p.setPose(l.x, l.z, l.yaw, -0.03); p.keys.add("KeyW"); await new Promise((r) => setTimeout(r, l.ms)); p.keys.delete("KeyW"); }
      const d = [...g.stats.dt].sort((a, b) => a - b); const r = g.renderer.info.render; const perf = await window.uptime.invoke("sim.perf");
      return { n: d.length, p50: d[Math.floor(d.length / 2)], p95: d[Math.floor(d.length * 0.95)], p99: d[Math.floor(d.length * 0.99)], calls: r.drawCalls ?? r.calls, racks: g.client.world.racks.length, tick: perf.tickP95 };
    });
    const f = (r) => `p50 ${r.p50.toFixed(1)} / p95 ${r.p95.toFixed(1)} / p99 ${r.p99.toFixed(1)} ms over ${r.n} frames, ${r.calls} draw calls`;
    const pass = hi.p95 <= 16.9 && ul.p95 <= 16.9 && hi.calls < 300 && mega.p95 <= 16.9 && mega.calls < 300 && a.errors.length === 0 && hi.calls > 60 && sized && hi.px[0] === 2560 && ul.px[0] === 2560;
    return { pass, detail: `render size ${hi.px.join("x")}\nHigh, full Hall A:  ${f(hi)}\nUltra, full Hall A: ${f(ul)}\nHigh, all three halls (${mega.racks} racks), walking Hall C: ${f(mega)}; sim step p95 ${mega.tick.toFixed(2)} ms including the renderer feed; console errors ${a.errors.length}${a.errors[0] ? " " + a.errors[0].slice(0, 120) : ""}` };
  } finally { await a.close(); }
}
