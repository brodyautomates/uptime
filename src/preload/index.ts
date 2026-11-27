import { contextBridge, ipcRenderer, webUtils } from "electron";

// Typed allowlist: nothing outside these channels crosses the boundary (SPEC section 16, appendix E).
const INVOKE = new Set(["desktop.status", "remote.connect", "remote.keys", "app.relaunch", "desktop.protect", "desktop.openSettings", "sim.snapshot", "sim.command", "sim.query", "sim.watch", "sim.pause", "sim.hash", "sim.perf", "save.list", "save.write", "save.load", "game.new",
  "pty.restart", "pty.status", "settings.get", "settings.set", "workspace.refresh", "replay.start", "replay.stop", "replay.marker", "replay.load", "replay.advance", "app.quit", "app.info", "app.openLogs", "app.selftest", "window.size", "diag.stats",
  "capture.frame", "shots.list", "shots.capture", "shots.js", "shots.done"]);
const SEND = new Set(["pty.input", "player.pose"]);
const ON = new Set(["sim.delta", "sim.reset", "sim.events", "pty.data", "pty.status", "mcp.activity", "replay.failed", "app.focus", "seat.chord"]);

const invoke = (ch: string, ...a: unknown[]) => { if (!INVOKE.has(ch)) throw new Error(`blocked channel ${ch}`); return ipcRenderer.invoke(ch, ...a); };
const on = (ch: string, fn: (...a: any[]) => void) => {
  if (!ON.has(ch)) throw new Error(`blocked channel ${ch}`);
  const h = (_e: unknown, ...a: any[]) => fn(...a);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld("uptime", {
  shots: { list: () => invoke("shots.list") as Promise<string[]>, capture: (name: string) => invoke("shots.capture", name) as Promise<boolean>, done: () => invoke("shots.done"), js: () => invoke("shots.js") },
  quit: () => invoke("app.quit"),
  invoke, on,
  send: (ch: string, ...a: unknown[]) => { if (!SEND.has(ch)) throw new Error(`blocked channel ${ch}`); ipcRenderer.send(ch, ...a); },
  pathForFile: (f: File) => webUtils.getPathForFile(f),
});
