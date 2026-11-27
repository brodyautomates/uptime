// Modes, interaction and the hands-on rack/server flow (SPEC section 7).
import * as THREE from "three/webgpu";
import { RACK, SEAT_EYE, EYE, MONITOR } from "@shared/layout";
import type { ServerView, InvItem } from "@shared/view";
import { Racks, SERVER_FRONT_Z, bayY, SERVER_W, SERVER_H } from "./world/racks";
import { ServerModel, SLOT_GEO, SLOTS, slotFamily, FAMILY_LABEL, type SlotId } from "./world/serverModel";
import { Tweens, easeInOut, easeOut } from "./util/tween";
import { Player } from "./player/controller";
import { findServer, findRack, type Client } from "./client";
import { ui, isFree } from "./ui/store";
import { clock } from "./clock";
import { keys as K, label as keyLabel } from "./keys";

export const PULL = 0.55;                 // metres a server slides out on its rails (SPEC section 7)
const HOT = new Set(["DRV", "PSU", "FAN"]);

export interface Target { id: string; min: THREE.Vector3; max: THREE.Vector3; prompt: () => string; card?: () => { title: string; lines: string[] } | null; use: () => void; alt?: () => void; reach?: number }

export class Game {
  tweens = new Tweens();
  model: ServerModel;
  targets: Target[] = [];                 // generic world targets (desk, crates, breakers…)
  private camFrom = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: 75 };
  private camTo = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: 75 };
  private camBlend = 1;                   // 1 = at target / player-controlled
  private camLocked = false;              // camera driven by a fixed pose (inspect / seated)
  inspecting: string | null = null;
  private silentInspect = false;
  private workLight: THREE.SpotLight;
  private hl: THREE.LineSegments;
  private mouse = new THREE.Vector2(0, 0);
  private current: { kind: "door" | "server" | "target"; id: string; t?: Target } | null = null;
  onSit: () => void = () => {}; onStand: () => void = () => {}; onFocus: (i: 0 | 1 | 2) => void = () => {};
  seatedReady = false;
  monitorCentre: ((i: number) => THREE.Vector3) | null = null;
  monitorNormal: ((i: number) => THREE.Vector3) | null = null;
  onSeatMove: () => void = () => {};
  private pendingSeat = 0; private seatMoving = 0;
  sounds: (name: string, at?: THREE.Vector3) => void = () => {};
  cameraEase = true;
  forceDoor = new Set<string>();                 // racks the gantry is holding open
  bayTarget: ((rack: string, bay: number) => Target | null) | null = null;
  rackTarget: ((rack: string) => Target | null) | null = null;

  constructor(public camera: THREE.PerspectiveCamera, public player: Player, public racks: Racks, public client: Client, scene: THREE.Scene, faceMap: THREE.Texture | null) {
    this.model = new ServerModel(faceMap);
    scene.add(this.model.group);
    this.workLight = new THREE.SpotLight(0xfff1dc, 0, 3.2, 0.7, 0.6, 1.4);
    scene.add(this.workLight); scene.add(this.workLight.target);
    this.hl = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicNodeMaterial({ color: 0xcfe6ff, transparent: true, opacity: 0.9 })); this.hl.visible = false; this.hl.renderOrder = 9; scene.add(this.hl);
    window.addEventListener("mousemove", (e) => { this.mouse.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1); });
    window.addEventListener("keydown", (e) => this.key(e));
    window.addEventListener("keydown", (e) => {
      if (this.mode !== "seated" || !e.metaKey) return;
      if (e.code === "KeyE") { e.preventDefault(); e.stopPropagation(); this.stand(); }
      if (e.code === "Digit0") { e.preventDefault(); e.stopPropagation(); this.overview(); }
      const d = ["Digit1", "Digit2", "Digit3"].indexOf(e.code);
      if (d >= 0) { e.preventDefault(); e.stopPropagation(); this.focusMonitor(d as 0 | 1 | 2); }
    }, true);
    window.addEventListener("mousedown", (e) => { if (ui.getState().mode === "inspect" && e.button === 0 && (e.target as HTMLElement)?.id === "view") this.clickPart(e); });
  }

  get mode() { return ui.getState().mode; }
  /** The rack under the crosshair, or the nearest one. */
  lookRack(): string | null {
    const c = this.current; if (c?.kind === "door") return c.id; if (c?.kind === "server") return c.id.slice(0, 5); if (c?.kind === "target" && /^[ABC]-R\d\d/.test(c.id)) return c.id.slice(0, 5);
    let best: string | null = null, bd = 1e9;
    for (const [id, m] of this.racks.rackMatrix) { const d = Math.hypot(m.elements[12] - this.camera.position.x, m.elements[14] - this.camera.position.z); if (d < bd) { bd = d; best = id; } }
    return best;
  }

  // ---------- input ----------
  private key(e: KeyboardEvent): void {
    const st = ui.getState();
    if (st.mode === "seated" || st.mode === "menu") return;
    if (e.repeat) return;
    if (e.code === K.hud) ui.getState().set({ hudHidden: !st.hudHidden });
    if (isFree(st.mode)) {
      if (e.code === K.use) this.use();
      if (e.code === K.putBack) this.alt();
    } else if (st.mode === "inspect") {
      if (e.code === K.putBack || e.code === "Escape") { if (st.partMenu) st.set({ partMenu: null }); else this.closeInspect(); }
      if (e.code === K.explode) this.toggleExplode();
    }
  }

  private use(): void {
    const c = this.current; if (!c) return;
    if (c.kind === "door") { void this.client.send({ type: "setRackDoor", rack: c.id, open: true, by: "player" }); }
    else if (c.kind === "server") this.openInspect(c.id);
    else c.t!.use();
  }
  /** called when Q is pressed with nothing under the crosshair (leave the cart or dolly) */
  onIdleAlt: () => void = () => {};
  private alt(): void {
    const c = this.current; if (!c) { this.onIdleAlt(); return; }
    if (c.kind === "server") { const e = this.racks.serverIndex.get(c.id); if (e) void this.client.send({ type: "setRackDoor", rack: e.rack, open: false, by: "player" }); }
    else if (c.kind === "target") c.t!.alt?.();
  }

  // ---------- targeting (walk mode) ----------
  private ray = new THREE.Ray(); private inv = new THREE.Matrix4(); private tmp = new THREE.Vector3(); private tmp2 = new THREE.Vector3();
  private pickWalk(): void {
    const cam = this.camera;
    const origin = cam.getWorldPosition(new THREE.Vector3()), dir = cam.getWorldDirection(new THREE.Vector3());
    let best: { d: number; kind: "door" | "server" | "target"; id: string; t?: Target } | null = null;
    const w = this.client.world;
    for (const rack of w.racks) {
      const rm = this.racks.rackMatrix.get(rack.id); if (!rm) continue;
      const dx = rm.elements[12] - origin.x, dz = rm.elements[14] - origin.z;
      if (dx * dx + dz * dz > 9) continue;
      this.inv.copy(rm).invert();
      this.ray.origin.copy(origin).applyMatrix4(this.inv); this.ray.direction.copy(dir).transformDirection(this.inv);
      if (this.ray.direction.z > 1e-4) {
        // from behind: the rear PDU. Shows the load; E resets a tripped breaker (SPEC section 9: "E on the PDU")
        const tb = (-RACK.d / 2 - this.ray.origin.z) / this.ray.direction.z; const bx2 = this.ray.origin.x + this.ray.direction.x * tb, by2 = this.ray.origin.y + this.ray.direction.y * tb;
        if (tb > 0 && tb < 2.4 && Math.abs(bx2) < RACK.w / 2 && by2 > 0.3 && by2 < 1.7 && (!best || tb < best.d)) {
          const tripped = rack.breaker === "tripped";
          best = { d: tb, kind: "target", id: rack.id + ":pdu", t: { id: rack.id + ":pdu", min: this.tmp, max: this.tmp2, prompt: () => (tripped ? "E  reset breaker" : ""), card: () => ({ title: `${rack.id} PDU`, lines: [`${rack.kw.toFixed(1)} / ${rack.pduCapKw} kW`, tripped ? "Breaker tripped" : "Breaker closed"] }), use: () => { if (tripped) { void this.client.send({ type: "resetBreaker", rack: rack.id, by: "player" }); this.sounds("breaker"); } } } };
        }
        continue;
      }
      if (this.ray.direction.z >= -1e-4) continue;                     // must look toward the rack front (-z in rack space)
      const planeZ = rack.doorOpen ? SERVER_FRONT_Z : RACK.d / 2;
      const t = (planeZ - this.ray.origin.z) / this.ray.direction.z;
      if (t < 0 || t > 2.4) continue;
      const hx = this.ray.origin.x + this.ray.direction.x * t, hy = this.ray.origin.y + this.ray.direction.y * t;
      if (Math.abs(hx) > RACK.w / 2 || hy < 0.05 || hy > RACK.h) continue;
      if (!rack.doorOpen) { const rt = this.rackTarget?.(rack.id); if (!best || t < best.d) best = rt ? { d: t, kind: "target", id: rack.id, t: rt } : { d: t, kind: "door", id: rack.id }; continue; }
      const bay = Math.floor((hy - RACK.bayBase) / RACK.bayH) + 1;
      const s = rack.servers[bay - 1];
      if (bay >= 1 && bay <= RACK.bays && s && (!best || t < best.d)) best = { d: t, kind: "server", id: s.id };
      else if (bay >= 1 && bay <= RACK.bays && !s && (!best || t < best.d)) { const bt = this.bayTarget?.(rack.id, bay); best = bt ? { d: t, kind: "target", id: `${rack.id}:${bay}`, t: bt } : { d: t, kind: "target", id: rack.id + ":door", t: { id: rack.id, min: this.tmp, max: this.tmp2, prompt: () => "Q  close door", use: () => {}, alt: () => void this.client.send({ type: "setRackDoor", rack: rack.id, open: false, by: "player" }) } }; }
    }
    for (const tg of this.targets) {
      const hit = rayBox(origin, dir, tg.min, tg.max);
      if (hit !== null && hit < (tg.reach ?? 2.4) && (!best || hit < best.d)) best = { d: hit, kind: "target", id: tg.id, t: tg };
    }
    this.current = best;
    // highlight what is under the crosshair (SPEC section 7 step 1)
    if (best && (best.kind === "door" || best.kind === "server")) {
      const rid = best.kind === "door" ? best.id : best.id.slice(0, 5); const rm = this.racks.rackMatrix.get(rid)!;
      if (best.kind === "door") { this.hl.scale.set(RACK.w - 0.02, RACK.h - 0.06, 0.03); this.hl.position.set(0, RACK.h / 2, RACK.d / 2 + 0.01).applyMatrix4(rm); }
      else { const bay = Number(best.id.slice(-2)); this.hl.scale.set(SERVER_W + 0.04, SERVER_H, 0.02); this.hl.position.set(0, bayY(bay), SERVER_FRONT_Z + 0.006).applyMatrix4(rm); }
      this.hl.quaternion.setFromRotationMatrix(rm); this.hl.visible = true;
    } else this.hl.visible = false;
    const st = ui.getState();
    let prompt = "", card: { title: string; lines: string[] } | null = null;
    if (best?.kind === "door") prompt = "E  open door";
    else if (best?.kind === "server") {
      const s = findServer(w, best.id)!;
      prompt = "E  pull out     Q  close door";
      card = { title: s.id, lines: [stateText(s), `${Math.round(s.tempC)} °C   load ${Math.round(s.load * 100)}%`] };
    } else if (best?.kind === "target") { prompt = best.t!.prompt(); card = best.t!.card?.() ?? null; }
    prompt = prompt.replace(/^E  /, `${keyLabel(K.use)}  `).replace(/     Q  /, `     ${keyLabel(K.putBack)}  `).replace(/^Q  /, `${keyLabel(K.putBack)}  `);
    if (prompt !== st.prompt || JSON.stringify(card) !== JSON.stringify(st.card)) st.set({ prompt, card });
  }

  // ---------- inspect ----------
  openInspect(id: string, silent = false): void {
    const e = this.racks.serverIndex.get(id); if (!e || this.inspecting) return;
    this.silentInspect = silent;
    if (!silent) void this.client.send({ type: "pullServer", server: id, by: "player" });
    if (!silent) this.client.watchServer(id);        // in a replay the capture loop requests the detail itself, in step with its frames
    this.inspecting = id;
    this.racks.hidden.add(id); this.racks.inspect = { rack: e.rack, bay: e.bay };
    this.model.group.visible = true; this.model.setLid(0); this.model.setExplode(0);
    const s = findServer(this.client.world, id)!;
    if (s.slots) this.model.sync(s);
    this.sounds("rail", this.serverPos(id));
    this.tweens.to("pull:" + id, PULL, 0.6, (v) => this.racks.setPull(id, v), easeInOut, () => {
      this.tweens.to("lid", 1, 0.4, (v) => this.model.setLid(v), easeOut, undefined, 0);
      this.sounds("latch", this.serverPos(id));
    }, 0);
    // camera pose: three-quarter view above the pulled chassis
    const rm = this.racks.rackMatrix.get(e.rack)!;
    const local = new THREE.Vector3(0.0, bayY(e.bay) + 0.6, SERVER_FRONT_Z + PULL + 0.24);
    const look = new THREE.Vector3(0, bayY(e.bay) - 0.04, SERVER_FRONT_Z + PULL - 0.43);
    this.flyTo(local.applyMatrix4(rm), look.applyMatrix4(rm), 50, 0.6);
    this.workLight.position.copy(new THREE.Vector3(0.25, bayY(e.bay) + 0.9, SERVER_FRONT_Z + PULL + 0.1).applyMatrix4(rm));
    this.workLight.target.position.copy(new THREE.Vector3(0, bayY(e.bay), SERVER_FRONT_Z + PULL - 0.43).applyMatrix4(rm));
    this.tweens.to("work", 1, 0.6, (v) => (this.workLight.intensity = v * 9), easeInOut, undefined, 0);
    this.player.enabled = false; this.player.unlock();
    ui.getState().set({ mode: "inspect", prompt: "", card: null, inspect: { server: s, hover: null, exploded: false }, partMenu: null });
  }

  /** Open a server for inspection without a player command (replay). */
  forceInspect(id: string): void { const e = this.racks.serverIndex.get(id); if (e) this.forceDoor.add(e.rack); this.racks.setDoorAngle(e?.rack ?? "", 1.95); this.openInspect(id, true); }

  closeInspect(): void {
    const id = this.inspecting; if (!id) return;
    ui.getState().set({ partMenu: null, labels: [] });
    this.tweens.to("explode", 0, 0.25, (v) => this.model.setExplode(v));
    this.tweens.to("lid", 0, 0.3, (v) => this.model.setLid(v), easeOut, () => {
      this.sounds("rail", this.serverPos(id));
      this.tweens.to("pull:" + id, 0, 0.5, (v) => this.racks.setPull(id, v), easeInOut, () => {
        this.racks.hidden.delete(id); this.racks.inspect = null; this.racks.setPull(id, 0); this.model.group.visible = false;
        if (!this.silentInspect) void this.client.send({ type: "pushServer", server: id, by: "player" });
        if (!this.silentInspect) this.client.watchServer(null);
        this.inspecting = null;
      });
    });
    this.releaseCamera(0.5);
    this.tweens.to("work", 0, 0.4, (v) => (this.workLight.intensity = v * 9));
    ui.getState().set({ mode: "walk", inspect: null, pinned: null });
    this.player.enabled = true;
  }

  toggleExplode(): void {
    const st = ui.getState(); if (!st.inspect) return;
    const ex = !st.inspect.exploded;
    st.set({ inspect: { ...st.inspect, exploded: ex }, partMenu: null });
    this.tweens.to("explode", ex ? 1 : 0, 0.5, (v) => this.model.setExplode(v));
    const e = this.racks.serverIndex.get(this.inspecting!)!; const rm = this.racks.rackMatrix.get(e.rack)!;
    const local = ex ? new THREE.Vector3(0.5, bayY(e.bay) + 0.62, SERVER_FRONT_Z + PULL + 0.34) : new THREE.Vector3(0.0, bayY(e.bay) + 0.6, SERVER_FRONT_Z + PULL + 0.24);
    const look = ex ? new THREE.Vector3(0.04, bayY(e.bay) + 0.14, SERVER_FRONT_Z + PULL - 0.43) : new THREE.Vector3(0, bayY(e.bay) - 0.04, SERVER_FRONT_Z + PULL - 0.43);
    this.flyTo(local.applyMatrix4(rm), look.applyMatrix4(rm), ex ? 58 : 50, 0.5);
  }

  private clickPart(e: MouseEvent): void {
    const st = ui.getState(); const ins = st.inspect; if (!ins) return;
    const slot = this.model.hit(this.camera, this.mouse);
    if (!slot) { st.set({ partMenu: null }); return; }
    const part = ins.server.slots?.[slot] ?? null;
    const fam = slotFamily(slot);
    const options = this.client.inventory.filter((i) => i.family === fam);
    const TIER1: Record<string, [string, string]> = { cpu: ["cpu.k1", "Kestrel CPU K1"], gpu: ["gpu.v1", "Vanta GPU V1"], ram: ["ram.s1", "Strata RAM S1"], drv: ["drv.f1", "Flux drive F1"], psu: ["psu.b1", "Bastion PSU B1"], fan: ["fan.z1", "Zephyr fan Z1"], nic: ["nic.l1", "Lumen NIC L1"] };
    st.set({ partMenu: { slot, part, x: e.clientX, y: e.clientY, options, orderSku: TIER1[fam][0], orderName: TIER1[fam][1] } });
  }

  /** True while a swap animation is running; further part actions wait for it. */
  swapping = false;
  private anim(key: string, from: number, to: number, dur: number, set: (v: number) => void): Promise<void> { return new Promise((res) => this.tweens.to(key, to, dur, set, easeInOut, res, from)); }
  private wait(dur: number): Promise<void> { return this.anim("wait:" + Math.random(), 0, 1, dur, () => {}); }

  /** Latch opens (0.2 s), the part lifts out (0.4 s), then it is in your hand. */
  async removePart(slot: string): Promise<boolean> {
    if (this.swapping) return false; const sl = slot as SlotId; const id = this.inspecting; if (!id) return false;
    ui.getState().set({ partMenu: null });
    // ask first: a refusal must not play the animation
    const srv = findServer(this.client.world, id); const fam = slot.slice(0, 3);
    if (srv?.slots?.[slot] && !HOT.has(fam) && srv.power !== "off") { this.refuse(sl, "Power the server off before removing this part."); return false; }
    this.swapping = true;
    try {
      if (srv?.slots?.[slot]) { this.sounds("latch", this.serverPos(id)); await this.wait(0.2); await this.anim("lift:" + slot, 0, 1, 0.4, (v) => this.model.setLift(sl, v)); }
      const r = await this.client.send({ type: "removePart", server: id, slot, by: "player" });
      this.model.setLift(sl, 0);
      if (!r.ok) { this.refuse(sl, r.message); return false; }
      return true;
    } finally { this.swapping = false; }
  }
  /** Swap or install: the old part comes out as above, the new part drops in (0.4 s) and the latch closes (0.2 s). 1.2 s for a swap. */
  async installPart(slot: string, part: string): Promise<boolean> {
    if (this.swapping) return false; const sl = slot as SlotId; const id = this.inspecting; if (!id) return false;
    ui.getState().set({ partMenu: null });
    const srv = findServer(this.client.world, id); const fam = slot.slice(0, 3);
    if (!HOT.has(fam) && srv && srv.power !== "off") { this.refuse(sl, "Power the server off before changing this part."); return false; }
    this.swapping = true;
    try {
      if (srv?.slots?.[slot]) {
        this.sounds("latch", this.serverPos(id)); await this.wait(0.2); await this.anim("lift:" + slot, 0, 1, 0.4, (v) => this.model.setLift(sl, v));
        const r0 = await this.client.send({ type: "removePart", server: id, slot, by: "player", toShelf: true });
        if (!r0.ok) { this.model.setLift(sl, 0); this.refuse(sl, r0.message); return false; }
      }
      this.model.setLift(sl, 1);
      const r = await this.client.send({ type: "installPart", server: id, slot, part, by: "player" });
      if (!r.ok) { this.model.setLift(sl, 0); this.refuse(sl, r.message); return false; }
      // wait for the new part to appear in the model, then lower it
      for (let i = 0; i < 20 && !findServer(this.client.world, id)?.slots?.[slot]; i++) await this.wait(0.05);
      await this.anim("lift:" + slot, 1, 0, 0.4, (v) => this.model.setLift(sl, v));
      this.sounds("seat", this.serverPos(id)); await this.wait(0.2);
      return true;
    } finally { this.model.setLift(sl, 0); this.swapping = false; }
  }
  /** "Order now" from the part menu: one of that part, express. */
  async orderNow(sku: string): Promise<void> {
    ui.getState().set({ partMenu: null });
    const r = await this.client.send({ type: "placeOrder", lines: [{ sku, qty: 1 }], express: true, by: "player" });
    ui.getState().pushFeed(r.ok ? `Ordered 1 x ${sku}, express. It arrives in the loading bay in about 20 seconds.` : r.message, r.ok ? "info" : "warn"); if (!r.ok) this.sounds("deny");
  }
  /** "Info" from the part menu: pin that slot's card in the panel. */
  pinInfo(slot: string): void { const st = ui.getState(); st.set({ partMenu: null, pinned: st.pinned === slot ? null : slot }); }
  async togglePower(): Promise<void> {
    const srv = findServer(this.client.world, this.inspecting!); if (!srv) return;
    const r = await this.client.send({ type: "setServerPower", server: srv.id, on: srv.power === "off", by: "player" });
    if (!r.ok) ui.getState().pushFeed(r.message, "warn"); else this.sounds("click", this.serverPos(srv.id));
  }
  private refuseUntil = 0; private refuseSlot: SlotId | null = null;
  private refuse(slot: SlotId, message: string): void {
    this.refuseSlot = slot; this.refuseUntil = clock.now() + 900;
    ui.getState().pushFeed(message, "warn"); this.sounds("deny");
  }

  serverPos(id: string): THREE.Vector3 { const m = this.racks.serverMatrix(id); return m ? new THREE.Vector3().setFromMatrixPosition(m) : new THREE.Vector3(); }

  // ---------- seated ----------
  sit(): void {
    if (!isFree(this.mode)) return;
    this.player.enabled = false; this.player.unlock();
    ui.getState().set({ mode: "seated", prompt: "", card: null });
    this.seatedReady = false;
    this.flyTo(new THREE.Vector3(SEAT_EYE.x, SEAT_EYE.y, SEAT_EYE.z), new THREE.Vector3(SEAT_EYE.x + 1, SEAT_EYE.y - 0.06, SEAT_EYE.z), SEAT_EYE.fov, 0.7, () => { if (this.mode === "seated") { this.pendingSeat = 2; } });
    this.sounds("chair");
  }
  stand(): void {
    if (this.mode !== "seated") return;
    this.seatedReady = false; this.onStand();
    this.player.setPose(SEAT_EYE.x - 0.55, SEAT_EYE.z + 0.75, -Math.PI / 2, 0);
    this.releaseCamera(0.6);
    ui.getState().set({ mode: "walk" });
    this.player.enabled = true;
    this.sounds("chair");
  }
  focusMonitor(i: 0 | 1 | 2): void {
    ui.getState().set({ focusMonitor: i }); this.onFocus(i);
    // lean in so the focused screen fills the view: its text is then as large as the window allows
    const c = this.monitorCentre?.(i);
    if (c && this.seatedReady) {
      // face the screen dead on: the eye moves onto the line straight out of the screen's centre
      const n = this.monitorNormal?.(i) ?? new THREE.Vector3(-1, 0, 0), d = 0.8, aspect = window.innerWidth / window.innerHeight;
      const fov = Math.max(2 * Math.atan(MONITOR.h / 2 / d), 2 * Math.atan(MONITOR.w / 2 / d / aspect)) * (180 / Math.PI) * 1.1;
      this.flyTo(c.clone().addScaledVector(n, d), c.clone(), fov, 0.3);
    }
  }
  /** Sit back: all three screens in view. */
  overview(): void {
    if (this.seatedReady) this.flyTo(new THREE.Vector3(SEAT_EYE.x, SEAT_EYE.y, SEAT_EYE.z), new THREE.Vector3(SEAT_EYE.x + 1, SEAT_EYE.y - 0.06, SEAT_EYE.z), SEAT_EYE.fov, 0.3);
  }

  // ---------- camera ----------
  flyTo(pos: THREE.Vector3, look: THREE.Vector3, fov: number, dur: number, done?: () => void): void {
    this.camFrom.pos.copy(this.camera.position); this.camFrom.quat.copy(this.camera.quaternion); this.camFrom.fov = this.camera.fov;
    this.camTo.pos.copy(pos); this.camTo.fov = fov;
    const m = new THREE.Matrix4().lookAt(pos, look, new THREE.Vector3(0, 1, 0));
    this.camTo.quat.setFromRotationMatrix(m);
    this.camLocked = true;
    this.tweens.to("cam", 1, this.cameraEase ? dur : 0, (v) => (this.camBlend = v), easeInOut, done, 0);
  }
  /** Hand the camera back to the player controller with an ease. */
  releaseCamera(dur: number): void {
    this.camFrom.pos.copy(this.camera.position); this.camFrom.quat.copy(this.camera.quaternion); this.camFrom.fov = this.camera.fov;
    const p = this.player;
    this.camTo.pos.set(p.pos.x, EYE, p.pos.z);
    this.camTo.quat.setFromEuler(new THREE.Euler(p.pitch, p.yaw, 0, "YXZ")); this.camTo.fov = this.baseFov;
    this.tweens.to("cam", 1, this.cameraEase ? dur : 0, (v) => (this.camBlend = v), easeInOut, () => { this.camLocked = false; }, 0);
  }
  baseFov = 75;

  // ---------- frame ----------
  update(dt: number): void {
    this.tweens.update(dt);
    const w = this.client.world;
    // doors follow sim state
    for (const r of w.racks) {
      const want = r.doorOpen || this.forceDoor.has(r.id) ? 1.95 : 0;
      const key = "door:" + r.id;
      if (this.tweens.get(key) !== want && !this.tweens.busy(key)) { this.tweens.to(key, want, 0.45, (v) => this.racks.setDoorAngle(r.id, v)); this.sounds("door", new THREE.Vector3().setFromMatrixPosition(this.racks.rackMatrix.get(r.id) ?? new THREE.Matrix4())); }
    }
    if (this.camLocked) {
      this.camera.position.lerpVectors(this.camFrom.pos, this.camTo.pos, this.camBlend);
      this.camera.quaternion.slerpQuaternions(this.camFrom.quat, this.camTo.quat, this.camBlend);
      const fov = this.camFrom.fov + (this.camTo.fov - this.camFrom.fov) * this.camBlend;
      if (Math.abs(fov - this.camera.fov) > 0.01) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
    } else if (Math.abs(this.camera.fov - this.baseFov) > 0.01 && isFree(this.mode)) { this.camera.fov = this.baseFov; this.camera.updateProjectionMatrix(); }

    if (this.seatedReady && this.tweens.busy("cam")) this.seatMoving = 2;
    if (this.seatMoving > 0) { this.seatMoving--; this.camera.updateMatrixWorld(true); this.onSeatMove(); }
    if (this.pendingSeat > 0 && --this.pendingSeat === 0 && this.mode === "seated") { this.camera.updateMatrixWorld(true); this.seatedReady = true; this.onSit(); this.focusMonitor(ui.getState().focusMonitor); }
    const st = ui.getState();
    if (isFree(st.mode)) this.pickWalk(); else this.hl.visible = false;
    if (this.inspecting) {
      const m = this.racks.serverMatrix(this.inspecting);
      if (m) { this.model.group.matrixAutoUpdate = false; this.model.group.matrix.copy(m); this.model.group.matrixWorldNeedsUpdate = true; this.model.group.updateMatrixWorld(true); }
      const s = findServer(w, this.inspecting);
      if (s?.slots) this.model.sync(s);
      this.model.update(dt);
      if (st.mode === "inspect" && st.inspect && s) {
        const slot = st.partMenu ? (st.partMenu.slot as SlotId) : this.model.hit(this.camera, this.mouse);
        const refusing = clock.now() < this.refuseUntil;
        this.model.highlight(refusing ? this.refuseSlot : slot, refusing ? 0xff3b30 : 0xffffff);
        const hover = slot ? { slot, part: s.slots?.[slot] ?? null } : null;
        const labels = st.inspect.exploded && this.tweens.get("explode") > 0.9 ? this.buildLabels(s) : [];
        if (hover?.slot !== st.inspect.hover?.slot || hover?.part?.id !== st.inspect.hover?.part?.id || st.inspect.server !== s || labels.length !== st.labels.length || (labels.length && Math.abs(labels[0].x - st.labels[0].x) > 0.5))
          st.set({ inspect: { ...st.inspect, server: s, hover }, labels });
      }
    }
  }

  private buildLabels(s: ServerView) {
    const v = new THREE.Vector3(); const out: any[] = [];
    // one label per family group, anchored at the first filled slot of that group
    const groups: [string, SlotId[]][] = [["CPU", ["CPU1", "CPU2"]], ["Memory", ["RAM1", "RAM5"]], ["GPU", ["GPU1", "GPU2", "GPU3", "GPU4"]], ["Drives", ["DRV1", "DRV2", "DRV3", "DRV4"]], ["Power", ["PSU1", "PSU2"]], ["Fans", ["FAN1", "FAN2", "FAN3", "FAN4"]], ["Network", ["NIC1"]]];
    for (const [name, slots] of groups) {
      const fam = slotFamily(slots[0]);
      const all = SLOTS.filter((x) => slotFamily(x) === fam);
      const parts = all.map((x) => s.slots?.[x]).filter(Boolean) as any[];
      if (!parts.length) continue;
      const anchor = name === "GPU" || name === "Drives" || name === "Fans" ? all[all.length - 1] : slots[slots.length - 1];
      this.model.slotWorld(anchor, v); v.y += SLOT_GEO[anchor].size[1] / 2 + 0.01; v.project(this.camera);
      const worst = parts.some((p) => p.status === "failed") ? "failed" : parts.some((p) => p.status === "degraded") ? "degraded" : "ok";
      const tiers = [...new Set(parts.map((p) => p.tier))].sort();
      const ax = (v.x * 0.5 + 0.5) * window.innerWidth, ay = (-v.y * 0.5 + 0.5) * window.innerHeight;
      out.push({ slot: anchor, ax, ay, x: ax + 46, y: ay - 26, text: `${name} × ${parts.length}`, sub: `tier ${tiers.join(", ")}`, tier: Math.max(...tiers), status: worst });
    }
    // resolve overlaps: push labels apart vertically
    out.sort((a, b) => a.y - b.y);
    for (let i = 1; i < out.length; i++) if (out[i].y - out[i - 1].y < 44 && Math.abs(out[i].x - out[i - 1].x) < 170) out[i].y = out[i - 1].y + 44;
    return out;
  }
}

function stateText(s: ServerView): string {
  if (s.power === "off") return "Powered off";
  if (s.power === "booting") return "Booting";
  if (s.power === "shutdown_thermal") return "Thermal shutdown";
  if (s.power === "no_power") return "No power";
  return s.status === "ok" ? "Healthy" : s.status === "degraded" ? "Degraded part" : "Failed part";
}

function rayBox(o: THREE.Vector3, d: THREE.Vector3, min: THREE.Vector3, max: THREE.Vector3): number | null {
  let t0 = 0, t1 = Infinity;
  for (const a of ["x", "y", "z"] as const) {
    const inv = 1 / d[a]; let n = (min[a] - o[a]) * inv, f = (max[a] - o[a]) * inv;
    if (n > f) [n, f] = [f, n];
    t0 = Math.max(t0, n); t1 = Math.min(t1, f);
    if (t0 > t1) return null;
  }
  return t0;
}
export { HOT, FAMILY_LABEL, SERVER_W, SERVER_H, SEAT_EYE };
export type { InvItem };
