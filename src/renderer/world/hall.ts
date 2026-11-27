import * as THREE from "three/webgpu";
import { RectAreaLightTexturesLib } from "three/addons/lights/RectAreaLightTexturesLib.js";
import { color, uv, texture, uniform, mrt, vec4 } from "three/tsl";
import { HALLS, CEILING, CONTROL, LOADING, PLANT, type HallId } from "@shared/layout";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { mats as rawMats, makeFloor, glow, type Floor } from "./materials";

export interface AABB { x0: number; x1: number; z0: number; z1: number; tag?: string }
export interface HallBuild { group: THREE.Group; colliders: AABB[]; floor: Floor; /** where the two roaming fill lights sit in each hall */ fillSlots: Record<HallId, { pos: [number, number, number]; hex: number; power: number; reach: number }[]>; /** where each hall's own ceiling area lights sit */ /** one brightness uniform per ceiling light bar, in row order, so a new hall's lights can strike on row by row */ bars: Record<HallId, { value: number }[]>; areaSlots: Record<HallId, { pos: [number, number, number]; w: number; h: number; hex: number; power: number }[]>; /** where the two roaming shadow spots sit in each hall */ spotSlots: Record<HallId, { pos: [number, number, number]; target: [number, number, number] }[]> }

// One material instance per kind per build, so the static shell can be merged into a handful of draw calls.
let cache = new Map<string, THREE.Material>();
const once = <T extends THREE.Material>(key: string, make: () => T): T => { let m = cache.get(key) as T | undefined; if (!m) { m = make(); cache.set(key, m); } return m; };
const mats = {
  steel: () => once("steel", rawMats.steel), darkPlastic: () => once("dark", rawMats.darkPlastic), wall: () => once("wall", rawMats.wall), wallDark: () => once("wallDark", rawMats.wallDark),
  ceiling: () => once("ceiling", rawMats.ceiling), glass: () => once("glass", rawMats.glass), emissive: (hex: number, i: number) => once(`em${hex}:${i}`, () => rawMats.emissive(hex, i)),
};
let fillSlots: HallBuild["fillSlots"] = { A: [], B: [], C: [] }; let fillHall: HallId | "control" = "A"; let spotSlots: HallBuild["spotSlots"] = { A: [], B: [], C: [] }; let areaSlots: HallBuild["areaSlots"] = { A: [], B: [], C: [] }; let bars: HallBuild["bars"] = { A: [], B: [], C: [] };

/** A shadow-casting spot over an aisle, with a faint visible cone of light under it (SPEC section 6, lighting). */
function shadowSpot(g: THREE.Group, hall: HallId, x: number, z: number, tx: number, tz: number): void {
  // The light itself is one of two roaming spots owned by the main loop; a hall only records where they go.
  spotSlots[hall].push({ pos: [x, CEILING - 0.3, z], target: [tx, 0, tz] });
  const cm = once("cone", () => { const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }); m.colorNode = color(0xdfe9ff).mul(0.05); m.opacityNode = uv().y.pow(2.2).mul(0.5); return m; });
  const cone = new THREE.Mesh(new THREE.ConeGeometry(1.5, 2.6, 24, 1, true), cm); cone.position.set((x + tx) / 2, CEILING - 0.5 - 1.3, (z + tz) / 2); cone.renderOrder = 3; g.add(cone);
}

/** Row and rack numbers painted on the floor in front of every rack slot. */
function floorDecals(g: THREE.Group, hall: HallId): void {
  const hb = HALLS[hall], W = hb.x1 - hb.x0, D = hb.z1 - hb.z0, ppm = 150;
  const c = document.createElement("canvas"); c.width = Math.round(W * ppm); c.height = Math.round(D * ppm);
  const cx = c.getContext("2d")!; cx.clearRect(0, 0, c.width, c.height);
  cx.fillStyle = "rgba(230,236,244,0.55)"; cx.font = `600 ${Math.round(0.13 * ppm)}px "SF Mono", Menlo, monospace`; cx.textAlign = "center"; cx.textBaseline = "middle";
  let n = 0;
  for (const row of hb.rows) for (let i = 0; i < row.n; i++) {
    n++; const x = row.x0 + i * 0.6, front = row.rot === 0 ? row.z + 0.6 + 0.22 : row.z - 0.6 - 0.22;
    const px = (x - hb.x0) * ppm, py = (hb.z1 - front) * ppm;
    cx.save(); cx.translate(px, py); if (row.rot === 0) cx.rotate(Math.PI); cx.fillText(`${hall}${String(n).padStart(2, "0")}`, 0, 0); cx.restore();
    cx.fillStyle = "rgba(255,196,40,0.45)"; cx.fillRect(px - 0.28 * ppm, (hb.z1 - (row.rot === 0 ? row.z + 0.6 + 0.06 : row.z - 0.6 - 0.06)) * ppm - 2, 0.56 * ppm, 4); cx.fillStyle = "rgba(230,236,244,0.55)";
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  const m = new THREE.MeshBasicNodeMaterial({ map: t, transparent: true, depthWrite: false }); m.colorNode = texture(t, uv()).rgb.mul(0.5); m.opacityNode = texture(t, uv()).a;
  const pl = new THREE.Mesh(new THREE.PlaneGeometry(W, D), m); pl.rotation.x = -Math.PI / 2; pl.position.set((hb.x0 + hb.x1) / 2, 0.004, (hb.z0 + hb.z1) / 2); pl.renderOrder = 1; g.add(pl);
}

function sprinklers(g: THREE.Group, x0: number, x1: number, zs: number[]): void {
  const red = once("pipeRed", () => new THREE.MeshStandardNodeMaterial({ color: 0x7a1512, roughness: 0.45, metalness: 0.6 })), steel = mats.steel();
  for (const z of zs) {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, x1 - x0, 10), red); pipe.rotation.z = Math.PI / 2; pipe.position.set((x0 + x1) / 2, CEILING - 0.12, z); g.add(pipe);
    for (let x = x0 + 1.2; x < x1; x += 2.4) { const head = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.012, 0.06, 10), once("sprinklerHead", rawMats.steel)); head.position.set(x, CEILING - 0.17, z); head.layers.set(1); g.add(head); }
  }
}

function fireCabinet(g: THREE.Group, col: AABB[], x: number, z: number): void {
  const red = once("cabRed", () => new THREE.MeshStandardNodeMaterial({ color: 0x8e1a15, roughness: 0.4, metalness: 0.5 }));
  g.add(box(0.5, 1.5, 0.28, red, x, 0.75, z)); g.add(box(0.36, 0.5, 0.01, once("cabGlass", () => new THREE.MeshStandardNodeMaterial({ color: 0x0c0f12, roughness: 0.1, metalness: 0.2 })), x, 1.05, z + 0.146));
  g.add(box(0.42, 0.08, 0.012, mats.emissive(0xff3b30, 1.6), x, 1.42, z + 0.146));
  col.push({ x0: x - 0.25, x1: x + 0.25, z0: z - 0.14, z1: z + 0.14, tag: "cabinet" });
}

/** Merge every static mesh that shares a material into one mesh. Lights and the reflector target are left alone. */
function mergeStatic(group: THREE.Group): void {
  group.updateMatrixWorld(true);
  const by = new Map<THREE.Material, { geos: THREE.BufferGeometry[]; meshes: THREE.Mesh[]; shadow: boolean }>();
  group.traverse((o: any) => { if (o.isMesh && !o.isInstancedMesh && !Array.isArray(o.material)) { let e = by.get(o.material); if (!e) by.set(o.material, (e = { geos: [], meshes: [], shadow: false })); const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone(); g.applyMatrix4(o.matrixWorld); for (const k of Object.keys(g.attributes)) if (!["position", "normal", "uv"].includes(k)) g.deleteAttribute(k); e.geos.push(g); e.meshes.push(o); e.shadow ||= o.receiveShadow; } });
  for (const [mat, e] of by) {
    if (e.meshes.length < 2) continue;
    const merged = mergeGeometries(e.geos, false); if (!merged) continue;
    const layer1 = e.meshes.every((m) => m.layers.mask === 2);
    for (const m of e.meshes) { m.parent?.remove(m); m.geometry.dispose(); }
    const mesh = new THREE.Mesh(merged, mat); if (layer1) mesh.layers.set(1); mesh.receiveShadow = e.shadow; mesh.castShadow = !(mat as any).transparent && (mat as any).isMeshStandardNodeMaterial === true; group.add(mesh);
  }
}

let ltcReady = false;

function box(w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  mesh.castShadow = true; mesh.receiveShadow = true;
  return mesh;
}

/** A wall along x (constant z) or along z (constant x), with optional gaps. Adds colliders. */
function wall(g: THREE.Group, col: AABB[], m: THREE.Material, axis: "x" | "z", at: number, a: number, b: number, gaps: [number, number][] = [], h = CEILING, t = 0.12): void {
  let cur = a;
  const spans: [number, number][] = [];
  for (const [g0, g1] of [...gaps].sort((p, q) => p[0] - q[0])) { if (g0 > cur) spans.push([cur, g0]); cur = Math.max(cur, g1); }
  if (cur < b) spans.push([cur, b]);
  for (const [s0, s1] of spans) {
    const len = s1 - s0, mid = (s0 + s1) / 2;
    if (axis === "x") { g.add(box(len, h, t, m, mid, h / 2, at)); col.push({ x0: s0, x1: s1, z0: at - t / 2, z1: at + t / 2 }); }
    else { g.add(box(t, h, len, m, at, h / 2, mid)); col.push({ x0: at - t / 2, x1: at + t / 2, z0: s0, z1: s1 }); }
  }
  // lintel over each gap
  for (const [g0, g1] of gaps) {
    const len = g1 - g0, mid = (g0 + g1) / 2, lh = h - 2.2;
    if (lh <= 0) continue;
    if (axis === "x") g.add(box(len, lh, t, m, mid, 2.2 + lh / 2, at));
    else g.add(box(t, lh, len, m, at, 2.2 + lh / 2, mid));
  }
}

function lightBar(g: THREE.Group, x: number, z: number, len: number, alongX: boolean, intensity: number, hex = 0xdfe9ff, power = 9, area = false): void {
  const housing = box(alongX ? len : 0.16, 0.05, alongX ? 0.16 : len, mats.darkPlastic(), x, CEILING - 0.42, z);
  housing.castShadow = false;
  g.add(housing);
  const barU = uniform(1); const barM = glow(color(hex).mul(intensity).mul(barU));
  if (fillHall !== "control") bars[fillHall].push(barU as any);
  const strip = new THREE.Mesh(new THREE.BoxGeometry(alongX ? len - 0.06 : 0.1, 0.012, alongX ? 0.1 : len - 0.06), barM);
  strip.position.set(x, CEILING - 0.45, z);
  g.add(strip);
  if (area) {
    // true area light (the costly kind): the hall's own, created once by the main loop and placed here
    if (fillHall !== "control" && power > 0) areaSlots[fillHall].push({ pos: [x, CEILING - 0.46, z], w: alongX ? len : 0.14, h: alongX ? 0.14 : len, hex, power });
  } else {
    // cheap fill. In the halls this only records a slot for one of the two roaming fill lights (see the main loop): switching lights
    // on and off per hall would rebuild every shader, so a fixed set of lights moves with the player instead. Side rooms keep their own.
    if (fillHall === "control") { const pl = new THREE.PointLight(hex, power * 1.5, Math.max(7, len * 1.2), 1.4); pl.position.set(x, CEILING - 0.6, z); g.add(pl); }
    else fillSlots[fillHall].push({ pos: [x, CEILING - 0.6, z], hex, power: power * 1.5, reach: Math.max(7, len * 1.2) });
  }
}

function cableTray(g: THREE.Group, x0: number, x1: number, z: number, y: number): void {
  const len = x1 - x0, mid = (x0 + x1) / 2;
  const steel = mats.steel();
  g.add(box(len, 0.02, 0.4, steel, mid, y, z));
  g.add(box(len, 0.08, 0.015, steel, mid, y + 0.04, z - 0.2));
  g.add(box(len, 0.08, 0.015, steel, mid, y + 0.04, z + 0.2));
  // fibre bundles
  const colors = [0xd8b400, 0x1fb5b0, 0xd8b400, 0x2b6fd6, 0xe07a10];
  colors.forEach((c, i) => {
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, len, 8), once(`fibre${c}`, () => new THREE.MeshStandardNodeMaterial({ color: c, roughness: 0.55 })));
    cyl.rotation.z = Math.PI / 2;
    cyl.position.set(mid, y + 0.03, z - 0.14 + i * 0.07);
    g.add(cyl);
  });
  // cable ties around the bundles, each with a short tail standing up
  const tie = once("tie", () => new THREE.MeshStandardNodeMaterial({ color: 0x0c0c0c, roughness: 0.6 }));
  for (let x = x0 + 0.45, k = 0; x < x1; x += 0.9, k++) { const band = box(0.006, 0.045, 0.34, tie, x, y + 0.035, z); band.layers.set(1); g.add(band); const tail = box(0.004, 0.05, 0.004, tie, x, y + 0.08, z - 0.15 + (k % 5) * 0.07); tail.rotation.z = 0.5 - (k % 3) * 0.4; tail.layers.set(1); g.add(tail); }
  for (let x = x0 + 0.6; x < x1; x += 1.8) {
    g.add(box(0.012, CEILING - y - 0.02, 0.012, steel, x, (CEILING + y) / 2, z - 0.2));
    g.add(box(0.012, CEILING - y - 0.02, 0.012, steel, x, (CEILING + y) / 2, z + 0.2));
  }
}

export function buildFloorAndShell(owned: Record<HallId, boolean>): HallBuild {
  if (!ltcReady) { (THREE as any).RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init()); ltcReady = true; }
  const group = new THREE.Group();
  const colliders: AABB[] = [];
  cache = new Map(); fillSlots = { A: [], B: [], C: [] }; spotSlots = { A: [], B: [], C: [] }; areaSlots = { A: [], B: [], C: [] }; bars = { A: [], B: [], C: [] }; fillHall = "A";
  const floor = makeFloor(0.5);
  group.add(floor.target);

  const wallM = mats.wall(), wallD = mats.wallDark(), ceilM = mats.ceiling();

  const addFloorCeil = (x0: number, x1: number, z0: number, z1: number, h = CEILING) => {
    const w = x1 - x0, d = z1 - z0;
    const f = new THREE.Mesh(new THREE.PlaneGeometry(w, d), floor.material);
    f.rotation.x = -Math.PI / 2; f.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2); f.receiveShadow = true;
    group.add(f);
    const c = new THREE.Mesh(new THREE.PlaneGeometry(w, d), ceilM);
    c.rotation.x = Math.PI / 2; c.position.set((x0 + x1) / 2, h, (z0 + z1) / 2);
    group.add(c);
  };

  // ---- Hall A ----
  const A = HALLS.A;
  addFloorCeil(A.x0, A.x1, A.z0, A.z1);
  wall(group, colliders, wallM, "x", A.z0, A.x0, A.x1);                                   // south
  if (!owned.C) wall(group, colliders, wallM, "x", A.z1, A.x0, A.x1);                     // north (opens to C)
  else wall(group, colliders, wallM, "x", A.z1, A.x0, A.x1, [[5.0, 7.0]]);
  if (!owned.B) wall(group, colliders, wallD, "z", A.x1, A.z0, A.z1);                     // east (opens to B)
  else wall(group, colliders, wallD, "z", A.x1, A.z0, A.z1, [[3.3, 5.1]]);
  // west: plant wall (solid), control room glass (z 3..6) with door, loading bay wall with doorway
  // the plant room sits behind a window in this wall, so its chillers and switchgear can be seen from the hall
  wall(group, colliders, wallM, "z", 0, 0, 0.7); wall(group, colliders, wallM, "z", 0, 2.3, CONTROL.z0);
  group.add(box(0.12, 0.9, 1.6, wallM, 0, 0.45, 1.5)); group.add(box(0.12, CEILING - 2.2, 1.6, wallM, 0, 2.2 + (CEILING - 2.2) / 2, 1.5));
  { const pw = new THREE.Mesh(new THREE.BoxGeometry(0.02, 1.3, 1.6), mats.glass()); pw.position.set(0, 1.55, 1.5); group.add(pw); colliders.push({ x0: -0.06, x1: 0.06, z0: 0.7, z1: 2.3, tag: "plant-window" }); }
  wall(group, colliders, wallM, "z", 0, CONTROL.z1, A.z1, [[7.0, 8.2]]);
  // glass wall with door gap; a low sill + mullions
  const glass = mats.glass();
  const gz0 = CONTROL.doorZ1, gz1 = CONTROL.z1;
  const pane = new THREE.Mesh(new THREE.BoxGeometry(0.02, CEILING - 0.1, gz1 - gz0), glass);
  pane.position.set(0, CEILING / 2, (gz0 + gz1) / 2);
  group.add(pane);
  colliders.push({ x0: -0.06, x1: 0.06, z0: gz0, z1: gz1, tag: "glass" });
  const steel = mats.steel();
  for (const z of [gz0, (gz0 + gz1) / 2, gz1]) group.add(box(0.05, CEILING, 0.05, steel, 0, CEILING / 2, z));
  group.add(box(0.05, 0.05, gz1 - gz0, steel, 0, 0.025, (gz0 + gz1) / 2));
  group.add(box(0.05, 0.05, gz1 - CONTROL.doorZ0, steel, 0, CEILING - 0.025, (CONTROL.doorZ0 + gz1) / 2));
  group.add(box(0.05, CEILING, 0.05, steel, 0, CEILING / 2, CONTROL.doorZ0));

  // lights: cold aisle is the bright spine; hot aisles get a dim cool wash
  lightBar(group, 6.0, 3.72, 9.4, true, 3.0, 0xe4edff, 0, true); lightBar(group, 6.0, 4.68, 9.4, true, 3.0, 0xe4edff, 0, true);
  // the two ceiling strips are lit as one area light spanning both: each area light costs about a millisecond a frame
  areaSlots.A.push({ pos: [6.0, CEILING - 0.46, 4.2], w: 9.4, h: 1.1, hex: 0xe4edff, power: 1.2 });
  lightBar(group, 6.0, 1.0, 5.0, true, 1.4, 0x5b8cff, 3.0);
  lightBar(group, 6.0, 7.6, 5.0, true, 1.4, 0x5b8cff, 3.0);
  shadowSpot(group, "A", 5.2, 4.2, 5.8, 4.2);
  floorDecals(group, "A"); sprinklers(group, 0.6, 11.4, [1.4, 7.4]); fireCabinet(group, colliders, 10.9, 0.26);
  // cable trays over each rack row
  cableTray(group, 1.2, 11.4, 2.7, 2.42);
  cableTray(group, 1.2, 11.4, 5.7, 2.42);

  // floor decals: row markers
  // (drawn by racks module once positions are known)

  fillHall = "control";
  // ---- Control room ----
  addFloorCeil(CONTROL.x0, CONTROL.x1, CONTROL.z0, CONTROL.z1, 2.8);
  wall(group, colliders, wallM, "z", CONTROL.x0, CONTROL.z0, CONTROL.z1, [], 2.8);
  wall(group, colliders, wallM, "x", CONTROL.z0, CONTROL.x0, CONTROL.x1, [], 2.8);
  wall(group, colliders, wallM, "x", CONTROL.z1, CONTROL.x0, CONTROL.x1, [[-3.4, -2.5]], 2.8);
  lightBar(group, -1.25, 4.5, 1.6, false, 2.2, 0xcfe0ff, 2.6);        // sits over the monitors: the control room is lit from the screens' side
  { const mat = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.006, 1.3), once("rubber", rawMats.rubber)); mat.position.set(-1.9, 0.004, 4.5); mat.receiveShadow = true; group.add(mat); }

  // ---- Loading bay ----
  addFloorCeil(LOADING.x0, LOADING.x1, LOADING.z0, LOADING.z1);
  wall(group, colliders, wallM, "z", LOADING.x0, LOADING.z0, LOADING.z1);
  wall(group, colliders, wallM, "x", LOADING.z1, LOADING.x0, LOADING.x1);
  lightBar(group, -2.0, 7.5, 2.0, true, 3, 0xe4edff, 4);

  // ---- Plant room (visual only, sealed) ----
  addFloorCeil(PLANT.x0, PLANT.x1, PLANT.z0, PLANT.z1);
  wall(group, colliders, wallM, "z", PLANT.x0, PLANT.z0, PLANT.z1); wall(group, colliders, wallM, "x", PLANT.z0, PLANT.x0, PLANT.x1);
  { const pb = mats.emissive(0xffb46b, 2.2); const strip = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.012, 0.08), pb); strip.position.set(-1.5, CEILING - 0.05, 1.5); group.add(strip); }

  // ---- Halls B and C when owned ----
  if (owned.B) {
    fillHall = "B";
    const B = HALLS.B;
    addFloorCeil(B.x0, B.x1, B.z0, B.z1);
    wall(group, colliders, wallM, "x", B.z0, B.x0, B.x1);
    wall(group, colliders, wallM, "x", B.z1, B.x0, B.x1);
    wall(group, colliders, wallD, "z", B.x1, B.z0, B.z1);
    lightBar(group, 18.0, 4.2, 9.4, true, 3.4, 0xe4edff, 11, true); 
    lightBar(group, 18.0, 1.0, 5.0, true, 1.4, 0x5b8cff, 3.0);
    lightBar(group, 18.0, 7.6, 5.0, true, 1.4, 0x5b8cff, 3.0);
    shadowSpot(group, "B", 17.2, 4.2, 17.8, 4.2);
    floorDecals(group, "B"); sprinklers(group, 12.6, 23.4, [1.4, 7.4]); fireCabinet(group, colliders, 22.9, 0.26);
    cableTray(group, 12.6, 23.4, 2.7, 2.42);
    cableTray(group, 12.6, 23.4, 5.7, 2.42);
  }
  if (owned.C) {
    fillHall = "C";
    const C = HALLS.C;
    addFloorCeil(C.x0, C.x1, C.z0 + 0.06, C.z1);
    wall(group, colliders, wallM, "x", C.z1, C.x0, C.x1);
    wall(group, colliders, wallM, "z", C.x0, C.z0, C.z1);
    wall(group, colliders, wallD, "z", C.x1, C.z0, C.z1);
    wall(group, colliders, wallM, "x", C.z0, A.x1, C.x1);
    for (const z of [13.2, 18.6]) lightBar(group, 9.0, z, 14, true, 3.4, 0xe4edff, 11, true);
    shadowSpot(group, "C", 8.4, 13.2, 9.0, 13.2);
    floorDecals(group, "C"); sprinklers(group, 0.6, 17.4, [10.0, 15.9, 20.6]); fireCabinet(group, colliders, 17.0, 20.74);
    for (const z of [11.7, 14.7, 17.1, 20.1]) cableTray(group, 1.2, 16.8, z, 2.42);
    lightBar(group, 9.0, 10.2, 12, true, 1.4, 0x5b8cff, 3.0); lightBar(group, 9.0, 15.9, 12, true, 1.4, 0x5b8cff, 3.0);
  }
  mergeStatic(group);
  return { group, colliders, floor, fillSlots, spotSlots, areaSlots, bars };
}
