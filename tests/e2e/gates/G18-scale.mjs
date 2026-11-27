import { launch, sleep } from "../harness.mjs";
export const name = "Scale through the running host: 600 servers, delta and tick size";
export default async function () {
  const a = await launch({ preset: "mega" });
  try {
    await sleep(6000); const seen = [];
    for (let i = 0; i < 30; i++) { seen.push(await a.page.evaluate(() => window.uptime.invoke("diag.stats"))); await sleep(200); }
    const snap = await a.page.evaluate(async () => JSON.stringify(await window.uptime.invoke("sim.snapshot")).length);
    const maxDelta = Math.max(...seen.map((s) => s.deltaBytes)), avg = seen.reduce((x, s) => x + s.deltaBytes, 0) / seen.length, tick = Math.max(...seen.map((s) => s.tickP95));
    const servers = await a.page.evaluate(() => window.game.client.world.racks.reduce((n, r) => n + r.servers.filter(Boolean).length, 0));
    const pass = servers === 600 && maxDelta < 40 * 1024 && tick < 4 && snap < 2 * 1024 * 1024;
    return { pass, detail: `${servers} servers; 10 Hz delta: largest ${(maxDelta / 1024).toFixed(1)} KB, average ${(avg / 1024).toFixed(1)} KB (limit 40 KB); host step p95 ${tick.toFixed(2)} ms (limit 4 ms); renderer snapshot ${(snap / 1024).toFixed(0)} KB (limit 2,048 KB)` };
  } finally { await a.close(); }
}
