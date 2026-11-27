// The left monitor: the facility's ops app (SPEC section 8).
import { useEffect, useState, useCallback } from "react";
import type { Client } from "../client";
import { money, useUI } from "../ui/Hud";
import { ui } from "../ui/store";
import type { Settings } from "../settings";
import { ACTIONS, keys as K, label as keyLabel, type Action } from "../keys";
import "./ops.css";

type Tab = "Overview" | "Floor" | "Racks" | "Contracts" | "Shop" | "Finance" | "Build" | "Settings";
const TABS: Tab[] = ["Overview", "Floor", "Racks", "Contracts", "Shop", "Finance", "Build", "Settings"];

function useView<T>(client: Client, view: string, args: any[] = [], ms = 600): T | null {
  const [v, setV] = useState<T | null>(null);
  const key = JSON.stringify(args);
  useEffect(() => {
    let live = true;
    const pull = () => client.query<T>(view, ...args).then((r) => { if (live) setV(r); }).catch(() => {});
    pull(); const iv = setInterval(pull, ms);
    return () => { live = false; clearInterval(iv); };
  }, [view, key]);
  return v;
}
const pct = (a: number, b: number) => (b > 0 ? Math.min(100, (a / b) * 100) : 0);
const stPill = (s: string) => <span className={`pill ${s === "ok" || s === "on" || s === "closed" ? "ok" : s === "degraded" || s === "booting" ? "warn" : s === "off" ? "" : "bad"}`}>{s}</span>;

export interface OpsProps { client: Client; settings: Settings; onSettings: (k: keyof Settings, v: any) => void; onMenu: () => void; onRebind: (a: Action, code: string) => void }

export function Ops({ client, settings, onSettings, onMenu, onRebind }: OpsProps) {
  const [tab, setTab] = useState<Tab>("Overview");
  const [msg, setMsg] = useState("");
  const w = useUI((s) => s.world);
  const send = useCallback(async (cmd: Record<string, any>) => {
    const r = await client.send({ ...cmd, by: "player" });
    setMsg(r.ok ? "" : r.message); if (!r.ok) setTimeout(() => setMsg(""), 4000);
    return r;
  }, [client]);
  if (!w) return null;
  return (
    <div className="ops" style={{ display: "flex", width: "100%", height: "100%" }} data-tab={tab}>
      <div className="ops-nav">
        <div className="brand">UPTIME OPS</div>
        {TABS.map((t) => <button key={t} className={t === tab ? "on" : ""} onClick={() => setTab(t)} data-tab-btn={t}>{t}</button>)}
        <div className="sp" />
        <div className="speed">{[0, 1, 2, 4].map((s) => <button key={s} className={w.speed === s ? "on" : ""} onClick={() => void send({ type: "setSpeed", speed: s, seated: true })}>{s === 0 ? "II" : s + "x"}</button>)}</div>
        <div className="time">Day {w.time.day} · {String(w.time.hour).padStart(2, "0")}:{String(w.time.minute).padStart(2, "0")}</div>
        <button onClick={onMenu}>Menu</button>
      </div>
      <div className="ops-main">
        {tab === "Overview" && <Overview client={client} />}
        {tab === "Floor" && <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }} ref={(el) => { const c = (window as any).game?.floorCanvas as HTMLCanvasElement | undefined; if (el && c && c.parentElement !== el) { c.style.cssText = "max-width:100%;max-height:100%;display:block"; el.appendChild(c); } }} />}
        {tab === "Racks" && <Racks client={client} send={send} />}
        {tab === "Contracts" && <Contracts client={client} send={send} />}
        {tab === "Shop" && <Shop client={client} send={send} cash={w.cash} />}
        {tab === "Finance" && <Finance client={client} />}
        {tab === "Build" && <Build client={client} send={send} />}
        {tab === "Settings" && <SettingsTab settings={settings} onSettings={onSettings} send={send} onRebind={onRebind} />}
        {msg && <div className="msg">{msg}</div>}
      </div>
    </div>
  );
}

function Overview({ client }: { client: Client }) {
  const o = useView<any>(client, "overview"); const alerts = useView<any[]>(client, "alerts") ?? [];
  if (!o) return null;
  return (
    <>
      <h2>{o.facility}</h2>
      <div className="tiles">
        <div className="tile"><div className="k">Cash</div><div className="v">{money(o.cash)}</div><div className="s">reputation {Math.round(o.reputation)}</div></div>
        <div className="tile"><div className="k">Net per hour</div><div className="v" style={{ color: o.incomePerHour - o.costPerHour >= 0 ? "#35e06f" : "#ff6259" }}>{money(o.incomePerHour - o.costPerHour)}</div><div className="s">{money(o.incomePerHour)} in · {money(o.costPerHour)} out</div></div>
        <div className="tile"><div className="k">Power</div><div className="v">{o.power.usedKw.toFixed(1)} <span className="dim" style={{ fontSize: 13 }}>/ {o.power.capKw} kW</span></div><div className="meter"><i style={{ width: pct(o.power.usedKw, o.power.capKw) + "%", background: o.power.usedKw > o.power.capKw * 0.9 ? "#ffb020" : undefined }} /></div></div>
        <div className="tile"><div className="k">Cooling</div><div className="v">{o.cooling.heatKw.toFixed(1)} <span className="dim" style={{ fontSize: 13 }}>/ {o.cooling.capKw} kW</span></div><div className="meter"><i style={{ width: pct(o.cooling.heatKw, o.cooling.capKw) + "%", background: o.cooling.heatKw > o.cooling.capKw ? "#ff3b30" : o.cooling.heatKw > o.cooling.capKw * 0.9 ? "#ffb020" : undefined }} /></div></div>
      </div>
      <div className="row2">
        <div>
          <h4>Capacity sold</h4>
          <table className="t"><thead><tr><th>Unit</th><th className="r">Capacity</th><th className="r">On contract</th></tr></thead><tbody>
            {(["cpu", "gpu", "tb"] as const).map((u) => <tr key={u}><td>{u === "cpu" ? "Compute units" : u === "gpu" ? "GPU units" : "Storage TB"}</td><td className="r">{Math.round(o.capacity?.[u] ?? 0).toLocaleString()}</td><td className="r">{Math.round(o.sold?.[u] ?? 0).toLocaleString()}</td></tr>)}
          </tbody></table>
          <h4>Halls</h4>
          <table className="t"><tbody>{(o.halls ?? []).map((h: any) => <tr key={h.id}><td>Hall {h.id}</td><td className="r" style={{ color: h.airC > 35 ? "#ff6259" : h.airC > 28 ? "#ffb020" : undefined }}>{h.airC.toFixed(1)} °C</td></tr>)}</tbody></table>
        </div>
        <div>
          <h4>Alerts ({alerts.length})</h4>
          {alerts.length === 0 && <div className="dim">All clear.</div>}
          <table className="t"><tbody>{alerts.slice(0, 9).map((a) => <tr key={a.id}><td><span className={`pill ${a.severity === "critical" ? "bad" : a.severity === "warn" ? "warn" : ""}`}>{a.severity}</span></td><td>{a.text}</td></tr>)}</tbody></table>
        </div>
      </div>
    </>
  );
}

function Racks({ client, send }: { client: Client; send: (c: any) => Promise<any> }) {
  const racks = useView<any[]>(client, "racks") ?? [];
  const [sel, setSel] = useState<string | null>(null); const [srv, setSrv] = useState<string | null>(null);
  const rack = useView<any>(client, "rack", [sel], 700); const server = useView<any>(client, "server", [srv], 700);
  if (srv && server) return (
    <>
      <h2><button className="ob sm" onClick={() => setSrv(null)}>Back</button>  {server.id} {stPill(server.power)}</h2>
      <div className="dim">{Math.round(server.tempC)} °C · load {Math.round((server.load ?? 0) * 100)}% · {Math.round(server.watts)} W · out {Math.round(server.out?.cpu ?? 0)} CPU / {Math.round(server.out?.gpu ?? 0)} GPU / {Math.round(server.out?.tb ?? 0)} TB{server.bottleneck && server.bottleneck !== "none" ? ` · limited by ${server.bottleneck}` : ""}</div>
      <div style={{ margin: "8px 0" }}><button className="ob" onClick={() => void send({ type: "setServerPower", server: server.id, on: server.power === "off" })}>{server.power === "off" ? "Power on" : "Power off"}</button></div>
      <table className="t"><thead><tr><th>Slot</th><th>Part</th><th>Tier</th><th>Health</th><th>Temp</th><th /></tr></thead><tbody>
        {(server.slots ?? []).map((s: any) => <tr key={s.slot}><td>{s.slot}</td><td>{s.part ? s.part.name : <span className="dim">empty</span>}</td><td>{s.part?.tier ?? ""}</td><td>{s.part ? <>{Math.round(s.part.health)}% {s.part.status !== "ok" && stPill(s.part.status)}</> : ""}</td><td>{s.part ? Math.round(s.part.tempC) + " °C" : ""}</td>
          <td className="r">{s.part && <button className="ob sm" onClick={() => void send({ type: "queueJob", kind: "remove", server: server.id, slot: s.slot })}>Gantry remove</button>}</td></tr>)}
      </tbody></table>
    </>
  );
  if (sel && rack) return (
    <>
      <h2><button className="ob sm" onClick={() => setSel(null)}>Back</button>  {rack.id} {stPill(rack.breaker ?? "closed")}</h2>
      <div className="dim">{(rack.kw ?? 0).toFixed(1)} / {rack.pduCapKw} kW{rack.breaker === "tripped" && <> · <button className="ob sm" onClick={() => void send({ type: "resetBreaker", rack: rack.id })}>Reset breaker</button></>}</div>
      <table className="t" style={{ marginTop: 8 }}><thead><tr><th>Server</th><th>State</th><th className="r">Temp</th><th className="r">Load</th><th className="r">CPU</th><th className="r">GPU</th><th>Limit</th><th /></tr></thead><tbody>
        {(rack.servers ?? []).map((s: any) => <tr key={s.id} className="click" onClick={() => setSrv(s.id)}><td>{s.id}</td><td>{stPill(s.power)}</td><td className="r">{Math.round(s.tempC)} °C</td><td className="r">{Math.round((s.load ?? 0) * 100)}%</td><td className="r">{Math.round(s.out?.cpu ?? 0)}</td><td className="r">{Math.round(s.out?.gpu ?? 0)}</td><td>{s.bottleneck !== "none" ? s.bottleneck : ""}</td>
          <td className="r"><button className="ob sm" onClick={(e) => { e.stopPropagation(); void send({ type: "setServerPower", server: s.id, on: s.power === "off" }); }}>{s.power === "off" ? "On" : "Off"}</button></td></tr>)}
      </tbody></table>
    </>
  );
  return (
    <>
      <h2>Racks</h2>
      <table className="t"><thead><tr><th>Rack</th><th>Hall</th><th className="r">Servers</th><th className="r">Load</th><th className="r">Max temp</th><th>Breaker</th><th>Status</th></tr></thead><tbody>
        {racks.map((r) => <tr key={r.id} className="click" onClick={() => setSel(r.id)}><td>{r.id}</td><td>{r.hall}</td><td className="r">{r.servers}</td><td className="r">{(r.kw ?? 0).toFixed(1)} / {r.pduCapKw} kW</td><td className="r">{Math.round(r.maxTempC ?? 0)} °C</td><td>{stPill(r.breaker ?? "closed")}</td><td>{stPill(r.worstStatus ?? "ok")}</td></tr>)}
      </tbody></table>
    </>
  );
}

function Contracts({ client, send }: { client: Client; send: (c: any) => Promise<any> }) {
  const active = useView<any[]>(client, "contracts", ["active"]) ?? []; const offers = useView<any[]>(client, "contracts", ["offer"]) ?? [];
  const unit = (u: string) => (u === "cpu" ? "CU" : u === "gpu" ? "GU" : "TB");
  const row = (c: any, offer: boolean) => <tr key={c.id}><td style={{ textTransform: "capitalize" }}>{c.type}</td><td className="r">{Math.round(c.demand).toLocaleString()} {unit(c.unit)}</td><td className="r">{money(c.ratePerUnitHour * c.demand)}/h</td><td className="r">{c.slaPct}%</td><td className="r">{c.days} d</td>
    {!offer && <td className="r" style={{ color: c.deliveredPctToday < c.slaPct ? "#ff6259" : "#35e06f" }}>{Math.round(c.deliveredPctToday ?? 0)}%</td>}
    <td className="r">{offer ? <button className="ob sm pri" onClick={() => void send({ type: "acceptContract", contract: c.id })}>Accept</button> : <button className="ob sm" onClick={() => void send({ type: "cancelContract", contract: c.id })}>Cancel</button>}</td></tr>;
  return (
    <>
      <h2>Contracts</h2>
      <h4>Active</h4>
      {active.length === 0 ? <div className="dim">None. Unsold capacity sells on the spot market at 60% of base.</div> :
        <table className="t"><thead><tr><th>Type</th><th className="r">Demand</th><th className="r">Pays</th><th className="r">SLA</th><th className="r">Left</th><th className="r">Today</th><th /></tr></thead><tbody>{active.map((c) => row(c, false))}</tbody></table>}
      <h4>Offers</h4>
      <table className="t"><thead><tr><th>Type</th><th className="r">Demand</th><th className="r">Pays</th><th className="r">SLA</th><th className="r">Length</th><th /></tr></thead><tbody>{offers.map((c) => row(c, true))}</tbody></table>
    </>
  );
}

const FAMS: [string, string][] = [["gpu", "GPUs"], ["cpu", "CPUs"], ["ram", "Memory"], ["drv", "Drives"], ["psu", "Power"], ["fan", "Fans"], ["nic", "Network"], ["item", "Racks and chassis"]];
function Shop({ client, send, cash }: { client: Client; send: (c: any) => Promise<any>; cash: number }) {
  const [fam, setFam] = useState("gpu"); const [cart, setCart] = useState<Record<string, number>>({}); const [express, setExpress] = useState(false);
  const all = useView<any[]>(client, "catalog", [], 5000) ?? []; const orders = useView<any>(client, "orders") ?? { orders: [], gantryJobs: [] };
  const items = all.filter((i) => (fam === "item" ? !/^(cpu|gpu|ram|drv|psu|fan|nic)\./.test(i.sku) : i.sku.startsWith(fam + ".")));
  const total = Object.entries(cart).reduce((a, [sku, q]) => a + (all.find((i) => i.sku === sku)?.price ?? 0) * q, 0) * (express ? 1.25 : 1);
  const add = (sku: string, d: number) => setCart((c) => { const n = { ...c, [sku]: Math.max(0, (c[sku] ?? 0) + d) }; if (!n[sku]) delete n[sku]; return n; });
  const place = async () => { const r = await send({ type: "placeOrder", lines: Object.entries(cart).map(([sku, qty]) => ({ sku, qty })), express }); if (r.ok) setCart({}); };
  return (
    <>
      <h2>Shop</h2>
      <div className="row2">
        <div style={{ flex: 1.7 }}>
          <div className="fams">{FAMS.map(([k, l]) => <button key={k} className={`ob sm ${fam === k ? "pri" : ""}`} onClick={() => setFam(k)}>{l}</button>)}</div>
          <table className="t"><thead><tr><th>Item</th><th>Spec</th><th className="r">Price</th><th /></tr></thead><tbody>
            {items.map((i) => <tr key={i.sku}><td>{i.name}</td><td className="dim">{i.spec}</td><td className="r">{money(i.price)}</td><td className="r"><button className="ob sm" data-add={i.sku} onClick={() => add(i.sku, 1)}>Add</button></td></tr>)}
          </tbody></table>
        </div>
        <div>
          <div className="cart">
            <b>Cart</b>
            {Object.keys(cart).length === 0 && <div className="dim" style={{ marginTop: 4 }}>Empty.</div>}
            {Object.entries(cart).map(([sku, q]) => <div key={sku} style={{ display: "flex", justifyContent: "space-between", marginTop: 5 }}><span>{all.find((i) => i.sku === sku)?.name ?? sku}</span><span><button className="ob sm" onClick={() => add(sku, -1)}>-</button> {q} <button className="ob sm" onClick={() => add(sku, 1)}>+</button></span></div>)}
            <label style={{ display: "block", marginTop: 8 }}><input type="checkbox" checked={express} onChange={(e) => setExpress(e.target.checked)} data-express /> Express (+25%, arrives in seconds)</label>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}><b>{money(total)}</b><button className="ob pri" data-order disabled={!total} onClick={() => void place()}>{total > cash + 10000 ? "Not enough cash" : "Place order"}</button></div>
          </div>
          <h4>Stock</h4>
          <Stock client={client} send={send} />
          <h4>In transit</h4>
          {(orders.orders ?? []).filter((o: any) => o.state !== "opened").length === 0 && <div className="dim">Nothing on the way.</div>}
          {(orders.orders ?? []).filter((o: any) => o.state !== "opened").map((o: any) => <div key={o.id} style={{ marginTop: 4 }}>{o.lines.map((l: any) => `${l.qty} × ${l.sku}`).join(", ")} <span className={`pill ${o.state === "delivered" ? "ok" : "cy"}`}>{o.state === "delivered" ? "in loading bay" : o.eta ?? "in transit"}</span></div>)}
          <h4>Gantry jobs</h4>
          {(orders.gantryJobs ?? []).length === 0 && <div className="dim">Queue empty.</div>}
          {(orders.gantryJobs ?? []).slice(0, 6).map((j: any) => <div key={j.id} style={{ marginTop: 4 }}>{j.kind} {j.server} {j.slot} <span className="pill cy">{j.state}</span> {j.state === "queued" && <button className="ob sm" onClick={() => void send({ type: "cancelJob", job: j.id })}>Cancel</button>}</div>)}
        </div>
      </div>
    </>
  );
}

/** Parts not installed anywhere. Each can be sold back at 40% of its price. */
function Stock({ client, send }: { client: Client; send: (c: any) => Promise<any> }) {
  const [, force] = useState(0); useEffect(() => { const iv = setInterval(() => force((x) => x + 1), 700); return () => clearInterval(iv); }, []);
  const inv = client.inventory;
  if (!inv.length) return <div className="dim">Nothing in stock.</div>;
  return <div style={{ maxHeight: 120, overflow: "auto" }}>{inv.slice(0, 40).map((i) => <div key={i.id} style={{ display: "flex", justifyContent: "space-between", marginTop: 3 }}><span>{i.name} <span className="dim">{i.where}</span></span><button className="ob sm" data-sell={i.id} onClick={() => void send({ type: "sellPart", part: i.id })}>Sell {money(Math.round((i.price ?? 0) * 0.4 * (i.status === "failed" ? 0.1 : i.status === "degraded" ? 0.5 : 1)))}</button></div>)}</div>;
}

function Finance({ client }: { client: Client }) {
  const f = useView<any>(client, "finance", [7], 1500);
  if (!f) return null;
  const days: any[] = f.byDay ?? []; const max = Math.max(1, ...days.map((d) => Math.abs(d.net ?? 0)));
  const line = (k: string, v: number) => <tr key={k}><td style={{ textTransform: "capitalize" }}>{k}</td><td className="r">{money(v ?? 0)}</td></tr>;
  return (
    <>
      <h2>Finance <span className="dim" style={{ fontSize: 13, fontWeight: 500 }}>last 7 days</span></h2>
      <div className="row2">
        <div><h4>Income</h4><table className="t"><tbody>{Object.entries(f.income ?? {}).map(([k, v]) => line(k, v as number))}</tbody></table></div>
        <div><h4>Costs</h4><table className="t"><tbody>{Object.entries(f.costs ?? {}).map(([k, v]) => line(k, v as number))}</tbody></table></div>
      </div>
      <h4>Net by day · total {money(f.net ?? 0)}</h4>
      <div className="chart">{days.map((d, i) => <div key={i} className={d.net < 0 ? "neg" : ""} style={{ height: `${(Math.abs(d.net ?? 0) / max) * 100}%` }}><span>{d.day ?? i + 1}</span></div>)}</div>
    </>
  );
}

function Build({ client, send }: { client: Client; send: (c: any) => Promise<any> }) {
  const b = useView<any>(client, "build", [], 1200); const racks = useView<any[]>(client, "racks") ?? [];
  if (!b) return null;
  return (
    <>
      <h2>Build</h2>
      <table className="t"><thead><tr><th>Upgrade</th><th>Now</th><th>Next</th><th className="r">Price</th><th /></tr></thead><tbody>
        {(b.items ?? []).map((u: any) => <tr key={u.kind + (u.target ?? "")}><td>{u.label}</td><td>{u.now}</td><td>{u.next ?? <span className="dim">max</span>}</td><td className="r">{u.price != null ? money(u.price) : ""}</td><td className="r">{u.price != null && <button className="ob sm pri" data-buy={u.kind + (u.target ?? "")} disabled={!!u.blocked} title={u.blocked ?? ""} onClick={() => void send({ type: "buyUpgrade", kind: u.kind, target: u.target })}>{u.blocked ?? "Buy"}</button>}</td></tr>)}
      </tbody></table>
      <h4>Per rack</h4>
      <table className="t"><thead><tr><th>Rack</th><th>PDU</th><th>Rear-door cooler</th></tr></thead><tbody>
        {racks.map((r) => <tr key={r.id}><td>{r.id}</td><td>{r.pduCapKw} kW {r.pduCapKw < 30 && <button className="ob sm" onClick={() => void send({ type: "buyUpgrade", kind: "pdu", target: r.id })}>Upgrade {money(b.pduPrice ?? 2500)}</button>}</td><td>{r.rearDoor ? <span className="pill ok">fitted</span> : <button className="ob sm" onClick={() => void send({ type: "buyUpgrade", kind: "rear_door", target: r.id })}>Fit {money(b.rearDoorPrice ?? 4000)}</button>}</td></tr>)}
      </tbody></table>
    </>
  );
}

function Rebind({ onRebind }: { onRebind: (a: Action, code: string) => void }) {
  const [wait, setWait] = useState<Action | null>(null);
  useEffect(() => { if (!wait) return; const h = (e: KeyboardEvent) => { e.preventDefault(); e.stopPropagation(); if (e.code !== "Escape" && !e.metaKey) onRebind(wait, e.code); setWait(null); }; window.addEventListener("keydown", h, true); return () => window.removeEventListener("keydown", h, true); }, [wait]);
  return <>{ACTIONS.map(([a, name]) => <div className="setrow" key={a}><span>{name}</span><button className={`ob sm ${wait === a ? "pri" : ""}`} data-rebind={a} onClick={() => setWait(a)}>{wait === a ? "Press a key" : keyLabel(K[a])}</button></div>)}</>;
}

function SettingsTab({ settings, onSettings, send, onRebind }: { settings: Settings; onSettings: (k: keyof Settings, v: any) => void; send: (c: any) => Promise<any>; onRebind: (a: Action, code: string) => void }) {
  const sel = (k: keyof Settings, opts: (string | number)[], label: string) => <div className="setrow"><span>{label}</span><select value={String(settings[k])} onChange={(e) => { const raw = e.target.value; const v = typeof settings[k] === "number" ? Number(raw) : typeof settings[k] === "boolean" ? raw === "true" : raw; onSettings(k, v); if (k === "claude.autonomy") void send({ type: "setAutonomy", level: String(v).toLowerCase() }); }}>{opts.map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}</select></div>;
  const tog = (k: keyof Settings, label: string) => sel(k, ["true", "false"], label);
  return (
    <>
      <h2>Settings</h2>
      <div className="row2">
        <div>
          <h4>Graphics</h4>
          {sel("graphics.tier", ["Medium", "High", "Ultra"], "Quality")}
          {settings["graphics.steppedDown"] && <div className="dim" style={{ padding: "4px 0" }}>{settings["graphics.steppedDown"]}</div>}
          {sel("graphics.resolutionScale", [0.5, 0.75, 1], "Resolution scale")}
          {sel("graphics.fov", [60, 65, 70, 75, 80, 90, 100], "Field of view")}
          {tog("graphics.vsync", "Lock to 60 fps")}
          {tog("graphics.filmGrain", "Film grain")}
          {tog("camera.guide916", "9:16 guide frame")}
          <div className="setrow"><span>Window size</span><span><button className="ob sm" data-win="1080x1920" onClick={() => void (window as any).uptime?.invoke("window.size", 1080, 1920)}>1080 x 1920</button> <button className="ob sm" data-win="1600x900" onClick={() => void (window as any).uptime?.invoke("window.size", 3200, 1800)}>16:9</button></span></div>
          <h4>Controls and comfort</h4>
          {sel("controls.sensitivity", [0.2, 0.5, 0.75, 1, 1.5, 2, 3], "Mouse sensitivity")}
          {tog("controls.invertY", "Invert Y")}
          {tog("comfort.headBob", "Head bob")}
          {tog("comfort.cameraEase", "Ease camera moves")}
          {sel("comfort.textScale", [0.8, 0.9, 1, 1.15, 1.3, 1.5], "Text scale")}
        </div>
        <div>
          <h4>Audio</h4>
          {sel("audio.master", [0, 0.2, 0.4, 0.6, 0.8, 1], "Master")}
          {sel("audio.world", [0, 0.2, 0.4, 0.6, 0.8, 1], "World")}
          {sel("audio.ui", [0, 0.2, 0.4, 0.7, 1], "Interface")}
          <h4>Claude and terminal</h4>
          {sel("claude.autonomy", ["Advise", "Operate", "Full"], "Claude autonomy")}
          {tog("claude.bootInto", "Boot terminal into Claude")}
          {sel("terminal.fontSize", [11, 12, 13, 14, 15, 16, 18, 20], "Terminal font size")}
          <div className="setrow"><span>Workspace folder</span>{settings["streamer.enabled"] ? <span className="dim" data-workspace-hidden>hidden in streamer mode</span> : <input type="text" style={{ width: 170 }} defaultValue={settings["terminal.workspace"]} placeholder="default" onBlur={(e) => onSettings("terminal.workspace", e.target.value)} />}</div>
          {tog("streamer.enabled", "Streamer mode")}
          <h4>Keys <span className="dim">(Cmd chords at the desk are fixed)</span></h4>
          <Rebind onRebind={onRebind} />
          <h4>Simulation and demo</h4>
          {tog("sim.pauseWhenUnfocused", "Pause when unfocused")}
          {tog("demo.director", "Demo director keys")}
          {tog("replay.logging", "Replay logging")}
        </div>
      </div>
    </>
  );
}
export { ui };
