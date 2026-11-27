import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { launch, sleep, waitFor, frames, send, query, root } from "../harness.mjs";
export const name = "Spec details (extra): part actions, carry mode, PDU, plant room, textures, samples, light strike, overlays";
export default async function () {
  const a = await launch({ preset: "demo", demo: true, w: 1280, h: 720 }); const { page } = a; const rows = []; const row = (l, ok, n = "") => rows.push({ l, ok: !!ok, n });
  try {
    // textures and footstep samples are real files that load
    const assets = await page.evaluate(async () => { const g = window.game; g.audio.start(); await new Promise((r) => setTimeout(r, 1500)); const T = g.TEX; return { tex: Object.entries(T).map(([k, t]) => [k, t.image?.width ?? 0]), steps: [g.audio.steps.hard.filter(Boolean).length, g.audio.steps.perforated.filter(Boolean).length] }; });
    row("CC0 textures (metal, rubber, epoxy roughness, perforation alpha) and footstep samples load", assets.tex.length === 6 && assets.tex.every((t) => t[1] === 512) && assets.steps[0] === 4 && assets.steps[1] === 4, JSON.stringify(assets));
    const lic = readFileSync(join(root, "assets/LICENSES.md"), "utf8");
    row("every bundled asset is listed in assets/LICENSES.md", ["Metal009", "Rubber004", "SheetMetal001", "concrete_floor_painted", "JetBrains Mono", "footsteps"].every((k) => lic.includes(k)), "");
    // inspect: card shows what a part contributes; the menu has Remove, Swap, Order now, Info; leader lines in the exploded view
    await send(page, { type: "setRackDoor", rack: "A-R02", open: true, by: "player" }); await frames(page, 40);
    await page.evaluate(() => window.game.ui.getState().set({ hudHidden: false })); await page.evaluate(() => window.game.game.openInspect("A-R02-S04"));
    await waitFor(() => page.evaluate(() => !!window.game.ui.getState().inspect?.server?.slots), 6000); await frames(page, 80);
    const pt = async (slot) => page.evaluate((s) => { const g = window.game; const v = g.game.model.slotWorld(s, undefined, true).project(g.camera); return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight }; }, slot);
    let p = await pt("FAN2"); await page.mouse.move(p.x, p.y); await frames(page, 6);
    const card = await page.evaluate(() => document.querySelector(".panel")?.textContent ?? "");
    await page.mouse.click(p.x, p.y); await sleep(250);
    const acts = await page.evaluate(() => [...document.querySelectorAll(".menu [data-act]")].map((e) => e.getAttribute("data-act")));
    await page.click('.menu [data-act="info"]'); await page.mouse.move(40, 400); await frames(page, 6);
    const pinned = await page.evaluate(() => ({ pin: window.game.ui.getState().pinned, text: document.querySelector(".panel")?.textContent ?? "" }));
    await page.mouse.click(p.x, p.y); await sleep(250); await page.click('.menu [data-act="order"]'); await sleep(400);
    const ordered = await page.evaluate(() => window.game.client.extra.orders.some((o) => o.lines.some((l) => l.sku.startsWith("fan."))));
    row("part card says what the part contributes; menu offers Remove, Swap, Order now and Info; Info pins the card; Order now places an express order", /Contributes/.test(card) && /moves \d+ W of heat/.test(card) && ["remove", "swap", "order", "info"].every((x) => acts.includes(x)) && pinned.pin === "FAN2" && /Zephyr/.test(pinned.text) && ordered, `actions ${acts.join(",")}; card has contributes ${/Contributes/.test(card)}; pinned ${pinned.pin}; ordered ${ordered}`);
    await page.keyboard.press("x"); await frames(page, 60);
    const lead = await page.evaluate(() => ({ lines: document.querySelectorAll(".leaders line").length, labels: document.querySelectorAll("#ui .label").length }));
    row("exploded view: a thin leader line for every label", lead.lines === lead.labels && lead.lines >= 6, JSON.stringify(lead));
    // swap animation timing through the UI path (a fan swap: latch, lift, drop, latch = about 1.2 s)
    const spare = await page.evaluate(() => window.game.client.inventory.find((i) => i.family === "fan" && i.where === "shelf")?.id);
    const t0 = Date.now(); const swapped = await page.evaluate((id) => window.game.game.installPart("FAN2", id), spare); const dur = (Date.now() - t0) / 1000;
    row("swap animation: latch, lift out, drop in, latch, about 1.2 s", swapped === true && dur > 1.0 && dur < 2.0, `${dur.toFixed(2)} s`);
    // carry mode: a part in hand puts the player in "carry"; exactly one mode at a time
    await page.evaluate(() => window.game.game.removePart("FAN3")); await sleep(300);
    await page.keyboard.press("q"); await waitFor(() => page.evaluate(() => window.game.game.inspecting === null), 6000); await frames(page, 20);
    const carry = await page.evaluate(() => window.game.ui.getState().mode);
    await page.evaluate(() => { const g = window.game; const h = g.client.inventory.find((i) => i.where === "hand"); return g.client.send({ type: "stowPart", part: h.id, to: "shelf", by: "player" }); }); await frames(page, 30);
    const walk = await page.evaluate(() => window.game.ui.getState().mode);
    row("modes: holding a part is Carry, an empty hand is Walk", carry === "carry" && walk === "walk", `${carry} -> ${walk}`);
    // rear PDU: card with load from behind; a tripped breaker resets with E there
    await page.evaluate(() => window.game.player.setPose(4.5, 1.2, Math.PI, -0.3)); await frames(page, 12);
    const pduCard = await page.evaluate(() => window.game.ui.getState().card);
    row("rear PDU: looking at the back of a rack shows its load", pduCard && /PDU/.test(pduCard.title) && /kW/.test(pduCard.lines[0]), JSON.stringify(pduCard));
    const pduLeds = await page.evaluate(() => window.game.racks.pdu.count); row("rear PDU: ten outlet LEDs per rack", pduLeds === 120, String(pduLeds));
    // server highlight outline when looked at
    await page.evaluate(() => window.game.player.setPose(4.5, 4.35, 0, -0.35)); await frames(page, 10);
    row("the thing under the crosshair is outlined", await page.evaluate(() => window.game.game.hl.visible), "");
    // plant room machinery follows the facility tiers
    const plant0 = await page.evaluate(() => [window.game.props.chillers.filter((c) => c.visible).length, window.game.props.gear.filter((c) => c.visible).length]);
    await send(page, { type: "director.addCash", amount: 900000, by: "director" });
    const up = await send(page, { type: "buyUpgrade", kind: "cooling", by: "player" }); await sleep(700);
    const plant1 = await page.evaluate(() => [window.game.props.chillers.filter((c) => c.visible).length, window.game.props.gear.filter((c) => c.visible).length]);
    row("plant room: a cooling upgrade adds a chiller", up.ok && plant1[0] === plant0[0] + 1, `${plant0} -> ${plant1}`);
    // buying a hall: its lights strike on row by row, then settle at full
    await send(page, { type: "buyUpgrade", kind: "hall", target: "B", by: "player" });
    const mid = await waitFor(() => page.evaluate(() => { const b = window.game.shell.bars.B.map((u) => u.value); return b.length >= 2 && b.some((v) => v >= 0.9) && b.some((v) => v < 0.5) ? b : null; }), 5000, 30);
    await sleep(3500); const end = await page.evaluate(() => ({ bars: window.game.shell.bars.B.map((u) => u.value), f: window.game.props.areaFactor.B, bakes: window.game.probes.bakes, hasB: window.game.probes.has("B") }));
    row("buying Hall B: lights strike on row by row, then all on; its reflection probe is baked", !!mid && end.bars.every((v) => v === 1) && end.f === 1 && end.hasB, `mid-strike ${JSON.stringify(mid)}; end ${JSON.stringify(end.bars)}`);
    // selling a part back at 40%
    await page.evaluate(() => window.uptime.invoke("sim.pause", true)); await sleep(250);      // freeze income so the cash change is the sale alone
    const cash0 = (await query(page, "overview")).cash; const part = await page.evaluate(() => window.game.client.inventory.find((i) => i.where === "shelf" && i.status === "ok"));
    const sold = await send(page, { type: "sellPart", part: part.id, by: "player" }); await sleep(300); const cash1 = (await query(page, "overview")).cash; await page.evaluate(() => window.uptime.invoke("sim.pause", false));
    row("a part sells back at 40% of its price", sold.ok && Math.abs((cash1 - cash0) - part.price * 0.4) <= 1, `${part.name} $${part.price}: cash +${Math.round(cash1 - cash0)}`);
    // seated: streamer mode hides the workspace path in Settings; the window can be set to 1080 x 1920; debug overlay has every field
    await page.evaluate(() => window.game.setSetting("streamer.enabled", true)); await page.evaluate(() => window.game.game.sit()); await waitFor(() => page.evaluate(() => window.game.game.seatedReady), 6000);
    await page.keyboard.press("Meta+1"); await frames(page, 30); await page.click('[data-tab-btn="Settings"]'); await sleep(300);
    const hiddenPath = await page.evaluate(() => !!document.querySelector("[data-workspace-hidden]") && !document.querySelector('.mon-ops input[type="text"]'));
    row("streamer mode hides the workspace path in Settings", hiddenPath, "");
    await page.click('[data-win="1080x1920"]'); await sleep(900);
    const px = await page.evaluate(() => [Math.round(innerWidth * devicePixelRatio), Math.round(innerHeight * devicePixelRatio)]);
    row("Camera setting sizes the window to 1080 x 1920", px[0] === 1080 && Math.abs(px[1] - 1920) <= 140, px.join("x") + " (the screen is shorter than 1920 px when it comes up short)");
    await a.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 720)); await sleep(500);
    await page.keyboard.press("Meta+e"); await frames(page, 50); await page.evaluate(() => window.game.setSetting("streamer.enabled", false));
    await page.keyboard.press("F10"); await sleep(1300); const dbg = await page.evaluate(() => document.querySelector(".debug")?.textContent ?? ""); await page.keyboard.press("F10");
    row("debug overlay: frame graph, draw calls, instances, active lights, sim tick, delta size, MCP calls per minute", ["frame ", "draw calls", "instances", "active lights", "sim tick", "delta", "MCP calls per minute"].every((k) => dbg.includes(k)), dbg.replace(/\n/g, " | ").slice(0, 200));
    // files the spec names
    const bm = JSON.parse(readFileSync(join(root, "tests/visual/bookmarks.json"), "utf8"));
    row("tests/visual/bookmarks.json holds 12 full poses; scripts/render-replay.ts exists", bm.length === 12 && bm.every((b) => b.name && b.pos?.length === 3 && typeof b.yaw === "number" && typeof b.fov === "number" && b.mode) && existsSync(join(root, "scripts/render-replay.ts")), "");
    const lights = await page.evaluate(() => { let n = 0, sh = 0, ar = 0; window.game.scene.traverse((o) => { if (o.isLight && o.intensity > 0) { n++; if (o.castShadow) sh++; if (o.isRectAreaLight) ar++; } }); return { n, sh, ar }; });
    row("lighting: area lights for the owned halls, at least one shadow-casting spot, rack status light", lights.ar === 2 && lights.sh >= 1 && lights.n >= 5, JSON.stringify(lights));
    row("no console errors", a.errors.length === 0, a.errors[0] ?? "");
  } catch (e) { row("gate threw", false, String(e).slice(0, 300)); }
  finally { await a.close(); }
  const failed = rows.filter((r) => !r.ok);
  return { pass: failed.length === 0, detail: `${rows.length - failed.length}/${rows.length} checks pass\n` + rows.map((r) => `${r.ok ? "ok  " : "FAIL"} ${r.l}${r.ok ? "" : " [" + r.n + "]"}`).join("\n") };
}
