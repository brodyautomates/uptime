import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, statSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, sleep, waitFor, root, world } from "../harness.mjs";
export const name = "Package: the dmg installs and the app runs with a working terminal";
export default async function () {
  const dmg = join(root, "dist/UPTIME-0.1.0-arm64.dmg");
  if (!existsSync(dmg)) return { pass: false, detail: "dist/UPTIME-0.1.0-arm64.dmg not found. Run: npm run dist" };
  const mnt = mkdtempSync(join(tmpdir(), "uptime-mnt-")), dest = mkdtempSync(join(tmpdir(), "uptime-apps-")), home = mkdtempSync(join(tmpdir(), "uptime-home-"));
  const att = spawnSync("hdiutil", ["attach", dmg, "-nobrowse", "-readonly", "-mountpoint", mnt], { encoding: "utf8" });
  if (att.status !== 0) return { pass: false, detail: "could not mount the dmg: " + att.stderr.slice(0, 200) };
  let a;
  try {
    cpSync(join(mnt, "UPTIME.app"), join(dest, "UPTIME.app"), { recursive: true, verbatimSymlinks: true });       // "install" = copy out of the image
    const exe = join(dest, "UPTIME.app/Contents/MacOS/UPTIME");
    const helper = join(dest, "UPTIME.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper");
    const helperOk = existsSync(helper) && (statSync(helper).mode & 0o111) !== 0;
    // a clean account is approximated by an empty HOME and an empty profile folder
    a = await launch({ executablePath: exe, preset: "fresh", env: { HOME: home, ZDOTDIR: home, SHELL: "/bin/zsh" } });
    const w = await world(a.page);
    await waitFor(() => a.page.evaluate(() => window.game.term.status === "running"), 10000); await sleep(1200);
    await a.page.evaluate(() => window.uptime.send("pty.input", "printf 'packaged %s\\n' ok\r"));
    const ok = await waitFor(() => a.page.evaluate(() => window.game.term.text().split("\n").some((l) => l.trim() === "packaged ok")), 8000);
    const info = await a.page.evaluate(() => window.uptime.invoke("app.info"));
    const size = (statSync(dmg).size / 1e6).toFixed(0);
    const pass = helperOk && w.racks === 2 && !!ok && info.mcpUp && a.errors.length === 0;
    return { pass, detail: `dmg ${size} MB mounts; app copied out and launched in ${a.bootMs} ms with an empty home folder; native terminal module loaded and helper is executable: ${helperOk}; shell ran a command: ${!!ok}; MCP server up: ${info.mcpUp}; console errors ${a.errors.length}. Not signed or notarised, and not tested on a second macOS user account.` };
  } finally { await a?.close(); spawnSync("hdiutil", ["detach", mnt, "-force"]); }
}
