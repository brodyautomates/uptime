import { useSyncExternalStore, useRef, useState } from "react";
import { ui, isFree, type UIState } from "./store";
import { FAMILY_LABEL, slotFamily, TIER_COLOR } from "../world/serverModel";
import type { PartView } from "@shared/view";
import "./hud.css";

export function useUI<T>(sel: (s: UIState) => T): T { return useSyncExternalStore(ui.subscribe, () => sel(ui.getState())); }
export const money = (n: number) => (n < 0 ? "-" : "") + "$" + Math.abs(Math.round(n)).toLocaleString("en-US");
const statusColor = (s: string) => (s === "failed" ? "var(--red)" : s === "degraded" ? "var(--amber)" : "var(--green)");
const hex = (n: number) => "#" + n.toString(16).padStart(6, "0");

export interface HudActions { removePart(slot: string): void; installPart(slot: string, part: string): void; togglePower(): void; explode(): void; close(): void; orderNow(sku: string): void; info(slot: string): void }

/** The power button is held for one second (SPEC section 7). A ring fills while you hold. */
function HoldButton({ label, onDone }: { label: string; onDone: () => void }) {
  const [p, setP] = useState(0); const iv = useRef<number | null>(null); const t0 = useRef(0);
  const stop = () => { if (iv.current) clearInterval(iv.current); iv.current = null; setP(0); };
  const start = () => { stop(); t0.current = performance.now(); iv.current = window.setInterval(() => { const k = Math.min(1, (performance.now() - t0.current) / 1000); setP(k); if (k >= 1) { stop(); onDone(); } }, 33); };
  return (<button className="btn hold" data-power onMouseDown={start} onMouseUp={stop} onMouseLeave={stop}><i style={{ width: `${p * 100}%` }} /><span>{label}</span></button>);       // the label never changes while held: a narrower button would slip from under the cursor and cancel the hold
}

function PartCard({ slot, part }: { slot: string; part: PartView | null }) {
  const fam = FAMILY_LABEL[slotFamily(slot)];
  if (!part) return (<div><b>{slot}</b><div className="row"><span>Empty {fam.toLowerCase()} slot</span><span /></div></div>);
  return (
    <div>
      <b><span className="dot" style={{ background: hex(TIER_COLOR[part.tier] ?? 0x888888) }} />{part.name}</b>
      <div className="row"><span>{slot} · tier {part.tier}</span><span style={{ color: statusColor(part.status) }}>{part.status === "ok" ? "Healthy" : part.status === "degraded" ? "Degraded" : "Failed"}</span></div>
      <div className="row"><span>Health</span><span>{Math.round(part.health)}%</span></div>
      <div className="bar"><i style={{ width: `${part.health}%`, background: statusColor(part.status) }} /></div>
      <div className="row" style={{ marginTop: 6 }}><span>Temperature</span><span style={{ color: part.tempC > 85 ? "var(--red)" : part.tempC > 70 ? "var(--amber)" : undefined }}>{Math.round(part.tempC)} °C</span></div>
      <div className="row"><span>Draw</span><span>{Math.round(part.watts)} W</span></div>
      {part.contrib && <div className="row"><span>Contributes</span><span>{part.contrib}</span></div>}
    </div>
  );
}

export function Hud({ actions }: { actions: HudActions }) {
  const s = useUI((x) => x);
  if (s.hudHidden) return null;
  const w = s.world;
  const ins = s.inspect;
  return (
    <>
      {s.mode === "seated" && (
        <div className="seatbar glass">
          <button onMouseDown={(e) => { e.preventDefault(); (window as any).game?.game.stand(); }}>Stand up <b>⌘E</b></button>
          <span><b>⌘1</b> ops <b>⌘2</b> terminal <b>⌘3</b> desktop <b>⌘D</b> desktop on/off <b>⌘0</b> sit back</span>
        </div>
      )}
      {w && s.mode !== "seated" && (
        <div className="topbar glass">
          <span><b>{money(w.cash)}</b></span>
          <span><span className="k">Income</span><span className={w.incomePerHour - w.costPerHour >= 0 ? "good" : "bad"}>{money(w.incomePerHour)}/h</span></span>
          <span><span className="k">Power</span><span className={w.power.usedKw > w.power.capKw * 0.9 ? "warn" : ""}>{w.power.usedKw.toFixed(1)} / {w.power.capKw} kW</span></span>
          <span><span className="k">Heat</span><span className={w.cooling.heatKw > w.cooling.capKw ? "bad" : w.cooling.heatKw > w.cooling.capKw * 0.9 ? "warn" : ""}>{w.cooling.heatKw.toFixed(1)} / {w.cooling.capKw} kW</span></span>
          <span><span className="k">Alerts</span><span className={w.alertCount ? "warn" : ""}>{w.alertCount}</span></span>
          <span><span className="k">Day {w.time.day}</span>{String(w.time.hour).padStart(2, "0")}:{String(w.time.minute).padStart(2, "0")}{w.speed !== 1 ? `  ${w.speed === 0 ? "paused" : w.speed + "x"}` : ""}</span>
        </div>
      )}
      {s.banner && <div className="banner glass">{s.banner}</div>}
      {isFree(s.mode) && <div className="cross" />}
      {isFree(s.mode) && s.prompt && <div className="prompt glass">{s.prompt}</div>}
      {isFree(s.mode) && s.card && (<div className="card glass"><b>{s.card.title}</b>{s.card.lines.map((l, i) => <div key={i}>{l}</div>)}</div>)}
      {s.held && s.mode !== "seated" && (<div className="held glass"><span className="k" style={{ color: "var(--dim)" }}>Holding </span><b>{s.held.name}</b>{s.cartCount ? <span style={{ color: "var(--dim)" }}>  · cart {s.cartCount}</span> : null}</div>)}
      {ins && (
        <>
          <div className="panel glass">
            <h3>{ins.server.id}</h3>
            <div className="row"><span>State</span><span>{ins.server.power === "on" ? "Running" : ins.server.power === "booting" ? "Booting" : ins.server.power === "off" ? "Off" : ins.server.power === "no_power" ? "No power" : "Thermal shutdown"}</span></div>
            <div className="row"><span>Temperature</span><span>{Math.round(ins.server.tempC)} °C</span></div>
            <div className="row"><span>Load</span><span>{Math.round(ins.server.load * 100)}%</span></div>
            <div className="row"><span>Output</span><span>{Math.round(ins.server.out.cpu)} CPU · {Math.round(ins.server.out.gpu)} GPU · {Math.round(ins.server.out.tb)} TB</span></div>
            <div className="row"><span>Draw</span><span>{Math.round(ins.server.watts)} W</span></div>
            {ins.server.bottleneck !== "none" && <div className="row"><span>Limited by</span><span style={{ color: "var(--amber)" }}>{ins.server.bottleneck}</span></div>}
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <HoldButton label={ins.server.power === "off" ? "Hold to power on" : "Hold to power off"} onDone={actions.togglePower} />
              <button className="btn" onClick={actions.explode}>{ins.exploded ? "Collapse" : "Exploded view"}</button>
            </div>
            <hr />
            {ins.hover ? <PartCard slot={ins.hover.slot} part={ins.hover.part} /> : s.pinned && ins.server.slots ? <PartCard slot={s.pinned} part={ins.server.slots[s.pinned] ?? null} /> : <div style={{ color: "var(--dim)" }}>Hover a part to inspect it. Click to remove, swap, order or pin its card.</div>}
          </div>
          <div className="keys glass"><b>Click</b> part actions    <b>X</b> exploded view    <b>Q</b> close</div>
          {s.labels.length > 0 && (<svg className="leaders" width="100%" height="100%">{s.labels.map((l) => (<line key={l.slot} x1={l.ax} y1={l.ay} x2={l.x + 14} y2={l.y} />))}</svg>)}
          {s.labels.map((l) => (<div key={l.slot} className="label glass" style={{ left: l.x, top: l.y, borderLeftColor: hex(TIER_COLOR[l.tier] ?? 0xffffff) }}><span className="dot" style={{ background: statusColor(l.status) }} />{l.text}<small>{l.sub}</small></div>))}
          {s.partMenu && (
            <div className="menu glass" style={{ left: Math.min(s.partMenu.x + 12, window.innerWidth - 240), top: Math.min(s.partMenu.y, window.innerHeight - 260) }}>
              <div className="t">{s.partMenu.slot}{s.partMenu.part ? ` · ${s.partMenu.part.name}` : " · empty"}</div>
              {s.partMenu.part && <div className="it" data-act="remove" onClick={() => actions.removePart(s.partMenu!.slot)}><span>Remove</span><small>to hand</small></div>}
              {s.partMenu.options.map((o) => (<div key={o.id} className="it" data-act="swap" onClick={() => actions.installPart(s.partMenu!.slot, o.id)}><span>{s.partMenu!.part ? "Swap for" : "Install"} {o.name}</span><small>{o.where === "crate" ? "delivery" : o.where}</small></div>))}
              <div className="it" data-act="order" onClick={() => actions.orderNow(s.partMenu!.part?.sku ?? s.partMenu!.orderSku)}><span>Order now</span><small>{s.partMenu.part ? s.partMenu.part.name : s.partMenu.orderName} · express</small></div>
              <div className="it" data-act="info" onClick={() => actions.info(s.partMenu!.slot)}><span>Info</span><small>pin the card</small></div>
            </div>
          )}
        </>
      )}
      <div className="feed">{s.feed.slice(-4).map((f) => (<div key={f.id} className={`line glass ${f.kind}`}>{f.text}</div>))}</div>
    </>
  );
}
