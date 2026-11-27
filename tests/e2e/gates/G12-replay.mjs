import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, mkdtempSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, sleep, waitFor, frames, send, root } from "../harness.mjs";
export const name = "Replay: record 30 s, render twice at 60 fps, frame-identical";
const SECONDS = Number(process.env.G12_SECONDS ?? 30);
export default async function () {
  const a = await launch({ preset: "showcase", env: { UPTIME_SHOW: "1" } }); const { page } = a; let dir;
  try {
    await waitFor(() => page.evaluate(() => window.game.term.status === "running"), 10000);
    dir = await page.evaluate(() => window.game.capture.setLogging(true)); const t0 = Date.now();
    await page.evaluate(async () => { const p = window.game.player; p.setPose(0.8, 4.2, -Math.PI / 2, -0.02); p.keys.add("KeyW"); await new Promise((r) => setTimeout(r, 2200)); p.keys.delete("KeyW"); });
    await page.evaluate(() => window.uptime.send("pty.input", "printf 'replay gate %s\\n' ok\r"));
    await page.evaluate(() => window.game.player.setPose(4.5, 4.35, 0, -0.35)); await frames(page, 20);
    await send(page, { type: "setRackDoor", rack: "A-R01", open: true, by: "player" }); await sleep(900);
    await page.evaluate(() => window.game.game.openInspect("A-R01-S06")); await sleep(2500);
    await page.evaluate(() => window.game.game.toggleExplode()); await sleep(2500);
    await page.evaluate(() => window.game.game.closeInspect()); await sleep(1800);
    await send(page, { type: "queueJob", kind: "remove", server: "A-R02-S03", slot: "FAN1", by: "claude" });
    await page.evaluate(async () => { const p = window.game.player; p.setPose(2.5, 4.2, -Math.PI / 2, -0.05); });
    await sleep(Math.max(0, SECONDS * 1000 + 600 - (Date.now() - t0)));
    await page.evaluate(() => window.game.capture.setLogging(false));
  } finally { await a.close(); }
  if (!dir || !existsSync(join(dir, "meta.json"))) return { pass: false, detail: "no replay log was written" };
  const render = (label) => { const out = mkdtempSync(join(tmpdir(), `uptime-g12-${label}-`)); const r = spawnSync("node", ["scripts/render-replay.mjs", dir, "--size", "540x960", "--fps", "60", "--seconds", String(SECONDS), "--frames", out, "--no-encode"], { cwd: root, encoding: "utf8", timeout: 1500000 }); return { out, log: (r.stdout + r.stderr).trim().split("\n").slice(-3).join(" | ") }; };
  const A = render("a"), B = render("b");
  const fa = readdirSync(A.out).filter((f) => f.endsWith(".png")).sort(), fb = readdirSync(B.out).filter((f) => f.endsWith(".png")).sort();
  const h = (p) => createHash("sha1").update(readFileSync(p)).digest("hex");
  let diff = 0, first = -1; const n = Math.min(fa.length, fb.length);
  for (let i = 0; i < n; i++) if (h(join(A.out, fa[i])) !== h(join(B.out, fb[i]))) { diff++; if (first < 0) first = i; }
  const distinct = new Set(fa.slice(0, 400).map((f) => h(join(A.out, f)))).size;
  // encode run A and read back what the file reports
  const mov = join(A.out, "g12.mov");
  spawnSync("ffmpeg", ["-y", "-v", "error", "-framerate", "60", "-i", join(A.out, "f_%06d.png"), "-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le", "-r", "60", mov]);
  const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=r_frame_rate,nb_read_frames,width,height", "-of", "csv=p=0", mov], { encoding: "utf8" }).stdout.trim();
  const [w, hgt, rate, count] = probe.split(",");
  const want = SECONDS * 60;
  const pass = fa.length === want && fb.length === want && diff === 0 && rate === "60/1" && Number(count) === want && distinct > 50;
  return { pass, detail: `frames ${fa.length} and ${fb.length} (want ${want}); ${diff} differ${first >= 0 ? `, first at ${first}` : ""}; ${distinct} distinct frames in the first 400; file reports ${w}x${hgt}, ${rate} fps, ${count} frames\nrun A: ${A.log}\nrun B: ${B.log}\nreplay: ${dir}\nframes: ${A.out}` };
}
