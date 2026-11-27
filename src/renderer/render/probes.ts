// Reflection probes (SPEC section 6, reflection stack 3): one prefiltered cube probe per hall and one for the control room,
// rebaked when a rack is added or a hall opens. The probe of the room the player is in is the scene's environment.
import * as THREE from "three/webgpu";
import { HALLS, CONTROL, type HallId } from "@shared/layout";

export type ProbeId = HallId | "control";
const CENTRE: Record<ProbeId, [number, number, number]> = {
  A: [(HALLS.A.x0 + HALLS.A.x1) / 2, 1.6, 4.2], B: [(HALLS.B.x0 + HALLS.B.x1) / 2, 1.6, 4.2], C: [(HALLS.C.x0 + HALLS.C.x1) / 2, 1.6, 15.9],
  control: [(CONTROL.x0 + CONTROL.x1) / 2 - 0.6, 1.5, (CONTROL.z0 + CONTROL.z1) / 2],
};

export class Probes {
  private cams = new Map<ProbeId, THREE.CubeCamera>();      // one raw cube capture per room
  private pmrem: THREE.PMREMGenerator;
  /** One prefiltered environment target shared by every room. Swapping the scene's environment texture forces materials to
   *  rebuild (a visible hitch), so the texture object stays the same and the current room's probe is filtered into it. */
  private envRT: THREE.RenderTarget | null = null;
  private queue: ProbeId[] = [];
  private cool = 0;
  current: ProbeId | null = null;
  bakes = 0;
  constructor(private renderer: THREE.WebGPURenderer, private scene: THREE.Scene, private fallback: THREE.Texture, private hide: THREE.Object3D[]) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
  }
  /** Ask for a rebake. Bakes happen one per call to update(), spaced out, so there is no visible hitch. */
  request(ids: ProbeId[]): void { for (const id of ids) if (!this.queue.includes(id)) this.queue.push(id); }
  has(id: ProbeId): boolean { return this.cams.has(id); }
  /** Call once per frame with the room the player is in. */
  update(room: ProbeId): void {
    let refilter = false;
    if (this.cool > 0) this.cool--;
    else if (this.queue.length) {
      const i = Math.max(0, this.queue.indexOf(room)); const id = this.queue.splice(i, 1)[0];      // the player's own room first
      this.bake(id); this.cool = 20; if (id === room) refilter = true;
    }
    if (room !== this.current && this.cams.has(room)) { this.current = room; refilter = true; }
    if (refilter && this.cams.has(room)) {
      this.envRT = this.pmrem.fromCubemap(this.cams.get(room)!.renderTarget.texture as THREE.CubeTexture, this.envRT as any) as any;
      if (this.scene.environment !== this.envRT!.texture) { this.scene.environment = this.envRT!.texture; this.scene.environmentIntensity = 1.5; }
    }
  }
  private bake(id: ProbeId): void {
    let cam = this.cams.get(id);
    if (!cam) { cam = new THREE.CubeCamera(0.1, 45, new THREE.CubeRenderTarget(128, { type: THREE.HalfFloatType })); this.cams.set(id, cam); }
    const [x, y, z] = CENTRE[id]; const vis = this.hide.map((o) => o.visible); this.hide.forEach((o) => (o.visible = false));
    const prevEnv = this.scene.environment, prevI = this.scene.environmentIntensity, fog = this.scene.fog;
    this.scene.environment = this.fallback; this.scene.environmentIntensity = 0.3; this.scene.fog = null;
    cam.position.set(x, y, z); cam.update(this.renderer as any, this.scene);
    this.scene.environment = prevEnv; this.scene.environmentIntensity = prevI; this.scene.fog = fog; this.hide.forEach((o, i) => (o.visible = vis[i]));
    this.bakes++;
  }
}
