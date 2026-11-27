import * as THREE from "three/webgpu";
import { EYE, SPAWN } from "@shared/layout";
import type { AABB } from "../world/hall";
import { keys as K } from "../keys";

const RADIUS = 0.3;

export class Player {
  pos = new THREE.Vector3(SPAWN.x, 0, SPAWN.z);
  yaw = SPAWN.yaw; pitch = 0;
  keys = new Set<string>();
  enabled = true;
  locked = false;
  sensitivity = 1; invertY = false; headBob = false;
  private bobT = 0;
  colliders: () => AABB[] = () => [];
  stepped = 0;   // metres walked, for footsteps

  constructor(private camera: THREE.PerspectiveCamera, private dom: HTMLElement) {
    document.addEventListener("pointerlockchange", () => { this.locked = document.pointerLockElement === this.dom; });
    document.addEventListener("mousemove", (e) => {
      if (!this.locked || !this.enabled) return;
      this.yaw -= e.movementX * 0.0022 * this.sensitivity;
      this.pitch -= e.movementY * 0.0022 * this.sensitivity * (this.invertY ? -1 : 1);
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));
    });
    window.addEventListener("keydown", (e) => { if (this.enabled) this.keys.add(e.code); });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());
  }
  lock(): void { if (!this.locked) this.dom.requestPointerLock?.(); }
  unlock(): void { if (this.locked) document.exitPointerLock(); }

  setPose(x: number, z: number, yaw: number, pitch = 0): void { this.pos.set(x, 0, z); this.yaw = yaw; this.pitch = pitch; }

  update(dt: number): void {
    if (this.enabled) {
      const f = (this.keys.has(K.forward) ? 1 : 0) - (this.keys.has(K.back) ? 1 : 0);
      const s = (this.keys.has(K.right) ? 1 : 0) - (this.keys.has(K.left) ? 1 : 0);
      if (f || s) {
        const speed = (this.keys.has(K.run) ? 4.2 : 2.2) * dt;
        const len = Math.hypot(f, s);
        const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
        // forward = (-sin, -cos) in (x, z); right = (cos, -sin)
        const dx = ((-sin * f + cos * s) / len) * speed;
        const dz = ((-cos * f - sin * s) / len) * speed;
        this.move(dx, 0); this.move(0, dz);
        this.stepped += Math.hypot(dx, dz); this.bobT += Math.hypot(dx, dz);
      }
    }
    const bob = this.headBob ? Math.sin(this.bobT * 5.2) * 0.018 : 0;
    this.camera.position.set(this.pos.x, EYE + bob, this.pos.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, "YXZ");
  }

  private move(dx: number, dz: number): void {
    const nx = this.pos.x + dx, nz = this.pos.z + dz;
    for (const b of this.colliders()) {
      const cx = Math.max(b.x0, Math.min(nx, b.x1)), cz = Math.max(b.z0, Math.min(nz, b.z1));
      if ((nx - cx) ** 2 + (nz - cz) ** 2 < RADIUS * RADIUS) return;
    }
    this.pos.x = nx; this.pos.z = nz;
  }
}
