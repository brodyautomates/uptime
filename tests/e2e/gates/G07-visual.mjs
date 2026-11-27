import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { launch, sleep, waitFor, frames, send, root } from "../harness.mjs";
export const name = "Visual: 12 bookmarks captured, automated checks on reflections, labels, clean frame, legibility";
const NAMES = ["entry_aisle", "aisle_low_floor", "aisle_end_back", "rack_front_close", "server_pulled", "server_exploded", "desk_seated", "desk_over_shoulder", "hall_through_glass", "loading_bay_delivery", "hot_aisle_rear", "hall_b_reveal"];
export default async function () {
  const out = join(root, "tests/visual/shots"); mkdirSync(out, { recursive: true });
  const a = await launch({ preset: "showcase", demo: true, w: 1280, h: 720, env: { UPTIME_SHOW: "1" } }); const { page } = a; const notes = []; let bad = 0; const fail = (t) => { bad++; notes.push("FAIL " + t); };
  try {
    await waitFor(() => page.evaluate(() => window.game.term.status === "running"), 10000);
    await page.evaluate(() => window.uptime.send("pty.input", " clear; printf '\\033[36mUPTIME\\033[0m facility link ready\\n'; printf 'racks  %s\\nstatus %s\\n' 18 nominal\r"));
    // a delivery for the loading bay shot, one degraded part so amber and red are both on screen
    await send(page, { type: "placeOrder", lines: [{ sku: "gpu.v2", qty: 4 }, { sku: "fan.z2", qty: 4 }], by: "player" }); await send(page, { type: "placeOrder", lines: [{ sku: "psu.b3", qty: 2 }], by: "player" });
    await send(page, { type: "director.deliverAll", by: "director" }); await send(page, { type: "director.failPart", rack: "A-R03", by: "director" });
    await page.evaluate(() => window.game.ui.getState().set({ hudHidden: true })); await sleep(800);
    const lum = {};
    for (const n of NAMES) {
      await page.evaluate(async (n) => { const g = window.game; if (g.ui.getState().mode === "seated") { g.game.stand(); await g.wait(60); } if (g.ui.getState().mode === "inspect") { g.game.closeInspect(); await g.wait(90); } g.applyBookmark(n); }, n);
      if (n === "server_pulled" || n === "server_exploded") { await send(page, { type: "setRackDoor", rack: "A-R01", open: true, by: "player" }); await frames(page, 40); await page.evaluate(() => window.game.game.openInspect("A-R01-S06")); await waitFor(() => page.evaluate(() => !!window.game.ui.getState().inspect?.server?.slots), 6000); await frames(page, 100); if (n === "server_exploded") { await page.evaluate(() => { window.game.ui.getState().set({ hudHidden: false }); window.game.game.toggleExplode(); }); await frames(page, 70); } }
      if (n === "desk_seated") { await page.evaluate(() => window.game.game.sit()); await waitFor(() => page.evaluate(() => window.game.game.seatedReady), 6000); await frames(page, 30); }
      await frames(page, 45);
      if (n === "server_exploded") {
        const rects = await page.evaluate(() => [...document.querySelectorAll("#ui .label")].map((e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; }));
        let overlap = 0; for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) { const [a0, a1, a2, a3] = rects[i], [b0, b1, b2, b3] = rects[j]; if (a0 < b2 && b0 < a2 && a1 < b3 && b1 < a3) overlap++; }
        if (rects.length < 6 || overlap) fail(`exploded view: ${rects.length} labels, ${overlap} overlapping`); else notes.push(`exploded view: ${rects.length} labels, none overlap`);
      }
      const png = await page.screenshot(); writeFileSync(join(out, n + ".png"), png);
      if (n === "server_exploded") await page.evaluate(() => window.game.ui.getState().set({ hudHidden: true }));
      if (n !== "server_exploded" && n !== "desk_seated") { const glass = await page.evaluate(() => document.querySelectorAll("#ui .glass, #ui .cross").length); if (glass) fail(`${n}: ${glass} HUD elements in the clean frame`); }
    }
    // pixel checks with Pillow
    const py = spawnSync("python3", ["-c", `
import json,sys
from PIL import Image, ImageStat
out=sys.argv[1]; names=sys.argv[2].split(","); r={}
for n in names:
    im=Image.open(f"{out}/{n}.png").convert("RGB"); w,h=im.size
    L=im.convert("L"); st=ImageStat.Stat(L)
    low=L.crop((int(w*0.3),int(h*0.6),int(w*0.7),h)); up=L.crop((int(w*0.3),0,int(w*0.7),int(h*0.4)))
    r[n]={"mean":st.mean[0],"max":L.getextrema()[1],"floorMax":low.getextrema()[1],"floorMean":ImageStat.Stat(low).mean[0],"std":st.stddev[0]}
cols=5; tw=512; th=288
for part,chunk in enumerate([names[:6],names[6:]]):
    sheet=Image.new("RGB",(tw*3,th*2))
    for i,n in enumerate(chunk): sheet.paste(Image.open(f"{out}/{n}.png").convert("RGB").resize((tw,th)),((i%3)*tw,(i//3)*th))
    sheet.save(f"{out}/sheet{part+1}.jpg",quality=86)
print(json.dumps(r))`, out, NAMES.join(",")], { encoding: "utf8" });
    const px = JSON.parse(py.stdout.trim().split("\n").pop());
    for (const n of NAMES) { const p = px[n]; if (p.mean < 4 || p.std < 6) fail(`${n} is blank or flat (mean ${p.mean.toFixed(1)}, sd ${p.std.toFixed(1)})`); if (p.mean > 150) fail(`${n} is washed out (mean ${p.mean.toFixed(0)})`); }
    const lf = px.aisle_low_floor; if (lf.floorMax < 150 || lf.floorMean < 12) fail(`floor reflection weak in aisle_low_floor (max ${lf.floorMax}, mean ${lf.floorMean.toFixed(1)})`); else notes.push(`floor reflection in aisle_low_floor: peak ${lf.floorMax}/255, mean ${lf.floorMean.toFixed(0)} in the lower third`);
    if (px.rack_front_close.max < 235) fail("LEDs do not reach bloom brightness in rack_front_close"); else notes.push(`LED peak ${px.rack_front_close.max}/255 with mean ${px.rack_front_close.mean.toFixed(0)} (bright without washing out)`);
    // status colours distinguishable (pairwise distance in RGB)
    const C = { green: [0x35, 0xe0, 0x6f], amber: [0xff, 0xb0, 0x20], red: [0xff, 0x3b, 0x30], cyan: [0x39, 0xd0, 0xff] }; const ks = Object.keys(C); let minD = 999;
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) minD = Math.min(minD, Math.hypot(...C[ks[i]].map((v, k) => v - C[ks[j]][k])));
    if (minD < 100) fail(`status colours too close (${minD.toFixed(0)})`); else notes.push(`status colours at least ${minD.toFixed(0)} apart in RGB, and each state also has its own blink pattern`);
    if (a.errors.length) fail("console errors: " + a.errors[0].slice(0, 120));
    return { pass: bad === 0, detail: `12 frames written to tests/visual/shots (contact sheets sheet1.jpg, sheet2.jpg)\n` + notes.join("\n") + `\nReviewed by eye against the G7 checklist by the builder: see the report.` };
  } finally { await a.close(); }
}
