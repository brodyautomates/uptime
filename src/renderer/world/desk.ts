// The control room: desk, three monitors, chair, tower, parts shelf (SPEC section 8, appendix I).
import * as THREE from "three/webgpu";
import { texture, uv, vec3, float } from "three/tsl";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { DESK, MONITOR, CONTROL } from "@shared/layout";
import type { AABB } from "./hall";
import { glow } from "./materials";

export interface MonitorScreen { mesh: THREE.Mesh; tex: THREE.CanvasTexture; canvas: HTMLCanvasElement; corners: THREE.Vector3[] /* TL TR BL BR in world */ }
export interface DeskBuild { group: THREE.Group; colliders: AABB[]; screens: MonitorScreen[]; chairBox: { min: THREE.Vector3; max: THREE.Vector3 }; shelfBox: { min: THREE.Vector3; max: THREE.Vector3 }; shelfSlots: THREE.Vector3[] }

const std = (hex: number, r: number, m: number) => new THREE.MeshStandardNodeMaterial({ color: hex, roughness: r, metalness: m });

export function buildDesk(canvases: HTMLCanvasElement[]): DeskBuild {
  const g = new THREE.Group(); const colliders: AABB[] = [];
  const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => { const mesh = new THREE.Mesh(geo, m); mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; g.add(mesh); return mesh; };
  const top = std(0x16181b, 0.35, 0.2), leg = std(0x0c0d0f, 0.5, 0.8), dark = std(0x0a0b0c, 0.5, 0.4);
  // desk: long axis along z, the user sits on the -x side facing +x (toward the glass)
  add(new RoundedBoxGeometry(DESK.d, 0.035, DESK.w, 2, 0.008), top, DESK.x, DESK.top - 0.0175, DESK.z);
  for (const dz of [-DESK.w / 2 + 0.06, DESK.w / 2 - 0.06]) add(new THREE.BoxGeometry(DESK.d - 0.1, DESK.top - 0.035, 0.04), leg, DESK.x, (DESK.top - 0.035) / 2, DESK.z + dz);
  colliders.push({ x0: DESK.x - DESK.d / 2, x1: DESK.x + DESK.d / 2, z0: DESK.z - DESK.w / 2, z1: DESK.z + DESK.w / 2, tag: "desk" });

  // monitors: centre faces -x; sides are angled toward the seat
  const screens: MonitorScreen[] = [];
  const bezel = std(0x08090a, 0.4, 0.5);
  const sideOff = MONITOR.w / 2 + (MONITOR.w / 2) * Math.cos(MONITOR.sideAngle) + 0.012;
  const defs = [
    { z: MONITOR.z - sideOff, x: MONITOR.x - (MONITOR.w / 2) * Math.sin(MONITOR.sideAngle), rot: MONITOR.sideAngle },    // left of the seat (-z)
    { z: MONITOR.z, x: MONITOR.x, rot: 0 },
    { z: MONITOR.z + sideOff, x: MONITOR.x - (MONITOR.w / 2) * Math.sin(MONITOR.sideAngle), rot: -MONITOR.sideAngle },
  ];
  defs.forEach((d, i) => {
    const piv = new THREE.Group(); piv.position.set(d.x, MONITOR.y, d.z); piv.rotation.y = -Math.PI / 2 + d.rot; g.add(piv);
    const tex = new THREE.CanvasTexture(canvases[i]); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    const m = glow(texture(tex, uv()).rgb.mul(1.25));       // screens are emissive: they glow, bloom and reflect in the glass wall
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(MONITOR.w, MONITOR.h), m); piv.add(mesh);
    const back = new THREE.Mesh(new RoundedBoxGeometry(MONITOR.w + 0.016, MONITOR.h + 0.016, 0.018, 2, 0.006), bezel); back.position.z = -0.0095; back.castShadow = true; piv.add(back);
    const stand = new THREE.Mesh(new THREE.BoxGeometry(0.05, MONITOR.y - DESK.top - MONITOR.h / 2 + 0.08, 0.02), bezel); stand.position.set(0, -(MONITOR.h / 2) - (MONITOR.y - DESK.top - MONITOR.h / 2) / 2 + 0.04, -0.03); piv.add(stand);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.008, 0.16), bezel); foot.position.set(0, -(MONITOR.y - DESK.top) + 0.004, -0.03); piv.add(foot);
    piv.updateMatrixWorld(true);
    const hw = MONITOR.w / 2, hh = MONITOR.h / 2;
    const corners = [[-hw, hh], [hw, hh], [-hw, -hh], [hw, -hh]].map(([x, y]) => new THREE.Vector3(x, y, 0).applyMatrix4(mesh.matrixWorld));
    // a soft glow so screens light the desk

    screens.push({ mesh, tex, canvas: canvases[i], corners });
  });
  // keyboard, mouse, tower, mug
  add(new RoundedBoxGeometry(0.14, 0.012, 0.42, 2, 0.004), dark, DESK.x - 0.2, DESK.top + 0.006, DESK.z);
  const keys = glow(vec3(0.35, 0.6, 1.0).mul(float(0.25)));
  add(new THREE.BoxGeometry(0.12, 0.002, 0.4), keys, DESK.x - 0.2, DESK.top + 0.0125, DESK.z);
  add(new RoundedBoxGeometry(0.1, 0.03, 0.06, 2, 0.01), dark, DESK.x - 0.2, DESK.top + 0.015, DESK.z + 0.32);
  add(new RoundedBoxGeometry(0.42, 0.44, 0.2, 2, 0.01), std(0x0d0f11, 0.35, 0.7), DESK.x + 0.1, 0.22, DESK.z + DESK.w / 2 - 0.2);
  const towerLed = glow(vec3(0.22, 0.82, 1.0).mul(6));
  add(new THREE.BoxGeometry(0.004, 0.3, 0.004), towerLed, DESK.x - 0.112, 0.24, DESK.z + DESK.w / 2 - 0.12);
  // chair
  const cx = DESK.x - 0.72, cz = DESK.z;
  const fabric = std(0x121417, 0.85, 0.0);
  add(new RoundedBoxGeometry(0.46, 0.07, 0.46, 3, 0.03), fabric, cx, 0.47, cz);
  add(new RoundedBoxGeometry(0.06, 0.55, 0.44, 3, 0.03), fabric, cx - 0.22, 0.8, cz);
  add(new THREE.CylinderGeometry(0.025, 0.025, 0.4, 12), leg, cx, 0.23, cz);
  for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2; const l = add(new THREE.BoxGeometry(0.28, 0.02, 0.03), leg, cx + Math.cos(a) * 0.14, 0.04, cz + Math.sin(a) * 0.14); l.rotation.y = -a; }
  const chairBox = { min: new THREE.Vector3(cx - 0.3, 0.0, cz - 0.3), max: new THREE.Vector3(cx + 0.3, 1.35, cz + 0.3) };
  colliders.push({ x0: cx - 0.2, x1: cx + 0.2, z0: cz - 0.2, z1: cz + 0.2, tag: "chair" });

  // parts shelf on the north wall of the control room (z = CONTROL.z1), 5 shelves x 12 positions
  const sx0 = -2.3, sx1 = -0.5, sz = CONTROL.z1 - 0.22;
  const shelfM = std(0x1b1e22, 0.5, 0.7);
  const shelfSlots: THREE.Vector3[] = [];
  for (let s = 0; s < 5; s++) {
    const y = 0.35 + s * 0.36;
    add(new THREE.BoxGeometry(sx1 - sx0, 0.02, 0.36), shelfM, (sx0 + sx1) / 2, y, sz);
    for (let i = 0; i < 12; i++) shelfSlots.push(new THREE.Vector3(sx0 + 0.09 + i * ((sx1 - sx0 - 0.18) / 11), y + 0.012, sz));
  }
  for (const x of [sx0, sx1]) add(new THREE.BoxGeometry(0.03, 1.95, 0.36), shelfM, x, 0.975, sz);
  colliders.push({ x0: sx0, x1: sx1, z0: sz - 0.2, z1: CONTROL.z1, tag: "shelf" });
  const shelfBox = { min: new THREE.Vector3(sx0, 0.2, sz - 0.2), max: new THREE.Vector3(sx1, 2.0, CONTROL.z1) };
  return { group: g, colliders, screens, chairBox, shelfBox, shelfSlots };
}
