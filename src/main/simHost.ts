// Runs the simulation in the main process and feeds the renderer, the MCP server, saves and the replay log.
import { app, ipcMain, type BrowserWindow } from "electron";
import { join } from "node:path";
import { z } from "zod";
import { gunzipSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, copyFileSync, readdirSync, statSync } from "node:fs";
import balanceJson from "../../balance/balance.json";
import { deserialize, parseBalance, newGame, applyCommand, tick, views, gameTime, markMilestone, stateHash, ticksPerHour, partSpec, slotFamily, SLOTS, type SlotId, type State, type Balance, type Preset, type SimEvent, type Command, type Result } from "@sim/index";
import { packSave, unpackSave } from "@sim/saveNode";
import type { WorldView, RackView, ServerView, PartView, InvItem, CmdResult } from "@shared/view";
import type { SimApi } from "./mcp/tools";
import { readPoses, type ReplayLog } from "./replayLog";

export const bal: Balance = parseBalance(balanceJson);
/** Schemas for the replay log (SPEC appendix H, gate G19). */
const ReplayMeta = z.object({ seed: z.number(), version: z.number(), startHash: z.string(), tick0: z.number(), markers: z.array(z.object({ label: z.string(), t: z.number(), tick: z.number() })), endTick: z.number().optional(), durationMs: z.number().optional() }).passthrough();
const ReplayCmd = z.object({ tick: z.number().int().nonnegative(), t: z.number().optional(), cmd: z.object({ type: z.string(), by: z.enum(["player", "claude", "director"]) }).passthrough() });
const ReplayPose = z.object({ t: z.number(), tick: z.number(), p: z.object({ pos: z.array(z.number()).length(3), yaw: z.number().optional(), pitch: z.number().optional(), q: z.array(z.number()).length(4), fov: z.number(), mode: z.string(), inspect: z.string().nullable().optional(), ex: z.boolean().optional() }) });
const ReplayPty = z.object({ t: z.number(), tick: z.number().optional(), b: z.string() });
const TOOL_OF: Record<string, string> = { placeOrder: "shop_order", queueJob: "gantry_job", setServerPower: "set_server_power", resetBreaker: "reset_breaker", acceptContract: "accept_contract", cancelContract: "cancel_contract", buyUpgrade: "buy_upgrade" };
const SLOT_KEYS = ["autosave", "slot1", "slot2", "slot3"] as const;
type Waiter = { kinds?: string[]; resolve: (e: any | null) => void; timer: NodeJS.Timeout };

export class SimHost implements SimApi {
  state: State;
  private queue: { cmd: Record<string, any>; resolve: (r: CmdResult) => void }[] = [];
  private timer: NodeJS.Timeout | null = null;
  private lastRack = new Map<string, string>();
  private lastHeader = ""; private lastInv = "";
  private watched: string | null = null;
  private waiters: Waiter[] = [];
  private claudeTouched = new Map<string, number>(); private playerTouched = new Map<string, number>();
  private openAlerts = new Map<string, string | undefined>();
  private claudeFlash = new Map<string, number>();
  paused = false;
  replay: ReplayLog | null = null;
  tickMs: number[] = [];
  onMilestone: (id: string) => void = () => {};
  mcpStats = { calls: 0, since: Date.now() };
  slotInUse = "autosave";

  constructor(private getWin: () => BrowserWindow | null, private log: (s: string) => void) {
    this.state = newGame(bal, { seed: 1, facilityName: "UPTIME", preset: "fresh" });
    ipcMain.handle("sim.snapshot", () => this.fullWorld());
    ipcMain.handle("sim.command", (_e, cmd) => this.command(cmd));
    ipcMain.handle("sim.query", (_e, name: string, ...args: any[]) => this.view(name, ...args));
    ipcMain.handle("sim.watch", (_e, id: string | null) => { this.watched = id; });
    ipcMain.handle("save.list", () => this.listSaves());
    ipcMain.handle("save.write", (_e, slot: string) => this.save(slot));
    ipcMain.handle("save.load", (_e, slot: string) => this.load(slot));
    ipcMain.handle("game.new", (_e, o: { name: string; preset: Preset; slot?: string; seed?: number }) => { this.newGame(o.preset, o.name, o.seed); if (o.slot) this.slotInUse = o.slot; return true; });
    ipcMain.handle("sim.pause", (_e, on: boolean) => { this.paused = on; });
    ipcMain.handle("sim.hash", () => stateHash(this.state));
    ipcMain.handle("sim.perf", () => { const s = [...this.tickMs].sort((a, b) => a - b); return { tickP50: s[Math.floor(s.length / 2)] ?? 0, tickP95: s[Math.floor(s.length * 0.95)] ?? 0 }; });
  }

  /** In replay playback nothing is pushed: results are returned to the caller so the renderer applies them in step with its frames. */
  private capture: { ch: string; a: unknown[] }[] | null = null;
  private send(ch: string, ...a: unknown[]) { if (this.capture) { this.capture.push({ ch, a }); return; } const w = this.getWin(); if (w && !w.isDestroyed()) w.webContents.send(ch, ...a); }
  savesDir() { const d = join(app.getPath("userData"), "saves"); mkdirSync(d, { recursive: true }); return d; }

  // ---------- lifecycle ----------
  start(): void { if (this.timer) return; this.timer = setInterval(() => this.step(), bal.time.tickMs); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  newGame(preset: Preset, name: string, seed = (Date.now() % 2147483647) | 0): void {
    this.state = newGame(bal, { seed, facilityName: name || "UPTIME", preset });
    this.resetCaches(); this.send("sim.reset", this.fullWorld());
  }
  private resetCaches() { this.lastRack.clear(); this.lastHeader = ""; this.lastInv = ""; this.openAlerts.clear(); this.claudeFlash.clear(); }

  // ---------- the tick ----------
  private step(): void {
    if (this.paused) return;
    const t0 = performance.now();
    const events: SimEvent[] = [];
    const q = this.queue; this.queue = [];
    for (const item of q) item.resolve(this.apply(item.cmd, events));
    const n = this.state.speed;
    for (let i = 0; i < n; i++) { for (const e of tick(this.state, bal)) events.push(e); if (this.replay) this.replay.tick(this.state.tick); }
    this.tickMs.push(performance.now() - t0); if (this.tickMs.length > 600) this.tickMs.shift();
    if (events.length) this.handleEvents(events);
    if (n > 0 && this.state.tick % ticksPerHour(bal) < n) this.save("autosave");
    this.pushDelta();
  }

  private apply(raw: Record<string, any>, events: SimEvent[]): CmdResult {
    const cmd = { ...raw };
    const s = this.state;
    // host-side conveniences on top of the sim's command set
    if (cmd.type === "queueJob" && cmd.kind === "install" && !cmd.part && cmd.sku) {
      const pid = Object.keys(s.parts).sort().find((id) => s.parts[id].sku === cmd.sku && s.parts[id].where.kind === "shelf" && s.parts[id].status !== "failed");
      if (!pid) return { ok: false, reason: "part_not_available", message: `No ${cmd.sku} is in stock. Order one with shop_order first.` };
      cmd.part = pid;
    }
    delete cmd.sku;
    // install into an occupied slot is a swap: the gantry takes the old part to the shelf first (unless a remove is already queued)
    if (cmd.type === "queueJob" && cmd.kind === "install" && s.servers[cmd.server]?.slots?.[cmd.slot as SlotId] && !s.jobs.some((j) => j.server === cmd.server && j.slot === cmd.slot && j.kind === "remove" && (j.state === "queued" || j.state === "running"))) {
      const r0 = applyCommand(s, bal, { type: "queueJob", kind: "remove", server: cmd.server, slot: cmd.slot, by: cmd.by } as Command);
      if (!r0.ok) return { ok: false, reason: r0.reason, message: r0.message };
    }
    let stow: string | undefined;
    if (cmd.type === "removePart" && cmd.toShelf) { stow = s.servers[cmd.server]?.slots?.[cmd.slot as keyof State["servers"][string]["slots"]]; }
    delete cmd.toShelf;
    let r: Result;
    try { r = applyCommand(s, bal, cmd as Command); } catch (e) { return { ok: false, reason: "invalid", message: String((e as Error).message ?? e).slice(0, 200) }; }
    if (r.ok && stow) applyCommand(s, bal, { type: "stowPart", part: stow, to: "shelf", by: cmd.by } as Command);
    if (r.ok) {
      this.replay?.command(s.tick, cmd);
      const target = (cmd.server ?? cmd.rack ?? cmd.target) as string | undefined;
      if (target) (cmd.by === "claude" ? this.claudeTouched : this.playerTouched).set(String(target).slice(0, 5), Date.now());
      if (cmd.by === "claude" && cmd.server) this.claudeFlash.set(cmd.server, s.tick + 20);
      if (cmd.by === "claude") this.send("mcp.activity", { tool: TOOL_OF[cmd.type] ?? cmd.type, target, ok: true, write: true });
    } else { if (cmd.by !== "director") this.log(`refused ${cmd.type} by ${cmd.by}: ${r.reason}`); if (cmd.by === "claude") this.send("mcp.activity", { tool: TOOL_OF[cmd.type] ?? cmd.type, target: (cmd.server ?? cmd.rack ?? cmd.target) as string | undefined, ok: false, write: true }); }
    return r.ok ? { ok: true, data: r.data } : { ok: false, reason: r.reason, message: r.message };
  }

  private handleEvents(events: SimEvent[]): void {
    for (const e of events) {
      if (e.kind === "milestone") this.onMilestone(String(e.target ?? ""));
      if (e.kind === "alert" || e.kind === "delivery" || e.kind === "job_done" || e.kind === "job_failed" || e.kind === "alert_cleared" || e.kind === "breaker_trip") this.wake(e);
    }
    // "Hands off": an alert Claude touched clears with no player touch on that rack
    const open = new Map<string, string | undefined>();
    for (const a of this.state.alerts) if (!a.cleared && a.severity !== "info") open.set(a.id, a.target);
    for (const [id, target] of this.openAlerts) if (!open.has(id) && target) {
      const key = target.slice(0, 5), c = this.claudeTouched.get(key) ?? 0, p = this.playerTouched.get(key) ?? 0;
      if (c && Date.now() - c < 180000 && p < c - 1000) markMilestone(this.state, "hands_off");
    }
    this.openAlerts = open;
    this.send("sim.events", events.slice(0, 200));
  }

  // ---------- MCP-facing API ----------
  command(cmd: Record<string, any>): Promise<CmdResult> {
    if (this.paused) { const ev: SimEvent[] = []; const r = this.apply(cmd, ev); if (ev.length) this.handleEvents(ev); this.pushDelta(); return Promise.resolve(r); }
    return new Promise((resolve) => this.queue.push({ cmd, resolve }));
  }
  view(name: string, ...args: any[]): any {
    const s = this.state;
    switch (name) {
      case "overview": return { ...(views.overview(s, bal) as object), autonomy: s.settings.autonomy };
      case "alerts": return views.alerts(s, !!args[0], bal);
      case "racks": return views.racks(s, bal, args[0]);
      case "rack": return args[0] ? views.rack(s, bal, args[0]) : null;
      case "server": return args[0] ? views.server(s, bal, args[0]) : null;
      case "inventory": return views.inventory(s, bal);
      case "catalog": return views.catalog(bal, args[0]);
      case "orders": return views.orders(s, bal);
      case "contracts": return views.contracts(s, bal, args[0]);
      case "finance": return views.finance(s, bal, args[0]);
      case "build": return this.buildView();
      case "milestones": return s.milestones;
      case "stock": return s.stock;
      default: return null;
    }
  }
  waitForEvent(kinds: string[] | undefined, timeoutMs: number): Promise<any | null> {
    return new Promise((resolve) => {
      const w: Waiter = { kinds, resolve, timer: setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); resolve(null); }, timeoutMs) };
      this.waiters.push(w);
    });
  }
  private wake(e: SimEvent): void {
    for (const w of [...this.waiters]) if (!w.kinds || w.kinds.includes(e.kind) || w.kinds.includes(String((e.data as any)?.kind ?? ""))) { clearTimeout(w.timer); this.waiters = this.waiters.filter((x) => x !== w); w.resolve({ kind: e.kind, target: e.target, text: e.text, time: gameTime(this.state, bal) }); }
  }
  activity(tool: string, target: string | undefined, ok: boolean): void {
    this.mcpStats.calls++; this.log(`mcp ${tool}${target ? " " + target : ""} ${ok ? "ok" : "refused"}`);      // every MCP call is logged (never the terminal's content)
    if (/^(get_|list_|shop_catalog|wait_for)/.test(tool)) this.send("mcp.activity", { tool, target, ok, write: false });
  }

  private buildView() {
    const s = this.state, f = bal.facility;
    const next = (tiers: { kw: number; price: number }[], cur: number) => tiers.find((t) => t.kw > cur);
    const np = next(f.powerTiers, s.powerCapKw), nc = next(f.coolingTiers, s.coolingCapKw);
    const items: any[] = [
      { kind: "power", label: "Facility power", now: `${s.powerCapKw} kW`, next: np ? `${np.kw} kW` : null, price: np?.price ?? null },
      { kind: "cooling", label: "Facility cooling", now: `${s.coolingCapKw} kW`, next: nc ? `${nc.kw} kW` : null, price: nc?.price ?? null },
      { kind: "hall", target: "B", label: "Hall B", now: s.halls.B.owned ? "owned" : "not built", next: s.halls.B.owned ? null : `${f.halls.B.slots} rack slots`, price: s.halls.B.owned ? null : f.halls.B.price },
      { kind: "hall", target: "C", label: "Hall C", now: s.halls.C.owned ? "owned" : "not built", next: s.halls.C.owned ? null : `${f.halls.C.slots} rack slots`, price: s.halls.C.owned ? null : f.halls.C.price, blocked: s.halls.B.owned ? undefined : "Needs Hall B" },
    ];
    return { items, pduPrice: f.pduUpgradePrice, rearDoorPrice: f.rearDoorPrice };
  }

  // ---------- renderer feed ----------
  private serverLight(id: string): ServerView {
    const s = this.state, sv = s.servers[id];
    let worst = 0; const drives = [0, 0, 0, 0];
    for (const slot of SLOTS) {
      const pid = sv.slots[slot]; if (!pid) continue;
      const st = s.parts[pid].status, n = st === "failed" ? 3 : st === "degraded" ? 2 : 1;
      if (n > worst) worst = n;
      if (slot.startsWith("DRV")) drives[Number(slot[3]) - 1] = n;
    }
    const v: ServerView = { id, bay: sv.bay, power: sv.power, status: worst === 3 ? "failed" : worst === 2 ? "degraded" : "ok", load: Math.round(sv.load * 12) / 12, tempC: Math.round(sv.tempC), out: { cpu: Math.round(sv.out.cpu), gpu: Math.round(sv.out.gpu), tb: Math.round(sv.out.tb) }, watts: Math.round(sv.watts), bottleneck: sv.bottleneck, pulledOut: sv.pulledOut, drives };
    const fl = this.claudeFlash.get(id); if (fl && fl > s.tick) v.claudeUntil = fl;
    return v;
  }
  private serverDetail(id: string): Record<string, PartView | null> | undefined {
    const d = views.server(this.state, bal, id) as any; if (!d) return undefined;
    const out: Record<string, PartView | null> = {};
    for (const row of d.slots) out[row.slot] = row.part ? { ...row.part, family: slotFamily(row.slot), contrib: contribOf(row.part.sku), price: partSpec(bal, row.part.sku)?.price } : null;
    return out;
  }
  private rackView(id: string): RackView {
    const r = this.state.racks[id];
    return { id, hall: r.hall, slot: r.slot, doorOpen: r.doorOpen, breaker: r.breaker, pduCapKw: r.pduCapKw, rearDoor: r.rearDoor, kw: Math.round(r.kw * 10) / 10, servers: r.servers.map((sid) => (sid ? this.serverLight(sid) : null)) };
  }
  private header() {
    const s = this.state, t = s.totals;
    const open = s.alerts.filter((a) => !a.cleared && a.severity !== "info").length;
    return { tick: s.tick, cash: Math.round(s.cash), incomePerHour: Math.round(t.incomePerHour), costPerHour: Math.round(t.costPerHour), reputation: Math.round(s.reputation), power: { usedKw: Math.round(t.kw * bal.rates.overhead * 10) / 10, capKw: s.powerCapKw }, cooling: { heatKw: Math.round(t.heatKw * 10) / 10, capKw: s.coolingCapKw }, time: gameTime(s, bal), speed: this.paused ? 0 : s.speed, facilityName: s.facilityName, halls: { A: hv(s, "A"), B: hv(s, "B"), C: hv(s, "C") }, alertCount: open, milestones: s.milestones, stock: s.stock, shopBlocked: s.shopBlocked, autonomy: s.settings.autonomy };
  }
  private inventory(): InvItem[] {
    const s = this.state, out: InvItem[] = [];
    for (const id of Object.keys(s.parts)) {
      const p = s.parts[id]; if (p.where.kind === "slot" || p.where.kind === "gantry") continue;
      const spec = partSpec(bal, p.sku)!;
      out.push({ id, sku: p.sku, name: spec.name, family: spec.family, tier: spec.tier, health: Math.round(p.health), status: p.status, tempC: 22, watts: spec.watts, contrib: contribOf(p.sku), price: spec.price, where: p.where.kind as InvItem["where"] });
    }
    return out;
  }
  fullWorld(): { world: WorldView; inventory: InvItem[]; extra: any } {
    const s = this.state; const h = this.header();
    const racks = Object.keys(s.racks).sort().map((id) => this.rackView(id));
    for (const r of racks) this.lastRack.set(r.id, JSON.stringify(r));
    if (this.watched && s.servers[this.watched]) attach(racks, this.watched, this.serverDetail(this.watched));
    return { world: { ...h, racks } as WorldView, inventory: this.inventory(), extra: this.extra() };
  }
  private extra() { const s = this.state; return { orders: s.orders.filter((o) => o.state !== "opened").map((o) => ({ id: o.id, state: o.state, lines: o.lines, express: o.express })), jobs: s.jobs.filter((j) => j.state === "queued" || j.state === "running").map((j) => ({ id: j.id, kind: j.kind, server: j.server, slot: j.slot, state: j.state, hall: j.hall, part: j.part, sku: j.part ? s.parts[j.part]?.sku : undefined, doneTick: j.doneTick })), milestones: s.milestones, stock: s.stock }; }
  private lastExtra = "";
  private pushDelta(): void {
    const s = this.state; const header = this.header();
    const changed: RackView[] = []; const seen = new Set<string>();
    for (const id of Object.keys(s.racks)) {
      seen.add(id); const v = this.rackView(id), j = JSON.stringify(v);
      if (this.lastRack.get(id) !== j) { this.lastRack.set(id, j); changed.push(v); }
    }
    const removed = [...this.lastRack.keys()].filter((id) => !seen.has(id)); for (const id of removed) this.lastRack.delete(id);
    const delta: any = { header };
    if (changed.length) delta.racks = changed;
    if (removed.length) delta.removed = removed;
    if (this.watched && s.servers[this.watched]) delta.detail = { id: this.watched, slots: this.serverDetail(this.watched) };
    const inv = this.inventory(), ij = JSON.stringify(inv); if (ij !== this.lastInv) { this.lastInv = ij; delta.inventory = inv; }
    const ex = this.extra(), ej = JSON.stringify(ex); if (ej !== this.lastExtra) { this.lastExtra = ej; delta.extra = ex; }
    this.lastDeltaBytes = JSON.stringify(delta).length;
    this.send("sim.delta", delta);
  }
  lastDeltaBytes = 0;

  // ---------- saves ----------
  private file(slot: string) { return join(this.savesDir(), `${slot}.json`); }
  save(slot: string): boolean {
    if (!SLOT_KEYS.includes(slot as any)) return false;
    try {
      const f = this.file(slot);
      if (slot === "autosave" && existsSync(f)) { const d = this.savesDir(); if (existsSync(join(d, "autosave.1.json"))) renameSync(join(d, "autosave.1.json"), join(d, "autosave.2.json")); renameSync(f, join(d, "autosave.1.json")); }
      writeFileSync(f, packSave(this.state, new Date().toISOString())); return true;
    } catch (e) { this.log(`save failed: ${e}`); return false; }
  }
  load(slot: string): { ok: boolean; error?: string; fallback?: string } {
    const f = this.file(slot);
    try {
      const { state } = unpackSave(readFileSync(f), bal);
      this.state = state; this.slotInUse = slot.startsWith("autosave") ? this.slotInUse : slot; this.resetCaches(); this.send("sim.reset", this.fullWorld()); return { ok: true };
    } catch (e) {
      const q = join(this.savesDir(), "quarantine"); mkdirSync(q, { recursive: true });
      try { if (existsSync(f)) copyFileSync(f, join(q, `${slot}-${Date.now()}.json`)); } catch {}
      this.log(`load ${slot} failed: ${e}`);
      const fb = ["autosave.1", "autosave.2"].find((s) => existsSync(this.file(s)));
      return { ok: false, error: `The save in ${slot} could not be read. A copy was kept in saves/quarantine.`, fallback: fb };
    }
  }
  loadFile(path: string): boolean { try { const { state } = unpackSave(readFileSync(path), bal); this.state = state; this.resetCaches(); this.send("sim.reset", this.fullWorld()); return true; } catch (e) { this.log(`loadFile failed: ${e}`); return false; } }
  listSaves() {
    const d = this.savesDir();
    return [...SLOT_KEYS, "autosave.1", "autosave.2"].map((slot) => {
      const f = join(d, `${slot}.json`); if (!existsSync(f)) return { slot, exists: false };
      try { const { state, savedAt } = unpackSave(readFileSync(f), bal); return { slot, exists: true, savedAt: savedAt ?? statSync(f).mtime.toISOString(), name: state.facilityName, cash: Math.round(state.cash), day: gameTime(state, bal).day }; }
      catch { return { slot, exists: true, corrupt: true }; }
    });
  }
  hasAnySave(): boolean { try { return readdirSync(this.savesDir()).some((f) => f.endsWith(".json")); } catch { return false; } }

  // ---------- replay playback (offline render) ----------
  private rpCmds: { tick: number; cmd: any }[] = []; private rpI = 0;
  loadReplay(dir: string): any {
    const meta = ReplayMeta.parse(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")));
    this.state = deserialize(gunzipSync(readFileSync(join(dir, "state0.json.gz"))).toString("utf8"), bal);
    const nd = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
    this.rpCmds = nd("commands.ndjson").map((l) => ReplayCmd.parse(l)) as { tick: number; cmd: any }[];        // each command is validated again by the command schema when it is applied this.rpI = 0; this.stop(); this.resetCaches();
    this.send("sim.reset", this.fullWorld());
    const pose = existsSync(join(dir, "pose.bin")) ? readPoses(readFileSync(join(dir, "pose.bin")), nd("pose-events.ndjson")) : nd("pose.ndjson");
    if (meta.startHash && meta.startHash !== stateHash(this.state)) throw new Error("replay: the start state does not match the log's hash");
    return { meta, pose: pose.map((x: unknown) => ReplayPose.parse(x)), pty: nd("pty.ndjson").map((x) => ReplayPty.parse(x)), startHash: stateHash(this.state) };
  }
  /** Advance deterministically to an absolute tick, applying logged commands at their ticks. */
  replayAdvance(toTick: number): { hash: string; msgs: { ch: string; a: unknown[] }[] } {
    const events: SimEvent[] = []; this.capture = [];
    while (this.state.tick < toTick) {
      while (this.rpI < this.rpCmds.length && this.rpCmds[this.rpI].tick <= this.state.tick) this.apply(this.rpCmds[this.rpI++].cmd, events);
      for (const e of tick(this.state, bal)) events.push(e);
    }
    if (events.length) this.handleEvents(events);
    this.pushDelta();
    const msgs = this.capture; this.capture = null;
    return { hash: stateHash(this.state), msgs };
  }

  /** Text for the workspace CLAUDE.md: the unit rules from SPEC section 9, with the live numbers. */
  rulesText(): string {
    const b = bal;
    return [
      `- One game hour is ${(b.time.tickMs * b.time.ticksPerGameHour) / 1000} real seconds.`,
      `- A server has 2 CPU, 8 RAM, 4 GPU, 4 drive, 2 PSU, 4 fan and 1 NIC slot.`,
      `- cpuUnits = min(sum of CPU units, RAM GB / ${b.server.cpuRamGbPerUnit}). gpuUnits = min(sum of GPU units, RAM GB / ${b.server.gpuRamGbPerUnit}, CPU units x ${b.server.gpuPerCpuUnit}). Total units are capped at NIC Gbps x ${b.server.unitsPerGbps}.`,
      `- A degraded part counts at ${b.wear.degradedMult * 100}%; a failed part counts as zero. The server card names the bottleneck.`,
      `- Base pay per game hour: $${b.rates.cpu} per compute unit, $${b.rates.gpu} per GPU unit, $${b.rates.tb} per TB. Unsold capacity sells on the spot market at ${b.rates.spotMult * 100}%.`,
      `- Parts throttle above ${b.thermal.throttleC} °C and a server shuts down above ${b.thermal.shutdownC} °C. Heat over the cooling capacity raises hall temperature.`,
      `- Rack PDU cap is ${b.facility.pduBaseKw} kW (${b.facility.pduUpgradedKw} kW upgraded). Going over trips the breaker; reset it with reset_breaker after shedding load.`,
      `- Standard delivery takes ${b.shop.standardHours} game hours; express costs ${Math.round((b.shop.expressMult - 1) * 100)}% more and takes about ${Math.round((b.shop.expressTicks * b.time.tickMs) / 1000)} seconds.`,
      `- Each gantry job costs $${b.gantry.fee} and takes about ${Math.round((b.gantry.jobTicks * b.time.tickMs) / 1000)} seconds. One gantry per hall, first in first out.`,
      `- Autonomy "operate" refuses any single purchase above ${b.money.operateCapPct * 100}% of current cash.`,
    ].join("\n");
  }
}

const CONTRIB: Record<string, (v: number) => string> = { cpu: (v) => `${v} compute units`, gpu: (v) => `${v} GPU units`, ram: (v) => `${v} GB of memory`, drv: (v) => `${v} TB of storage`, psu: (v) => `supplies ${v} W`, fan: (v) => `moves ${v} W of heat`, nic: (v) => `${v} Gbps (up to ${v * bal.server.unitsPerGbps} units out)` };
const contribOf = (sku: string): string => { const sp = partSpec(bal, sku); return sp ? CONTRIB[sp.family](sp.value) : ""; };
function hv(s: State, id: "A" | "B" | "C") { const h = s.halls[id]; return { id, owned: h.owned, airC: Math.round(h.airC * 10) / 10, heatKw: Math.round(h.heatKw * 10) / 10, coolingKw: Math.round(h.coolingKw * 10) / 10 }; }
function attach(racks: RackView[], id: string, slots?: Record<string, PartView | null>) { for (const r of racks) for (const sv of r.servers) if (sv && sv.id === id) sv.slots = slots; }
