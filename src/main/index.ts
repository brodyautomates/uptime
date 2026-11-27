import { app, BrowserWindow, ipcMain, dialog, shell, screen, session, desktopCapturer, systemPreferences } from "electron";
import { join, dirname } from "node:path";
import { writeFileSync, mkdirSync, readFileSync, existsSync, appendFileSync, statSync, renameSync } from "node:fs";
import { PtyHost } from "./pty";
import { SimHost, bal } from "./simHost";
import { McpHost } from "./mcp/server";
import { ReplayLog } from "./replayLog";
import { serialize, stateHash, SAVE_VERSION, type Preset } from "@sim/index";

app.setName("UPTIME");
const isDev = !!process.env.ELECTRON_RENDERER_URL;
const argv = process.argv.join(" ");
const demoFlag = /--demo\b/.test(argv) || !!process.env.UPTIME_DEMO;
const presetArg = (process.env.UPTIME_PRESET ?? /--preset[= ](\w+)/.exec(argv)?.[1]) as Preset | undefined;
// Shot mode: UPTIME_SHOTS="bookmark:path,bookmark:path" renders each bookmark to a PNG and quits.
const shots = (process.env.UPTIME_SHOTS ?? "").split(",").filter(Boolean).map((s) => { const i = s.indexOf(":"); return { name: s.slice(0, i), path: s.slice(i + 1) }; });
const replayMode = !!process.env.UPTIME_REPLAY;
const testMode = shots.length > 0 || !!process.env.UPTIME_TEST || replayMode || !!process.env.UPTIME_SELFTEST;
if (process.env.UPTIME_USERDATA) app.setPath("userData", process.env.UPTIME_USERDATA);

let win: BrowserWindow | null = null;
let remoteHasKeys = false;
ipcMain.handle("remote.keys", (_e, on: unknown) => { remoteHasKeys = on === true; });
const userData = () => app.getPath("userData");

// ---------- logs ----------
function log(line: string, file = "main.log"): void {
  try {
    const dir = join(userData(), "logs"); mkdirSync(dir, { recursive: true }); const f = join(dir, file);
    if (existsSync(f) && statSync(f).size > 5 * 1024 * 1024) { for (let i = 2; i >= 1; i--) if (existsSync(`${f}.${i}`)) renameSync(`${f}.${i}`, `${f}.${i + 1}`); renameSync(f, `${f}.1`); }
    appendFileSync(f, `${new Date().toISOString()} ${line}\n`);
  } catch {}
  if (process.env.UPTIME_LOG) console.log(line);
}

// ---------- settings ----------
const settingsFile = () => join(userData(), "settings.json");
let settings: Record<string, any> = {};
function loadSettings() { try { settings = JSON.parse(readFileSync(settingsFile(), "utf8")); } catch { settings = {}; } if (demoFlag) settings["demo.director"] = true; }
function saveSettings() { try { mkdirSync(userData(), { recursive: true }); writeFileSync(settingsFile(), JSON.stringify(settings, null, 1)); } catch (e) { log(`settings save failed: ${e}`); } }
const defaultWorkspace = () => join(userData(), "workspace");
const workspace = () => (typeof settings["terminal.workspace"] === "string" && settings["terminal.workspace"].trim() ? settings["terminal.workspace"].trim().replace(/^~(?=\/|$)/, app.getPath("home")) : defaultWorkspace());

const sim = new SimHost(() => win, log);
const mcp = new McpHost(sim, log);
const ptyHost = new PtyHost(() => win, () => ({ cwd: workspace(), streamer: !!settings["streamer.enabled"], bootIntoClaude: !!settings["claude.bootInto"], mcpConfig: join(workspace(), ".mcp.json") }));
ptyHost.onData = (d) => sim.replay?.ptyData(d);

function writeWorkspace() { if (mcp.up) try { mcp.writeWorkspace(workspace(), sim.state.facilityName, sim.rulesText()); } catch (e) { log(`workspace write failed: ${e}`); } }

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: Number(process.env.UPTIME_W ?? 1600), height: Number(process.env.UPTIME_H ?? 900), minWidth: 540, minHeight: 540,
    fullscreenable: false,        // a native full-screen window gets its own Space with nothing behind it, so the desktop mirror would be black
    backgroundColor: "#05070a", show: !!process.env.UPTIME_SHOW || (shots.length === 0 && !process.env.UPTIME_HIDDEN && !replayMode && !process.env.UPTIME_TEST), title: "UPTIME",
    webPreferences: { preload: join(__dirname, "../preload/index.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  // full screen is the kind that stays on the desktop's own Space (control-command-F toggles it); the game starts in it
  win.webContents.on("before-input-event", (e, input) => { if (input.type === "keyDown" && input.meta && !input.control && !input.alt && remoteHasKeys && /^(KeyE|KeyD|Digit[0-3])$/.test(input.code)) { e.preventDefault(); win!.webContents.send("seat.chord", input.code); return; }
    if (input.type === "keyDown" && input.meta && input.control && input.code === "KeyF") { e.preventDefault(); win!.setSimpleFullScreen(!win!.isSimpleFullScreen()); } });
  if (!testMode && process.platform === "darwin" && !/--windowed\b/.test(argv)) win.setSimpleFullScreen(true);
  win.webContents.on("console-message", (e: any) => {
    const level = typeof e.level === "string" ? ({ info: 1, warning: 2, error: 3, debug: 0 } as any)[e.level] ?? 1 : e.level, message = e.message ?? "";
    if (level >= 2) log(`[renderer] ${message}`, "renderer.log");
    if (process.env.UPTIME_LOG || (testMode && level >= 2)) console.log(`[renderer:${level}] ${message}`);
  });
  win.webContents.on("render-process-gone", (_e, d) => { log(`renderer gone: ${d.reason}`); if (win && !win.isDestroyed()) win.reload(); });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.on("blur", () => { if (settings["sim.pauseWhenUnfocused"]) { sim.paused = true; win?.webContents.send("app.focus", false); } });
  win.on("focus", () => { if (settings["sim.pauseWhenUnfocused"]) win?.webContents.send("app.focus", true); });
  let closing = false;
  win.on("close", (e) => {
    if (closing || testMode) return;
    if (ptyHost.foregroundBusy()) {
      const r = dialog.showMessageBoxSync(win!, { type: "question", buttons: ["Quit anyway", "Cancel"], defaultId: 1, cancelId: 1, message: "A process is still running in the terminal.", detail: "Quitting will end it." });
      if (r === 1) { e.preventDefault(); return; }
    }
    closing = true;
  });
  const query = new URLSearchParams(process.env.UPTIME_QUERY ?? "");
  if (testMode) query.set("test", "1");
  if (replayMode) query.set("replay", "1");
  if (isDev) await win.loadURL(process.env.ELECTRON_RENDERER_URL! + "?" + query.toString());
  else await win.loadFile(join(__dirname, "../renderer/index.html"), { search: query.toString() });
  if (/--mirror-test\b/.test(argv)) setTimeout(async () => {
    try {
      await win!.webContents.executeJavaScript("window.game.desktop.toggle()", true);
      await new Promise((r) => setTimeout(r, 4000));
      const r = await win!.webContents.executeJavaScript(`(() => { const v = document.querySelector(".mon-map video"); const c = document.createElement("canvas"); c.width = 64; c.height = 40; const g = c.getContext("2d"); g.drawImage(v, 0, 0, 64, 40); const big = document.createElement("canvas"); big.width = 900; big.height = Math.round(900 * v.videoHeight / v.videoWidth); big.getContext("2d").drawImage(v, 0, 0, big.width, big.height); window.__shot = big.toDataURL("image/jpeg", 0.8); const d = g.getImageData(0, 0, 64, 40).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; const t = v.srcObject && v.srcObject.getVideoTracks()[0]; return JSON.stringify({ on: window.game.desktop.on, w: v.videoWidth, h: v.videoHeight, mean: s / (64 * 40 * 3), label: t && t.label, state: t && t.readyState, muted: t && t.muted, note: document.querySelector(".desk-note").textContent.slice(0, 50) }); })()`, true);
      log(`mirror-test: ${r} simpleFullScreen=${win!.isSimpleFullScreen()}`);
      const shot: string = await win!.webContents.executeJavaScript("window.__shot", true); writeFileSync(join(userData(), "mirror-test.jpg"), Buffer.from(shot.split(",")[1], "base64"));
    } catch (e) { log(`mirror-test failed: ${e}`); }
  }, 7000);
}

// ---------- IPC ----------
ipcMain.handle("shots.list", () => shots.map((s) => s.name));
ipcMain.handle("shots.capture", async (_e, name: string) => { const s = shots.find((x) => x.name === name); if (!s || !win) return false; const img = await win.webContents.capturePage(); mkdirSync(dirname(s.path), { recursive: true }); writeFileSync(s.path, img.toPNG()); return true; });
ipcMain.handle("shots.js", async () => { if (process.env.UPTIME_JS && win) { try { return await win.webContents.executeJavaScript(process.env.UPTIME_JS, true); } catch (e) { console.log("JS error", e); } } return null; });
ipcMain.handle("shots.done", () => { app.exit(0); });
ipcMain.handle("app.quit", () => { win?.close(); });
// ---------- desktop mirror: the third monitor can show the Mac's own screen (view only) ----------
ipcMain.handle("desktop.status", async () => {
  if (process.platform !== "darwin") return "granted";
  let st = systemPreferences.getMediaAccessStatus("screen");
  // asking for the sources once is what makes macOS show its permission prompt and list the app in System Settings
  if (st !== "granted") { try { await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 16, height: 16 } }); } catch {} st = systemPreferences.getMediaAccessStatus("screen"); }
  log(`desktop mirror: screen recording permission is ${st}`);
  return st;
});
ipcMain.handle("app.relaunch", () => { app.relaunch(); app.quit(); });
// while the mirror is on, the game window is hidden from screen capture, so the mirror shows the desktop behind the game and not the game itself
ipcMain.handle("desktop.protect", (_e, on: unknown) => { win?.setContentProtection(on === true); });
// ---------- remote computer on the right monitor: another computer's desktop over VNC, fully interactive ----------
// Configured in uptime.config.json (see uptime.config.example.json) or with UPTIME_REMOTE_URL and UPTIME_REMOTE_NAME.
// The config file is looked for at UPTIME_CONFIG, then in the user data folder, then next to package.json.
// With nothing configured the right monitor mirrors this computer's own screen instead.
function remoteConfig(): { url: string; name: string } | null {
  let c: any = {};
  for (const f of [process.env.UPTIME_CONFIG, join(userData(), "uptime.config.json"), join(app.getAppPath(), "uptime.config.json")]) {
    if (!f || !existsSync(f)) continue;
    try { c = JSON.parse(readFileSync(f, "utf8"))?.remoteDesktop ?? {}; } catch (e) { log(`config: ${f} could not be read: ${e}`); }
    break;
  }
  const url = String(process.env.UPTIME_REMOTE_URL ?? c.url ?? "").trim(); if (!/^wss?:\/\//.test(url)) return null;
  return { url, name: String(process.env.UPTIME_REMOTE_NAME ?? c.name ?? "the remote computer").trim().slice(0, 60) };
}
ipcMain.handle("remote.connect", () => {
  const c = remoteConfig(); if (!c) return { ok: false, reason: "none" };
  log(`remote desktop: connecting to ${c.name}`); return { ok: true, ws: c.url, name: c.name };
});
ipcMain.handle("desktop.openSettings", () => { void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"); });
function wireDesktopCapture(): void {
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    desktopCapturer.getSources({ types: ["screen"] }).then((sources) => {
      if (!sources.length) return cb({});
      // with two displays, show the one the game is not on, so the mirror does not show itself
      const mine = win ? String(screen.getDisplayMatching(win.getBounds()).id) : "";
      cb({ video: sources.find((x) => x.display_id && x.display_id !== mine) ?? sources[0] });
    }).catch((e) => { log(`desktop capture failed: ${e}`); cb({}); });
  });
}
ipcMain.handle("app.info", () => ({ demo: demoFlag, test: testMode, preset: presetArg ?? null, hasSave: sim.hasAnySave(), mcpUp: mcp.up, mcpPort: mcp.port, selftest: !!process.env.UPTIME_SELFTEST, workspace: workspace(), version: app.getVersion(), userData: userData() }));
ipcMain.handle("app.selftest", (_e, result: unknown) => { if (process.env.UPTIME_SELFTEST) { try { writeFileSync(process.env.UPTIME_SELFTEST, JSON.stringify(result)); } catch (e) { log(`selftest write failed: ${e}`); } setTimeout(() => app.exit(0), 200); } });
// "Camera" setting: size the window so its drawing area is exactly w x h device pixels (e.g. 1080 x 1920 for a vertical recording)
ipcMain.handle("window.size", (_e, wPx: number, hPx: number) => { if (!win) return null; const sf = screen.getDisplayMatching(win.getBounds()).scaleFactor; win.setContentSize(Math.round(wPx / sf), Math.round(hPx / sf)); return win.getContentSize(); });
ipcMain.handle("diag.stats", () => { const now = Date.now(); const perMin = sim.mcpStats.calls / Math.max(1 / 60, (now - sim.mcpStats.since) / 60000); if (now - sim.mcpStats.since > 60000) sim.mcpStats = { calls: 0, since: now }; const t = [...sim.tickMs].sort((a, b) => a - b); return { deltaBytes: sim.lastDeltaBytes, mcpPerMin: Math.round(perMin), tickP95: t[Math.floor(t.length * 0.95)] ?? 0 }; });
ipcMain.handle("app.openLogs", () => shell.openPath(join(userData(), "logs")));
ipcMain.handle("settings.get", () => settings);
ipcMain.handle("settings.set", (_e, key: string, value: unknown) => {
  settings[key] = value; saveSettings();
  if (key === "terminal.workspace") { writeWorkspace(); ptyHost.start(); }
  if (key === "claude.bootInto" || key === "streamer.enabled") ptyHost.start();
  if (key === "sim.pauseWhenUnfocused" && !value) sim.paused = false;
  return true;
});
ipcMain.handle("workspace.refresh", () => { writeWorkspace(); return workspace(); });
ipcMain.handle("capture.frame", async (_e, path: string, dataUrl: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, Buffer.from(dataUrl.split(",")[1], "base64")); return true; });
// replay logging
ipcMain.handle("replay.start", () => {
  if (sim.replay) return sim.replay.dir;
  try {
    const r = new ReplayLog(process.env.UPTIME_REPLAY_ROOT ?? join(userData(), "replays"), { seed: sim.state.seed, version: SAVE_VERSION, startHash: stateHash(sim.state), tick0: sim.state.tick }, serialize(sim.state));
    r.onFail = () => { sim.replay = null; win?.webContents.send("replay.failed"); };
    sim.replay = r; return r.dir;
  } catch (e) { log(`replay start failed: ${e}`); win?.webContents.send("replay.failed"); return null; }
});
ipcMain.handle("replay.stop", () => { const d = sim.replay?.close() ?? null; sim.replay = null; return d; });
ipcMain.handle("replay.marker", (_e, label: string) => { sim.replay?.marker(label); });
ipcMain.handle("replay.load", () => (process.env.UPTIME_REPLAY ? { ...sim.loadReplay(process.env.UPTIME_REPLAY), out: process.env.UPTIME_REPLAY_OUT, fps: Number(process.env.UPTIME_REPLAY_FPS ?? 60), size: process.env.UPTIME_REPLAY_SIZE ?? "1080x1920", camera: process.env.UPTIME_REPLAY_CAMERA ? JSON.parse(readFileSync(process.env.UPTIME_REPLAY_CAMERA, "utf8")) : null, tier: process.env.UPTIME_REPLAY_TIER ?? "capture", maxSeconds: Number(process.env.UPTIME_REPLAY_SECONDS ?? 0) } : null));
ipcMain.handle("replay.advance", (_e, toTick: number) => sim.replayAdvance(toTick));
ipcMain.on("player.pose", (_e, p) => sim.replay?.poseSample(p));

app.commandLine.appendSwitch("enable-unsafe-webgpu");
app.whenReady().then(async () => {
  loadSettings();
  if (presetArg) sim.newGame(presetArg, "UPTIME", 1);
  else if (!testMode && sim.hasAnySave()) { const r = sim.load("autosave"); if (!r.ok && r.fallback) sim.load(r.fallback); sim.paused = true; }      // the main menu drifts through the last save's hall; Continue resumes it
  if (settings["claude.autonomy"]) void sim.command({ type: "setAutonomy", level: String(settings["claude.autonomy"]).toLowerCase(), by: "player" });
  if (demoFlag || settings["demo.director"]) void sim.command({ type: "setDemoMode", on: true, by: "player" });
  await mcp.start();
  if (!mcp.up) log("mcp: the facility link is down; the terminal will run without game tools");
  writeWorkspace();
  sim.onMilestone = () => {};
  wireDesktopCapture();
  await createWindow();
  if (!replayMode) { sim.start(); ptyHost.start(); void ptyHost.detectClaude(); }
});
app.on("before-quit", () => { if (!testMode) sim.save("autosave"); sim.replay?.close(); ptyHost.kill(); mcp.stop(); });
app.on("window-all-closed", () => app.quit());
process.on("uncaughtException", (e) => log(`uncaught: ${e?.stack ?? e}`));
