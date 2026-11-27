// Replay logging and offline, frame-stepped capture (SPEC section 15).
import * as THREE from "three/webgpu";
import type { Player } from "../player/controller";
import type { Game } from "../game";
import type { Pipeline } from "../render/pipeline";
import { ui } from "../ui/store";
import { clock } from "../clock";

export interface CamKey { t: number; pos: [number, number, number]; yaw: number; pitch: number; fov: number; /** how to move into the next key: "linear" or "inout" (default) */ ease?: "linear" | "inout" }

export class Capture {
  /** true while an offline render owns the frame loop */
  offline = false;
  /** true while the camera is driven by a recorded pose or a track */
  driving = false;
  frame: (dt?: number) => void = () => {};
  private logging = false; private poseTimer: number | null = null;
  constructor(private renderer: THREE.WebGPURenderer, private canvas: HTMLCanvasElement, private camera: THREE.PerspectiveCamera, private player: Player, private game: Game, private pipeline: () => Pipeline, private api: any) {}

  async setLogging(on: boolean): Promise<string | null> {
    if (on === this.logging) return null;
    this.logging = on;
    if (on) {
      const dir = await this.api?.invoke("replay.start");
      this.poseTimer = window.setInterval(() => { const c = this.camera; const e = new THREE.Euler().setFromQuaternion(c.quaternion, "YXZ"); this.api?.send("player.pose", { pos: [round(c.position.x), round(c.position.y), round(c.position.z)], yaw: round(e.y), pitch: round(e.x), fov: round(c.fov), mode: ui.getState().mode, inspect: this.game.inspecting, ex: ui.getState().inspect?.exploded ?? false }); }, 1000 / 60);
      return dir;
    }
    if (this.poseTimer) clearInterval(this.poseTimer); this.poseTimer = null;
    return this.api?.invoke("replay.stop");
  }

  afterRender(): void {}

  /** Set the camera from a pose sample or track key. */
  setCamera(pos: number[], q: number[] | null, yaw: number, pitch: number, fov: number): void {
    this.camera.position.set(pos[0], pos[1], pos[2]);
    if (q) this.camera.quaternion.set(q[0], q[1], q[2], q[3]); else this.camera.rotation.set(pitch, yaw, 0, "YXZ");
    if (Math.abs(this.camera.fov - fov) > 1e-3) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
    this.camera.updateMatrixWorld(true);
  }

  /** Grab the current canvas as a PNG data URL (call right after a render). */
  async grab(): Promise<string> {
    if (!this.resolve) { await (this.renderer.backend as any).device?.queue?.onSubmittedWorkDone?.(); return this.canvas.toDataURL("image/png"); }
    return this.resolve.toDataURL("image/png");
  }
  /** Copy the frame that was just rendered (same task, before the canvas texture is presented) and resolve the supersampling. */
  private snap(): void {
    if (!this.outSize) return; const [w, h] = this.outSize;
    if (!this.resolve) { this.resolve = document.createElement("canvas"); this.resolve.width = w; this.resolve.height = h; }
    const g = this.resolve.getContext("2d", { willReadFrequently: false })!; g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high"; g.drawImage(this.canvas, 0, 0, w, h);
  }
  private outSize: [number, number] | null = null; private resolve: HTMLCanvasElement | null = null;

  /** Enter offline mode at an exact pixel size. The frame loop stops; the caller steps frames. */
  begin(width: number, height: number, tier: "capture" | "ultra" | "high" = "capture"): void {
    this.offline = true; this.driving = true; this.outSize = [width, height];
    ui.getState().set({ hudHidden: true });
    this.player.enabled = false; this.player.unlock();
    const px = width * height, ss = tier === "capture" ? Math.max(1, Math.min(2, Math.sqrt(34e6 / px))) : 1;      // 2x supersampling up to a 2160x3840 output
    this.pipeline().setTier(tier);
    this.canvas.style.width = `${width}px`; this.canvas.style.height = `${height}px`;
    this.renderer.setPixelRatio(ss); this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height; this.camera.updateProjectionMatrix();
    clock.set(0);
  }
  preRender: (() => void) | null = null;

  /** Offline render of a recorded session (SPEC section 15). Writes numbered PNG frames into the output folder. */
  async runReplay(term: { term: any; paint(): boolean; dirty: boolean }, ingest: (msgs: any[]) => void, onScreen: () => void = () => {}): Promise<{ frames: number; hash: string }> {
    const d = await this.api.invoke("replay.load"); if (!d) throw new Error("no replay configured");
    const [w, h] = String(d.size).split("x").map(Number); const fps = d.fps as number;
    const pose: any[] = d.pose, pty: any[] = d.pty, track: CamKey[] | null = d.camera?.keys ?? null;
    const dur = Math.min(d.maxSeconds > 0 ? d.maxSeconds * 1000 : Infinity, pose.length ? pose[pose.length - 1].t : d.meta.durationMs ?? 0);
    const frames = Math.max(1, Math.floor((dur / 1000) * fps));
    this.begin(w, h, d.tier);
    const q0 = new THREE.Quaternion(), q1 = new THREE.Quaternion();
    let pi = 0, ti = 0, inspect: string | null = null, exploded = false, hash = "";
    let cam: { pos: number[]; q: number[] | null; yaw: number; pitch: number; fov: number } | null = null;
    this.preRender = () => { if (cam) this.setCamera(cam.pos, cam.q, cam.yaw, cam.pitch, cam.fov); };
    for (let f = 0; f < frames; f++) {
      const t = (f / fps) * 1000;
      while (pi < pose.length - 1 && pose[pi + 1].t <= t) pi++;
      const a = pose[pi], b = pose[Math.min(pi + 1, pose.length - 1)];
      const adv = await this.api.invoke("replay.advance", a ? a.tick : d.meta.tick0); hash = adv.hash;
      ingest(adv.msgs);
      while (ti < pty.length && pty[ti].t <= t) { const bytes = Uint8Array.from(atob(pty[ti].b), (c) => c.charCodeAt(0)); await new Promise<void>((r) => term.term.write(bytes, () => r())); term.dirty = true; ti++; }
      if (a) {
        const k = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
        if (track) { const c = sampleTrack(track, t / 1000); cam = { pos: c.pos, q: c.q ?? null, yaw: c.yaw, pitch: c.pitch, fov: c.fov }; }
        else { q0.fromArray(a.p.q); q1.fromArray(b.p.q); q0.slerp(q1, k); cam = { pos: [0, 1, 2].map((i) => a.p.pos[i] + (b.p.pos[i] - a.p.pos[i]) * k), q: q0.toArray() as number[], yaw: 0, pitch: 0, fov: a.p.fov + (b.p.fov - a.p.fov) * k }; }
        const wantInspect: string | null = a.p.inspect ?? null, wantEx = !!a.p.ex;
        if (wantInspect !== inspect) {
          if (inspect) this.game.closeInspect();
          // the part detail for the open server is requested here and awaited, so it reaches the renderer on the same frame in every render
          if (wantInspect) { await this.api.invoke("sim.watch", wantInspect); this.game.forceInspect(wantInspect); } else await this.api.invoke("sim.watch", null);
          inspect = wantInspect; exploded = false;
        }
        if (inspect && wantEx !== exploded) { this.game.toggleExplode(); exploded = wantEx; }
      }
      this.step(1 / fps);
      onScreen();
      const url = await this.grab();
      await this.api.invoke("capture.frame", `${d.out}/f_${String(f).padStart(6, "0")}.png`, url);
    }
    return { frames, hash };
  }

  /** Render one frame at virtual time step dt. */
  step(dt: number): void {
    clock.advance(dt);
    const nf = (this.renderer as any)._nodes?.nodeFrame; if (nf) { nf.frameId++; nf.renderId++; }   // advance three's frame counter exactly once per output frame
    this.frame(dt); this.snap();
  }
}
const round = (n: number) => Math.round(n * 1e5) / 1e5;

/** Camera track (SPEC appendix H): Catmull-Rom on position, slerp on rotation, per-key ease. */
function sampleTrack(keys: CamKey[], t: number): CamKey & { q?: number[] } {
  const quat = (k: CamKey) => new THREE.Quaternion().setFromEuler(new THREE.Euler(k.pitch, k.yaw, 0, "YXZ"));
  if (t <= keys[0].t) return { ...keys[0], q: quat(keys[0]).toArray() as number[] }; const last = keys[keys.length - 1]; if (t >= last.t) return { ...last, q: quat(last).toArray() as number[] };
  let i = 0; while (keys[i + 1].t < t) i++;
  const p0 = keys[Math.max(0, i - 1)], p1 = keys[i], p2 = keys[i + 1], p3 = keys[Math.min(keys.length - 1, i + 2)];
  const lin = (t - p1.t) / (p2.t - p1.t), u = p1.ease === "linear" ? lin : lin * lin * (3 - 2 * lin);
  const cr = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u * u + (-a + 3 * b - 3 * c + d) * u * u * u);
  const q = quat(p1).slerp(quat(p2), u);
  return { t, pos: [0, 1, 2].map((k) => cr(p0.pos[k], p1.pos[k], p2.pos[k], p3.pos[k])) as [number, number, number], yaw: p1.yaw, pitch: p1.pitch, fov: p1.fov + (p2.fov - p1.fov) * u, q: q.toArray() as number[] };
}
