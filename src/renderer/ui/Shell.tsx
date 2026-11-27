// Menus and overlays that sit above the HUD: first-launch notices, main menu, new game, load, pause, the tablet,
// the first-shift checklist and the debug overlay (SPEC appendices A and L).
import { useEffect, useState } from "react";
import { useUI, money } from "./Hud";
import { ui, isFree } from "./store";
import { STEPS } from "./checklist";

export interface ShellActions {
  resume(): void; quit(): void; newGame(name: string, preset: string, slot: string): Promise<void>; load(slot: string): Promise<any>; save(slot: string): Promise<any>;
  listSaves(): Promise<any[]>; openLogs(): void; setSetting(k: any, v: any): void; settings(): any; showChecklist(): void; seenNotices(): void;
}
const go = (menu: any) => ui.getState().set({ menu });
const SLOT_LABEL: Record<string, string> = { autosave: "Autosave", "autosave.1": "Autosave (previous)", "autosave.2": "Autosave (older)", slot1: "Slot 1", slot2: "Slot 2", slot3: "Slot 3" };

function Saves({ actions, mode, onDone }: { actions: ShellActions; mode: "load" | "save"; onDone: () => void }) {
  const [list, setList] = useState<any[]>([]); const [msg, setMsg] = useState("");
  const refresh = () => actions.listSaves().then(setList);
  useEffect(() => { void refresh(); }, []);
  const rows = list.filter((s) => (mode === "save" ? /^slot/.test(s.slot) : true));
  return (
    <div className="mlist">
      {rows.map((s) => (
        <button key={s.slot} className="mbtn" data-slot={s.slot} disabled={mode === "load" && (!s.exists || s.corrupt)} onClick={async () => {
          if (mode === "save") { await actions.save(s.slot); setMsg(`Saved to ${SLOT_LABEL[s.slot]}.`); void refresh(); return; }
          const r = await actions.load(s.slot); if (r?.ok) onDone(); else setMsg(`${r?.error ?? "That save could not be loaded."}${r?.fallback ? " The previous autosave is available below." : ""}`);
        }}>{SLOT_LABEL[s.slot] ?? s.slot}<small>{s.corrupt ? "Damaged save" : s.exists ? `${s.name} · day ${s.day} · ${money(s.cash)} · ${new Date(s.savedAt).toLocaleString()}` : "Empty"}</small></button>
      ))}
      {msg && <p style={{ color: "var(--amber)", marginTop: 8 }} data-save-msg>{msg}</p>}
    </div>
  );
}

export function Shell({ actions, info, hasSave }: { actions: ShellActions; info: any; hasSave: boolean }) {
  const menu = useUI((s) => s.menu); const tablet = useUI((s) => s.tablet); const check = useUI((s) => s.checklist); const mode = useUI((s) => s.mode);
  const hidden = useUI((s) => s.hudHidden); const world = useUI((s) => s.world); const debug = useUI((s) => s.debug);
  const [name, setName] = useState("UPTIME"); const [slot, setSlot] = useState("slot1");
  const [dbg, setDbg] = useState("");
  useEffect(() => {
    if (!debug) return;
    const iv = setInterval(async () => {
      const g = (window as any).game; const raw: number[] = g.stats.dt.slice(-120); const dt = [...raw].sort((a: number, b: number) => a - b); const r: any = g.renderer.info.render;
      const d = (await (window as any).uptime?.invoke("diag.stats")) ?? {};
      let inst = 0, lights = 0; g.scene.traverse((o: any) => { if (o.isInstancedMesh) inst += o.count; if (o.isLight && o.visible && o.intensity > 0) lights++; });
      const bars = "▁▂▃▄▅▆▇█"; const graph = raw.slice(-48).map((v) => bars[Math.max(0, Math.min(7, Math.floor((v / 33.4) * 8)))]).join("");
      setDbg(`frame ${graph}\nframe p50 ${dt[Math.floor(dt.length / 2)]?.toFixed(1)} ms  p95 ${dt[Math.floor(dt.length * 0.95)]?.toFixed(1)} ms\ndraw calls ${r.drawCalls ?? r.calls}  triangles ${r.triangles}\ninstances ${inst}  active lights ${lights}\nracks ${g.client.world.racks.length}  tier ${g.pipeline.tier}\nsim tick p95 ${(d.tickP95 ?? 0).toFixed(2)} ms  delta ${((d.deltaBytes ?? 0) / 1024).toFixed(1)} KB\nMCP calls per minute ${d.mcpPerMin ?? 0}`);
    }, 500);
    return () => clearInterval(iv);
  }, [debug]);
  const checkShown = !hidden && mode !== "menu" && mode !== "seated" && check.step <= 6 && !check.dismissed;
  useEffect(() => { document.body.classList.toggle("has-check", checkShown); }, [checkShown]);
  const start = async (preset: string) => { await actions.newGame(name.trim() || "UPTIME", preset, slot); };
  return (
    <>
      {!info.test && !info.preset && <div className="splash"><h1>UPTIME</h1><div>compiling shaders</div></div>}
      {menu === "notice1" && (<div className="scrim"><div className="sheet glass"><h2>A real terminal</h2><p>The computer in this game runs a real terminal with your own permissions. Anything you type there runs on this Mac, exactly as it would in your usual terminal app. The game never stores or reads your credentials.</p><div className="mlist"><button className="mbtn pri" data-continue onClick={() => go("notice2")}>Continue</button></div></div></div>)}
      {menu === "notice2" && (<div className="scrim"><div className="sheet glass"><h2>Streamer mode</h2><p>Streamer mode starts the terminal with a short prompt in the game's own folder, so your home path is not on screen. It cannot hide what Claude or your tools print. Turn it on in Settings before you record.</p><div className="mlist"><button className="mbtn pri" data-continue onClick={() => { actions.seenNotices(); go("main"); }}>Continue</button></div></div></div>)}
      {menu === "main" && (<div className="scrim main"><div className="sheet"><h1>UPTIME</h1><div className="sub">Run the data center. Hand it to Claude.</div><div className="mlist">
        <button className="mbtn" data-menu="continue" disabled={!hasSave} onClick={() => actions.resume()}>Continue</button>
        <button className="mbtn" data-menu="new" onClick={() => go("new")}>New game</button>
        <button className="mbtn" data-menu="load" onClick={() => go("load")}>Load</button>
        <button className="mbtn" data-menu="demo" onClick={() => go("demo")}>Demo saves</button>
        <button className="mbtn" data-menu="settings" onClick={() => go("settings")}>Settings</button>
        <button className="mbtn" onClick={actions.quit}>Quit</button></div></div></div>)}
      {menu === "new" && (<div className="scrim"><div className="sheet glass"><h2>New game</h2>
        <label className="field">Facility name<input value={name} maxLength={28} onChange={(e) => setName(e.target.value)} data-name /></label>
        <label className="field">Save slot<select value={slot} onChange={(e) => setSlot(e.target.value)}><option value="slot1">Slot 1</option><option value="slot2">Slot 2</option><option value="slot3">Slot 3</option></select></label>
        <div className="mlist"><button className="mbtn pri" data-start onClick={() => void start("fresh")}>Start</button><button className="mbtn" onClick={() => go("main")}>Back</button></div></div></div>)}
      {menu === "demo" && (<div className="scrim"><div className="sheet glass"><h2>Demo saves</h2><div className="mlist">
        <button className="mbtn" data-demo="fresh" onClick={() => void start("fresh")}>Fresh start<small>Two racks, $25,000</small></button>
        <button className="mbtn" data-demo="demo" onClick={() => void start("demo")}>Demo stage<small>Hall A full, Hall B still to buy, spares on the shelf</small></button>
        <button className="mbtn" data-demo="showcase" onClick={() => void start("showcase")}>Showcase<small>Hall A full, Hall B half built, $180,000</small></button>
        <button className="mbtn" data-demo="mega" onClick={() => void start("mega")}>Mega<small>All three halls full</small></button>
        <button className="mbtn" onClick={() => go("main")}>Back</button></div></div></div>)}
      {menu === "load" && (<div className="scrim"><div className="sheet glass"><h2>Load</h2><Saves actions={actions} mode="load" onDone={() => {}} /><div className="mlist" style={{ marginTop: 8 }}><button className="mbtn" onClick={() => go(ui.getState().world && ui.getState().paused && (window as any).__fromPause ? "pause" : "main")}>Back</button></div></div></div>)}
      {menu === "settings" && (<div className="scrim"><div className="sheet glass"><h2>Settings</h2><p>All settings are on the left monitor of the master computer, under Settings. The essentials:</p>
        {[["graphics.tier", ["Medium", "High", "Ultra"], "Quality"], ["streamer.enabled", ["false", "true"], "Streamer mode"], ["demo.director", ["false", "true"], "Demo director keys"], ["claude.autonomy", ["Advise", "Operate", "Full"], "Claude autonomy"]].map(([k, opts, label]: any) => (
          <label className="field" key={k}>{label}<select defaultValue={String(actions.settings()[k])} onChange={(e) => actions.setSetting(k, e.target.value === "true" ? true : e.target.value === "false" ? false : e.target.value)}>{opts.map((o: string) => <option key={o} value={o}>{o === "true" ? "On" : o === "false" ? "Off" : o}</option>)}</select></label>))}
        <div className="mlist"><button className="mbtn" onClick={() => go((window as any).__fromPause ? "pause" : "main")}>Back</button></div></div></div>)}
      {menu === "pause" && (<PauseMenu actions={actions} />)}
      {checkShown && mode === "inspect" && (<div className="check mini glass"><b>First shift</b><span className="step">step {check.step + 1} of 7: {STEPS[check.step]}</span></div>)}
      {checkShown && mode !== "inspect" && (
        <div className="check glass"><span className="x" onClick={() => ui.getState().set({ checklist: { ...check, dismissed: true } })}>×</span><b>First shift</b>
          {STEPS.map((s, i) => (<div key={i} className={`st ${check.done[i] ? "done" : i === check.step ? "cur" : ""}`}><span className="box" />{s}</div>))}
          {check.hint && <div className="hint">{check.hint}</div>}
          {check.step === 6 && <button className="btn" style={{ marginTop: 8 }} onClick={() => (window as any).game.checklist.skip()}>Skip this step</button>}
        </div>)}
      {!hidden && tablet && isFree(mode) && world && (
        <div className="tablet glass"><div className="cols">
          <div><div className="k">Cash</div><div className="v">{money(world.cash)}</div></div>
          <div><div className="k">Net per hour</div><div className="v">{money(world.incomePerHour - world.costPerHour)}</div></div>
          <div><div className="k">Power</div><div className="v">{world.power.usedKw.toFixed(0)}/{world.power.capKw}</div></div>
          <div><div className="k">Heat</div><div className="v">{world.cooling.heatKw.toFixed(0)}/{world.cooling.capKw}</div></div></div>
          <TabletAlerts /></div>)}
      {debug && <div className="debug glass">{dbg}</div>}
    </>
  );
}

function TabletAlerts() {
  const [alerts, setAlerts] = useState<any[]>([]);
  useEffect(() => { const pull = () => (window as any).game?.client.query("alerts").then((a: any[]) => setAlerts(a ?? [])); pull(); const iv = setInterval(pull, 1000); return () => clearInterval(iv); }, []);
  if (!alerts.length) return <div className="al">No open alerts.</div>;
  return <>{alerts.slice(0, 5).map((a) => <div key={a.id} className={`al ${a.severity}`}>{a.text}</div>)}</>;
}

function PauseMenu({ actions }: { actions: ShellActions }) {
  const [sub, setSub] = useState<"" | "save" | "load">("");
  (window as any).__fromPause = true;
  return (<div className="scrim"><div className="sheet glass"><h2>Paused</h2>
    {sub === "" && <div className="mlist">
      <button className="mbtn pri" data-resume onClick={actions.resume}>Resume</button>
      <button className="mbtn" onClick={() => setSub("save")}>Save</button>
      <button className="mbtn" onClick={() => setSub("load")}>Load</button>
      <button className="mbtn" onClick={() => go("settings")}>Settings</button>
      <button className="mbtn" onClick={() => { actions.showChecklist(); actions.resume(); }}>First-shift checklist</button>
      <button className="mbtn" onClick={() => { (window as any).__fromPause = false; go("main"); }}>Main menu</button>
      <button className="mbtn" onClick={actions.openLogs}>Open logs</button>
      <button className="mbtn" onClick={actions.quit}>Quit</button></div>}
    {sub !== "" && <><Saves actions={actions} mode={sub} onDone={() => {}} /><div className="mlist" style={{ marginTop: 8 }}><button className="mbtn" onClick={() => setSub("")}>Back</button></div></>}
  </div></div>);
}
