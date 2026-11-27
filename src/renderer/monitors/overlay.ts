// Lays the three monitor apps (real DOM) exactly over their in-world screens while seated,
// and paints stand-in textures for them when the player is elsewhere.
import * as THREE from "three/webgpu";
import { quadMatrix3d } from "../util/homography";
import type { MonitorScreen } from "../world/desk";

export const MON_W = 1000, MON_H = 567;

export class MonitorOverlay {
  root: HTMLDivElement;
  mons: HTMLDivElement[] = [];
  visible = false;
  private last: string[] = [];
  constructor(private screens: MonitorScreen[]) {
    this.root = document.createElement("div"); this.root.id = "monitors";
    document.body.appendChild(this.root);
    const style = document.createElement("style");
    style.textContent = `
      #monitors { position: fixed; inset: 0; pointer-events: none; opacity: 0; transition: opacity .25s; z-index: 5; }
      #monitors.on { opacity: 1; }
      #monitors .mon { position: absolute; left: 0; top: 0; width: ${MON_W}px; height: ${MON_H}px; transform-origin: 0 0; overflow: hidden; background: #0b0e13; pointer-events: none; }
      #monitors.on .mon { pointer-events: auto; }
      #monitors .mon.focus { outline: 2px solid rgba(57,208,255,.55); outline-offset: -2px; }
      .mon-term { display: flex; align-items: center; justify-content: center; }
      .mon-term .term-holder { padding: 4px; }
      .mon-term .xterm-viewport { overflow: hidden !important; }
      .term-banner { position: absolute; left: 0; right: 0; top: 0; padding: 6px 12px; background: #2a2110; color: #ffbd2e; font: 500 13px -apple-system, system-ui, sans-serif; z-index: 2; }
    `;
    document.head.appendChild(style);
  }
  add(el: HTMLDivElement): void { this.mons.push(el); if (el.parentElement !== this.root) this.root.appendChild(el); }
  /** Project each screen's corners and transform its DOM element onto them. Returns the screen rects. */
  layout(camera: THREE.PerspectiveCamera): { x: number; y: number; w: number; h: number }[] {
    const W = window.innerWidth, H = window.innerHeight, v = new THREE.Vector3();
    return this.screens.map((s, i) => {
      const pts = s.corners.map((c) => { v.copy(c).project(camera); return [(v.x * 0.5 + 0.5) * W, (-v.y * 0.5 + 0.5) * H] as [number, number]; });
      const el = this.mons[i]; if (el) { const t = quadMatrix3d(MON_W, MON_H, pts[0], pts[1], pts[2], pts[3]); if (this.last[i] !== t) { el.style.transform = t; this.last[i] = t; } }
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    });
  }
  show(on: boolean): void { this.visible = on; this.root.classList.toggle("on", on); }
  focus(i: number): void { this.mons.forEach((m, k) => m.classList.toggle("focus", k === i)); }
}
