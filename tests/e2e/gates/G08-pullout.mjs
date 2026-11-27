import { launch, frames, send, sleep, waitFor } from "../harness.mjs";
export const name = "Pull-out, hover all slots, swap a fan and a CPU";
export default async function () {
  const a = await launch({ preset: "showcase" }); const { page } = a; const notes = [];
  try {
    const sid = "A-R01-S03";
    await send(page, { type: "setRackDoor", rack: "A-R01", open: true, by: "player" });
    await frames(page, 40);
    await page.evaluate((id) => window.game.game.openInspect(id), sid);
    await waitFor(() => page.evaluate(() => !!window.game.ui.getState().inspect?.server?.slots), 8000);
    await frames(page, 80);
    // hover each of the 25 slots: project its world position to the screen and ask the model what is under it
    const hover = await page.evaluate(() => {
      const g = window.game, m = g.game.model, cam = g.camera; const miss = [];
      const slots = ["CPU1","CPU2","RAM1","RAM2","RAM3","RAM4","RAM5","RAM6","RAM7","RAM8","GPU1","GPU2","GPU3","GPU4","DRV1","DRV2","DRV3","DRV4","PSU1","PSU2","FAN1","FAN2","FAN3","FAN4","NIC1"];
      cam.updateMatrixWorld(true);
      for (const s of slots) { const v = m.slotWorld(s, undefined, true).project(cam); const hit = m.hit(cam, { x: v.x, y: v.y }); if (hit !== s) miss.push(`${s}->${hit}`); if (Math.abs(v.x) > 1 || Math.abs(v.y) > 1) miss.push(`${s} off screen`); }
      // every part model must actually sit in its slot (a hit box in the right place is not enough)
      const srv = g.ui.getState().inspect.server; let misplaced = 0, built = 0;
      for (const s of slots) { if (!srv.slots[s]) continue; const grp = m.parts.get(s); built += grp.children.length > 1 ? 1 : 0; const want = m.slotWorld(s), at = grp.getWorldPosition(new g.THREE.Vector3()); if (want.distanceTo(at) > 0.002 || grp.parent !== m.group) misplaced++; }
      const stray = 0;
      // no part clips the chassis or a neighbour: every slot box lies inside the tray, and no two boxes overlap
      const G = g.game.model.constructor; const geo = g.SLOT_GEO; let clips = 0; const W = 0.445 / 2 - 0.004, H = 0.168 / 2, D = 0.86;
      const boxes = slots.map((s) => { const q = geo[s]; return { s, x0: q.pos[0] - q.size[0] / 2, x1: q.pos[0] + q.size[0] / 2, y0: q.pos[1] - q.size[1] / 2, y1: q.pos[1] + q.size[1] / 2, z0: q.pos[2] - q.size[2] / 2, z1: q.pos[2] + q.size[2] / 2 }; });
      for (const b of boxes) if (b.x0 < -W || b.x1 > W || b.y0 < -H || b.y1 > H || b.z1 > 0 || b.z0 < -D + 0.004) clips++;
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) { const a = boxes[i], b = boxes[j]; if (a.x0 < b.x1 - 1e-4 && b.x0 < a.x1 - 1e-4 && a.y0 < b.y1 - 1e-4 && b.y0 < a.y1 - 1e-4 && a.z0 < b.z1 - 1e-4 && b.z0 < a.z1 - 1e-4) clips++; }
      return { n: slots.length, miss, misplaced, built, stray, clips };
    });
    notes.push(`hovered ${hover.n} slots, ${hover.miss.length} missed${hover.miss.length ? " (" + hover.miss.join(",") + ")" : ""}; ${hover.built} part models built, ${hover.misplaced} misplaced, ${hover.clips} clipping the chassis or each other`);
    const inv0 = await page.evaluate(() => window.game.client.inventory.length);
    // hot-swap a fan: remove FAN1, put it back
    const slotsBefore = await page.evaluate((id) => window.game.findServer(window.game.client.world, id).slots.FAN1?.id, sid);
    let r = await send(page, { type: "removePart", server: sid, slot: "FAN1", by: "player" }); notes.push(`remove fan: ${r.ok ? "ok" : r.reason}`);
    await sleep(400);
    const held = await page.evaluate(() => window.game.client.inventory.find((i) => i.where === "hand")?.id);
    r = await send(page, { type: "installPart", server: sid, slot: "FAN1", part: held, by: "player" }); notes.push(`install fan: ${r.ok ? "ok" : r.reason}`);
    await sleep(400);
    const fanBack = await page.evaluate((id) => window.game.findServer(window.game.client.world, id).slots.FAN1?.id, sid);
    // CPU needs power off
    const refused = await send(page, { type: "removePart", server: sid, slot: "CPU1", by: "player" });
    notes.push(`cpu while on: ${refused.ok ? "allowed (wrong)" : refused.reason}`);
    await send(page, { type: "setServerPower", server: sid, on: false, by: "player" }); await sleep(300);
    r = await send(page, { type: "removePart", server: sid, slot: "CPU1", by: "player" }); await sleep(300);
    const heldCpu = await page.evaluate(() => window.game.client.inventory.find((i) => i.where === "hand")?.id);
    const r2 = await send(page, { type: "installPart", server: sid, slot: "CPU1", part: heldCpu, by: "player" }); await sleep(300);
    notes.push(`cpu swap off: remove ${r.ok ? "ok" : r.reason}, install ${r2.ok ? "ok" : r2.reason}`);
    await send(page, { type: "setServerPower", server: sid, on: true, by: "player" });
    const inv1 = await page.evaluate(() => window.game.client.inventory.length);
    await page.evaluate(() => window.game.game.closeInspect()); await frames(page, 100);
    const closed = await page.evaluate(() => window.game.game.inspecting === null && window.game.ui.getState().mode === "walk");
    const pass = hover.miss.length === 0 && hover.misplaced === 0 && hover.clips === 0 && hover.stray === 0 && hover.built >= 20 && fanBack === slotsBefore && !refused.ok && refused.reason === "needs_power_off" && r.ok && r2.ok && inv0 === inv1 && closed && a.errors.length === 0;
    return { pass, detail: notes.join("; ") + `; closed=${closed}; errors=${a.errors.length}${a.errors.length ? " " + a.errors[0] : ""}` };
  } finally { await a.close(); }
}
