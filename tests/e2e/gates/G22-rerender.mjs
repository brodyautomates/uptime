import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { root } from "../harness.mjs";
export const name = "Definition of done: the demo run re-renders from its replay log at 2160 x 3840";
const SECONDS = Number(process.env.G22_SECONDS ?? 2);
export default async function () {
  const ptr = join(root, "tests/visual/last-demo-replay.txt");
  if (!existsSync(ptr)) return { pass: false, detail: "no demo replay log yet: run G13 first" };
  const dir = readFileSync(ptr, "utf8").trim();
  if (!existsSync(join(dir, "meta.json"))) return { pass: false, detail: `the demo replay log is gone (${dir}): run G13 again` };
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  const out = mkdtempSync(join(tmpdir(), "uptime-g22-")); const mov = join(out, "demo-4k.mov");
  const r = spawnSync("node", ["scripts/render-replay.ts", dir, "--size", "2160x3840", "--fps", "60", "--seconds", String(SECONDS), "--frames", join(out, "f"), "--out", mov], { cwd: root, encoding: "utf8", timeout: 1700000 });
  const n = existsSync(join(out, "f")) ? readdirSync(join(out, "f")).filter((f) => f.endsWith(".png")).length : 0;
  const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=codec_name,profile,width,height,r_frame_rate,nb_read_frames", "-of", "csv=p=0", mov], { encoding: "utf8" }).stdout.trim();
  const [codec, profile, w, h, rate, frames] = probe.split(",");
  const preview = existsSync(mov.replace(/\.mov$/, ".preview.mp4"));
  const pass = n === SECONDS * 60 && codec === "prores" && profile === "HQ" && w === "2160" && h === "3840" && rate === "60/1" && Number(frames) === SECONDS * 60 && preview && meta.durationMs > 70000;
  return { pass, detail: `demo log of ${(meta.durationMs / 1000).toFixed(1)} s with ${meta.endTick - meta.tick0} sim ticks; rendered the first ${SECONDS} s: ${n} frames; master ${codec} ${profile} ${w}x${h} at ${rate} fps, ${frames} frames; H.264 preview written: ${preview}. Set G22_SECONDS=75 to render the whole run (about 80 minutes).\nmaster: ${mov}` + (pass ? "" : "\n" + (r.stdout + r.stderr).slice(-300)) };
}
