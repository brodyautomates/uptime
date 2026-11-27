// The centre monitor: a real xterm bound to the pty in the main process, plus a painter that mirrors
// the text buffer onto a canvas texture for the in-world screen (SPEC section 8, "How monitors are drawn").
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";

export const TERM_COLS = 110, TERM_ROWS = 32;
const THEME = {
  background: "#0b0e13", foreground: "#d6dde6", cursor: "#39d0ff", selectionBackground: "#2a3a4d",
  black: "#1b2028", red: "#ff5f56", green: "#35e06f", yellow: "#ffbd2e", blue: "#5aa9ff", magenta: "#c792ea", cyan: "#39d0ff", white: "#d6dde6",
  brightBlack: "#5c6773", brightRed: "#ff7b72", brightGreen: "#6ff09a", brightYellow: "#ffd866", brightBlue: "#82c0ff", brightMagenta: "#dab6f5", brightCyan: "#7fe3ff", brightWhite: "#ffffff",
};
const ANSI = [THEME.black, THEME.red, THEME.green, THEME.yellow, THEME.blue, THEME.magenta, THEME.cyan, THEME.white, THEME.brightBlack, THEME.brightRed, THEME.brightGreen, THEME.brightYellow, THEME.brightBlue, THEME.brightMagenta, THEME.brightCyan, THEME.brightWhite];
function pal(i: number): string {
  if (i < 16) return ANSI[i];
  if (i < 232) { const n = i - 16, v = [0, 95, 135, 175, 215, 255]; return `rgb(${v[Math.floor(n / 36)]},${v[Math.floor(n / 6) % 6]},${v[n % 6]})`; }
  const g = 8 + (i - 232) * 10; return `rgb(${g},${g},${g})`;
}
const rgb = (n: number) => `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`;

export class TerminalMonitor {
  el: HTMLDivElement;
  term: Terminal;
  canvas: HTMLCanvasElement;
  dirty = true;
  webgl = false;
  status: "running" | "ended" | "claudeMissing" = "ended";
  claudeFound: boolean | null = null;
  private off: (() => void)[] = [];
  onPaint: () => void = () => {};

  constructor(parent: HTMLElement, fontSize = 14) {
    this.el = document.createElement("div");
    this.el.className = "mon mon-term";
    parent.appendChild(this.el);
    const holder = document.createElement("div"); holder.className = "term-holder"; this.el.appendChild(holder);
    this.term = new Terminal({ cols: TERM_COLS, rows: TERM_ROWS, fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace', fontSize, lineHeight: 1.15, theme: THEME, scrollback: 5000, cursorBlink: true, allowProposedApi: true, macOptionIsMeta: true });
    this.term.open(holder);
    // xterm's DOM renderer: its WebGL renderer draws half-size glyphs under the monitor's CSS perspective transform.
    this.webgl = false;
    this.canvas = document.createElement("canvas"); this.canvas.width = 1280; this.canvas.height = 724;
    const api = window.uptime;
    if (api) {
      this.off.push(api.on("pty.data", (d: string) => { this.term.write(d, () => { this.dirty = true; }); }));
      this.off.push(api.on("pty.status", (s: any) => { this.status = s.status; this.claudeFound = s.claudeFound; this.dirty = true; if (s.status === "running") this.term.reset(); }));
      this.term.onData((d) => { if (this.status === "ended") { if (d === "\r") void api.invoke("pty.restart"); return; } api.send?.("pty.input", d); });
      void api.invoke("pty.status").then((s: any) => { this.status = s.status; this.claudeFound = s.claudeFound; this.dirty = true; });
    } else {
      this.term.writeln("\x1b[36mUPTIME\x1b[0m  terminal preview (no pty in this build)");
      this.term.writeln(""); this.term.write("$ ");
    }
    this.term.onScroll(() => (this.dirty = true)); this.term.onCursorMove(() => (this.dirty = true));
    // paste + file drop
    this.el.addEventListener("dragover", (e) => e.preventDefault());
    this.el.addEventListener("drop", (e) => { e.preventDefault(); const paths = [...(e.dataTransfer?.files ?? [])].map((f: any) => window.uptime?.pathForFile?.(f) ?? f.path ?? f.name).filter(Boolean); if (paths.length) this.term.paste(paths.map((p) => (/\s/.test(p) ? `'${p}'` : p)).join(" ")); });
  }

  focus(): void { this.term.focus(); }
  blur(): void { this.term.blur(); }
  setFontSize(px: number): void { this.term.options.fontSize = px; }

  /** Mirror the visible text buffer to the canvas. Cheap: only when dirty, at most 10 Hz (caller throttles). */
  paint(): boolean {
    if (!this.dirty) return false;
    this.dirty = false;
    const g = this.canvas.getContext("2d")!, W = this.canvas.width, H = this.canvas.height;
    const padX = 14, padY = 12, cw = (W - padX * 2) / TERM_COLS, ch = (H - padY * 2) / TERM_ROWS;
    g.fillStyle = THEME.background; g.fillRect(0, 0, W, H);
    const buf = this.term.buffer.active, cell = buf.getNullCell();
    g.textBaseline = "middle";
    const fpx = Math.floor(ch * 0.82);
    let lastFont = "";
    for (let y = 0; y < TERM_ROWS; y++) {
      const line = buf.getLine(buf.viewportY + y); if (!line) continue;
      for (let x = 0; x < TERM_COLS; x++) {
        line.getCell(x, cell); if (!cell) continue;
        let fg = cell.isFgRGB() ? rgb(cell.getFgColor()) : cell.isFgPalette() ? pal(cell.getFgColor()) : THEME.foreground;
        let bg: string | null = cell.isBgRGB() ? rgb(cell.getBgColor()) : cell.isBgPalette() ? pal(cell.getBgColor()) : null;
        if (cell.isInverse()) { const t = bg ?? THEME.background; bg = fg; fg = t; }
        const w = Math.max(1, cell.getWidth());
        if (bg) { g.fillStyle = bg; g.fillRect(padX + x * cw, padY + y * ch, cw * w + 0.5, ch + 0.5); }
        const chars = cell.getChars();
        if (chars && chars !== " ") {
          const font = `${cell.isBold() ? "700" : "500"} ${cell.isItalic() ? "italic " : ""}${fpx}px "JetBrains Mono", "SF Mono", Menlo, monospace`;
          if (font !== lastFont) { g.font = font; lastFont = font; }
          g.globalAlpha = cell.isDim() ? 0.6 : 1; g.fillStyle = fg;
          g.fillText(chars, padX + x * cw, padY + y * ch + ch / 2);
          g.globalAlpha = 1;
        }
      }
    }
    if (buf.viewportY === buf.baseY) { g.fillStyle = THEME.cursor; g.globalAlpha = 0.85; g.fillRect(padX + buf.cursorX * cw, padY + buf.cursorY * ch, cw, ch); g.globalAlpha = 1; }
    if (this.status === "ended") {
      g.fillStyle = "rgba(11,14,19,0.82)"; g.fillRect(0, H / 2 - 50, W, 100);
      g.fillStyle = "#d6dde6"; g.font = `600 ${fpx * 1.3}px "SF Pro Text", system-ui, sans-serif`; g.textAlign = "center";
      g.fillText("Session ended", W / 2, H / 2 - 12); g.fillStyle = "#8e99a6"; g.font = `500 ${fpx}px "SF Pro Text", system-ui, sans-serif`;
      g.fillText("Press Enter to start a new one", W / 2, H / 2 + 20); g.textAlign = "left";
    }
    this.onPaint();
    return true;
  }
  /** Plain text of the visible screen (used by tests, gate G9). */
  text(): string { const b = this.term.buffer.active; const out: string[] = []; for (let y = 0; y < TERM_ROWS; y++) out.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? ""); return out.join("\n"); }
}
