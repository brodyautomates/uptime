// Right monitor: floor map with live heat overlay and the activity feed. One canvas serves both the DOM view and the in-world texture.
import { HALLS, RACK, slotPose, CONTROL, LOADING, type HallId } from "@shared/layout";
import type { WorldView } from "@shared/view";
import type { FeedLine } from "../ui/store";

const heat = (c: number) => { const t = Math.max(0, Math.min(1, (c - 40) / 50)); const r = Math.round(40 + 215 * t), g = Math.round(200 - 150 * t * t), b = Math.round(120 - 110 * t); return `rgb(${r},${g},${b})`; };

export function paintMap(canvas: HTMLCanvasElement, w: WorldView, feed: FeedLine[], pulses: Map<string, number>, now: number): void {
  const g = canvas.getContext("2d")!, W = canvas.width, H = canvas.height;
  g.fillStyle = "#0b0e13"; g.fillRect(0, 0, W, H);
  const mapW = W * 0.66;
  // world bounds: x -4..24, z 0..21 ; fit into the map area (z up on screen)
  const owned = (h: HallId) => w.halls[h].owned;
  const x0 = -4.5, x1 = owned("B") || owned("C") ? 24.5 : 12.5, z0 = -0.5, z1 = owned("C") ? 21.5 : 9.5;
  const s = Math.min((mapW - 40) / (x1 - x0), (H - 90) / (z1 - z0));
  const ox = 20 + ((mapW - 40) - (x1 - x0) * s) / 2, oy = 64 + ((H - 90) - (z1 - z0) * s) / 2;
  const X = (x: number) => ox + (x - x0) * s, Y = (z: number) => oy + (z1 - z) * s;
  g.font = "600 22px -apple-system, system-ui, sans-serif"; g.fillStyle = "#dfe6ee"; g.fillText("Floor", 22, 38);
  g.font = "500 15px -apple-system, system-ui, sans-serif"; g.fillStyle = "#8e99a6"; g.fillText("server temperature", 86, 38);
  const room = (rx0: number, rx1: number, rz0: number, rz1: number, label: string, on = true) => {
    g.strokeStyle = on ? "rgba(255,255,255,.22)" : "rgba(255,255,255,.08)"; g.lineWidth = 2; g.setLineDash(on ? [] : [6, 6]);
    g.strokeRect(X(rx0), Y(rz1), (rx1 - rx0) * s, (rz1 - rz0) * s); g.setLineDash([]);
    g.fillStyle = on ? "rgba(255,255,255,.035)" : "transparent"; g.fillRect(X(rx0), Y(rz1), (rx1 - rx0) * s, (rz1 - rz0) * s);
    g.fillStyle = "#6f7a87"; g.font = "500 13px -apple-system, system-ui, sans-serif"; g.fillText(label, X(rx0) + 6, Y(rz1) + 16);
  };
  (["A", "B", "C"] as HallId[]).forEach((h) => { const b = HALLS[h]; if (h === "A" || owned(h) || (h === "B") || (h === "C" && owned("B"))) if (b.x1 <= x1 + 0.6 && b.z1 <= z1 + 0.6) room(b.x0, b.x1, b.z0, b.z1, `Hall ${h}${owned(h) ? `  ${w.halls[h].airC.toFixed(0)} °C` : ""}`, owned(h)); });
  room(CONTROL.x0, CONTROL.x1, CONTROL.z0, CONTROL.z1, "Control"); room(LOADING.x0, LOADING.x1, LOADING.z0, LOADING.z1, "Loading");
  for (const r of w.racks) {
    const p = slotPose(r.hall, r.slot); const rw = RACK.w * s, rd = RACK.d * s;
    const rx = X(p.x) - rw / 2, ry = Y(p.z) - rd / 2;
    g.fillStyle = "#151a22"; g.fillRect(rx, ry, rw - 1, rd);
    const n = r.servers.length;
    r.servers.forEach((sv, i) => {
      if (!sv) return;
      const cell = rd / n; const front = p.rot === 0 ? ry : ry + rd - cell;   // just a vertical stack of cells per rack
      void front;
      g.fillStyle = sv.power === "on" ? heat(sv.tempC) : sv.power === "off" ? "#2a313b" : "#ff3b30";
      g.fillRect(rx + 1, ry + i * cell + 0.5, rw - 3, cell - 1);
    });
    if (r.breaker === "tripped") { g.strokeStyle = "#ff3b30"; g.lineWidth = 2; g.strokeRect(rx - 1, ry - 1, rw + 1, rd + 2); }
    const pu = pulses.get(r.id);
    if (pu && now < pu) { const k = 1 - (pu - now) / 2000; g.strokeStyle = `rgba(57,208,255,${1 - k})`; g.lineWidth = 3; g.beginPath(); g.arc(X(p.x), Y(p.z), 10 + k * 26, 0, 7); g.stroke(); }
  }
  // legend
  const lg = g.createLinearGradient(22, 0, 182, 0); for (let i = 0; i <= 10; i++) lg.addColorStop(i / 10, heat(40 + i * 5));
  g.fillStyle = lg; g.fillRect(22, H - 22, 160, 6); g.fillStyle = "#8e99a6"; g.font = "500 12px -apple-system, system-ui, sans-serif"; g.fillText("40 °C", 22, H - 28); g.fillText("90 °C", 150, H - 28);
  // activity feed
  const fx = mapW + 10;
  g.fillStyle = "rgba(255,255,255,.06)"; g.fillRect(fx - 10, 0, 1, H);
  g.font = "600 22px -apple-system, system-ui, sans-serif"; g.fillStyle = "#dfe6ee"; g.fillText("Activity", fx + 8, 38);
  g.font = "500 15px -apple-system, system-ui, sans-serif";
  const lines = feed.slice(-22).reverse(); let y = 70;
  for (const f of lines) {
    g.fillStyle = f.kind === "claude" ? "#39d0ff" : f.kind === "critical" ? "#ff6259" : f.kind === "warn" ? "#ffb020" : "#b9c3ce";
    const words = f.text.split(" "); let line = "";
    for (const wd of words) { if (g.measureText(line + wd).width > W - fx - 26) { g.fillText(line, fx + 8, y); y += 20; line = ""; } line += wd + " "; }
    g.fillText(line, fx + 8, y); y += 28; if (y > H - 20) break;
  }
}

/** Stand-in texture for the ops monitor when nobody is seated. */
export function paintOpsSummary(canvas: HTMLCanvasElement, w: WorldView): void {
  const g = canvas.getContext("2d")!, W = canvas.width, H = canvas.height;
  g.fillStyle = "#0b0e13"; g.fillRect(0, 0, W, H);
  g.fillStyle = "#0e1218"; g.fillRect(0, 0, 170, H);
  g.fillStyle = "#39d0ff"; g.font = "700 15px -apple-system, system-ui, sans-serif"; g.fillText("UPTIME OPS", 22, 40);
  ["Overview", "Racks", "Contracts", "Shop", "Finance", "Build", "Settings"].forEach((t, i) => { g.fillStyle = i === 0 ? "#fff" : "#8e99a6"; g.font = "500 17px -apple-system, system-ui, sans-serif"; if (i === 0) { g.fillStyle = "rgba(57,208,255,.14)"; g.fillRect(12, 60, 146, 30); g.fillStyle = "#fff"; } g.fillText(t, 24, 82 + i * 36); });
  g.fillStyle = "#dfe6ee"; g.font = "600 24px -apple-system, system-ui, sans-serif"; g.fillText(w.facilityName, 200, 46);
  const tile = (i: number, k: string, v: string, frac?: number, warn = false) => {
    const x = 200 + i * 266, y = 70, tw = 250, th = 104;
    g.fillStyle = "#121720"; g.fillRect(x, y, tw, th);
    g.fillStyle = "#8e99a6"; g.font = "500 16px -apple-system, system-ui, sans-serif"; g.fillText(k, x + 16, y + 30);
    g.fillStyle = "#fff"; g.font = "600 27px -apple-system, system-ui, sans-serif"; g.fillText(v, x + 16, y + 66);
    if (frac !== undefined) { g.fillStyle = "rgba(255,255,255,.1)"; g.fillRect(x + 16, y + 82, tw - 32, 6); g.fillStyle = warn ? "#ffb020" : "#35e06f"; g.fillRect(x + 16, y + 82, (tw - 32) * Math.min(1, frac), 6); }
  };
  const net = w.incomePerHour - w.costPerHour;
  tile(0, "Cash", "$" + Math.round(w.cash).toLocaleString("en-US"));
  tile(1, "Net per hour", (net < 0 ? "-$" : "$") + Math.abs(Math.round(net)).toLocaleString("en-US"));
  tile(2, "Power", `${w.power.usedKw.toFixed(0)} / ${w.power.capKw} kW`, w.power.usedKw / w.power.capKw, w.power.usedKw > w.power.capKw * 0.9);
  tile(3, "Cooling", `${w.cooling.heatKw.toFixed(0)} / ${w.cooling.capKw} kW`, w.cooling.heatKw / w.cooling.capKw, w.cooling.heatKw > w.cooling.capKw * 0.9);
  g.fillStyle = "#8e99a6"; g.font = "500 16px -apple-system, system-ui, sans-serif";
  g.fillText(`Day ${w.time.day}   ${String(w.time.hour).padStart(2, "0")}:${String(w.time.minute).padStart(2, "0")}      ${w.racks.length} racks      ${w.alertCount} alerts      reputation ${Math.round(w.reputation)}`, 200, 220);
  // rack strip
  w.racks.slice(0, 60).forEach((r, i) => { const x = 200 + (i % 30) * 34, y = 250 + Math.floor(i / 30) * 150; g.fillStyle = "#151a22"; g.fillRect(x, y, 28, 130); r.servers.forEach((s, b) => { if (!s) return; g.fillStyle = s.power !== "on" ? "#2a313b" : s.status === "failed" ? "#ff3b30" : s.status === "degraded" ? "#ffb020" : "#35e06f"; g.fillRect(x + 3, y + 117 - b * 12.4, 22, 9); }); });
}
