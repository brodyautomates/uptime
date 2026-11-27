import * as THREE from "three/webgpu";
import { attribute, fract, floor, step, hash, abs, smoothstep, select, float, texture, uv, vec2 } from "three/tsl";
import { timeU as time, clock } from "../clock";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { RACK, slotPose, STATUS } from "@shared/layout";
import type { RackView, ServerView, WorldView } from "@shared/view";
import { mats, glow } from "./materials";
import type { AABB } from "./hall";

const MAX_RACKS = 60;
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const MAX_SERVERS = MAX_RACKS * RACK.bays;
export const LEDS_PER_SERVER = 24;
export const SERVER_W = 0.445, SERVER_H = 0.168, SERVER_D = 0.86;
export const SERVER_FRONT_Z = 0.56;         // rack-local z of a server's front face (rack front is +z)
const FACE_PX = { w: 1024, h: 388 };

export const bayY = (bay: number) => RACK.bayBase + (bay - 1) * RACK.bayH + RACK.bayH / 2;

/** A box with 2 mm bevelled edges (SPEC section 5: "parametric boxes with 2 mm bevels"). */
function bx(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const r = Math.min(0.002, Math.min(w, h, d) / 2 - 0.0005);
  const g: THREE.BufferGeometry = r > 0.0004 ? new RoundedBoxGeometry(w, h, d, 1, r) : new THREE.BoxGeometry(w, h, d).toNonIndexed();
  g.translate(x, y, z); return g.index ? g.toNonIndexed() : g;
}

function rackFrameGeometry(): THREE.BufferGeometry {
  const { w, d, h } = RACK, t = 0.018;
  const parts = [
    bx(t, h, d, -w / 2 + t / 2, h / 2, 0), bx(t, h, d, w / 2 - t / 2, h / 2, 0),          // sides
    bx(w, 0.06, d, 0, 0.03, 0),                                                            // plinth
    bx(w - 2 * t, h - 0.08, 0.012, 0, h / 2 + 0.02, -d / 2 + 0.03),                        // rear door
    bx(0.03, h - 0.08, 0.03, -w / 2 + 0.05, h / 2 + 0.02, SERVER_FRONT_Z - 0.02),          // front posts
    bx(0.03, h - 0.08, 0.03, w / 2 - 0.05, h / 2 + 0.02, SERVER_FRONT_Z - 0.02),
  ];
  return mergeGeometries(parts)!;
}

/** The rack's top panel and the 2U top-of-rack switch. Separate from the frame so it can be lifted away while a server in that rack is open. */
function rackTopGeometry(): THREE.BufferGeometry {
  const { w, d, h } = RACK, t = 0.018;
  return mergeGeometries([bx(w, t, d, 0, h - t / 2, 0), bx(w - 2 * t, 0.085, 0.5, 0, 1.868 + 0.045, SERVER_FRONT_Z - 0.26)])!;
}

function doorFrameGeometry(): THREE.BufferGeometry {
  // hinge at local x = 0 (left edge), door extends +x
  const w = RACK.w - 0.01, h = RACK.h - 0.07, t = 0.02, b = 0.035;
  return mergeGeometries([
    bx(b, h, t, b / 2, h / 2, 0), bx(b, h, t, w - b / 2, h / 2, 0),
    bx(w, b, t, w / 2, b / 2, 0), bx(w, b, t, w / 2, h - b / 2, 0),
    bx(0.012, 0.16, 0.03, w - 0.06, h / 2, 0.02),                                          // handle
  ])!;
}

/** One texture holding every id label: 60 rack ids and 10 bay ids, in an 8 x 9 grid of cells. */
const LABELS: string[] = [...["A", 12], ...["B", 16], ...["C", 32]].reduce<string[]>((a, _v, i, arr) => (i % 2 ? a : a.concat(Array.from({ length: arr[i + 1] as number }, (_x, k) => `${arr[i]}-R${String(k + 1).padStart(2, "0")}`))), []).concat(Array.from({ length: 10 }, (_x, k) => `S${String(k + 1).padStart(2, "0")}`));
const LCOLS = 8, LROWS = 9;
function labelAtlas(): THREE.CanvasTexture {
  const c = document.createElement("canvas"); c.width = LCOLS * 128; c.height = LROWS * 40; const g = c.getContext("2d")!;
  g.fillStyle = "#0b0c0e"; g.fillRect(0, 0, c.width, c.height); g.fillStyle = "#cfd8e2"; g.font = "700 26px 'SF Mono', Menlo, monospace"; g.textAlign = "center"; g.textBaseline = "middle";
  LABELS.forEach((t, i) => g.fillText(t, (i % LCOLS) * 128 + 64, Math.floor(i / LCOLS) * 40 + 21));
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8; return tex;
}
const labelUV = (text: string): [number, number] => { const i = Math.max(0, LABELS.indexOf(text)); return [(i % LCOLS) / LCOLS, 1 - (Math.floor(i / LCOLS) + 1) / LROWS]; };
let faceTex: THREE.CanvasTexture | null = null;
export function serverFaceTexture(): THREE.CanvasTexture {
  if (faceTex) return faceTex;
  const c = document.createElement("canvas"); c.width = FACE_PX.w; c.height = FACE_PX.h;
  const g = c.getContext("2d")!;
  const sx = FACE_PX.w / SERVER_W, sy = FACE_PX.h / SERVER_H;
  const X = (m: number) => (m + SERVER_W / 2) * sx, Y = (m: number) => (SERVER_H / 2 - m) * sy;
  g.fillStyle = "#17191c"; g.fillRect(0, 0, c.width, c.height);
  // brushed bezel gradient
  const gr = g.createLinearGradient(0, 0, 0, c.height); gr.addColorStop(0, "#22252a"); gr.addColorStop(0.5, "#16181b"); gr.addColorStop(1, "#0f1113");
  g.fillStyle = gr; g.fillRect(0, 0, c.width, c.height);
  // vent field (hex perforation) across the upper middle
  g.fillStyle = "#050607";
  for (let y = 0.02; y < 0.075; y += 0.0062) for (let x = -0.165, i = 0; x < 0.2; x += 0.0072, i++) {
    if (x > 0.012 && x < 0.172 && y > 0.044 && y < 0.068) continue; // room for the load bar
    g.beginPath(); g.arc(X(x + ((Math.round(y / 0.0062) % 2) ? 0.0036 : 0)), Y(y), 0.0024 * sx, 0, 7); g.fill();
  }
  // load bar well
  g.fillStyle = "#07080a"; g.fillRect(X(0.012), Y(0.064), 0.16 * sx, 0.018 * sy);
  // drive caddies along the bottom
  for (const cx of [-0.13, -0.05, 0.03, 0.11]) {
    g.fillStyle = "#0c0d0f"; g.fillRect(X(cx - 0.036), Y(-0.022), 0.072 * sx, 0.052 * sy);
    g.strokeStyle = "#2d3136"; g.lineWidth = 2; g.strokeRect(X(cx - 0.036), Y(-0.022), 0.072 * sx, 0.052 * sy);
    g.fillStyle = "#050607";
    for (let yy = -0.03; yy > -0.056; yy -= 0.006) g.fillRect(X(cx - 0.008), Y(yy), 0.038 * sx, 0.0026 * sy);
    g.fillStyle = "#2a2d31"; g.fillRect(X(cx + 0.024), Y(-0.03), 0.006 * sx, 0.036 * sy); // pull tab
  }
  // left control column
  g.fillStyle = "#0b0c0e"; g.fillRect(X(-0.215), Y(0.07), 0.04 * sx, 0.11 * sy);
  g.strokeStyle = "#3a3f45"; g.lineWidth = 3; g.beginPath(); g.arc(X(-0.2), Y(0.05), 0.0085 * sx, 0, 7); g.stroke();
  // rack ears + screws
  g.fillStyle = "#1c1f23"; g.fillRect(0, 0, 0.006 * sx, c.height); g.fillRect(c.width - 0.006 * sx, 0, 0.006 * sx, c.height);
  // label plate
  g.fillStyle = "#c9d2dc"; g.font = "600 26px 'SF Mono', Menlo, monospace"; g.fillText("KESTREL NODE 4U", X(0.085), Y(-0.07));
  // edge highlight
  g.fillStyle = "rgba(255,255,255,0.06)"; g.fillRect(0, 0, c.width, 3);
  g.fillStyle = "rgba(0,0,0,0.5)"; g.fillRect(0, c.height - 4, c.width, 4);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; faceTex = t; return t;
}

/** LED layout on a server face, metres from the face centre. kind drives how the sim state maps to it. */
type LedKind = "power" | "temp" | "net" | "driveAct" | "driveStat" | "load";
interface LedDef { x: number; y: number; w: number; h: number; kind: LedKind; i: number }
export const LED_LAYOUT: LedDef[] = (() => {
  const L: LedDef[] = [];
  L.push({ x: -0.2, y: 0.05, w: 0.008, h: 0.008, kind: "power", i: 0 });
  L.push({ x: -0.2, y: 0.02, w: 0.005, h: 0.005, kind: "temp", i: 0 });
  L.push({ x: -0.205, y: -0.005, w: 0.004, h: 0.004, kind: "net", i: 0 });
  L.push({ x: -0.195, y: -0.005, w: 0.004, h: 0.004, kind: "net", i: 1 });
  [-0.13, -0.05, 0.03, 0.11].forEach((cx, i) => {
    L.push({ x: cx - 0.028, y: -0.03, w: 0.004, h: 0.004, kind: "driveAct", i });
    L.push({ x: cx - 0.028, y: -0.04, w: 0.004, h: 0.004, kind: "driveStat", i });
  });
  for (let i = 0; i < 12; i++) L.push({ x: 0.022 + i * 0.0128, y: 0.055, w: 0.0095, h: 0.007, kind: "load", i });
  return L;
})();

const hexToLin = (hex: number, k: number) => { const c = new THREE.Color(hex); return [c.r * k, c.g * k, c.b * k] as const; };

export class Racks {
  group = new THREE.Group();
  colliders: AABB[] = [];
  private frames: THREE.InstancedMesh;
  private tops: THREE.InstancedMesh;
  /** The server being inspected. Everything above it in its rack is hidden so the whole chassis, rear included, can be seen and reached
   *  at the 0.55 m slide-out (the rear third of a 0.86 m chassis is still inside the rack). */
  inspect: { rack: string; bay: number } | null = null;
  private doors: THREE.InstancedMesh;
  private doorGlass: THREE.InstancedMesh;
  private bodies: THREE.InstancedMesh;
  private faces: THREE.InstancedMesh;
  private blanks: THREE.InstancedMesh;
  private leds: THREE.InstancedMesh;
  private bars: THREE.InstancedMesh;
  private edges: THREE.InstancedMesh;
  private doorMesh: THREE.InstancedMesh;          // perforated lower panel of each door (glass above, mesh below)
  private pdu: THREE.InstancedMesh;               // rear PDU: a strip of 10 outlet LEDs per rack showing load
  private pduColor: THREE.InstancedBufferAttribute; private pduFx: THREE.InstancedBufferAttribute;
  private idLabels: THREE.InstancedMesh; private idUV: THREE.InstancedBufferAttribute;      // per-server bay label and per-rack id label
  private ledColor: THREE.InstancedBufferAttribute;
  private ledFx: THREE.InstancedBufferAttribute;
  private barColor: THREE.InstancedBufferAttribute;
  private barFx: THREE.InstancedBufferAttribute;
  /** rack id -> world matrix (rack-local to world) */
  rackMatrix = new Map<string, THREE.Matrix4>();
  /** server id -> { rack, bay, instance index } */
  serverIndex = new Map<string, { rack: string; bay: number; idx: number }>();
  private serverOrder: string[] = [];
  private doorAngle = new Map<string, number>();
  private pull = new Map<string, number>();      // server id -> pull-out distance (m)
  hidden = new Set<string>();                    // servers drawn by the inspect view instead
  private view: WorldView | null = null;
  /** per-server display values, eased toward the latest delta so the 10 Hz feed reads as continuous (SPEC section 4: the renderer interpolates) */
  private smooth = new Map<string, { load: number; temp: number }>(); private lastT = 0;
  private structureKey = "";

  constructor() {
    const metal = mats.rackMetal();
    this.frames = new THREE.InstancedMesh(rackFrameGeometry(), metal, MAX_RACKS);
    this.tops = new THREE.InstancedMesh(rackTopGeometry(), metal, MAX_RACKS); this.tops.count = 0; this.tops.frustumCulled = false; this.tops.castShadow = true; this.group.add(this.tops);
    this.doors = new THREE.InstancedMesh(doorFrameGeometry(), metal, MAX_RACKS);
    const glassG = new THREE.BoxGeometry(RACK.w - 0.08, RACK.h - 0.14 - 0.64, 0.006); glassG.translate((RACK.w - 0.01) / 2, (RACK.h - 0.07) / 2 + 0.32, 0);
    const glassM = new THREE.MeshPhysicalNodeMaterial({ color: 0x0c1418, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.2 });
    glassM.depthWrite = false; glassM.envMapIntensity = 1.6;
    this.doorGlass = new THREE.InstancedMesh(glassG, glassM, MAX_RACKS);
    const bodyG = bx(SERVER_W, SERVER_H, SERVER_D, 0, 0, -SERVER_D / 2 - 0.001);
    this.bodies = new THREE.InstancedMesh(bodyG, new THREE.MeshStandardNodeMaterial({ color: 0x1b1d20, roughness: 0.5, metalness: 0.8 }), MAX_SERVERS);
    const faceM = new THREE.MeshStandardNodeMaterial({ map: serverFaceTexture(), roughness: 0.55, metalness: 0.6 });
    this.faces = new THREE.InstancedMesh(new THREE.PlaneGeometry(SERVER_W + 0.036, SERVER_H), faceM, MAX_SERVERS);
    this.blanks = new THREE.InstancedMesh(new THREE.PlaneGeometry(SERVER_W + 0.036, SERVER_H), new THREE.MeshStandardNodeMaterial({ color: 0x08090a, roughness: 0.7, metalness: 0.5 }), MAX_SERVERS);

    const ledMat = (colorAttr: string, fxAttr: string) => {
      const col = attribute(colorAttr, "vec3"), fx = attribute(fxAttr, "vec4");
      const blink = step(0.5, fract(time.mul(fx.y).add(fx.z)));
      const flick = step(fx.w.oneMinus(), hash(floor(time.mul(fx.y)).add(fx.z.mul(97.13))));
      const sweep = smoothstep(0.3, 0.0, abs(fract(time.mul(fx.y)).sub(fx.z)));
      const k = select(fx.x.lessThan(0.5), float(1), select(fx.x.lessThan(1.5), blink, select(fx.x.lessThan(2.5), flick, sweep)));
      const m = glow(col.mul(k.mul(0.96).add(0.04)));
      return m;
    };
    const ledG = new THREE.PlaneGeometry(1, 1);
    const nLed = MAX_SERVERS * LEDS_PER_SERVER;
    this.ledColor = new THREE.InstancedBufferAttribute(new Float32Array(nLed * 3), 3);
    this.ledFx = new THREE.InstancedBufferAttribute(new Float32Array(nLed * 4), 4);
    ledG.setAttribute("ledColor", this.ledColor); ledG.setAttribute("ledFx", this.ledFx);
    this.leds = new THREE.InstancedMesh(ledG, ledMat("ledColor", "ledFx"), nLed);

    const barG = new THREE.BoxGeometry(RACK.w - 0.08, 0.012, 0.012);
    this.barColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_RACKS * 3), 3);
    this.barFx = new THREE.InstancedBufferAttribute(new Float32Array(MAX_RACKS * 4), 4);
    barG.setAttribute("ledColor", this.barColor); barG.setAttribute("ledFx", this.barFx);
    this.bars = new THREE.InstancedMesh(barG, ledMat("ledColor", "ledFx"), MAX_RACKS);

    const meshG = new THREE.PlaneGeometry(RACK.w - 0.09, 0.62); meshG.translate((RACK.w - 0.01) / 2, 0.36, 0.004);
    const uvA = meshG.attributes.uv; for (let i = 0; i < uvA.count; i++) uvA.setXY(i, uvA.getX(i) * 5, uvA.getY(i) * 6);
    this.doorMesh = new THREE.InstancedMesh(meshG, mats.perforated(), MAX_RACKS);
    const pduG = new THREE.PlaneGeometry(0.012, 0.012); pduG.rotateY(Math.PI);
    this.pduColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_RACKS * 10 * 3), 3); this.pduFx = new THREE.InstancedBufferAttribute(new Float32Array(MAX_RACKS * 10 * 4), 4);
    pduG.setAttribute("ledColor", this.pduColor); pduG.setAttribute("ledFx", this.pduFx);
    this.pdu = new THREE.InstancedMesh(pduG, ledMat("ledColor", "ledFx"), MAX_RACKS * 10);
    const idG = new THREE.PlaneGeometry(1, 1); this.idUV = new THREE.InstancedBufferAttribute(new Float32Array((MAX_SERVERS + MAX_RACKS) * 2), 2); idG.setAttribute("idUV", this.idUV);
    const idM = new THREE.MeshBasicNodeMaterial(); idM.colorNode = texture(labelAtlas(), uv().mul(vec2(1 / LCOLS, 1 / LROWS)).add(attribute("idUV", "vec2"))).rgb.mul(0.9);
    this.idLabels = new THREE.InstancedMesh(idG, idM, MAX_SERVERS + MAX_RACKS); this.idLabels.layers.set(1);
    const edgeG = mergeGeometries([bx(0.006, RACK.h - 0.12, 0.006, -RACK.w / 2 + 0.012, RACK.h / 2, RACK.d / 2 + 0.016), bx(0.006, RACK.h - 0.12, 0.006, RACK.w / 2 - 0.012, RACK.h / 2, RACK.d / 2 + 0.016)])!;
    edgeG.setAttribute("ledColor", this.barColor); edgeG.setAttribute("ledFx", this.barFx);
    this.edges = new THREE.InstancedMesh(edgeG, ledMat("ledColor", "ledFx"), MAX_RACKS);
    this.pdu.layers.set(1); this.doorMesh.layers.set(1);        // small props: drawn in the view, skipped by the floor reflection
    for (const m of [this.frames, this.doors, this.doorGlass, this.doorMesh, this.pdu, this.idLabels, this.bodies, this.faces, this.blanks, this.leds, this.bars, this.edges]) {
      m.count = 0; m.frustumCulled = false; this.group.add(m);
    }
    this.frames.castShadow = true; this.frames.receiveShadow = true;
    this.bodies.castShadow = false; this.faces.receiveShadow = true;
  }

  setDoorAngle(rack: string, a: number): void { this.doorAngle.set(rack, a); this.structureKey = ""; }
  setPull(server: string, d: number): void { this.pull.set(server, d); this.structureKey = ""; }
  getPull(server: string): number { return this.pull.get(server) ?? 0; }

  /** World matrix of a server's local frame (origin at face centre, +z out of the rack). */
  serverMatrix(id: string): THREE.Matrix4 | null {
    const e = this.serverIndex.get(id); if (!e) return null;
    const rm = this.rackMatrix.get(e.rack)!;
    return rm.clone().multiply(new THREE.Matrix4().makeTranslation(0, bayY(e.bay), SERVER_FRONT_Z + (this.pull.get(id) ?? 0)));
  }

  update(view: WorldView): void {
    this.view = view;
    const key = view.racks.map((r) => r.id + ":" + r.servers.map((s) => (s ? (this.hidden.has(s.id) ? "h" : "1") : "0")).join("")).join("|") + "#" + this.hidden.size + "#" + (this.inspect ? this.inspect.rack + this.inspect.bay : "");
    if (key !== this.structureKey) { this.rebuildStructure(view); this.structureKey = key; }
    this.updateLeds(view);
  }

  private rebuildStructure(view: WorldView): void {
    const M = new THREE.Matrix4(), T = new THREE.Matrix4(), R = new THREE.Matrix4();
    this.colliders.length = 0; this.rackMatrix.clear(); this.serverIndex.clear(); this.serverOrder.length = 0;
    let si = 0, bi = 0, li = 0; const idUV = this.idUV.array as Float32Array;
    const putLabel = (m: THREE.Matrix4, text: string) => { this.idLabels.setMatrixAt(li, m); const [u, v] = labelUV(text); idUV[li * 2] = u; idUV[li * 2 + 1] = v; li++; };
    view.racks.forEach((rack, ri) => {
      const p = slotPose(rack.hall, rack.slot);
      const rm = new THREE.Matrix4().makeRotationY(p.rot).setPosition(p.x, 0, p.z);
      this.rackMatrix.set(rack.id, rm);
      this.frames.setMatrixAt(ri, rm);
      const open = this.inspect && this.inspect.rack === rack.id ? this.inspect.bay : 0;
      this.tops.setMatrixAt(ri, open ? ZERO : rm);
      // door: hinge on the rack's local -x front edge
      const a = this.doorAngle.get(rack.id) ?? 0;
      T.makeTranslation(-RACK.w / 2 + 0.005, 0.05, RACK.d / 2 + 0.004); R.makeRotationY(-a);
      M.copy(rm).multiply(T).multiply(R);
      this.doors.setMatrixAt(ri, M); this.doorGlass.setMatrixAt(ri, M); this.doorMesh.setMatrixAt(ri, M);
      for (let k = 0; k < 10; k++) { const PM = rm.clone().multiply(new THREE.Matrix4().makeTranslation(RACK.w / 2 - 0.06, 0.5 + k * 0.1, -RACK.d / 2 - 0.004)); this.pdu.setMatrixAt(ri * 10 + k, PM); }
      // light bar on top front edge
      M.copy(rm).multiply(T.makeTranslation(0, RACK.h + 0.012, RACK.d / 2 - 0.02));
      this.bars.setMatrixAt(ri, M);
      this.edges.setMatrixAt(ri, rm);
      putLabel(rm.clone().multiply(new THREE.Matrix4().makeTranslation(0, RACK.h - 0.045, RACK.d / 2 + 0.016)).multiply(new THREE.Matrix4().makeScale(0.16, 0.05, 1)), rack.id);       // rack id plate on the door header
      const half = p.rot === 0 ? 1 : -1;
      this.colliders.push({ x0: p.x - RACK.w / 2, x1: p.x + RACK.w / 2, z0: p.z - RACK.d / 2, z1: p.z + RACK.d / 2, tag: rack.id });
      void half;
      rack.servers.forEach((s, b) => {
        const bay = b + 1;
        if (!s) {
          if (open && bay > open) return;
          M.copy(rm).multiply(T.makeTranslation(0, bayY(bay), SERVER_FRONT_Z - 0.004));
          this.blanks.setMatrixAt(bi++, M);
          return;
        }
        this.serverIndex.set(s.id, { rack: rack.id, bay, idx: si });
        this.serverOrder[si] = s.id;
        const z = SERVER_FRONT_Z + (this.pull.get(s.id) ?? 0);
        M.copy(rm).multiply(T.makeTranslation(0, bayY(bay), z));
        if (this.hidden.has(s.id) || (open && bay > open)) M.multiply(R.makeScale(0, 0, 0));
        this.bodies.setMatrixAt(si, M);
        const F = M.clone().multiply(T.makeTranslation(0, 0, 0.0005));
        this.faces.setMatrixAt(si, F);
        putLabel(M.clone().multiply(new THREE.Matrix4().makeTranslation(-0.165, 0.05, 0.0014)).multiply(new THREE.Matrix4().makeScale(0.042, 0.0131, 1)), `S${String(bay).padStart(2, "0")}`);        // id label beside the power button
        LED_LAYOUT.forEach((L, li) => {
          const LM = M.clone().multiply(T.makeTranslation(L.x, L.y, 0.0012)).multiply(R.makeScale(L.w, L.h, 1));
          this.leds.setMatrixAt(si * LEDS_PER_SERVER + li, LM);
        });
        si++;
      });
    });
    const nR = view.racks.length;
    this.tops.count = nR; this.tops.instanceMatrix.needsUpdate = true;
    this.frames.count = nR; this.doors.count = nR; this.doorGlass.count = nR; this.doorMesh.count = nR; this.pdu.count = nR * 10; this.bars.count = nR; this.edges.count = nR;
    this.bodies.count = si; this.faces.count = si; this.blanks.count = bi; this.leds.count = si * LEDS_PER_SERVER; this.idLabels.count = li; this.idLabels.instanceMatrix.needsUpdate = true; this.idUV.needsUpdate = true;
    for (const m of [this.frames, this.doors, this.doorGlass, this.doorMesh, this.pdu, this.bars, this.edges, this.bodies, this.faces, this.blanks, this.leds]) m.instanceMatrix.needsUpdate = true;
  }

  private updateLeds(view: WorldView): void {
    const col = this.ledColor.array as Float32Array, fx = this.ledFx.array as Float32Array;
    const now = view.tick;
    const set = (i: number, c: readonly [number, number, number], mode = 0, rate = 0, phase = 0, amt = 0) => {
      col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
      fx[i * 4] = mode; fx[i * 4 + 1] = rate; fx[i * 4 + 2] = phase; fx[i * 4 + 3] = amt;
    };
    const tNow = clock.now(); const kLerp = Math.min(1, Math.max(0, (tNow - this.lastT) / 1000) * 8); this.lastT = tNow;
    const OFF = [0, 0, 0] as const;
    const G = hexToLin(STATUS.green, 14), A = hexToLin(STATUS.amber, 17), Rr = hexToLin(STATUS.red, 20), C = hexToLin(STATUS.cyan, 20), W = hexToLin(STATUS.white, 0.6), B = hexToLin(0x3d8bff, 7);
    view.racks.forEach((rack, ri) => {
      let worst = 0; let any = false;
      for (const s of rack.servers) {
        if (!s) continue; any = true;
        const e = this.serverIndex.get(s.id); if (!e) continue;
        const base = e.idx * LEDS_PER_SERVER;
        const seed = (e.idx * 0.6180339) % 1;
        let sm = this.smooth.get(s.id); if (!sm) { sm = { load: s.load, temp: s.tempC }; this.smooth.set(s.id, sm); } else { sm.load += (s.load - sm.load) * kLerp; sm.temp += (s.tempC - sm.temp) * kLerp; }
        const load = sm.load, temp = sm.temp;
        const on = s.power === "on", boot = s.power === "booting", dead = s.power === "shutdown_thermal" || s.power === "no_power";
        const sev = dead || s.status === "failed" ? 2 : s.status === "degraded" ? 1 : 0;
        if (on || boot || dead) worst = Math.max(worst, sev);
        const claude = (s.claudeUntil ?? 0) > now;
        LED_LAYOUT.forEach((L, li) => {
          const i = base + li;
          const ph = (seed + li * 0.137) % 1;
          if (L.kind === "power") {
            if (claude) set(i, C, 1, 2.0, 0);
            else if (on) set(i, sev === 2 ? Rr : sev === 1 ? A : G, sev === 2 ? 1 : sev === 1 ? 1 : 0, sev === 2 ? 3 : 1, 0);
            else if (boot) set(i, G, 1, 2, 0);
            else if (dead) set(i, Rr, 1, 3, 0);
            else set(i, W);
          } else if (!on && !boot) {
            set(i, dead && L.kind === "temp" ? Rr : OFF, dead ? 1 : 0, 3, 0);
          } else if (boot) {
            if (L.kind === "load") set(i, G, 3, 0.9, L.i / 12); else set(i, OFF);
          } else if (L.kind === "temp") {
            set(i, temp > 85 ? Rr : temp > 70 ? A : G, temp > 85 ? 1 : 0, 3, 0);
          } else if (L.kind === "net") {
            set(i, L.i === 0 ? G : A, 2, 9 + L.i * 5, ph, 0.25 + 0.6 * load);
          } else if (L.kind === "driveAct") {
            if (!s.drives[L.i]) set(i, OFF); else set(i, B, 2, 14, ph, 0.1 + 0.7 * load);
          } else if (L.kind === "driveStat") {
            const d = s.drives[L.i];
            if (!d) set(i, OFF); else set(i, d === 3 ? Rr : d === 2 ? A : G, d === 1 ? 0 : 1, d === 3 ? 3 : 1, 0);
          } else {
            const lit = L.i < Math.round(load * 12);
            const c = L.i >= 10 ? Rr : L.i >= 8 ? A : G;
            set(i, lit ? c : hexToLin(0x14301f, 0.5));
          }
        });
      }
      const bc = !any ? hexToLin(0x223040, 0.6) : worst === 2 ? hexToLin(STATUS.red, 4) : worst === 1 ? hexToLin(STATUS.amber, 3) : hexToLin(0x8fc4ff, 1.6);
      const bcol = this.barColor.array as Float32Array, bfx = this.barFx.array as Float32Array;
      bcol[ri * 3] = bc[0]; bcol[ri * 3 + 1] = bc[1]; bcol[ri * 3 + 2] = bc[2];
      bfx[ri * 4] = worst === 2 ? 1 : 0; bfx[ri * 4 + 1] = 3; bfx[ri * 4 + 2] = 0; bfx[ri * 4 + 3] = 0;
      // rear PDU strip: outlets light up with load, green to amber to red; all red and blinking when the breaker has tripped
      const pc = this.pduColor.array as Float32Array, pf = this.pduFx.array as Float32Array; const lit = Math.round(Math.min(1, rack.kw / rack.pduCapKw) * 10);
      for (let k = 0; k < 10; k++) { const i = ri * 10 + k; const c = rack.breaker === "tripped" ? Rr : k < lit ? (k >= 9 ? Rr : k >= 7 ? A : G) : hexToLin(0x14301f, 0.5); pc[i * 3] = c[0] * 0.5; pc[i * 3 + 1] = c[1] * 0.5; pc[i * 3 + 2] = c[2] * 0.5; pf[i * 4] = rack.breaker === "tripped" ? 1 : 0; pf[i * 4 + 1] = 3; pf[i * 4 + 2] = 0; pf[i * 4 + 3] = 0; }
      if (rack.breaker === "tripped") { bcol[ri * 3] = Rr[0] * 0.2; bcol[ri * 3 + 1] = Rr[1] * 0.2; bcol[ri * 3 + 2] = Rr[2] * 0.2; bfx[ri * 4] = 1; }
    });
    this.ledColor.needsUpdate = true; this.ledFx.needsUpdate = true; this.barColor.needsUpdate = true; this.barFx.needsUpdate = true; this.pduColor.needsUpdate = true; this.pduFx.needsUpdate = true;
  }
}
