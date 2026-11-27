import * as THREE from "three/webgpu";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { buildFloorAndShell, type HallBuild } from "./world/hall";
import { Racks, serverFaceTexture } from "./world/racks";
import { TEX } from "./world/materials";
import { SLOT_GEO } from "./world/serverModel";
import { buildDesk } from "./world/desk";
import { Props } from "./world/props";
import { createPipeline, TIERS, GI, type Tier, type Pipeline } from "./render/pipeline";
import { Probes, type ProbeId } from "./render/probes";
import { Player } from "./player/controller";
import { BOOKMARKS } from "./bookmarks";
import { MockClient, IpcClient, findServer, type Client } from "./client";
import { Game } from "./game";
import { ui, isFree } from "./ui/store";
import { Hud } from "./ui/Hud";
import { Shell } from "./ui/Shell";
import { TerminalMonitor } from "./monitors/terminal";
import { MonitorOverlay } from "./monitors/overlay";
import { Ops } from "./monitors/Ops";
import { paintMap, paintOpsSummary } from "./monitors/map";
import { DesktopMirror } from "./monitors/desktop";
import { installCursor } from "./ui/cursor";
import { AudioEngine, type HumSource } from "./audio/engine";
import { DEFAULTS, type Settings } from "./settings";
import { Director } from "./director/director";
import { Capture } from "./director/capture";
import { Checklist } from "./ui/checklist";
import { CONTROL, RACK, slotPose } from "@shared/layout";
import { clock } from "./clock";
import { keys as K, loadKeys, bind, type Action } from "./keys";

declare global { interface Window { uptime: any; game: any } }

async function boot() {
  const canvas = document.getElementById("view") as HTMLCanvasElement;
  const params = new URLSearchParams(location.search);
  const api = window.uptime;
  const info = api ? await api.invoke("app.info") : { demo: false, test: true, preset: null, hasSave: false, mcpUp: false };
  const test = params.has("test") || info.test;
  const settings: Settings = { ...DEFAULTS, ...(api ? await api.invoke("settings.get") : {}) };
  loadKeys((settings as any)["controls.keys"]);
  const tierOf = (s: Settings): Tier => (params.get("tier") as Tier) ?? (s["graphics.tier"].toLowerCase() as Tier);

  // The scene pass writes five targets (colour, normal, metal-roughness, velocity, emissive: SPEC section 6). That is 40 bytes per sample,
  // over WebGPU's default limit of 32, so the higher limit is requested when the adapter offers it.
  let wideMRT = false;
  try { const ad = !params.has("forceWebGL") ? await (navigator as any).gpu?.requestAdapter({ powerPreference: "high-performance" }) : null; wideMRT = (ad?.limits?.maxColorAttachmentBytesPerSample ?? 0) >= 40; } catch { wideMRT = false; }
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, powerPreference: "high-performance", forceWebGL: params.has("forceWebGL"), ...(wideMRT ? { requiredLimits: { maxColorAttachmentBytesPerSample: 64 } } : {}) } as any);
  await renderer.init();
  const isWebGPU = !!(renderer.backend as any).isWebGPUBackend;
  if (!isWebGPU) { settings["graphics.tier"] = "Medium"; settings["graphics.steppedDown"] = "WebGPU is not available on this machine: running the compatibility renderer at Medium."; }
  const resumed = sessionStorage.getItem("uptime.resume") === "1"; sessionStorage.removeItem("uptime.resume");
  const deviceLost = (why = "") => { console.warn("GPU device lost, rebuilding the renderer", why); sessionStorage.setItem("uptime.resume", "1"); location.reload(); };
  (renderer as any).onDeviceLost = (i: any) => deviceLost(i?.message ?? "");
  renderer.toneMapping = THREE.AgXToneMapping; renderer.toneMappingExposure = 1.0; renderer.shadowMap.enabled = true;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020304);
  scene.fog = new THREE.FogExp2(0x05080c, 0.01);
  const camera = new THREE.PerspectiveCamera(settings["graphics.fov"], window.innerWidth / window.innerHeight, 0.05, 90);
  camera.layers.enable(1);        // layer 1 = small props, which the floor reflection leaves out (SPEC section 19)
  const pmrem = new THREE.PMREMGenerator(renderer);
  const fallbackEnv = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = fallbackEnv; scene.environmentIntensity = 0.3;

  // ---------- client ----------
  let client: Client;
  if (api && !params.has("mock")) { const c = new IpcClient(); await c.init(); client = c; }
  else client = new MockClient((params.get("preset") as any) ?? "showcase");

  // ---------- world ----------
  let shell: HallBuild; let ownedKey = "";
  const racks = new Racks(); scene.add(racks.group);
  const buildShell = () => {
    const o = { A: true, B: client.world.halls.B.owned, C: client.world.halls.C.owned };
    const key = `${o.B}${o.C}`; if (key === ownedKey) return false;
    if (shell) { scene.remove(shell.group); shell.group.traverse((x: any) => { x.geometry?.dispose?.(); }); }
    shell = buildFloorAndShell(o); scene.add(shell.group); ownedKey = key;
    if (pipeline) shell.floor.setResolution(TIERS[pipeline.tier].reflector);     // keep the post pipeline: rebuilding it here froze the game for over a second
    return true;
  };
  let pipeline: Pipeline = null as any;
  buildShell();
  racks.update(client.world);

  const monCanvases = [0, 1, 2].map(() => { const c = document.createElement("canvas"); c.width = 1280; c.height = 724; return c; });
  const overlayHost = document.createElement("div");
  const term = new TerminalMonitor(overlayHost, settings["terminal.fontSize"]);
  monCanvases[1] = term.canvas;
  const opsEl = document.createElement("div"); opsEl.className = "mon mon-ops"; opsEl.tabIndex = 0;
  const mapEl = document.createElement("div"); mapEl.className = "mon mon-map"; mapEl.tabIndex = 0;
  monCanvases[2].style.cssText = "width:100%;height:100%;display:block"; mapEl.appendChild(monCanvases[2]);
  const desktop = new DesktopMirror(mapEl); installCursor();
  const floorCanvas = document.createElement("canvas"); floorCanvas.width = 1280; floorCanvas.height = 724; let desktopTried = false;
  window.addEventListener("keydown", (e) => { if (e.metaKey && e.code === "KeyD" && ui.getState().mode === "seated") { e.preventDefault(); e.stopPropagation(); game.focusMonitor(2); void desktop.toggle(); } }, true);
  const desk = buildDesk(monCanvases); scene.add(desk.group);
  const overlay = new MonitorOverlay(desk.screens);
  overlay.add(opsEl); overlay.add(term.el); overlay.add(mapEl);

  const player = new Player(camera, canvas);
  const props = new Props(scene, client, desk);
  player.colliders = () => [...shell.colliders, ...racks.colliders, ...desk.colliders, ...props.colliders];
  const audio = new AudioEngine();
  const game = new Game(camera, player, racks, client, scene, serverFaceTexture());
  game.sounds = (n, at) => audio.play(n, at);
  props.attach(game, racks);
  props.getBars = (h) => shell.bars[h];
  const probes = new Probes(renderer, scene, fallbackEnv, [game.model.group]);
  const ownedRooms = (): ProbeId[] => ["A", "control", ...(client.world.halls.B.owned ? ["B" as const] : []), ...(client.world.halls.C.owned ? ["C" as const] : [])];
  let probeKey = ""; let shadowAge = 0; let lightHall = ""; let lightShell: HallBuild | null = null; let reflShell: HallBuild | null = null;
  // one shadow-casting spot per hall (the spec allows up to four): each one is paid for twice on Ultra, in the view and in the full-resolution floor reflection
  const roamSpots = [0].map(() => { const sp = new THREE.SpotLight(0xe8f0ff, 34, 10, 0.95, 0.5, 1.2); sp.castShadow = true; sp.shadow.mapSize.set(2048, 2048); sp.shadow.camera.near = 0.3; sp.shadow.camera.far = 9; sp.shadow.bias = -0.0008; sp.shadow.normalBias = 0.02; sp.shadow.autoUpdate = false; scene.add(sp, sp.target); return sp; });
  const mkArea = () => { const rl = new THREE.RectAreaLight(0xe4edff, 0, 9.4, 0.14); rl.rotation.x = -Math.PI / 2; scene.add(rl); return rl; };
  const hallAreas = { A: [mkArea()], B: [mkArea()], C: [mkArea(), mkArea()] };
  // rack status lights: each rack spills its dominant status colour; the nearest few are lit (SPEC: at most 24 active)
  const RACK_LIGHTS = Number(params.get("rackLights") ?? 1);
  const rackLights = Array.from({ length: RACK_LIGHTS }, () => { const pl = new THREE.PointLight(0x35e06f, 0, 2.6, 1.6); scene.add(pl); return pl; });
  const STATUS_HEX = { ok: 0x35e06f, degraded: 0xffb020, failed: 0xff3b30 } as const; let rackLightT = 0;
  document.addEventListener("click", (e) => { if ((e.target as HTMLElement)?.closest?.("button, .it, .mbtn, .ob")) audio.play("tick"); }, true);
  canvas.addEventListener("click", () => { audio.start(); if (isFree(ui.getState().mode) && !ui.getState().paused) player.lock(); });
  window.addEventListener("keydown", () => audio.start(), { once: true });

  // ---------- settings ----------
  const applySettings = () => {
    player.sensitivity = settings["controls.sensitivity"]; player.invertY = settings["controls.invertY"]; player.headBob = settings["comfort.headBob"];
    game.cameraEase = settings["comfort.cameraEase"]; game.baseFov = settings["graphics.fov"];
    audio.vol = { master: settings["audio.master"], world: settings["audio.world"], ui: settings["audio.ui"] }; audio.applyVolume();
    document.documentElement.style.setProperty("--ts", String(settings["comfort.textScale"]));
    term.setFontSize(settings["terminal.fontSize"]);
    if (pipeline) pipeline.grain.value = settings["graphics.filmGrain"] ? 0.02 : 0;
    document.body.classList.toggle("guide916", settings["camera.guide916"]);
  };
  const setSetting = (k: keyof Settings, v: any) => {
    (settings as any)[k] = v; void api?.invoke("settings.set", k, v);
    if (k === "graphics.tier" || k === "graphics.resolutionScale") { pipeline.setTier(tierOf(settings)); resize(); }
    if (k === "demo.director") void client.send({ type: "setDemoMode", on: !!v, by: "player" });
    if (k === "replay.logging") void capture.setLogging(!!v);
    applySettings(); rerender();
  };

  const resize = () => {
    const t = TIERS[pipeline?.tier ?? tierOf(settings)];
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * t.scale * settings["graphics.resolutionScale"]);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
    if (game.seatedReady) { camera.updateMatrixWorld(true); overlay.layout(camera); }
  };
  pipeline = createPipeline(renderer, scene, camera, tierOf(settings), (s) => shell.floor.setResolution(s), wideMRT || !isWebGPU);
  resize(); window.addEventListener("resize", resize);
  applySettings();

  // ---------- seated ----------
  game.targets.push({ id: "chair", min: desk.chairBox.min, max: desk.chairBox.max, prompt: () => "E  sit at the master computer", use: () => game.sit() });
  let trayPart: string | null = null;
  game.onSit = () => { camera.updateMatrixWorld(true); overlay.layout(camera); overlay.show(true); checklist.mark(3);
    if (!desktopTried && !info.test) { desktopTried = true; void desktop.toggle(); }       // the right monitor shows the Mac desktop by default
    const held = client.inventory.find((i) => i.where === "hand"); if (held) { trayPart = held.id; void client.send({ type: "stowPart", part: held.id, to: "shelf", by: "player" }); ui.getState().pushFeed(`${held.name} is on the desk tray. You will pick it up when you stand.`, "info"); } };
  game.onStand = () => { desktop.remote.releaseKeys(); if (trayPart) { void client.send({ type: "stowPart", part: trayPart, to: "hand", by: "player" }); trayPart = null; } overlay.show(false); term.blur(); (document.activeElement as HTMLElement | null)?.blur?.(); if (client.world.speed > 1) void client.send({ type: "setSpeed", speed: 1, seated: true, by: "player" }); };
  game.monitorNormal = (i) => { const [tl, tr, bl] = desk.screens[i].corners; const n = new THREE.Vector3().subVectors(tr, tl).cross(new THREE.Vector3().subVectors(bl, tl)).normalize(); if (n.x > 0) n.negate(); return n; };       // out of the screen, toward the seat
  game.monitorCentre = (i) => desk.screens[i].corners.reduce((a, c) => a.add(c), new THREE.Vector3()).multiplyScalar(0.25);
  game.onSeatMove = () => { camera.updateMatrixWorld(true); overlay.layout(camera); };
  game.onFocus = (i) => { overlay.focus(i); if (i === 1) term.focus(); else { term.blur(); (i === 0 ? opsEl : mapEl).focus(); } if (i === 2) desktop.remote.grabKeys(); else desktop.remote.releaseKeys(); };
  // while the remote computer has the keyboard, the main process catches the desk chords and hands them over here
  api?.on("seat.chord", (code: string) => {
    if (ui.getState().mode !== "seated") return;
    if (code === "KeyE") { desktop.remote.releaseKeys(); game.stand(); } else if (code === "KeyD") void desktop.toggle(); else if (code === "Digit0") { desktop.remote.releaseKeys(); game.overview(); } else game.focusMonitor((Number(code.slice(5)) - 1) as 0 | 1 | 2);
  });
  overlay.mons.forEach((m, i) => m.addEventListener("mousedown", () => { if (game.seatedReady && ui.getState().focusMonitor !== i) game.focusMonitor(i as 0 | 1 | 2); }));

  // ---------- UI ----------
  const director = new Director(game, client, () => settings["demo.director"] || info.demo, (n) => applyBookmark(n));
  const capture = new Capture(renderer, canvas, camera, player, game, () => pipeline, api);
  const checklist = new Checklist(client, api);
  const hudRoot = createRoot(document.getElementById("ui")!);
  const opsRoot = createRoot(opsEl);
  const shellActions = {
    resume: () => { ui.getState().set({ paused: false, mode: "walk", menu: null }); void api?.invoke("sim.pause", false); },
    quit: () => api?.quit(),
    newGame: async (name: string, preset: string, slot: string) => { await api?.invoke("game.new", { name, preset, slot }); await api?.invoke("workspace.refresh"); checklist.reset(preset === "fresh"); afterLoad(); },
    load: async (slot: string) => { const r = await api?.invoke("save.load", slot); if (r?.ok) { await api?.invoke("workspace.refresh"); afterLoad(); } return r; },
    save: (slot: string) => api?.invoke("save.write", slot),
    listSaves: () => api?.invoke("save.list") ?? Promise.resolve([]),
    openLogs: () => api?.invoke("app.openLogs"),
    setSetting, settings: () => settings,
    rebind: (a: Action, code: string) => { setSetting("controls.keys" as any, bind(a, code)); },
    showChecklist: () => checklist.show(),
    seenNotices: () => setSetting("first.noticesSeen", true),
  };
  const hudActions = { removePart: (s: string) => void game.removePart(s), installPart: (s: string, p: string) => void game.installPart(s, p), togglePower: () => void game.togglePower(), explode: () => game.toggleExplode(), close: () => game.closeInspect(), orderNow: (sku: string) => void game.orderNow(sku), info: (slot: string) => game.pinInfo(slot) };
  const rerender = () => {
    hudRoot.render(createElement("div", null, createElement(Hud, { actions: hudActions }), createElement(Shell, { actions: shellActions, info, hasSave: info.hasSave })));
    opsRoot.render(createElement(Ops, { client, settings: { ...settings }, onSettings: setSetting, onMenu: () => openPause(), onRebind: shellActions.rebind }));
  };
  const afterLoad = () => { player.setPose(0.6, 4.2, -Math.PI / 2, 0); ui.getState().set({ paused: false, mode: "walk", menu: null } as any); void api?.invoke("sim.pause", false); ownedKey = ""; buildShell(); };
  const openPause = () => { if (ui.getState().mode === "seated") game.stand(); player.unlock(); ui.getState().set({ paused: true, mode: "menu", menu: "pause" } as any); void api?.invoke("sim.pause", true); };
  window.addEventListener("keydown", (e) => {
    const st = ui.getState();
    if (e.code === K.pause && isFree(st.mode) && !e.repeat) openPause();
    else if ((e.code === K.pause || e.code === "Escape") && st.mode === "menu" && (st as any).menu === "pause") shellActions.resume();
    if (e.code === K.tablet && (isFree(st.mode))) { e.preventDefault(); st.set({ tablet: !st.tablet }); }
    if (e.code === K.flashlight && isFree(st.mode) && !e.repeat) props.toggleFlashlight();
  });

  // world summary to the HUD, 5 Hz
  const pulses = new Map<string, number>();
  const pushUI = () => ui.getState().set({ world: { ...client.world }, held: client.inventory.find((i) => i.where === "hand") ?? null, cartCount: client.inventory.filter((i) => i.where === "cart").length });
  pushUI(); setInterval(pushUI, 200);
  client.onChange(() => { if (buildShell()) { /* hall opened: handled by props */ } });
  client.onEvent((e) => {
    const st = ui.getState();
    const at = e.target && racks.rackMatrix.get(String(e.target).slice(0, 5)) ? new THREE.Vector3().setFromMatrixPosition(racks.rackMatrix.get(String(e.target).slice(0, 5))!).setY(1.2) : undefined;
    if (e.kind === "alert" && e.text && e.data?.kind !== "delivery" && !/has arrived/.test(e.text)) { st.pushFeed(e.text, (e.data?.severity ?? "warn") as any); }
    if (e.kind === "delivery") { st.pushFeed(e.text ?? "A delivery has arrived in the loading bay.", "info"); audio.play("truck", new THREE.Vector3(-3.5, 1, 7.5)); setTimeout(() => audio.play("roller", new THREE.Vector3(-3.8, 1.5, 7.5)), 1800); }
    if (e.kind === "breaker_trip") { audio.play("breaker", at); st.pushFeed(e.text ?? `Breaker tripped on ${e.target}.`, "critical"); }
    if (e.kind === "job_start") audio.play("gantry", at);
    if (e.kind === "job_done" && e.text) st.pushFeed(e.text, "info");
    if (e.kind === "job_failed" && e.text) st.pushFeed(e.text, "warn");
    if (e.kind === "milestone") { st.pushFeed(`Milestone: ${e.text ?? e.target}`, "info"); audio.play("milestone"); }
    if (e.kind === "hall_bought") { props.revealHall(String(e.target ?? "B")); audio.play("strike", new THREE.Vector3(12, 2, 4.2)); }
    if (e.kind === "order_placed") audio.play("cash");
    checklist.onEvent(e);
    props.onEvent(e);
  });
  const onMcpActivity = (a: any) => {
    checklist.onMcp(a);
    if (!a.write) return;
    ui.getState().pushFeed(`Claude · ${a.tool}${a.target ? " · " + a.target : ""}${a.ok ? "" : " · refused"}`, "claude");
    const rid = a.target && /^[ABC]-R\d\d/.test(a.target) ? String(a.target).slice(0, 5) : null;
    if (rid) { pulses.set(rid, clock.now() + 2000); props.pulse(rid); const m = racks.rackMatrix.get(rid); audio.play("claude", m ? new THREE.Vector3().setFromMatrixPosition(m).setY(1.2) : undefined); }
    else audio.play("claude");
  };
  api?.on("mcp.activity", onMcpActivity);
  api?.on("replay.failed", () => ui.getState().pushFeed("Replay logging stopped: the log could not be written.", "warn"));
  api?.on("app.focus", (on: boolean) => { if (on && !ui.getState().paused) void api.invoke("sim.pause", false); });
  const claudeBanner = (found: boolean | null) => { term.el.querySelector(".term-banner")?.remove(); checklist.claudeMissing = found === false; if (found === false) { const b = document.createElement("div"); b.className = "term-banner"; b.textContent = "Claude Code was not found on your PATH. Install it with: npm install -g @anthropic-ai/claude-code"; term.el.appendChild(b); } };
  api?.on("pty.status", (s: any) => claudeBanner(s.claudeFound));
  void api?.invoke("pty.status").then((s: any) => claudeBanner(s.claudeFound));
  if (!info.mcpUp && api) ui.getState().pushFeed("The facility link is down: the terminal works, but Claude has no game tools this session.", "warn");
  if (!isWebGPU) ui.getState().pushFeed("WebGPU is not available on this machine. Running the compatibility renderer at Medium quality.", "warn");
  rerender();

  // ---------- bookmarks ----------
  let bookmarkY: number | null = null;
  const applyBookmark = (name: string) => {
    const b = BOOKMARKS.find((x) => x.name === name); if (!b) return false;
    player.setPose(b.pos[0], b.pos[2], b.yaw, b.pitch); game.baseFov = b.fov; camera.fov = b.fov; camera.updateProjectionMatrix(); bookmarkY = b.pos[1]; return true;
  };

  // ---------- frame loop ----------
  const timer = new THREE.Timer();
  let menuT = 0;
  let frames = 0, paintT = 0, slowFor = 0, lastT = performance.now();
  const stats = { ms: [] as number[], dt: [] as number[] };
  const hum = new Map<string, HumSource>();
  /** Called about once a second with the 95th-percentile frame interval. Ten slow seconds in a row drop one tier. Never steps up. */
  let unlocked = params.has("unlock");      // tests measure true frame cost with the 60 Hz lock off
  const considerStepDown = (p95: number) => {
    slowFor = p95 > 21 ? slowFor + 1 : 0;       // a missed 60 Hz frame shows up as 25 ms or more; ordinary jitter around 16.7 ms must not count
    if (slowFor < 10) return false;
    slowFor = 0; const order: Settings["graphics.tier"][] = ["Ultra", "High", "Medium"]; const i = order.indexOf(settings["graphics.tier"]);
    if (i < 0 || i >= 2) return false;
    setSetting("graphics.tier", order[i + 1]); setSetting("graphics.steppedDown", `Stepped down from ${order[i]} to ${order[i + 1]} to hold 60 fps.`);
    ui.getState().pushFeed(`Graphics stepped down to ${order[i + 1]} to hold 60 fps.`, "info"); stats.dt.length = 0; return true;
  };
  const frame = (dtOverride?: number) => {
    timer.update(); const dt = dtOverride ?? Math.min(timer.getDelta(), 0.05);
    const t0 = performance.now(); stats.dt.push(t0 - lastT); lastT = t0; if (stats.dt.length > 600) stats.dt.shift();
    if (!capture.offline) clock.advance(dt);
    const st = ui.getState();
    if (!capture.driving) player.update(st.paused ? 0 : dt);
    // main menu: a slow camera drift down the cold aisle behind the menu
    if (st.mode === "menu" && st.menu !== "pause" && st.menu !== "settings" || (st.mode === "menu" && st.menu === "settings" && !(window as any).__fromPause)) { menuT += dt; const u = (Math.sin(menuT * 0.07) * 0.5 + 0.5); camera.position.set(1.2 + u * 7.5, 1.55 + Math.sin(menuT * 0.11) * 0.08, 4.2 + Math.sin(menuT * 0.05) * 0.25); camera.rotation.set(-0.03, -Math.PI / 2 + Math.sin(menuT * 0.09) * 0.07, 0, "YXZ"); }
    if (bookmarkY !== null && !player.locked && isFree(st.mode) && !capture.driving) camera.position.y = bookmarkY; else if (player.locked) { bookmarkY = null; game.baseFov = settings["graphics.fov"]; }
    // exactly one mode at a time: free movement is "carry" while a part, the cart or the rack dolly is in hand
    if (isFree(st.mode)) { const want = client.inventory.some((i) => i.where === "hand") || props.wheeling || props.pushing ? "carry" : "walk"; if (want !== st.mode) st.set({ mode: want }); }
    game.update(dt);
    racks.update(client.world);
    props.update(dt, camera);
    director.update();
    checklist.update(player, game);
    paintT += dt;
    if (paintT > 0.1) {
      paintT = 0;
      if (term.paint()) desk.screens[1].tex.needsUpdate = true;
      // the floor map lives on the ops monitor (Floor tab); the right monitor shows the Mac desktop, or the map while the mirror is off
      paintMap(floorCanvas, client.world, st.feedLog, pulses, clock.now());
      if (!desktop.paint(monCanvases[2])) monCanvases[2].getContext("2d")!.drawImage(floorCanvas, 0, 0);
      desk.screens[2].tex.needsUpdate = true;
      if (!game.seatedReady) { paintOpsSummary(monCanvases[0], client.world); desk.screens[0].tex.needsUpdate = true; }
    }
    // audio: one hum source per rack (rows merge beyond 12 m)
    hum.clear();
    const cp = camera.position;
    for (const r of client.world.racks) {
      const p = slotPose(r.hall, r.slot); const on = r.servers.filter((s) => s && s.power === "on") as any[]; if (!on.length) continue;
      const d = Math.hypot(p.x - cp.x, p.z - cp.z); const key = d > 12 ? `row:${r.hall}:${Math.round(p.z)}` : r.id;
      const cur = hum.get(key); const load = on.reduce((a, s) => a + s.load, 0) / on.length, strain = Math.max(...on.map((s) => (s.tempC - 40) / 50));
      if (cur) { cur.servers += on.length; cur.fanLoad = Math.max(cur.fanLoad, load); cur.strain = Math.max(cur.strain, strain); }
      else hum.set(key, { pos: new THREE.Vector3(p.x, 1.1, p.z), servers: on.length, fanLoad: load, strain });
    }
    const inControl = cp.x < 0 && cp.x > CONTROL.x0 && cp.z > CONTROL.z0 && cp.z < CONTROL.z1;
    const hallNow = cp.z > 9 ? "C" : cp.x > 12 ? "B" : "A";
    // Two roaming shadow spots and two roaming fills follow the player from hall to hall. The light set never changes, so no shader is rebuilt.
    shadowAge++;
    if (shell !== reflShell && frames > 2 && shell.floor.excludeSmall(camera)) reflShell = shell;
    if (hallNow !== lightHall || shell !== lightShell) {
      lightHall = hallNow; lightShell = shell;
      roamSpots.forEach((sp, i) => { const sl = shell.spotSlots[hallNow as "A"][i]; if (!sl) { sp.intensity = 0; return; } sp.intensity = 34; sp.position.set(...sl.pos); sp.target.position.set(...sl.target); sp.target.updateMatrixWorld(); sp.shadow.needsUpdate = true; });
      // every hall keeps its own ceiling area lights (SPEC section 6): they exist from boot, dark until the hall is owned, so the light set never changes
      for (const h of ["A", "B", "C"] as const) hallAreas[h].forEach((rl, i) => { const sl = shell.areaSlots[h][i]; if (!sl) return; rl.color.setHex(sl.hex); rl.width = sl.w; rl.height = sl.h; rl.position.set(...sl.pos); });
    } else if (shadowAge % 30 === 0) roamSpots[0].shadow.needsUpdate = true;       // refresh the shadow map twice a second
    for (const h of ["A", "B", "C"] as const) hallAreas[h].forEach((rl, i) => { const sl = shell.areaSlots[h][i]; rl.intensity = sl ? sl.power * props.areaFactor[h] : 0; });
    // haze: each hall has its own low-density fog volume; the density follows the room you are in
    const fogWant = inControl ? 0.004 : hallNow === "C" ? 0.008 : hallNow === "B" ? 0.011 : 0.010; const fog = scene.fog as THREE.FogExp2; fog.density += (fogWant - fog.density) * Math.min(1, dt * 2);
    rackLightT += dt;
    if (rackLightT > 0.2) {
      rackLightT = 0;
      const near = client.world.racks.map((r) => { const p = slotPose(r.hall, r.slot); return { r, p, d: (p.x - cp.x) ** 2 + (p.z - cp.z) ** 2 }; }).filter((x) => x.d < 64).sort((a, b) => a.d - b.d).slice(0, RACK_LIGHTS);
      rackLights.forEach((pl, i) => {
        const n = near[i]; if (!n) { pl.intensity = 0; return; }
        const live = n.r.servers.filter((sv) => sv && sv.power !== "off") as any[]; const worst = live.some((sv) => sv.status === "failed" || sv.power === "shutdown_thermal") || n.r.breaker === "tripped" ? "failed" : live.some((sv) => sv.status === "degraded") ? "degraded" : "ok";
        const front = n.p.rot === 0 ? 1 : -1;
        pl.position.set(n.p.x, 1.0, n.p.z + front * (RACK.d / 2 + 0.35)); pl.color.setHex(STATUS_HEX[worst]); pl.intensity = live.length ? (worst === "ok" ? 0.9 : 1.8) : 0;
      });
    }
    // reflection probes: rebake when the rack layout or the building changes
    const pk = `${ownedKey}:${client.world.racks.length}`;
    if (pk !== probeKey) { probeKey = pk; probes.request(ownedRooms()); }
    probes.update(inControl ? "control" : (hallNow as ProbeId));
    // depth of field: inspect mode and capture only
    if (game.inspecting && st.mode === "inspect") pipeline.setFocus(camera.position.distanceTo(game.serverPos(game.inspecting)) + 0.1, 1.4);
    else if (capture.offline) pipeline.setFocus(3.2, 0.5);
    else pipeline.setFocus(1, 0);
    let crit: THREE.Vector3 | null = null;
    for (const r of client.world.racks) if (r.breaker === "tripped" || r.servers.some((s) => s && (s.power === "shutdown_thermal" || (s.power === "on" && s.status === "failed")))) { const p = slotPose(r.hall, r.slot); crit = new THREE.Vector3(p.x, 1.6, p.z); break; }
    audio.update(camera, hum, inControl, crit);
    if (isFree(st.mode) && player.stepped > 0) { audio.step(player.stepped, cp.z < 2.1 || cp.z > 6.3); } player.stepped = 0;
    renderer.toneMappingExposure = props.exposure;
    capture.preRender?.();
    pipeline.render();
    capture.afterRender();
    const ms = performance.now() - t0; stats.ms.push(ms); if (stats.ms.length > 600) stats.ms.shift();
    // auto step-down: p95 frame interval over 16.7 ms for 10 s
    if (!test && !capture.driving && !st.paused && frames > 1200 && stats.dt.length >= 300 && frames % 60 === 0 && document.hasFocus() && document.visibilityState === "visible") { /* not while paused, not in the first 20 seconds while shaders build, and only while the window is in front: a covered window is drawn slowly by the system, which says nothing about the tier */ const s2 = [...stats.dt].sort((a, b) => a - b); considerStepDown(s2[Math.floor(s2.length * 0.95)]); }
    frames++;
  };
  capture.frame = frame;
  if (params.has("replay")) capture.offline = true;       // no live frames: an offline render must start from the same renderer state every time
  // In replay mode the animation loop never starts: three advances its frame counter on every display refresh,
  // which would make temporal noise (AO, GI) depend on wall-clock timing and break frame-identical renders.
  // Display loop: locked to 60 Hz unless the lock is switched off in Settings (SPEC section 6: "60 fps is the standard everywhere").
  let lastRender = 0;
  if (!params.has("replay")) renderer.setAnimationLoop(() => {
    if (capture.offline) return;
    if (settings["graphics.vsync"] && !unlocked) { const now = performance.now(); if (now - lastRender < 1000 / 60 - 2.5) return; lastRender = now; }
    frame();
  });

  window.game = { desktop, floorCanvas, game, client, ui, term, overlay, desk, props, renderer, scene, camera, player, racks, audio, capture, director, checklist, settings, setSetting, applyBookmark, stats, shellActions, get frames() { return frames; }, setTier: (t: Tier) => { pipeline.setTier(t); resize(); }, get pipeline() { return pipeline; }, AudioEngine, findServer, RACK, TIERS, GI, TEX, SLOT_GEO, wideMRT, get reflectionSkipsSmallProps() { return reflShell === shell; }, probes, keys: K, setUnlocked: (v: boolean) => { unlocked = v; }, considerStepDown, deviceLost, isWebGPU, THREE, get shell() { return shell; } };

  // ---------- start state ----------
  const wait = (n: number) => new Promise<void>((res) => { const s0 = frames; const iv = setInterval(() => { if (frames - s0 >= n) { clearInterval(iv); res(); } }, 20); });
  window.game.wait = wait;
  const shots: string[] = (await api?.shots.list()) ?? [];
  if (info.preset && info.preset !== "fresh") checklist.reset(false);
  if (test || info.preset || resumed) { ui.getState().set({ mode: "walk", menu: null, paused: false } as any); if (resumed) { checklist.reset(false); ui.getState().pushFeed("The graphics device was reset. The facility kept running.", "info"); } }
  else { ui.getState().set({ mode: "menu", menu: settings["first.noticesSeen"] ? "main" : "notice1", paused: true } as any); void api?.invoke("sim.pause", true); }
  rerender();

  if (info.selftest) {
    // self-test (scripts/test-second-account.sh): boot, world present, the real shell answers
    await wait(60); const token = "selftest-" + Date.now();
    for (let i = 0; i < 100 && term.status !== "running"; i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 1500)); api.send("pty.input", `printf '%s\\n' ${token}\r`);
    let echoed = false; for (let i = 0; i < 80 && !echoed; i++) { await new Promise((r) => setTimeout(r, 100)); echoed = term.text().split("\n").some((l) => l.trim() === token); }
    const racksN = client.world.racks.length;
    await api.invoke("app.selftest", { pass: racksN === 2 && echoed && frames > 60 && info.mcpUp, racks: racksN, terminal: echoed, frames, mcpUp: info.mcpUp, user: info.userData });
    return;
  }
  if (params.has("replay")) {
    try { const r = await capture.runReplay(term, (msgs) => (client as IpcClient).ingest(msgs, (ch, a) => { if (ch === "mcp.activity") onMcpActivity(a[0]); })); console.warn(`replay-done frames=${r.frames} hash=${r.hash}`); } catch (e: any) { console.error("replay failed", e?.stack ?? e); }
    await api.shots.done(); return;
  }
  if (shots.length) {
    for (const name of shots) {
      const bm = BOOKMARKS.find((x) => x.name === name);
      if (ui.getState().mode === "seated") { game.stand(); await wait(60); }
      if (ui.getState().mode === "inspect") { game.closeInspect(); await wait(90); }
      applyBookmark(name);
      if (bm?.mode === "pulled" || bm?.mode === "exploded") {
        await client.send({ type: "setRackDoor", rack: "A-R01", open: true, by: "player" });
        await wait(40); game.openInspect("A-R01-S03"); await wait(110);
        if (bm.mode === "exploded") { game.toggleExplode(); await wait(60); }
      }
      if (bm?.mode === "seated") { game.sit(); await wait(120); }
      const r = await api.shots.js(); if (r != null) console.warn("js:", JSON.stringify(r));
      await wait(50);
      await api.shots.capture(name);
    }
    const s = [...stats.ms].sort((a, b) => a - b), d = [...stats.dt].sort((a, b) => a - b);
    console.warn(`cpu-frame p50=${s[Math.floor(s.length / 2)]?.toFixed(2)}ms p95=${s[Math.floor(s.length * 0.95)]?.toFixed(2)}ms interval-p95=${d[Math.floor(d.length * 0.95)]?.toFixed(2)}ms calls=${(renderer.info.render as any).drawCalls ?? (renderer.info.render as any).calls}`);
    await api.shots.done();
  }
}
/** Recover screen (SPEC appendix L): shown for a failed boot and for any uncaught error afterwards. The sim and the terminal live in the main process, so Reload loses nothing. */
function recover(e: any): void {
  if (document.getElementById("recover")) return;
  console.error("UNCAUGHT", e?.stack ?? e);
  document.body.insertAdjacentHTML("beforeend", `<div id="recover" style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;color:#e8edf2;z-index:99;background:rgba(5,7,10,.94)"><div style="font-size:18px;font-weight:600">UPTIME hit a problem</div><div style="color:#8e99a6;max-width:560px;text-align:center">${String(e?.message ?? e).replace(/[<>&]/g, "").slice(0, 300)}</div><div><button id="recover-reload" style="padding:8px 16px">Reload</button> <button id="recover-logs" style="padding:8px 16px">Open logs</button></div></div>`);
  document.getElementById("recover-reload")!.onclick = () => { sessionStorage.setItem("uptime.resume", "1"); location.reload(); };
  document.getElementById("recover-logs")!.onclick = () => void window.uptime?.invoke("app.openLogs");
}
window.addEventListener("error", (ev) => { if (ev.error instanceof Error) recover(ev.error); });        // real script errors only: not resource or observer notices
window.addEventListener("unhandledrejection", (ev) => console.error("unhandled rejection", ev.reason?.stack ?? ev.reason));
boot().catch(recover);
