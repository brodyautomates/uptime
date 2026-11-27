// Third monitor, second mode: a live, view-only mirror of the Mac's own screen.
// The <video> sits over the map canvas for the seated view; the same frames are drawn into the canvas for the in-world screen.
import { RemoteDesktop } from "./remote";

export class DesktopMirror {
  remote: RemoteDesktop; private useRemote: boolean | null = null;
  on = false;
  private video = document.createElement("video");
  private note = document.createElement("div");
  private btn = document.createElement("button");
  private stream: MediaStream | null = null;
  constructor(private host: HTMLElement) {
    const css = document.createElement("style");
    css.textContent = `
      .mon-map { position: absolute; }
      .mon-map video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #000; display: none; }
      .mon-map .desk-btn { position: absolute; right: 12px; top: 10px; z-index: 3; background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.2); color: #dfe6ee; border-radius: 6px; padding: 5px 12px; font: 500 13px -apple-system, system-ui, sans-serif; cursor: pointer; }
      .mon-map .desk-btn:hover { background: rgba(255,255,255,.2); }
      .mon-map .desk-note { position: absolute; inset: 0; z-index: 2; display: none; align-items: center; justify-content: center; text-align: center; padding: 60px; background: #0b0e13; color: #dfe6ee; font: 500 18px/1.5 -apple-system, system-ui, sans-serif; white-space: pre-line; cursor: pointer; }
    `;
    document.head.appendChild(css);
    this.video.muted = true; this.video.playsInline = true;
    this.btn.className = "desk-btn"; this.note.className = "desk-note";
    this.btn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); void this.toggle(); });
    let opened = false;
    this.note.addEventListener("mousedown", () => {
      if (!this.needsPermission) return;
      if (!opened) { opened = true; void window.uptime?.invoke("desktop.openSettings"); } else void window.uptime?.invoke("app.relaunch");
    });
    host.append(this.video, this.note, this.btn); this.remote = new RemoteDesktop(host); host.append(this.btn); this.label();
  }
  private label(): void { this.btn.textContent = this.on ? "Floor map  ⌘D" : "Desktop  ⌘D"; }
  private say(text: string): void { this.note.textContent = text; this.note.style.display = text ? "flex" : "none"; }
  private needsPermission = false;
  async toggle(): Promise<void> {
    if (this.on) { this.stop(); return; }
    this.on = true; this.label();
    if (this.useRemote !== false) { const r = await this.remote.connect(); if (r !== "none") { this.useRemote = true; if (!this.on) this.remote.disconnect(); return; } this.useRemote = false; if (!this.on) return; }
    const status = await window.uptime?.invoke("desktop.status").catch(() => "unknown");
    if (!this.on) return;
    if (status !== "granted") { this.needsPermission = true; this.say("UPTIME needs permission to show your desktop.\n\n1. Click here to open System Settings\n2. Turn on UPTIME under Screen & System Audio Recording\n3. Come back and click here again to restart the game"); return; }
    try {
      await window.uptime?.invoke("desktop.protect", true);
      this.stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30, cursor: "never" } as MediaTrackConstraints, audio: false });
      this.stream.getVideoTracks()[0]?.addEventListener("ended", () => this.stop());
      this.video.srcObject = this.stream; await this.video.play(); this.video.style.display = "block"; this.say("");
    } catch { this.say("The screen could not be captured."); }
  }
  stop(): void {
    this.on = false; this.label(); this.say(""); if (this.useRemote) this.remote.disconnect(); this.video.style.display = "none"; void window.uptime?.invoke("desktop.protect", false);
    this.stream?.getTracks().forEach((t) => t.stop()); this.stream = null; this.video.srcObject = null;
  }
  /** Draw the current frame into the monitor's canvas (the in-world screen). False when there is nothing to draw. */
  paint(canvas: HTMLCanvasElement): boolean {
    if (this.on && this.useRemote) return this.remote.paint(canvas);
    if (!this.on || !this.stream || this.video.videoWidth === 0) return false;
    const g = canvas.getContext("2d")!, W = canvas.width, H = canvas.height, k = Math.min(W / this.video.videoWidth, H / this.video.videoHeight), w = this.video.videoWidth * k, h = this.video.videoHeight * k;
    g.fillStyle = "#000"; g.fillRect(0, 0, W, H); g.drawImage(this.video, (W - w) / 2, (H - h) / 2, w, h);
    return true;
  }
}
