#!/usr/bin/env node
// Re-render a recorded session offline at full quality (SPEC section 15).
//   node scripts/render-replay.mjs <replay-folder> [--size 2160x3840] [--fps 60] [--camera track.json] [--out out.mov] [--seconds N] [--tier capture|ultra|high] [--keep]
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const replay = args.find((a) => !a.startsWith("--") && existsSync(a));
if (!replay) { console.error("usage: render-replay.mjs <replay-folder> [--size WxH] [--fps 60] [--camera track.json] [--out file] [--seconds N] [--tier capture]"); process.exit(2); }
const opt = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const size = opt("size", "2160x3840"), fps = opt("fps", "60"), camera = opt("camera", ""), seconds = opt("seconds", "0"), tier = opt("tier", "capture");
const out = resolve(opt("out", join(dirname(resolve(replay)), basename(resolve(replay)).replace(/\.uptime-replay$/, "") + ".mov")));
const frames = opt("frames", mkdtempSync(join(tmpdir(), "uptime-frames-")));

if (!existsSync(join(root, "out/main/index.js"))) { const b = spawnSync("npx", ["electron-vite", "build"], { cwd: root, stdio: "inherit" }); if (b.status) process.exit(b.status); }
const [w, h] = size.split("x").map(Number);
const env = { ...process.env, UPTIME_REPLAY: resolve(replay), UPTIME_REPLAY_OUT: frames, UPTIME_REPLAY_FPS: fps, UPTIME_REPLAY_SIZE: size, UPTIME_REPLAY_SECONDS: seconds, UPTIME_REPLAY_TIER: tier, UPTIME_W: String(Math.min(w, 1600)), UPTIME_H: String(Math.min(h, 900)), UPTIME_USERDATA: join(tmpdir(), "uptime-replay-profile") };
if (camera) env.UPTIME_REPLAY_CAMERA = resolve(camera);
// UPTIME_GATES_PACKAGED=1 renders with the packaged app instead of the dev build
const packaged = join(root, "dist/mac-arm64/UPTIME.app/Contents/MacOS/UPTIME");
const r = process.env.UPTIME_GATES_PACKAGED && existsSync(packaged) ? spawnSync(packaged, [], { cwd: tmpdir(), env, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", maxBuffer: 1 << 28 }) : spawnSync("npx", ["electron", "."], { cwd: root, env, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", maxBuffer: 1 << 28 });
process.stdout.write((r.stdout ?? "").split("\n").filter((l) => /replay-done|replay failed|BOOT/.test(l)).join("\n") + "\n");
const n = readdirSync(frames).filter((f) => f.endsWith(".png")).length;
if (!n) { console.error("no frames were rendered"); process.exit(1); }
console.log(`${n} frames at ${size}, ${fps} fps`);
if (!args.includes("--no-encode")) {
  const input = ["-y", "-v", "error", "-framerate", fps, "-i", join(frames, "f_%06d.png")];
  const pr = spawnSync("ffmpeg", [...input, "-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le", "-r", fps, out], { stdio: "inherit" });
  const h264 = out.replace(/\.mov$/, ".preview.mp4");
  const pv = spawnSync("ffmpeg", [...input, "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-r", fps, h264], { stdio: "inherit" });
  if (pr.status || pv.status) { console.error("ffmpeg failed"); process.exit(1); }
  console.log(`master:  ${out}\npreview: ${h264}`);
}
if (!args.includes("--keep") && !args.includes("--frames")) rmSync(frames, { recursive: true, force: true }); else console.log(`frames:  ${frames}`);
