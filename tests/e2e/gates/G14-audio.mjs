import { launch } from "../harness.mjs";
export const name = "Audio: hall bed loudness";
export default async function () {
  const a = await launch({ preset: "showcase" });
  try {
    const r = await a.page.evaluate(async () => {
      const g = window.game; const pos = g.client.world.racks.filter((r) => r.hall === "A").map((r) => { const m = g.racks.rackMatrix.get(r.id); return [m.elements[12], m.elements[14]]; });
      const m = await g.AudioEngine.measureBed(pos, [6, 4.2]);
      // the live engine must build its graph and play every named one-shot without throwing
      g.audio.start(); const names = ["rail", "latch", "seat", "click", "door", "breaker", "roller", "truck", "chair", "deny", "tick", "cash", "claude", "strike", "gantry", "milestone"]; let threw = "";
      for (const n of names) { try { g.audio.play(n); } catch (e) { threw += n + " "; } }
      return { ...m, racks: pos.length, threw, state: g.audio.ctx?.state };
    });
    const pass = Math.abs(r.lufs + 24) <= 2 && r.peak < 0.98 && !r.threw;
    return { pass, detail: `hall bed with ${r.racks} racks from mid-aisle: ${r.lufs.toFixed(1)} LUFS (target -24 +/- 2), peak ${r.peak.toFixed(3)} (no clipping); one-shots that threw: ${r.threw || "none"}` };
  } finally { await a.close(); }
}
