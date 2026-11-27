// Shared helpers: seeded rng, the derived (non-serialized) cache, alerts, ledger, ids.
import type { Balance } from "./balance";
import { storeOf } from "./partStore";
import { SLOTS, slotFamily } from "./state";
import type { Alert, AlertKind, Bottleneck, HallId, LedgerDay, Part, PartId, Rack, Server, ServerId, SimEvent, Sku, State } from "./state";

// ---- rng (mulberry32, state kept in state.rngState) ----
export function rnd(state: State): number {
  let t = (state.rngState = (state.rngState + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
export const rndInt = (state: State, lo: number, hi: number): number => lo + Math.floor(rnd(state) * (hi - lo + 1));
export const rndRange = (state: State, lo: number, hi: number): number => lo + rnd(state) * (hi - lo);

// ---- time ----
export function gameTime(state: State, bal: Balance): { day: number; hour: number; minute: number } {
  return timeOfTick(state.tick, bal);
}
export function timeOfTick(tick: number, bal: Balance): { day: number; hour: number; minute: number } {
  const tph = bal.time.ticksPerGameHour;
  const minutes = Math.floor(((bal.time.startHour * tph + tick) * 60) / tph);
  const perDay = bal.time.hoursPerDay * 60;
  return { day: Math.floor(minutes / perDay) + 1, hour: Math.floor((minutes % perDay) / 60), minute: minutes % 60 };
}
/** 0-based game day index of a tick. */
export const dayIndex = (tick: number, bal: Balance): number =>
  Math.floor((bal.time.startHour * bal.time.ticksPerGameHour + tick) / (bal.time.ticksPerGameHour * bal.time.hoursPerDay));

// ---- per-server derived sums ----
export interface Stat {
  dirty: boolean;
  cpu: number; gpu: number; gpuT3: number; ram: number; tb: number; nic: number;   // status-weighted sums
  watts: number; supply: number; supplyMinusMax: number; psuCount: number; fanCap: number;
  hasCpu: boolean; hasGpu: boolean;
  outKey: number; gpuT3Out: number; gpuInfOut: number;
}
export interface Cache {
  listsDirty: boolean;
  servers: Server[]; stats: Stat[]; rackOf: Rack[]; racks: Rack[];
  statById: Map<ServerId, Stat>;
  pending: SimEvent[];     // events produced by commands, returned by the next tick()
}
const caches = new WeakMap<State, Cache>();
export function getCache(state: State): Cache {
  let c = caches.get(state);
  if (!c) { c = { listsDirty: true, servers: [], stats: [], rackOf: [], racks: [], statById: new Map(), pending: [] }; caches.set(state, c); }
  return c;
}
function newStat(): Stat {
  return { dirty: true, cpu: 0, gpu: 0, gpuT3: 0, ram: 0, tb: 0, nic: 0, watts: 0, supply: 0, supplyMinusMax: 0, psuCount: 0, fanCap: 0,
    hasCpu: false, hasGpu: false, outKey: -1, gpuT3Out: 0, gpuInfOut: 0 };
}
export function rebuildLists(state: State, cache: Cache): void {
  const ids = Object.keys(state.servers).sort();
  cache.servers = ids.map((id) => state.servers[id]);
  cache.stats = ids.map((id) => { let st = cache.statById.get(id); if (!st) { st = newStat(); cache.statById.set(id, st); } return st; });
  cache.rackOf = cache.servers.map((s) => state.racks[s.rack]);
  cache.racks = Object.keys(state.racks).sort().map((id) => state.racks[id]);
  cache.listsDirty = false;
}
export function markDirty(state: State, server: ServerId): void {
  const c = getCache(state);
  const st = c.statById.get(server);
  if (st) st.dirty = true;
}
export function statusMult(bal: Balance, status: Part["status"]): number {
  return status === "ok" ? 1 : status === "degraded" ? bal.wear.degradedMult : 0;
}
/** Sums the parts of one server. `parts` is a list of (sku, status) pairs in any order. */
export function sumParts(bal: Balance, st: Stat, parts: Iterable<{ sku: Sku; status: Part["status"] }>): void {
  st.cpu = st.gpu = st.gpuT3 = st.ram = st.tb = st.nic = st.watts = st.supply = st.fanCap = 0;
  st.psuCount = 0; st.hasCpu = st.hasGpu = false;
  let maxPsu = 0;
  for (const p of parts) {
    const m = statusMult(bal, p.status);
    if (m === 0) continue;                       // a failed part draws nothing and gives nothing
    const spec = bal.catalogue[p.sku];
    st.watts += spec.watts;
    const v = spec.value * m;
    switch (spec.family) {
      case "cpu": st.cpu += v; st.hasCpu = true; break;
      case "gpu": st.gpu += v; st.hasGpu = true; if (spec.tier >= bal.contracts.trainingMinGpuTier) st.gpuT3 += v; break;
      case "ram": st.ram += v; break;
      case "drv": st.tb += v; break;
      case "nic": st.nic += v; break;
      case "fan": st.fanCap += v; break;
      case "psu": st.supply += v; st.psuCount++; if (v > maxPsu) maxPsu = v; break;
    }
  }
  st.supplyMinusMax = st.supply - maxPsu;
  st.dirty = false; st.outKey = -1;
}
export function fillStat(state: State, bal: Balance, s: Server, st: Stat): void {
  const list: Part[] = [];
  for (const slot of SLOTS) { const pid = s.slots[slot]; if (pid !== undefined) list.push(state.parts[pid]); }
  sumParts(bal, st, list);
}
export interface Output { cpu: number; gpu: number; tb: number; gpuT3: number; bottleneck: Bottleneck }
/** SPEC section 9 "What a server delivers". */
export function computeOutput(bal: Balance, st: Stat, cpuThrottled: boolean, gpuThrottled: boolean): Output {
  const S = bal.server, tm = bal.thermal.throttleMult;
  const c = st.cpu * (cpuThrottled ? tm : 1);
  const g = st.gpu * (gpuThrottled ? tm : 1);
  let cpu = Math.min(c, st.ram / S.cpuRamGbPerUnit);
  let gpu = Math.min(g, st.ram / S.gpuRamGbPerUnit, c * S.gpuPerCpuUnit);
  let bottleneck: Bottleneck = "none";
  if (g > 0 && c * S.gpuPerCpuUnit < g) bottleneck = "cpu";
  if (st.ram / S.cpuRamGbPerUnit < c || (g > 0 && st.ram / S.gpuRamGbPerUnit < Math.min(g, c * S.gpuPerCpuUnit))) bottleneck = "ram";
  const cap = st.nic * S.unitsPerGbps, total = cpu + gpu;
  if (total > cap) { const f = total > 0 ? cap / total : 0; cpu *= f; gpu *= f; bottleneck = "nic"; }
  if (cpuThrottled || gpuThrottled) bottleneck = "thermal";
  return { cpu, gpu, tb: st.tb, gpuT3: g > 0 ? gpu * (st.gpuT3 / st.gpu) : 0, bottleneck };
}
/** Pure helper for planners: what a parts list would deliver and draw at full load, cool. */
export function evalParts(bal: Balance, skus: Sku[]): { out: Output; watts: number; supply: number; fanCap: number; redundant: boolean; boots: boolean; tempRiseC: number } {
  const st = newStat();
  sumParts(bal, st, skus.map((sku) => ({ sku, status: "ok" as const })));
  return { out: computeOutput(bal, st, false, false), watts: st.watts, supply: st.supply, fanCap: st.fanCap,
    redundant: st.psuCount >= 2 && st.supplyMinusMax >= st.watts, boots: st.supply > 0 && st.supply >= st.watts,
    tempRiseC: st.fanCap > 0 ? (bal.thermal.serverK * st.watts) / st.fanCap : Infinity };
}

// ---- ids ----
const pad = (n: number, w: number): string => String(n).padStart(w, "0");
export const nextPartId = (state: State): PartId => `p_${pad(++state.ids.part, 6)}`;
export const nextId = (state: State, kind: "order" | "job" | "contract" | "alert"): string =>
  `${kind[0]}_${pad(++state.ids[kind], 5)}`;
export const rackId = (hall: HallId, slot: number): string => `${hall}-R${pad(slot + 1, 2)}`;
export const serverId = (rack: string, bay: number): ServerId => `${rack}-S${pad(bay, 2)}`;
export function createPart(state: State, sku: Sku, where: Part["where"], tempC = 22): Part {
  const p = storeOf(state).add({ id: nextPartId(state), sku, health: 100, status: "ok", tempC, where });
  state.parts[p.id] = p;
  return p;
}

// ---- alerts ----
const MAX_ALERTS = 200;
export function raise(state: State, ev: SimEvent[], kind: AlertKind, severity: Alert["severity"], target: string | undefined, text: string): Alert {
  const a: Alert = { id: nextId(state, "alert"), tick: state.tick, severity, kind, text, cleared: false };
  if (target !== undefined) a.target = target;
  state.alerts.push(a);
  if (state.alerts.length > MAX_ALERTS) {
    const i = state.alerts.findIndex((x) => x.cleared);
    state.alerts.splice(i >= 0 ? i : 0, 1);
  }
  ev.push({ kind: "alert", target, text, data: a });
  return a;
}
export function clearAlerts(state: State, ev: SimEvent[], kinds: AlertKind[], target?: string): void {
  for (const a of state.alerts) {
    if (a.cleared || !kinds.includes(a.kind) || (target !== undefined && a.target !== target)) continue;
    a.cleared = true;
    ev.push({ kind: "alert_cleared", target: a.target, data: { id: a.id, kind: a.kind } });
  }
}

// ---- money ----
export function today(state: State): LedgerDay { return state.ledger[state.ledger.length - 1]; }
export function newLedgerDay(day: number): LedgerDay {
  return { day, income: { spot: 0, contracts: 0, sales: 0 }, costs: { power: 0, rent: 0, parts: 0, gantry: 0, penalties: 0, interest: 0, upgrades: 0 } };
}
/** Applies the debt floor and the shop block (SPEC Appendix A "Money trouble"). Call after any cash change. */
export function settleCash(state: State, bal: Balance): void {
  if (state.cash <= bal.money.debtFloor) { state.cash = bal.money.debtFloor; state.shopBlocked = true; }
  else if (state.cash > 0) state.shopBlocked = false;
}
export const canSpend = (state: State, bal: Balance, cost: number): boolean =>
  !state.shopBlocked && state.cash - cost >= bal.money.debtFloor;
export function addMilestone(state: State, ev: SimEvent[], id: string): boolean {
  if (state.milestones.includes(id)) return false;
  state.milestones.push(id);
  ev.push({ kind: "milestone", target: id, text: `Milestone reached: ${id.replace(/_/g, " ")}` });
  return true;
}
export const partTempOffset = (bal: Balance, sku: Sku): number => {
  const f = bal.catalogue[sku].family;
  return f === "cpu" ? bal.thermal.cpuOffsetC : f === "gpu" ? bal.thermal.gpuOffsetC : 0;
};
export { slotFamily };
