// Everything that moves in the building besides racks: deliveries, the gantry, rack and chassis placement,
// the parts shelf, breakers, Claude's pulse rings, the wall display, the flashlight and the hall reveal.
import * as THREE from "three/webgpu";
import { color, uniform, uv } from "three/tsl";
import { timeU } from "../clock";
import { HALLS, RACK, slotPose, CEILING, type HallId } from "@shared/layout";
import type { Client } from "../client";
import type { Game, Target } from "../game";
import type { Racks } from "./racks";
import { bayY, SERVER_FRONT_Z } from "./racks";
import type { DeskBuild } from "./desk";
import { buildPart, type SlotId } from "./serverModel";
import type { AABB } from "./hall";
import { clock } from "../clock";
import { ui } from "../ui/store";
import { money } from "../ui/Hud";

const std = (hex: number, r: number, m: number) => new THREE.MeshStandardNodeMaterial({ color: hex, roughness: r, metalness: m });
const SLOT_FOR: Record<string, SlotId> = { cpu: "CPU1", ram: "RAM1", gpu: "GPU1", drv: "DRV1", psu: "PSU1", fan: "FAN1", nic: "NIC1" };

interface Gantry { hall: HallId; carriage: THREE.Group; arm: THREE.Mesh; rail: THREE.Mesh; job: string | null; x: number }
interface Ring { mesh: THREE.Mesh; until: number; u: any }

export class Props {
  colliders: AABB[] = [];
  private g = new THREE.Group();
  private crates = new Map<string, THREE.Mesh>();
  private ghosts = new THREE.Group();
  private shelfParts = new THREE.Group(); private shelfKey = "";
  private held = new THREE.Group(); private heldKey = "";
  private gantries = new Map<HallId, Gantry>();
  rings: Ring[] = []; ringsFired = 0;
  private flash: THREE.SpotLight;
  private game!: Game; private racks!: Racks;
  private tT = 0;
  private dynamicTargets: Target[] = [];
  private door: THREE.Mesh; private doorOpen = 0; private doorTarget = 0;
  private wallCanvas = document.createElement("canvas"); private wallTex: THREE.CanvasTexture;
  private reveal: { mesh: THREE.Mesh; t: number } | null = null;
  private cart: THREE.Group;
  private dolly: THREE.Group;
  exposure = 1.12;
  private doorCloseAt = 0;
  private chillers: THREE.Group[] = []; private gear: THREE.Group[] = [];
  /** brightness of each hall's ceiling lights (0..1): below 1 only while a newly bought hall's lights strike on */
  areaFactor: Record<HallId, number> = { A: 1, B: 1, C: 1 };
  private strike: { hall: HallId; t: number } | null = null;
  getBars: (h: HallId) => { value: number }[] = () => [];
  private crateLabels = new Map<string, THREE.Mesh>();
  private shimmer: { mesh: THREE.Mesh; u: any }[] = [];
  /** true while the player is wheeling the rack dolly / pushing the parts cart */
  wheeling = false; pushing = false;
  private cartParts = new THREE.Group(); private cartKey = ""; private cartHome = new THREE.Vector3(-0.6, 0, 6.6);

  constructor(private scene: THREE.Scene, private client: Client, private desk: DeskBuild) {
    scene.add(this.g); this.g.add(this.ghosts, this.shelfParts);
    // flashlight + held part ride with the camera (added on attach)
    this.flash = new THREE.SpotLight(0xfff4e0, 0, 12, 0.45, 0.5, 1.2);
    // loading bay: pallet, roller door, cart, rack dolly
    const pallet = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.12, 1.1), std(0x6b5236, 0.9, 0)); pallet.position.set(-2.4, 0.06, 7.6); pallet.receiveShadow = true; this.g.add(pallet);
    this.door = new THREE.Mesh(new THREE.BoxGeometry(0.06, 2.6, 2.2), std(0x2a2e33, 0.5, 0.8)); this.door.position.set(-3.92, 1.3, 7.5); this.g.add(this.door);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 2.4), std(0xd8b400, 0.6, 0.3)); frame.position.set(-3.9, 2.66, 7.5); this.g.add(frame);
    this.cart = new THREE.Group();
    const cm = std(0x8f969e, 0.4, 0.9);
    const tray = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.03, 0.45), cm); tray.position.y = 0.8; const tray2 = tray.clone(); tray2.position.y = 0.3;
    this.cart.add(tray, tray2); for (const [x, z] of [[-0.33, -0.2], [0.33, -0.2], [-0.33, 0.2], [0.33, 0.2]]) { const l = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.85, 0.025), cm); l.position.set(x, 0.425, z); this.cart.add(l); }
    this.cart.position.set(-0.6, 0, 6.6); this.cart.visible = false; this.cart.add(this.cartParts); this.g.add(this.cart);
    this.dolly = new THREE.Group();
    const rackBox = new THREE.Mesh(new THREE.BoxGeometry(RACK.w, RACK.h, RACK.d), std(0x0b0c0e, 0.45, 0.85)); rackBox.position.y = RACK.h / 2 + 0.12; rackBox.castShadow = true;
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.1, 1.3), std(0xd8b400, 0.6, 0.3)); base.position.y = 0.07;
    this.dolly.add(rackBox, base); this.dolly.position.set(-1.1, 0, 8.2); this.dolly.visible = false; this.g.add(this.dolly);
    // plant room (seen through the window in Hall A's west wall): chillers grow with the cooling tier, switchgear with the power tier
    const unit = std(0xb9c0c8, 0.45, 0.7), dark = std(0x15171a, 0.5, 0.6), grey = std(0x4a5058, 0.5, 0.6);
    for (let i = 0; i < 4; i++) {
      const c = new THREE.Group(); const body = new THREE.Mesh(new THREE.BoxGeometry(0.55, 1.7, 0.62), unit); body.position.y = 0.85; c.add(body);
      const grill = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.04, 20), dark); grill.position.set(0, 1.72, 0); c.add(grill);
      const led = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.01), (() => { const m = new THREE.MeshBasicNodeMaterial(); m.colorNode = color(0x39d0ff).mul(5); return m; })()); led.position.set(0.28, 1.3, 0.2); c.add(led);
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.2, 10), std(0x2f6fd6, 0.4, 0.5)); pipe.position.set(-0.1, 2.3, 0); c.add(pipe);
      c.position.set(-2.62, 0, 0.45 + i * 0.7); c.visible = false; this.g.add(c); this.chillers.push(c);
      const sgr = new THREE.Group(); const cab = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.9, 0.4), grey); cab.position.y = 0.95; sgr.add(cab);
      const door = new THREE.Mesh(new THREE.BoxGeometry(0.42, 1.5, 0.01), dark); door.position.set(0, 1.0, 0.206); sgr.add(door);
      for (let k = 0; k < 3; k++) { const l = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.025, 0.01), (() => { const m = new THREE.MeshBasicNodeMaterial(); m.colorNode = color([0x35e06f, 0xffb020, 0x35e06f][k]).mul(4); return m; })()); l.position.set(-0.12 + k * 0.12, 1.62, 0.212); sgr.add(l); }
      sgr.position.set(-1.55 + i * 0.36 - 0.36, 0, 0.3); sgr.rotation.y = 0; sgr.visible = false; this.g.add(sgr); this.gear.push(sgr);
    }
    // wall display in Hall A (west wall, above the control-room glass)
    this.wallCanvas.width = 1024; this.wallCanvas.height = 384;
    this.wallTex = new THREE.CanvasTexture(this.wallCanvas); this.wallTex.colorSpace = THREE.SRGBColorSpace;
    const wm = new THREE.MeshBasicNodeMaterial({ map: this.wallTex });
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.9), wm); wall.position.set(0.075, 2.45, 1.5); wall.rotation.y = Math.PI / 2; this.g.add(wall);
    const wb = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.96, 2.46), std(0x08090a, 0.4, 0.5)); wb.position.set(0.058, 2.45, 1.5); this.g.add(wb);
  }

  attach(game: Game, racks: Racks): void {
    this.game = game; this.racks = racks;
    game.camera.add(this.flash); game.camera.add(this.flash.target); this.flash.position.set(0.15, -0.1, 0); this.flash.target.position.set(0, 0, -4);
    game.camera.add(this.held); this.held.position.set(0.26, -0.2, -0.5); this.held.rotation.set(0.3, -0.6, 0.1);
    this.scene.add(game.camera);
    // shelf: stow the held part
    game.targets.push({ id: "shelf", min: this.desk.shelfBox.min, max: this.desk.shelfBox.max, prompt: () => (this.heldItem() ? "E  put the part on the shelf" : `Parts shelf · ${this.client.inventory.filter((i) => i.where === "shelf").length} in stock`), use: () => { const h = this.heldItem(); if (h) { void this.client.send({ type: "stowPart", part: h.id, to: "shelf", by: "player" }); game.sounds("seat"); } } });
    // empty bay: fit a chassis when one is in stock
    game.bayTarget = (rack, bay) => (this.client.stock.chassis > 0 ? { id: `${rack}:${bay}`, min: new THREE.Vector3(), max: new THREE.Vector3(), prompt: () => `E  fit a chassis in bay ${bay}     Q  close door`, use: () => { void this.client.send({ type: "placeChassis", rack, bay, by: "player" }).then((r) => { if (!r.ok) ui.getState().pushFeed(r.message, "warn"); else game.sounds("seat"); }); }, alt: () => void this.client.send({ type: "setRackDoor", rack, open: false, by: "player" }) } : null);
    // tripped breaker: reset from the front
    game.rackTarget = (rack) => { const r = this.client.world.racks.find((x) => x.id === rack); return r?.breaker === "tripped" ? { id: rack, min: new THREE.Vector3(), max: new THREE.Vector3(), prompt: () => "E  reset breaker     Q  open door", use: () => { void this.client.send({ type: "resetBreaker", rack, by: "player" }); game.sounds("breaker"); }, alt: () => void this.client.send({ type: "setRackDoor", rack, open: true, by: "player" }) } : null; };
    this.buildGantries();
    game.onIdleAlt = () => { if (this.pushing) { this.pushing = false; game.sounds("door"); } else if (this.wheeling) { this.wheeling = false; game.sounds("door"); } };
    // heat shimmer: a faint wavering haze over racks that run hot (pool of 8)
    for (let i = 0; i < 8; i++) {
      const u = uniform(0); const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
      const wob = uv().x.mul(22).add(timeU.mul(5.5)).sin().mul(uv().y.mul(9).sub(timeU.mul(3.1)).sin()).mul(0.5).add(0.5);
      m.colorNode = color(0xff7a30).mul(0.22); m.opacityNode = wob.mul(uv().y.oneMinus().pow(1.5)).mul(u);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(RACK.w, 0.7), m); mesh.visible = false; mesh.renderOrder = 4; this.g.add(mesh); this.shimmer.push({ mesh, u });
    }
  }

  private heldItem() { return this.client.inventory.find((i) => i.where === "hand") ?? null; }
  toggleFlashlight(): void { this.flash.intensity = this.flash.intensity > 0 ? 0 : 30; this.game.sounds("click"); }

  private buildGantries(): void {
    for (const h of ["A", "B", "C"] as HallId[]) {
      const hb = HALLS[h]; const aisleZ = h === "C" ? 13.2 : 4.2;
      const rail = new THREE.Mesh(new THREE.BoxGeometry(hb.x1 - hb.x0 - 1.2, 0.06, 0.08), std(0x8f969e, 0.35, 1)); rail.position.set((hb.x0 + hb.x1) / 2, CEILING - 0.62, aisleZ); this.g.add(rail);
      const carriage = new THREE.Group(); carriage.position.set(hb.x0 + 1.2, CEILING - 0.69, aisleZ);
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.14, 0.24), std(0x15171a, 0.4, 0.8)); carriage.add(body);
      const led = new THREE.Mesh(new THREE.BoxGeometry(0.31, 0.012, 0.02), (() => { const m = new THREE.MeshBasicNodeMaterial(); m.colorNode = color(0x39d0ff).mul(5); return m; })()); led.position.set(0, -0.05, 0.12); carriage.add(led);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1, 0.05), std(0x8f969e, 0.35, 1)); arm.geometry.translate(0, -0.5, 0); arm.position.y = -0.07; arm.scale.y = 0.15; carriage.add(arm);
      const hand = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.04, 0.14), std(0x15171a, 0.4, 0.8)); hand.name = "hand"; carriage.add(hand);
      this.g.add(carriage);
      this.gantries.set(h, { hall: h, carriage, arm, rail, job: null, x: carriage.position.x });
    }
  }

  pulse(rackId: string): void {
    const m = this.racks.rackMatrix.get(rackId); if (!m) return;
    const u = uniform(1);
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false }); mat.colorNode = color(0x39d0ff).mul(4); mat.opacityNode = u;
    const mesh = new THREE.Mesh(new THREE.RingGeometry(0.72, 0.78, 48), mat); mesh.rotation.x = -Math.PI / 2; mesh.position.set(m.elements[12], 0.012, m.elements[14]);
    this.g.add(mesh); this.rings.push({ mesh, until: clock.now() + 2000, u }); this.ringsFired++;
  }

  revealHall(h: string): void {
    const hb = HALLS[h as HallId]; if (!hb) return;
    const mesh = h === "B" ? new THREE.Mesh(new THREE.BoxGeometry(0.14, 2.2, 1.8), std(0x14171a, 0.75, 0.1)) : new THREE.Mesh(new THREE.BoxGeometry(2.0, 2.2, 0.14), std(0x23272c, 0.8, 0));
    mesh.position.set(h === "B" ? 12 : 6.0, 1.1, h === "B" ? 4.2 : 9);
    this.g.add(mesh); this.reveal = { mesh, t: 0 }; this.strike = { hall: h as HallId, t: 0 }; this.areaFactor[h as HallId] = 0;
  }

  onEvent(e: { kind: string; target?: string }): void {
    if (e.kind === "delivery") { this.doorTarget = 1; this.doorCloseAt = clock.now() + 9000; }
  }

  /** Rebuild crate meshes, placement ghosts, shelf and held part to match the sim. */
  private sync(): void {
    const c = this.client as any; const orders: any[] = c.extra?.orders ?? [];
    this.colliders.length = 0; this.dynamicTargets.length = 0;
    const delivered = orders.filter((o) => o.state === "delivered");
    for (const [id, m] of this.crates) if (!delivered.some((o) => o.id === id)) { this.g.remove(m); this.crates.delete(id); const lab = this.crateLabels.get(id); if (lab) { this.g.remove(lab); this.crateLabels.delete(id); } }
    delivered.forEach((o, i) => {
      let m = this.crates.get(o.id);
      const px = -2.9 + (i % 3) * 0.5, pz = 7.25 + Math.floor(i / 3) % 2 * 0.6, py = 0.12 + 0.2 + Math.floor(i / 6) * 0.4;
      if (!m) { m = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.4, 0.5), std(0xa98a5c, 0.85, 0)); m.castShadow = true; this.g.add(m); this.crates.set(o.id, m); }
      m.position.set(px, py, pz);
      if (!this.crateLabels.has(o.id)) { const cv = document.createElement("canvas"); cv.width = 256; cv.height = 160; const cx = cv.getContext("2d")!; cx.fillStyle = "#efe9dc"; cx.fillRect(0, 0, 256, 160); cx.fillStyle = "#111"; cx.font = "700 22px -apple-system, system-ui, sans-serif"; cx.fillText(String(o.id).toUpperCase(), 12, 30); cx.font = "500 19px -apple-system, system-ui, sans-serif"; o.lines.slice(0, 5).forEach((l: any, k: number) => cx.fillText(`${l.qty} x ${l.sku}`, 12, 60 + k * 22)); const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; const lab = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.16), new THREE.MeshBasicNodeMaterial({ map: t })); lab.rotation.y = Math.PI / 2; this.g.add(lab); this.crateLabels.set(o.id, lab); }
      this.crateLabels.get(o.id)!.position.set(px + 0.222, py + 0.04, pz);
      const label = o.lines.map((l: any) => `${l.qty} × ${l.sku}`).join(", ");
      this.dynamicTargets.push({ id: "crate:" + o.id, min: new THREE.Vector3(px - 0.25, py - 0.22, pz - 0.27), max: new THREE.Vector3(px + 0.25, py + 0.22, pz + 0.27), prompt: () => "E  open crate", card: () => ({ title: "Delivery", lines: [label.slice(0, 60)] }), use: () => { void this.client.send({ type: "openCrate", order: o.id, by: "player" }); this.game.sounds("latch"); } });
    });
    this.colliders.push({ x0: -3.1, x1: -1.7, z0: 7.05, z1: 8.15, tag: "pallet" });
    // rack placement ghosts
    this.ghosts.clear();
    const stock = this.client.stock;
    this.dolly.visible = stock.racks > 0; this.cart.visible = !!stock.cart;
    if (stock.racks <= 0) this.wheeling = false;
    if (!stock.cart) this.pushing = false;
    // the rack dolly: take it from the loading bay, wheel it to an outlined slot
    if (stock.racks > 0 && !this.wheeling) {
      this.dolly.position.set(-1.1, 0, 8.2); this.dolly.rotation.y = 0;
      this.colliders.push({ x0: -1.45, x1: -0.75, z0: 7.55, z1: 8.85, tag: "dolly" });
      this.dynamicTargets.push({ id: "dolly", min: new THREE.Vector3(-1.5, 0, 7.5), max: new THREE.Vector3(-0.7, 2.2, 8.9), reach: 2.8, prompt: () => `E  take the rack dolly (${stock.racks} in stock)`, use: () => { this.wheeling = true; this.pushing = false; this.game.sounds("door"); ui.getState().pushFeed("Wheel the rack to an outlined slot and press E. Q leaves the dolly.", "info"); } });
    }
    // the parts cart: push it with you, or leave it where it stands
    if (stock.cart && !this.pushing) {
      const c = this.cart.position;
      this.colliders.push({ x0: c.x - 0.38, x1: c.x + 0.38, z0: c.z - 0.38, z1: c.z + 0.38, tag: "cart" });
      this.dynamicTargets.push({ id: "cart", min: new THREE.Vector3(c.x - 0.4, 0, c.z - 0.4), max: new THREE.Vector3(c.x + 0.4, 0.95, c.z + 0.4), prompt: () => `E  push the cart (${this.client.inventory.filter((i) => i.where === "cart").length} of 12 parts)`, use: () => { if (!this.wheeling) { this.pushing = true; this.game.sounds("door"); } } });
    }
    const onCart = this.client.inventory.filter((i) => i.where === "cart"); const ck = onCart.map((i) => i.id).join(",");
    if (ck !== this.cartKey) { this.cartKey = ck; this.cartParts.clear(); onCart.slice(0, 12).forEach((it, i) => { const slot = SLOT_FOR[it.family]; if (!slot) return; const m = buildPart(slot, it); m.position.set(-0.26 + (i % 6) * 0.105, (i < 6 ? 0.82 : 0.32) + (it.family === "gpu" ? 0.056 : 0.03), 0); if (it.family === "gpu" || it.family === "psu" || it.family === "ram") m.rotation.y = Math.PI / 2; this.cartParts.add(m); }); }
    if (stock.racks > 0 && this.wheeling) {
      const w = this.client.world; const taken = new Set(w.racks.map((r) => `${r.hall}:${r.slot}`));
      for (const h of ["A", "B", "C"] as HallId[]) {
        if (!w.halls[h].owned) continue;
        for (let s = 0; s < HALLS[h].slots; s++) {
          if (taken.has(`${h}:${s}`)) continue;
          const p = slotPose(h, s);
          const ghost = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(RACK.w - 0.02, RACK.h, RACK.d - 0.02)), new THREE.LineBasicNodeMaterial({ color: 0x39d0ff, transparent: true, opacity: 0.55 }));
          ghost.position.set(p.x, RACK.h / 2, p.z); this.ghosts.add(ghost);
          this.dynamicTargets.push({ id: `ghost:${h}:${s}`, min: new THREE.Vector3(p.x - 0.3, 0, p.z - 0.6), max: new THREE.Vector3(p.x + 0.3, RACK.h, p.z + 0.6), reach: 3.2, prompt: () => `E  place the rack here     Q  leave the dolly`, alt: () => { this.wheeling = false; }, use: () => { void this.client.send({ type: "placeRack", hall: h, slot: s, by: "player" }).then((r) => { if (!r.ok) ui.getState().pushFeed(r.message, "warn"); else { this.game.sounds("seat"); this.wheeling = false; } }); } });
        }
      }
    }
    // shelf parts
    const shelf = this.client.inventory.filter((i) => i.where === "shelf" || i.where === "crate");
    const key = shelf.map((i) => i.id).join(",");
    if (key !== this.shelfKey) {
      this.shelfKey = key; this.shelfParts.clear();
      shelf.slice(0, this.desk.shelfSlots.length).forEach((it, i) => { const slot = SLOT_FOR[it.family]; if (!slot) return; const m = buildPart(slot, it); const p = this.desk.shelfSlots[i]; m.position.set(p.x, p.y + (it.family === "gpu" ? 0.056 : it.family === "cpu" ? 0.035 : 0.02), p.z); if (it.family === "gpu" || it.family === "psu" || it.family === "ram") m.rotation.y = Math.PI / 2; this.shelfParts.add(m); });
    }
    const h = this.heldItem(); const hk = h ? h.id : "";
    if (hk !== this.heldKey) { this.heldKey = hk; this.held.clear(); if (h && SLOT_FOR[h.family]) { const m = buildPart(SLOT_FOR[h.family], h); m.scale.setScalar(1.15); this.held.add(m); } }
    // targets: replace our dynamic ones
    this.game.targets = this.game.targets.filter((t) => !t.id.startsWith("crate:") && !t.id.startsWith("ghost:") && t.id !== "dolly" && t.id !== "cart").concat(this.dynamicTargets);
  }

  private paintWall(): void {
    const w = this.client.world, g = this.wallCanvas.getContext("2d")!, W = 1024, H = 384;
    g.fillStyle = "#070a0e"; g.fillRect(0, 0, W, H);
    g.fillStyle = "#39d0ff"; g.font = "700 22px -apple-system, system-ui, sans-serif"; g.fillText(w.facilityName.toUpperCase(), 28, 44);
    g.fillStyle = "#8e99a6"; g.font = "500 20px -apple-system, system-ui, sans-serif"; g.fillText(`Day ${w.time.day}   ${String(w.time.hour).padStart(2, "0")}:${String(w.time.minute).padStart(2, "0")}`, 820, 44);
    const cell = (i: number, k: string, v: string, col = "#ffffff") => { const x = 28 + i * 248; g.fillStyle = "#8e99a6"; g.font = "500 19px -apple-system, system-ui, sans-serif"; g.fillText(k, x, 96); g.fillStyle = col; g.font = "600 38px -apple-system, system-ui, sans-serif"; g.fillText(v, x, 140); };
    const net = w.incomePerHour - w.costPerHour;
    cell(0, "Net per hour", money(net), net >= 0 ? "#35e06f" : "#ff6259"); cell(1, "Power", `${w.power.usedKw.toFixed(0)} kW`); cell(2, "Hall A", `${w.halls.A.airC.toFixed(0)} °C`, w.halls.A.airC > 30 ? "#ffb020" : "#fff"); cell(3, "Alerts", String(w.alertCount), w.alertCount ? "#ffb020" : "#35e06f");
    const ms: string[] = (w as any).milestones ?? [];
    const NAMES: [string, string][] = [["first_light", "First light"], ["in_the_black", "In the black"], ["five_nines", "Five nines"], ["hands_off", "Hands off"], ["full_house", "Full house"], ["second_hall", "Second hall"], ["megawatt", "Megawatt"], ["campus", "Campus"]];
    g.font = "500 19px -apple-system, system-ui, sans-serif";
    NAMES.forEach(([id, name], i) => { const x = 28 + (i % 4) * 248, y = 220 + Math.floor(i / 4) * 60, on = ms.includes(id); g.fillStyle = on ? "#35e06f" : "#3a424d"; g.beginPath(); g.arc(x + 9, y - 7, 8, 0, 7); g.fill(); g.fillStyle = on ? "#e8edf2" : "#6f7a87"; g.fillText(name, x + 28, y); });
    this.wallTex.needsUpdate = true;
  }

  update(dt: number, camera: THREE.Camera): void {
    this.tT += dt;
    if (this.tT > 0.25) { this.tT = 0; this.sync(); this.paintWall(); }
    // the dolly and the cart ride ahead of the player while held
    const pl = this.game.player, fx = -Math.sin(pl.yaw), fz = -Math.cos(pl.yaw);
    if (this.wheeling) { this.dolly.position.set(pl.pos.x + fx * 1.15, 0, pl.pos.z + fz * 1.15); this.dolly.rotation.y = pl.yaw; }
    if (this.pushing) { this.cart.position.set(pl.pos.x + fx * 0.85, 0, pl.pos.z + fz * 0.85); this.cart.rotation.y = pl.yaw; }
    // roller door
    if (this.doorTarget === 1 && clock.now() > this.doorCloseAt) this.doorTarget = 0;
    this.doorOpen += Math.sign(this.doorTarget - this.doorOpen) * Math.min(Math.abs(this.doorTarget - this.doorOpen), dt * 0.6);
    this.door.position.y = 1.3 + this.doorOpen * 2.3;
    // heat shimmer over the hottest racks
    const hot = this.client.world.racks.map((r) => ({ r, t: Math.max(0, ...r.servers.map((s) => (s && s.power !== "off" ? s.tempC : 0))) })).filter((x) => x.t > 78).sort((a, b) => b.t - a.t).slice(0, this.shimmer.length);
    this.shimmer.forEach((sh, i) => { const h = hot[i]; if (!h) { sh.mesh.visible = false; return; } const m = this.racks.rackMatrix.get(h.r.id); if (!m) return; sh.mesh.visible = true; sh.mesh.position.set(m.elements[12], RACK.h + 0.36, m.elements[14]); sh.mesh.rotation.y = Math.atan2(camera.position.x - m.elements[12], camera.position.z - m.elements[14]); sh.u.value = Math.min(1, (h.t - 78) / 14); });
    // pulse rings
    const now = clock.now();
    for (const r of [...this.rings]) { const k = 1 - (r.until - now) / 2000; if (k >= 1) { this.g.remove(r.mesh); this.rings = this.rings.filter((x) => x !== r); continue; } r.mesh.scale.setScalar(1 + k * 0.9); r.u.value = 1 - k; }
    // hall reveal: the wall panel slides up
    if (this.reveal) { this.reveal.t += dt; this.reveal.mesh.position.y = 1.1 + Math.min(1, this.reveal.t / 2.5) ** 2 * 2.4; if (this.reveal.t > 4) { this.g.remove(this.reveal.mesh); this.reveal = null; this.exposure = 1.12; } }
    // a newly bought hall's lights strike on row by row, each with a short flicker
    if (this.strike) {
      this.strike.t += dt; const bars = this.getBars(this.strike.hall); let sum = 0;
      bars.forEach((u, i) => { const t0 = 0.7 + i * 0.5, k = this.strike!.t - t0; u.value = k < 0 ? 0 : k < 0.3 ? (Math.sin(k * 70) > 0 ? 0.9 : 0.15) : 1; sum += u.value; });
      this.areaFactor[this.strike.hall] = bars.length ? sum / bars.length : 1;
      if (this.strike.t > 0.7 + bars.length * 0.5 + 0.4) { bars.forEach((u) => (u.value = 1)); this.areaFactor[this.strike.hall] = 1; this.strike = null; }
    }
    // plant room models follow the facility's power and cooling tiers
    const w = this.client.world; const ct = [30, 100, 350, 1100].findIndex((k) => w.cooling.capKw <= k), pt = [40, 120, 400, 1200].findIndex((k) => w.power.capKw <= k);
    this.chillers.forEach((c, i) => (c.visible = i <= (ct < 0 ? 3 : ct))); this.gear.forEach((c, i) => (c.visible = i <= (pt < 0 ? 3 : pt)));
    // gantries follow the running job (timing from the sim tick, so a replay is repeatable)
    const c = this.client as any; const jobs: any[] = c.extra?.jobs ?? []; const tick = this.client.world.tick;
    for (const gy of this.gantries.values()) {
      const job = jobs.find((j) => j.state === "running" && j.hall === gy.hall);
      const hand = gy.carriage.getObjectByName("hand")!;
      let targetX = HALLS[gy.hall].x0 + 1.2, armLen = 0.15, pull = 0; let rackId: string | null = null;
      if (job) {
        rackId = String(job.server).slice(0, 5); const m = this.racks.rackMatrix.get(rackId); const bay = Number(String(job.server).slice(-2));
        const total = 80, left = Math.max(0, (job.doneTick ?? tick) - tick), ph = 1 - left / total;      // 0..1 through the job
        if (m) {
          targetX = m.elements[12];
          const reach = (CEILING - 0.89) - (bayY(bay) + 0.16);
          if (ph > 0.2 && ph < 0.85) { armLen = Math.max(0.15, reach * Math.min(1, (ph - 0.2) / 0.12)); if (ph > 0.75) armLen = Math.max(0.15, reach * (1 - (ph - 0.75) / 0.1)); }
          pull = ph < 0.25 ? 0 : ph < 0.35 ? (ph - 0.25) / 0.1 : ph < 0.72 ? 1 : ph < 0.82 ? 1 - (ph - 0.72) / 0.1 : 0;
          const front = m.elements[10] > 0 ? 1 : -1;     // which way this rack faces in z
          gy.carriage.position.z += ((m.elements[14] + front * (RACK.d / 2 + 0.34)) - gy.carriage.position.z) * Math.min(1, dt * 3);
          if (this.game.inspecting !== job.server) this.racks.setPull(job.server, pull * 0.5);
        }
        if (gy.job !== job.id) { gy.job = job.id; this.game.forceDoor.add(rackId); }
      } else if (gy.job) {
        gy.job = null; this.game.forceDoor.clear();
      }
      gy.carriage.position.x += (targetX - gy.carriage.position.x) * Math.min(1, dt * 2.2);
      gy.arm.scale.y += (armLen - gy.arm.scale.y) * Math.min(1, dt * 6);
      hand.position.y = -0.07 - gy.arm.scale.y;
    }
    void camera; void SERVER_FRONT_Z;
  }
}
