// The real terminal behind the master computer (SPEC section 8). A plain login shell with the user's own environment.
import { ipcMain, type BrowserWindow } from "electron";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import * as pty from "node-pty";

export const COLS = 110, ROWS = 32;
export type PtyStatus = "running" | "ended" | "claudeMissing";

export class PtyHost {
  private proc: pty.IPty | null = null;
  private status: PtyStatus = "ended";
  claudeFound: boolean | null = null;
  onData: (d: string) => void = () => {};
  busy = false;                       // a foreground program other than the shell is running
  constructor(private getWin: () => BrowserWindow | null, private opts: () => { cwd: string; streamer: boolean; bootIntoClaude: boolean; mcpConfig: string }) {
    ipcMain.on("pty.input", (_e, d: string) => this.proc?.write(d));
    ipcMain.handle("pty.restart", () => { this.start(); });
    ipcMain.handle("pty.status", () => ({ status: this.status, claudeFound: this.claudeFound, cols: COLS, rows: ROWS }));
  }
  private send(ch: string, ...a: unknown[]) { const w = this.getWin(); if (w && !w.isDestroyed()) w.webContents.send(ch, ...a); }

  detectClaude(): Promise<boolean> {
    const shell = process.env.SHELL || "/bin/zsh";
    if (process.env.UPTIME_FAKE_NO_CLAUDE) { this.claudeFound = false; this.send("pty.status", { status: this.status, claudeFound: false }); return Promise.resolve(false); }
    return new Promise((res) => execFile(shell, ["-lic", "command -v claude"], { timeout: 8000 }, (err, out) => { this.claudeFound = !err && out.trim().length > 0; this.send("pty.status", { status: this.status, claudeFound: this.claudeFound }); res(this.claudeFound); }));
  }

  start(): void {
    this.kill();
    const o = this.opts();
    mkdirSync(o.cwd, { recursive: true });
    const shell = process.env.SHELL || "/bin/zsh";
    const env: Record<string, string> = { ...(process.env as Record<string, string>), TERM: "xterm-256color", COLORTERM: "truecolor", UPTIME: "1", UPTIME_MCP_CONFIG: o.mcpConfig };
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    if (o.streamer) { env.PS1 = "uptime $ "; env.PROMPT = "uptime %# "; }
    const args = o.bootIntoClaude ? ["-lic", `claude --mcp-config ${JSON.stringify(o.mcpConfig)}`] : ["-l"];
    try {
      this.proc = pty.spawn(shell, args, { name: "xterm-256color", cols: COLS, rows: ROWS, cwd: o.cwd, env });
    } catch (e) { this.status = "ended"; this.send("pty.status", { status: "ended", claudeFound: this.claudeFound, error: String(e) }); return; }
    this.status = "running"; this.send("pty.status", { status: "running", claudeFound: this.claudeFound });
    const p = this.proc;
    // Streamer mode: themes and prompt frameworks ignore PS1 from the environment, so set a plain prompt once the shell is up.
    if (o.streamer && !o.bootIntoClaude) {
      const zsh = /zsh$/.test(shell);
      const cmd = zsh ? " precmd_functions=(); preexec_functions=(); PROMPT='uptime %# '; RPROMPT=''; unset RPS1; clear" : " PROMPT_COMMAND=; PS1='uptime \\$ '; clear";
      setTimeout(() => { if (this.proc === p) p.write(cmd + "\r"); }, 900);
    }
    p.onData((d) => { this.onData(d); this.send("pty.data", d); });
    p.onExit(() => { if (this.proc === p) { this.proc = null; this.status = "ended"; this.send("pty.status", { status: "ended", claudeFound: this.claudeFound }); } });
  }
  write(d: string): void { this.proc?.write(d); }
  /** True when something other than the bare shell is in the foreground (used by the quit dialog). */
  foregroundBusy(): boolean { try { const n = this.proc?.process ?? ""; return !!this.proc && !/^-?(zsh|bash|fish|sh)$/.test(n.split("/").pop() ?? ""); } catch { return false; } }
  kill(): void { if (this.proc) { try { this.proc.kill("SIGHUP"); } catch {} this.proc = null; } }
}
