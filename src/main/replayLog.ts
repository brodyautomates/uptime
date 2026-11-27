// Replay log (SPEC section 15, appendix H): seed/start state, commands by tick, player pose at 60 Hz, pty bytes.
import { mkdirSync, writeFileSync, createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

export class ReplayLog {
  dir: string;
  private cmds: WriteStream; private pty: WriteStream; private pose: WriteStream; private poseEv: WriteStream; private lastEv = "";
  private t0 = Date.now(); private markers: { label: string; t: number; tick: number }[] = [];
  private lastTick = 0; failed = false; onFail: () => void = () => {};
  constructor(root: string, private meta: { seed: number; version: number; startHash: string; tick0: number }, state0Json: string) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.dir = join(root, `${stamp}.uptime-replay`); mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, "state0.json.gz"), gzipSync(state0Json));
    this.cmds = createWriteStream(join(this.dir, "commands.ndjson")); this.pty = createWriteStream(join(this.dir, "pty.ndjson")); this.pose = createWriteStream(join(this.dir, "pose.bin")); this.poseEv = createWriteStream(join(this.dir, "pose-events.ndjson"));
    for (const s of [this.cmds, this.pty, this.pose, this.poseEv]) s.on("error", () => this.fail());
    this.flushMeta();
  }
  private fail() { if (!this.failed) { this.failed = true; this.onFail(); } }
  private flushMeta() { try { writeFileSync(join(this.dir, "meta.json"), JSON.stringify({ ...this.meta, markers: this.markers, endTick: this.lastTick, durationMs: Date.now() - this.t0 }, null, 1)); } catch { this.fail(); } }
  tick(t: number) { this.lastTick = t; }
  command(tick: number, cmd: unknown) { if (!this.failed) this.cmds.write(JSON.stringify({ tick, t: Date.now() - this.t0, cmd }) + "\n"); }
  ptyData(d: string) { if (!this.failed) this.pty.write(JSON.stringify({ t: Date.now() - this.t0, tick: this.lastTick, b: Buffer.from(d, "utf8").toString("base64") }) + "\n"); }
  /** pose.bin (SPEC appendix H): 60 Hz records of nine little-endian float32: t (ms), x, y, z, yaw, pitch, mode, then two extras the
   *  renderer needs to replay exactly: the sim tick and the field of view. Inspect changes go to pose-events.ndjson. */
  poseSample(p: any) {
    if (this.failed) return; const t = Date.now() - this.t0;
    const f = new Float32Array([t, p.pos[0], p.pos[1], p.pos[2], p.yaw, p.pitch, MODES.indexOf(p.mode), this.lastTick, p.fov]);
    this.pose.write(Buffer.from(f.buffer));
    const ev = `${p.inspect ?? ""}|${p.ex ? 1 : 0}`; if (ev !== this.lastEv) { this.lastEv = ev; this.poseEv.write(JSON.stringify({ t, inspect: p.inspect ?? null, ex: !!p.ex }) + "\n"); }
  }
  marker(label: string) { this.markers.push({ label, t: Date.now() - this.t0, tick: this.lastTick }); this.flushMeta(); }
  close(): string { this.flushMeta(); for (const s of [this.cmds, this.pty, this.pose, this.poseEv]) s.end(); return this.dir; }
}

export const MODES = ["walk", "inspect", "seated", "menu", "carry"];
const REC = 9;
/** Read pose.bin + pose-events.ndjson back into the sample objects the renderer replays. */
export function readPoses(bin: Buffer, events: { t: number; inspect: string | null; ex: boolean }[]): { t: number; tick: number; p: any }[] {
  const f = new Float32Array(bin.buffer.slice(bin.byteOffset, bin.byteOffset + Math.floor(bin.byteLength / 4) * 4)); const out: { t: number; tick: number; p: any }[] = []; let ei = 0, cur = { inspect: null as string | null, ex: false };
  for (let i = 0; i + REC <= f.length; i += REC) {
    const t = f[i]; while (ei < events.length && events[ei].t <= t) cur = events[ei++];
    const yaw = f[i + 4], pitch = f[i + 5];
    // quaternion for a YXZ rotation with no roll
    const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
    out.push({ t, tick: f[i + 7], p: { pos: [f[i + 1], f[i + 2], f[i + 3]], yaw, pitch, q: [cy * sp, sy * cp, -sy * sp, cy * cp], fov: f[i + 8], mode: MODES[f[i + 6]] ?? "walk", inspect: cur.inspect, ex: cur.ex } });
  }
  return out;
}
