// The detailed server shown when one is pulled out: chassis tray, lid, and one mesh per part slot (SPEC section 7, appendix I).
import * as THREE from "three/webgpu";
import { color } from "three/tsl";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { ServerView, PartView } from "@shared/view";
import { SERVER_W, SERVER_H, SERVER_D } from "./racks";

export const SLOTS = ["CPU1", "CPU2", "RAM1", "RAM2", "RAM3", "RAM4", "RAM5", "RAM6", "RAM7", "RAM8", "GPU1", "GPU2", "GPU3", "GPU4", "DRV1", "DRV2", "DRV3", "DRV4", "PSU1", "PSU2", "FAN1", "FAN2", "FAN3", "FAN4", "NIC1"] as const;
export type SlotId = (typeof SLOTS)[number];
export const slotFamily = (s: string) => s.slice(0, 3).toLowerCase();
export const FAMILY_LABEL: Record<string, string> = { cpu: "CPU", ram: "Memory", gpu: "GPU", drv: "Drive", psu: "Power supply", fan: "Fan", nic: "Network card" };
export const TIER_COLOR = [0x7d848c, 0x7d848c, 0x2f7df6, 0x8b5cf6, 0xe0a82e, 0xf2f5f8];

const FLOOR_Y = -SERVER_H / 2 + 0.006;
interface SlotGeo { pos: [number, number, number]; size: [number, number, number]; layer: number }
/** Slot positions in server-local space (origin = centre of the front face, +z out of the rack, body runs to -z). */
export const SLOT_GEO: Record<SlotId, SlotGeo> = (() => {
  const g: any = {};
  const put = (id: string, x: number, z: number, w: number, h: number, d: number, layer: number) => { g[id] = { pos: [x, FLOOR_Y + h / 2, z], size: [w, h, d], layer }; };
  // SPEC appendix I: drives at the front, a row of fans, CPUs with a bank of four DIMMs on each side, GPUs standing in the rear half,
  // two PSU modules at the rear left, the NIC at the rear right.
  [-0.13, -0.05, 0.03, 0.11].forEach((x, i) => put(`DRV${i + 1}`, x, -0.062, 0.07, 0.016, 0.105, 1));
  [-0.165, -0.055, 0.055, 0.165].forEach((x, i) => put(`FAN${i + 1}`, x, -0.165, 0.082, 0.082, 0.028, 2));
  put("CPU1", -0.075, -0.36, 0.092, 0.07, 0.092, 4); put("CPU2", 0.075, -0.36, 0.092, 0.07, 0.092, 4);
  [-0.205, -0.188, -0.171, -0.154].forEach((x, i) => put(`RAM${i + 1}`, x, -0.36, 0.007, 0.032, 0.134, 3));
  [0.154, 0.171, 0.188, 0.205].forEach((x, i) => put(`RAM${i + 5}`, x, -0.36, 0.007, 0.032, 0.134, 3));
  [-0.075, -0.02, 0.035, 0.09].forEach((x, i) => put(`GPU${i + 1}`, x, -0.64, 0.04, 0.112, 0.27, 5));
  put("PSU1", -0.192, -0.72, 0.052, 0.075, 0.24, 2); put("PSU2", -0.135, -0.72, 0.052, 0.075, 0.24, 2);
  put("NIC1", 0.175, -0.74, 0.016, 0.06, 0.17, 3);
  return g;
})();

const std = (hex: number, rough: number, metal: number) => new THREE.MeshStandardNodeMaterial({ color: hex, roughness: rough, metalness: metal });

const lit = (hex: number, k: number) => { const m = new THREE.MeshBasicNodeMaterial(); m.colorNode = color(hex).mul(k); return m; };
const etchedTex = new Map<number, THREE.CanvasTexture>();
/** The tier number as it would be etched into a heatsink's top plate. */
function etched(tier: number): THREE.CanvasTexture {
  let t = etchedTex.get(tier);
  if (!t) { const c = document.createElement("canvas"); c.width = c.height = 64; const g = c.getContext("2d")!; g.clearRect(0, 0, 64, 64); g.fillStyle = "rgba(20,24,28,0.85)"; g.font = "700 46px 'SF Mono', Menlo, monospace"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(String(tier), 32, 35); t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; etchedTex.set(tier, t); }
  return t;
}
function tierBand(tier: number, w: number, h: number, d: number): THREE.Mesh {
  const m = new THREE.MeshStandardNodeMaterial({ color: TIER_COLOR[tier] ?? 0x888888, roughness: 0.35, metalness: 0.6 });
  if (tier >= 5) m.emissiveNode = color(0xdfeaff).mul(0.9);
  const band = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  return band;
}

/** Build the mesh group for one part. The group's origin is the slot's centre. */
export function buildPart(slot: SlotId, p: PartView): THREE.Group {
  const fam = slotFamily(slot), [w, h, d] = SLOT_GEO[slot].size;
  const g = new THREE.Group();
  const add = (m: THREE.Object3D, x = 0, y = 0, z = 0) => { m.position.set(x, y, z); g.add(m); return m; };
  if (fam === "cpu") {
    add(new THREE.Mesh(new THREE.BoxGeometry(w * 0.9, 0.006, d * 0.9), std(0x1a1c1f, 0.5, 0.6)), 0, -h / 2 + 0.003, 0);
    const finM = std(0xb9c0c8, 0.3, 1.0);
    for (let i = 0; i < 15; i++) add(new THREE.Mesh(new THREE.BoxGeometry(w, h - 0.014, 0.0022), finM), 0, 0.004, -d / 2 + 0.004 + i * ((d - 0.008) / 14));
    add(new THREE.Mesh(new THREE.BoxGeometry(w * 0.92, 0.005, d * 0.92), std(0xc8ced6, 0.25, 1.0)), 0, h / 2 - 0.0025, 0);
    add(tierBand(p.tier, w + 0.002, 0.008, d + 0.002), 0, h / 2 - 0.02, 0);
    { const pl = new THREE.Mesh(new THREE.PlaneGeometry(0.03, 0.03), new THREE.MeshStandardNodeMaterial({ map: etched(p.tier), transparent: true, roughness: 0.3, metalness: 1 })); pl.rotation.x = -Math.PI / 2; add(pl, 0, h / 2 + 0.0006, 0); }      // tier number etched in the top plate
  } else if (fam === "ram") {
    add(new THREE.Mesh(new THREE.BoxGeometry(0.0022, h, d), std(0x0d2a1c, 0.6, 0.2)));
    add(new THREE.Mesh(new THREE.BoxGeometry(w, h * 0.72, d * 0.96), std(TIER_COLOR[p.tier] ?? 0x888888, 0.4, 0.75)), 0, h * 0.1, 0);
  } else if (fam === "gpu") {
    add(new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, 0.004), std(0x15171a, 0.38, 0.75)));
    add(new THREE.Mesh(new THREE.BoxGeometry(w + 0.001, h * 0.55, d * 0.7), std(0x0b0c0d, 0.6, 0.4)), 0, -h * 0.05, 0);
    add(tierBand(p.tier, w + 0.002, 0.007, d * 0.9), 0, h / 2 - 0.016, 0);
    const strip = new THREE.MeshBasicNodeMaterial(); strip.colorNode = color(p.status === "failed" ? 0xff3b30 : p.status === "degraded" ? 0xffb020 : 0x35e06f).mul(p.status === "failed" ? 1.5 : 5);
    add(new THREE.Mesh(new THREE.BoxGeometry(w * 0.5, 0.003, d * 0.8), strip), 0, h / 2 + 0.0016, 0);
    add(new THREE.Mesh(new THREE.BoxGeometry(w * 0.9, h * 0.9, 0.004), std(0x9aa1a9, 0.3, 1)), 0, 0, -d / 2 - 0.002);
  } else if (fam === "drv") {
    add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), std(0x24272b, 0.4, 0.85)));
    add(new THREE.Mesh(new THREE.BoxGeometry(w * 0.7, 0.002, d * 0.6), std(0x596068, 0.6, 0.1)), 0, h / 2 + 0.001, -0.005);
    add(tierBand(p.tier, w, h + 0.002, 0.008), 0, 0, d / 2 - 0.006);
  } else if (fam === "psu") {
    add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), std(0x8f969e, 0.45, 0.9)));
    add(new THREE.Mesh(new THREE.BoxGeometry(w * 0.6, h * 0.5, 0.012), std(0x101214, 0.6, 0.3)), 0, 0, -d / 2 - 0.006);
    add(tierBand(p.tier, w + 0.002, h + 0.002, 0.012), 0, 0, d / 2 - 0.03);
    // handle on top, status LED beside it
    add(new THREE.Mesh(new THREE.BoxGeometry(w * 0.5, 0.006, 0.05), std(0x101214, 0.5, 0.6)), 0, h / 2 + 0.008, 0);
    for (const dz of [-0.022, 0.022]) add(new THREE.Mesh(new THREE.BoxGeometry(w * 0.5, 0.01, 0.005), std(0x101214, 0.5, 0.6)), 0, h / 2 + 0.003, dz);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.003, 0.006), lit(p.status === "failed" ? 0xff3b30 : p.status === "degraded" ? 0xffb020 : 0x35e06f, 5)), w * 0.3, h / 2 + 0.002, d / 2 - 0.05);
  } else if (fam === "fan") {
    add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), std(0x101214, 0.6, 0.2)));
    const rotor = new THREE.Group(); rotor.name = "rotor";
    const bladeM = std(0x2a2e33, 0.5, 0.3);
    for (let i = 0; i < 7; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(w * 0.4, 0.012, 0.003), bladeM); b.position.x = w * 0.2; const piv = new THREE.Group(); piv.rotation.z = (i / 7) * Math.PI * 2; b.rotation.x = 0.5; piv.add(b); rotor.add(piv); }
    rotor.add(new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, d + 0.002, 16).rotateX(Math.PI / 2), std(TIER_COLOR[p.tier] ?? 0x888888, 0.4, 0.6)));
    add(rotor, 0, 0, d / 2 + 0.002);
  } else {
    add(new THREE.Mesh(new THREE.BoxGeometry(0.002, h, d), std(0x0d2a1c, 0.6, 0.2)));
    add(new THREE.Mesh(new THREE.BoxGeometry(w, h * 0.5, d * 0.5), std(0x8f969e, 0.4, 0.9)), 0, -h * 0.1, -d * 0.2);
    add(tierBand(p.tier, w + 0.001, 0.006, d * 0.5), 0, h * 0.2, -d * 0.2);
    // two ports at the rear, each with a link LED
    for (const dy of [-0.012, 0.012]) { add(new THREE.Mesh(new THREE.BoxGeometry(w + 0.004, 0.014, 0.016), std(0x101214, 0.5, 0.6)), 0, dy, -d / 2 + 0.008); add(new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.003, 0.004), lit(p.status === "failed" ? 0xff3b30 : 0x35e06f, 5)), 0, dy + 0.009, -d / 2 + 0.004); }
  }
  if (p.status === "failed") {
    // a failed part is dark, with a red marker on top
    g.traverse((o: any) => { if (o.isMesh && o.material?.color) { o.material = o.material.clone(); o.material.color.multiplyScalar(0.35); } });
    const mk = new THREE.Mesh(new THREE.BoxGeometry(Math.min(w, 0.03) + 0.004, 0.004, Math.min(d, 0.03) + 0.004), (() => { const m = new THREE.MeshBasicNodeMaterial(); m.colorNode = color(0xff3b30).mul(6); return m; })());
    mk.position.set(0, h / 2 + 0.006, 0); mk.name = "marker"; g.add(mk);
  }
  if (fam === "cpu") { const sink = new THREE.Group(); sink.name = "heatsink"; for (const c of [...g.children]) if (c !== g.children[0] && c.name !== "marker") sink.add(c); g.add(sink); }
  if (p.tempC > 80 && p.status !== "failed") { const heat = Math.min(1, (p.tempC - 80) / 20); g.traverse((o: any) => { if (o.isMesh && o.material?.isMeshStandardNodeMaterial && !o.material.emissiveNode) { o.material = o.material.clone(); o.material.emissive = new THREE.Color(0xff6a1a); o.material.emissiveIntensity = 0.25 * heat; } }); }
  g.traverse((o: any) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

export interface PartHit { slot: SlotId; part: PartView | null }

export class ServerModel {
  group = new THREE.Group();
  private lid: THREE.Mesh;
  private lidMat: THREE.MeshStandardNodeMaterial;
  private parts = new Map<SlotId, THREE.Group>();
  private sockets = new Map<SlotId, THREE.Mesh>();
  private pick: THREE.Mesh[] = [];
  private outline: THREE.LineSegments;
  private explode = 0;
  private lift = new Map<SlotId, number>();
  private statusOf = new Map<SlotId, { status: string; tempC: number }>(); private pulseT = 0;
  private pulse: THREE.LineSegments[] = [];      // per-slot lift (0..1) used by the swap animation
  private key = "";
  private ray = new THREE.Raycaster();
  serverId = "";
  load = 0.5;

  constructor(faceMap: THREE.Texture | null) {
    const metal = std(0x1b1d20, 0.5, 0.85);
    const t = 0.004, W = SERVER_W, H = SERVER_H, D = SERVER_D;
    const tray = new THREE.Group();
    const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => { const mesh = new THREE.Mesh(geo, m); mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; tray.add(mesh); return mesh; };
    add(new THREE.BoxGeometry(W, t, D), metal, 0, -H / 2 + t / 2, -D / 2);
    add(new THREE.BoxGeometry(t, H, D), metal, -W / 2 + t / 2, 0, -D / 2);
    add(new THREE.BoxGeometry(t, H, D), metal, W / 2 - t / 2, 0, -D / 2);
    add(new THREE.BoxGeometry(W, H, t), metal, 0, 0, -D + t / 2);
    const face = add(new THREE.PlaneGeometry(W + 0.036, H), new THREE.MeshStandardNodeMaterial({ map: faceMap ?? undefined, color: faceMap ? 0xffffff : 0x17191c, roughness: 0.55, metalness: 0.6 }), 0, 0, 0.0005);
    face.castShadow = false;
    add(new THREE.BoxGeometry(W + 0.036, H, 0.006), std(0x131517, 0.5, 0.7), 0, 0, -0.004);
    // mainboard
    add(new THREE.BoxGeometry(W - 0.03, 0.003, D - 0.16), std(0x0c2418, 0.55, 0.25), 0, -H / 2 + 0.0065, -D / 2 - 0.06);
    // rails
    const rail = std(0x8f969e, 0.35, 1);
    add(new THREE.BoxGeometry(0.008, 0.03, D + 0.5), rail, -W / 2 - 0.006, -0.02, -D / 2 - 0.25);
    add(new THREE.BoxGeometry(0.008, 0.03, D + 0.5), rail, W / 2 + 0.006, -0.02, -D / 2 - 0.25);
    this.group.add(tray);
    this.lidMat = new THREE.MeshStandardNodeMaterial({ color: 0x1b1d20, roughness: 0.45, metalness: 0.85, transparent: true });
    this.lid = new THREE.Mesh(new THREE.BoxGeometry(W, t, D), this.lidMat);
    this.lid.position.set(0, H / 2 - t / 2, -D / 2);
    this.group.add(this.lid);
    for (const s of SLOTS) {
      const [w, , d] = SLOT_GEO[s].size, [x, , z] = SLOT_GEO[s].pos;
      const sock = new THREE.Mesh(new THREE.BoxGeometry(w + 0.006, 0.002, d + 0.006), std(0x050607, 0.8, 0.2));
      sock.position.set(x, -H / 2 + 0.009, z); this.group.add(sock); this.sockets.set(s, sock);
    }
    this.outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicNodeMaterial({ color: 0xffffff }));
    this.outline.visible = false; this.outline.renderOrder = 10;
    this.group.add(this.outline);
    this.group.visible = false;
  }

  setLid(open01: number): void {
    this.lid.position.y = SERVER_H / 2 - 0.002 + open01 * 0.12;
    this.lidMat.opacity = 1 - open01; this.lid.visible = open01 < 0.98;
  }
  setExplode(v: number): void { this.explode = v; this.place(); }
  /** Raise a part out of its slot (1) or seat it (0). */
  setLift(slot: SlotId, v: number): void { if (v <= 0) this.lift.delete(slot); else this.lift.set(slot, v); this.place(); }
  getExplode(): number { return this.explode; }

  private place(): void {
    for (const [slot, g] of this.parts) {
      const geo = SLOT_GEO[slot];
      const lf = this.lift.get(slot) ?? 0; g.position.set(geo.pos[0], geo.pos[1] + this.explode * geo.layer * 0.08 + (slot.startsWith("CPU") ? Math.max(0, lf * 2 - 1) : lf) * 0.14, geo.pos[2]);
    }
  }

  /** World position of a slot's part centre (for labels). */
  slotWorld(slot: SlotId, out = new THREE.Vector3(), top = false): THREE.Vector3 {
    const geo = SLOT_GEO[slot];
    return out.set(geo.pos[0], geo.pos[1] + this.explode * geo.layer * 0.08 + (top ? geo.size[1] / 2 : 0), geo.pos[2]).applyMatrix4(this.group.matrixWorld);
  }

  sync(s: ServerView): void {
    this.serverId = s.id; this.load = s.power === "on" ? s.load : 0;
    const key = SLOTS.map((k) => { const p = s.slots?.[k]; return p ? `${p.id}:${p.status}:${p.tempC > 80 ? Math.floor((p.tempC - 80) / 5) : 0}` : "-"; }).join(",");
    if (key === this.key) return;
    this.key = key;
    for (const g of this.parts.values()) this.group.remove(g);
    this.parts.clear(); this.pick.length = 0;
    for (const slot of SLOTS) {
      const p = s.slots?.[slot]; const geo = SLOT_GEO[slot];
      const hit = new THREE.Mesh(new THREE.BoxGeometry(geo.size[0] + 0.006, geo.size[1] + 0.006, geo.size[2] + 0.006), new THREE.MeshBasicNodeMaterial({ visible: false }));
      hit.userData.slot = slot;
      if (p) { const g = buildPart(slot, p); g.add(hit); this.parts.set(slot, g); this.group.add(g); this.statusOf.set(slot, { status: p.status, tempC: p.tempC }); }
      else { const g = new THREE.Group(); g.add(hit); this.parts.set(slot, g); this.group.add(g); this.statusOf.delete(slot); }
      this.pick.push(hit);
    }
    this.place();
  }

  update(dt: number): void {
    // degraded parts: a faint amber pulse on the outline. Hot parts (over 80 C): an orange tint that deepens with temperature.
    this.pulseT += dt; let k = 0;
    for (const [slot, st] of this.statusOf) {
      const g = this.parts.get(slot); if (!g) continue;
      if (st.status === "degraded") {
        let ln = this.pulse[k]; if (!ln) { ln = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicNodeMaterial({ color: 0xffb020, transparent: true })); ln.renderOrder = 9; this.group.add(ln); this.pulse[k] = ln; }
        const geo = SLOT_GEO[slot]; ln.visible = true; ln.position.copy(g.position); ln.scale.set(geo.size[0] + 0.006, geo.size[1] + 0.006, geo.size[2] + 0.006); (ln.material as any).opacity = 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(this.pulseT * 6.28)); k++;
      }
    }
    for (let i = k; i < this.pulse.length; i++) this.pulse[i].visible = false;
    // CPU swap: the heatsink lifts first, then the chip follows
    for (const [slot, g] of this.parts) if (slot.startsWith("CPU")) { const sink = g.getObjectByName("heatsink"); const l = this.lift.get(slot) ?? 0; if (sink) sink.position.y = Math.min(1, l * 2) * 0.05; }
    for (const [slot, g] of this.parts) if (slot.startsWith("FAN")) { const r = g.getObjectByName("rotor"); if (r) r.rotation.z += dt * (4 + this.load * 40); }
  }

  /** Which slot is under a normalised screen point (default: screen centre). */
  hit(camera: THREE.Camera, ndc = new THREE.Vector2(0, 0)): SlotId | null {
    this.ray.setFromCamera(ndc, camera as any);
    const h = this.ray.intersectObjects(this.pick, false)[0];
    return h ? (h.object.userData.slot as SlotId) : null;
  }

  highlight(slot: SlotId | null, hex = 0xffffff): void {
    if (!slot) { this.outline.visible = false; return; }
    const geo = SLOT_GEO[slot]; const g = this.parts.get(slot)!;
    this.outline.position.copy(g.position);
    this.outline.scale.set(geo.size[0] + 0.008, geo.size[1] + 0.008, geo.size[2] + 0.008);
    (this.outline.material as any).color.setHex(hex);
    this.outline.visible = true;
  }
}
