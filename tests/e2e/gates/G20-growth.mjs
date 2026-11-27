import { launch, sleep, waitFor, frames, send, query } from "../harness.mjs";
import { connect, call } from "./G10-mcp.mjs";
export const name = "Growth loop (extra): build a rack by hand, buy a hall, saves, speeds, autonomy, streamer mode, menus";
export default async function () {
  const a = await launch({ preset: "fresh", demo: true, env: { UPTIME_SHOW: "1" } }); const { page } = a; const rows = []; const row = (l, ok, n = "") => rows.push({ l, ok: !!ok, n });
  try {
    await send(page, { type: "director.addCash", amount: 600000, by: "director" });
    // order a rack, a chassis and a full set of parts
    const lines = [{ sku: "rack", qty: 1 }, { sku: "chassis", qty: 1 }, { sku: "cart", qty: 1 }, { sku: "cpu.k2", qty: 2 }, { sku: "ram.s2", qty: 8 }, { sku: "gpu.v2", qty: 2 }, { sku: "drv.f1", qty: 2 }, { sku: "psu.b3", qty: 2 }, { sku: "fan.z2", qty: 4 }, { sku: "nic.l2", qty: 1 }];
    const o = await send(page, { type: "placeOrder", lines, express: true, by: "player" }); await send(page, { type: "director.deliverAll", by: "director" });
    const oid = await waitFor(() => page.evaluate(() => window.game.client.extra.orders.find((x) => x.state === "delivered")?.id), 6000);
    await sleep(600);
    const crate = await page.evaluate(() => { const t = window.game.game.targets.find((x) => x.id.startsWith("crate:")); if (t) t.use(); return !!t; }); await sleep(600);
    const stock = await page.evaluate(() => ({ ...window.game.client.stock })); row("delivery: crate opens from the loading bay", o.ok && oid && crate && stock.racks === 1 && stock.chassis === 1 && stock.cart, JSON.stringify(stock));
    // place the rack on a ghost outline
    await sleep(500);
    const noGhosts = await page.evaluate(() => window.game.game.targets.filter((x) => x.id.startsWith("ghost:")).length);
    await page.evaluate(() => window.game.game.targets.find((x) => x.id === "dolly").use()); await sleep(500);
    const dollyFollows = await page.evaluate(async () => { const g = window.game; g.player.setPose(3, 4.2, -Math.PI / 2, 0); await g.wait(10); return Math.abs(g.props.dolly.position.x - 4.15) < 0.05; });
    const ghosts = await page.evaluate(() => window.game.game.targets.filter((x) => x.id.startsWith("ghost:")).length);
    await page.evaluate(() => window.game.game.targets.find((x) => x.id === "ghost:A:2").use());
    const placed = await waitFor(() => page.evaluate(() => window.game.client.world.racks.length === 3), 4000);
    await sleep(400); const cart = await page.evaluate(async () => { const g = window.game; g.game.targets.find((x) => x.id === "cart").use(); g.player.setPose(5, 7.5, -Math.PI / 2, 0); await g.wait(10); const follows = Math.abs(g.props.cart.position.x - 5.85) < 0.05; g.game.onIdleAlt(); return follows && !g.props.pushing; });
    row("rack on a dolly: take it from the bay, it rolls ahead of you, outlines appear, E places it; the cart can be pushed and left", noGhosts === 0 && dollyFollows && ghosts === 10 && placed && cart, `ghosts before taking the dolly ${noGhosts}, after ${ghosts}; dolly follows ${dollyFollows}; cart ${cart}`);
    const rid = await page.evaluate(() => window.game.client.world.racks.find((r) => r.slot === 2).id);
    await send(page, { type: "setRackDoor", rack: rid, open: true, by: "player" }); await sleep(300);
    await page.evaluate((rid) => window.game.game.bayTarget(rid, 1).use(), rid);
    const sid = await waitFor(() => page.evaluate((rid) => window.game.client.world.racks.find((r) => r.id === rid).servers[0]?.id, rid), 4000);
    row("chassis placement in an empty bay", !!sid, String(sid));
    // install everything by hand from stock
    const inv = await page.evaluate(() => window.game.client.inventory.map((i) => ({ id: i.id, family: i.family })));
    const slots = { cpu: ["CPU1", "CPU2"], ram: ["RAM1", "RAM2", "RAM3", "RAM4", "RAM5", "RAM6", "RAM7", "RAM8"], gpu: ["GPU1", "GPU2"], drv: ["DRV1", "DRV2"], psu: ["PSU1", "PSU2"], fan: ["FAN1", "FAN2", "FAN3", "FAN4"], nic: ["NIC1"] }; let bad = "";
    for (const it of inv) { const slot = slots[it.family]?.shift(); if (!slot) continue; const r = await send(page, { type: "installPart", server: sid, slot, part: it.id, by: "player" }); if (!r.ok) bad += `${slot}:${r.reason} `; }
    await send(page, { type: "setServerPower", server: sid, on: true, by: "player" });
    const on = await waitFor(async () => { const s = await query(page, "server", sid); return s.power === "on" && s.out.gpu > 0 ? s : null; }, 30000, 500);
    row("build a server from parts: boots and delivers GPU units", !bad && on, bad || `out ${JSON.stringify(on?.out)}, limited by ${on?.bottleneck}`);
    // speeds only while seated
    const sp0 = await send(page, { type: "setSpeed", speed: 4, by: "player" });
    await page.evaluate(() => window.game.game.sit()); await waitFor(() => page.evaluate(() => window.game.game.seatedReady), 6000);
    const sp1 = await send(page, { type: "setSpeed", speed: 4, seated: true, by: "player" }); await sleep(300);
    await page.evaluate(() => window.game.game.stand()); await sleep(800);
    const spAfter = await page.evaluate(() => window.game.client.world.speed);
    row("fast speeds only while seated; standing returns to 1x", !sp0.ok && sp0.reason === "not_seated" && sp1.ok && spAfter === 1, `${sp0.reason}, after standing ${spAfter}x`);
    // buy Hall B: the building changes
    const col0 = await page.evaluate(() => window.game.shell.colliders.length);
    const hb = await send(page, { type: "buyUpgrade", kind: "hall", target: "B", by: "player" });
    const built = await waitFor(() => page.evaluate((c) => window.game.client.world.halls.B.owned && window.game.shell.colliders.length !== c, col0), 5000);
    await sleep(2500);      // the wall panel slides up
    const dbg = await page.evaluate(async () => { const g = window.game, p = g.player; const f0 = g.frames; p.setPose(11.0, 4.2, -Math.PI / 2, 0); p.keys.add("KeyW"); await new Promise((r) => setTimeout(r, 1500)); const keys = [...p.keys]; p.keys.delete("KeyW"); return { x: p.pos.x, frames: g.frames - f0, keys, enabled: p.enabled, mode: g.ui.getState().mode, paused: g.ui.getState().paused, focus: document.hasFocus() }; }); const walk = dbg.x;
    const ms = await query(page, "milestones");
    row("buy Hall B: wall opens, you can walk in, milestone recorded", hb.ok && built && walk > 13 && ms.includes("second_hall"), `walked to x=${walk.toFixed(1)}; ${JSON.stringify(dbg)}; milestones ${ms.join(",")}`);
    // save, change, load
    const before = await page.evaluate(() => ({ cash: window.game.client.world.cash, racks: window.game.client.world.racks.length }));
    await page.evaluate(() => window.uptime.invoke("save.write", "slot1"));
    await page.evaluate(() => window.uptime.invoke("game.new", { name: "Other", preset: "fresh" })); await sleep(400);
    const mid = await page.evaluate(() => window.game.client.world.racks.length);
    const ld = await page.evaluate(() => window.uptime.invoke("save.load", "slot1")); await sleep(500);
    const after = await page.evaluate(() => ({ cash: window.game.client.world.cash, racks: window.game.client.world.racks.length, b: window.game.client.world.halls.B.owned, list: null }));
    const list = await page.evaluate(() => window.uptime.invoke("save.list"));
    row("save and load a slot", ld.ok && mid === 2 && after.racks === before.racks && after.b && Math.abs(after.cash - before.cash) < before.cash * 0.05 && list.find((s) => s.slot === "slot1").exists, `racks ${before.racks} -> ${mid} -> ${after.racks}`);
    // autonomy through MCP
    const { client } = await connect(a.userData);
    await send(page, { type: "setAutonomy", level: "advise", by: "player" }); await sleep(200);
    const adv = await call(client, "shop_order", { lines: [{ sku: "fan.z1", qty: 1 }] });
    const advRead = await call(client, "get_overview");
    await send(page, { type: "setAutonomy", level: "operate", by: "player" }); await sleep(200);
    const cash = (await query(page, "overview")).cash; const qty = Math.ceil((cash * 0.3) / 60000);
    const cap = await call(client, "shop_order", { lines: [{ sku: "gpu.v5", qty }] });
    const small = await call(client, "shop_order", { lines: [{ sku: "fan.z1", qty: 1 }] });
    await send(page, { type: "setAutonomy", level: "full", by: "player" }); await sleep(200);
    const full = await call(client, "shop_order", { lines: [{ sku: "gpu.v5", qty }] });
    await client.close();
    row("autonomy: Advise is read-only, Operate caps a purchase at 25% of cash, Full allows it", adv.isError && adv.v.error === "advise_only" && !advRead.isError && cap.isError && cap.v.error === "over_autonomy_cap" && !small.isError && !full.isError, `${adv.v.error} / ${cap.v.error} / small ok ${!small.isError} / full ok ${!full.isError}; message: ${cap.v.message}`);
    // streamer mode: short fixed prompt
    await page.evaluate(() => window.game.setSetting("streamer.enabled", true));
    const prompt = await waitFor(() => page.evaluate(() => { const t = window.game.term.text().split("\n").filter((l) => l.trim()); const last = t.at(-1) ?? ""; return /^uptime [%$#]/.test(last.trim()) ? last.trim() : null; }), 8000);
    const full2 = await page.evaluate(() => window.game.term.text());
    row("streamer mode: short prompt, no home path on screen", !!prompt && !/\/Users\/|\/var\/folders/.test(full2), String(prompt));
    await page.evaluate(() => window.game.setSetting("streamer.enabled", false));
    // menus and small tools
    await page.evaluate(() => window.game.player.setPose(2, 4.2, -Math.PI / 2, 0)); await frames(page, 5);
    await page.keyboard.press("p"); const paused = await waitFor(() => page.evaluate(() => window.game.ui.getState().menu === "pause"), 3000);
    const tk = await page.evaluate(() => window.game.client.world.tick); await sleep(500); const frozen = (await page.evaluate(() => window.game.client.world.tick)) === tk;
    await page.click("[data-resume]"); await sleep(400); const resumed = (await page.evaluate(() => window.game.client.world.tick)) > tk;
    await page.keyboard.press("Tab"); const tab = await page.evaluate(() => !!document.querySelector(".tablet")); await page.keyboard.press("Tab");
    await page.keyboard.press("h"); await sleep(150); const hiddenList = await page.evaluate(() => [...document.querySelectorAll("#ui .glass")].map((e) => e.className)); const hidden = hiddenList.length === 0; await page.keyboard.press("h");
    await page.keyboard.press("f"); const flash = await page.evaluate(() => window.game.props.flash.intensity > 0); await page.keyboard.press("f");
    row("pause menu freezes and resumes the sim; tablet, clean frame and flashlight toggle", paused && frozen && resumed && tab && hidden && flash, `paused=${!!paused} frozen=${frozen} resumed=${resumed} tablet=${tab} cleanFrame=${hidden} [${hiddenList}] flashlight=${flash}`);
    // key rebinding: Use moves to G; the prompt follows; E no longer works; taking a key that is in use swaps the two
    await page.evaluate(() => { window.game.game.shellActions?.rebind; window.game.shellActions.rebind("use", "KeyG"); });
    await page.evaluate(() => window.game.player.setPose(4.5, 4.35, 0, -0.81)); await frames(page, 10);
    await page.evaluate(() => window.game.client.send({ type: "setRackDoor", rack: "A-R01", open: false, by: "player" })); await frames(page, 45);
    const promptG = await page.evaluate(() => window.game.ui.getState().prompt);
    await page.keyboard.press("e"); await frames(page, 30); const eDid = await page.evaluate(() => window.game.client.world.racks.find((r) => r.id === "A-R01").doorOpen);
    await page.keyboard.press("g"); await frames(page, 30); const gDid = await page.evaluate(() => window.game.client.world.racks.find((r) => r.id === "A-R01").doorOpen);
    const swap = await page.evaluate(() => { window.game.shellActions.rebind("explode", "KeyG"); const k = { ...window.game.keys }; window.game.shellActions.rebind("use", "KeyE"); window.game.shellActions.rebind("explode", "KeyX"); return k; });
    const saved = await page.evaluate(() => window.uptime.invoke("settings.get")).then((x) => x["controls.keys"]);
    row("key rebinding: the new key works, the old one does not, prompts update, a clash swaps, the choice is saved", /^G  /.test(promptG) && !eDid && gDid && swap.explode === "KeyG" && swap.use === "KeyX" && saved.use === "KeyE" && saved.explode === "KeyX", `prompt "${promptG}", E opened door ${eDid}, G opened door ${gDid}, swap ${JSON.stringify({ use: swap.use, explode: swap.explode })}`);
    // 60 Hz lock
    const fps = async () => page.evaluate(async () => { const g = window.game; const f0 = g.frames, t0 = performance.now(); await new Promise((r) => setTimeout(r, 2000)); return (g.frames - f0) / ((performance.now() - t0) / 1000); });
    const locked = await fps(); await page.evaluate(() => window.game.setSetting("graphics.vsync", false)); const free = await fps(); await page.evaluate(() => window.game.setSetting("graphics.vsync", true));
    row("60 Hz lock: on by default, off runs at the display's rate", locked > 55 && locked < 62.5 && free >= locked - 1, `locked ${locked.toFixed(1)} fps, unlocked ${free.toFixed(1)} fps`);
    row("no console errors", a.errors.length === 0, a.errors[0] ?? "");
  } catch (e) { row("gate threw", false, String(e).slice(0, 300)); }
  finally { await a.close(); }
  const failed = rows.filter((r) => !r.ok);
  return { pass: failed.length === 0, detail: `${rows.length - failed.length}/${rows.length} checks pass\n` + rows.map((r) => `${r.ok ? "ok  " : "FAIL"} ${r.l}${r.ok ? "" : " [" + r.n + "]"}`).join("\n") };
}
