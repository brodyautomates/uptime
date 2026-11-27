// Right monitor, remote mode: a real computer's desktop over VNC, with mouse and keyboard.
// noVNC draws and handles the keyboard. The mouse is sent from here, because the monitor sits under a CSS perspective transform
// and only offsetX/offsetY give the true position inside it.
// @ts-ignore: the package ships no types
import RFB from "@novnc/novnc";

export class RemoteDesktop {
  connected = false; state = "";
  private rfb: any = null; private holder = document.createElement("div"); private pad = document.createElement("div"); private note = document.createElement("div");
  private mask = 0;
  onState: () => void = () => {};
  constructor(private host: HTMLElement) {
    const css = document.createElement("style");
    css.textContent = `
      .rd-holder { position: absolute; inset: 0; background: #000; display: none; }
      .rd-holder > div { position: absolute; overflow: hidden; }
      .rd-holder canvas { width: 100% !important; height: 100% !important; margin: 0 !important; }
      .rd-pad { position: absolute; z-index: 2; display: none; outline: none; }
      .rd-note { position: absolute; inset: 0; z-index: 2; display: none; align-items: center; justify-content: center; text-align: center; padding: 60px; background: #0b0e13; color: #dfe6ee; font: 500 18px/1.5 -apple-system, system-ui, sans-serif; white-space: pre-line; }`;
    document.head.appendChild(css);
    this.holder.className = "rd-holder"; this.pad.className = "rd-pad"; this.note.className = "rd-note"; this.pad.tabIndex = 0;
    host.append(this.holder, this.pad, this.note);
    // Where the pointer is on the remote screen. The monitor is drawn through a perspective transform, so the window position
    // is mapped back through that transform's inverse (a 3x3 homography) to the monitor's own pixels.
    const pos = (e: MouseEvent) => {
      const fw = this.rfb?._fbWidth || 1, fh = this.rfb?._fbHeight || 1;
      const m = new DOMMatrix(getComputedStyle(this.host).transform);
      const a = m.m11, b = m.m21, c = m.m41, d = m.m12, f = m.m22, g = m.m42, h = m.m14, i = m.m24, j = m.m44;
      const det = a * (f * j - g * i) - b * (d * j - g * h) + c * (d * i - f * h) || 1, X = e.clientX, Y = e.clientY;
      const lx = ((f * j - g * i) * X + (c * i - b * j) * Y + (b * g - c * f)) / det, ly = ((g * h - d * j) * X + (a * j - c * h) * Y + (c * d - a * g)) / det, lw = ((d * i - f * h) * X + (b * h - a * i) * Y + (a * f - b * d)) / det;
      const px = lx / lw - this.pad.offsetLeft, py = ly / lw - this.pad.offsetTop;
      return { x: Math.max(0, Math.min(fw - 1, Math.round((px / this.pad.clientWidth) * fw))), y: Math.max(0, Math.min(fh - 1, Math.round((py / this.pad.clientHeight) * fh))) };
    };
    const send = (e: MouseEvent) => { if (!this.connected) return; const p = pos(e); this.point(p.x, p.y, this.mask); };
    const bit = (b: number) => (b === 0 ? 1 : b === 1 ? 2 : b === 2 ? 4 : 0);
    this.pad.addEventListener("mousemove", send);
    this.pad.addEventListener("mousedown", (e) => { e.preventDefault(); this.grabKeys(); this.mask |= bit(e.button); send(e); });
    this.pad.addEventListener("mouseup", (e) => { this.mask &= ~bit(e.button); send(e); });
    this.pad.addEventListener("contextmenu", (e) => e.preventDefault());
    this.pad.addEventListener("wheel", (e) => { e.preventDefault(); if (!this.connected) return; const p = pos(e), clamp = (v: number) => Math.max(-200, Math.min(200, Math.round(v))); this.point(p.x, p.y, this.mask, clamp(e.deltaX), clamp(e.deltaY)); }, { passive: false });
  }
  /** A pointer event in the remote screen's own pixels. The computer runs KasmVNC, whose pointer message is 11 bytes:
   *  type 5, a 16-bit button mask, x, y, then scroll dx and dy. The standard 6-byte message makes it close the connection. */
  private point(x: number, y: number, mask: number, dx = 0, dy = 0): void {
    try {
      if (this.rfb?._rfbConnectionState !== "connected") return; const k = this.rfb._sock;
      k.sQpush8(5); k.sQpush16(mask & 0xffff); k.sQpush16(x); k.sQpush16(y); k.sQpush16(dx & 0xffff); k.sQpush16(dy & 0xffff); k.flush();
    } catch (err) { console.warn("remote mouse failed: " + err); }
  }
  private say(t: string): void { this.note.textContent = t; this.note.style.display = t ? "flex" : "none"; this.state = t; this.onState(); }
  /** Give the remote computer the keyboard. The desk chords still work: the main process catches them first. */
  grabKeys(): void { if (!this.connected) return; this.rfb.focus(); void window.uptime?.invoke("remote.keys", true); }
  releaseKeys(): void { try { this.rfb?.blur(); } catch {} void window.uptime?.invoke("remote.keys", false); }
  private fit(): void {
    const fw = this.rfb?._fbWidth, fh = this.rfb?._fbHeight; if (!fw || !fh) return;
    const W = this.host.clientWidth, H = this.host.clientHeight, k = Math.min(W / fw, H / fh), w = fw * k, h = fh * k;
    const box = `left:${(W - w) / 2}px;top:${(H - h) / 2}px;width:${w}px;height:${h}px;`;
    this.pad.style.cssText = box + "display:block";
    const inner = this.holder.firstElementChild as HTMLElement | null; if (inner) inner.style.cssText = box;       // the picture is sized here, not by the library, which measures through the perspective transform
  }
  /** Returns "none" when no remote computer is configured. */
  async connect(): Promise<"ok" | "none" | "failed"> {
    this.say("Starting the computer…"); this.holder.style.display = "block";
    const r = await window.uptime?.invoke("remote.connect").catch(() => ({ ok: false, reason: "failed" }));
    if (!r?.ok) { this.holder.style.display = "none"; if (r?.reason === "none") { this.say(""); return "none"; } this.say(String(r?.reason ?? "The computer could not be reached.")); return "failed"; }
    this.say(`Connecting to ${r.name}…`);
    return await new Promise((resolve) => {
      const target = document.createElement("div"); target.style.cssText = "left:0;top:0;width:100%;height:100%"; this.holder.replaceChildren(target);
      const rfb = new RFB(target, r.ws, {}); this.rfb = rfb;
      rfb.scaleViewport = false; rfb.clipViewport = false; rfb.resizeSession = false; rfb.focusOnClick = false; rfb.background = "#000";
      let done = false;
      rfb.addEventListener("connect", () => { this.connected = true; this.say(""); setTimeout(() => this.fit(), 300); setTimeout(() => this.fit(), 1500); rfb.addEventListener("desktopsize", () => this.fit()); if (!done) { done = true; resolve("ok"); } });
      rfb.addEventListener("disconnect", (ev: any) => { console.warn("remote desktop disconnected, clean=" + ev?.detail?.clean); this.connected = false; this.pad.style.display = "none"; this.releaseKeys(); this.say("The computer disconnected. Press ⌘D twice to reconnect."); if (!done) { done = true; resolve("failed"); } });
      rfb.addEventListener("credentialsrequired", () => { this.say("The computer asked for a password the game does not have."); });
    });
  }
  disconnect(): void { try { this.rfb?.disconnect(); } catch {} this.rfb = null; this.connected = false; this.releaseKeys(); this.holder.style.display = "none"; this.pad.style.display = "none"; this.say(""); }
  /** Draw the current picture into the monitor's canvas (the in-world screen). */
  paint(canvas: HTMLCanvasElement): boolean {
    const src = this.holder.querySelector("canvas") as HTMLCanvasElement | null; if (!this.connected || !src || !src.width) return false;
    const g = canvas.getContext("2d")!, W = canvas.width, H = canvas.height, k = Math.min(W / src.width, H / src.height), w = src.width * k, h = src.height * k;
    g.fillStyle = "#000"; g.fillRect(0, 0, W, H); g.drawImage(src, (W - w) / 2, (H - h) / 2, w, h); return true;
  }
}
