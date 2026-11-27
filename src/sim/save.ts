// Save format: zod-validated, versioned, migrated (SPEC section 9 "Saves", Appendix H). Browser-safe; gzip lives in saveNode.ts.
import { z } from "zod";
import { storeOf } from "./partStore";
import type { Balance } from "./balance";
import { getCache } from "./core";
import { SLOTS } from "./state";
import type { Part, Server, State } from "./state";
import { SAVE_VERSION } from "./version";

const n = z.number().finite();
const int = z.number().int();
const Slot = z.enum(SLOTS);
const Where = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("slot"), server: z.string(), slot: Slot }),
  z.object({ kind: z.literal("shelf") }), z.object({ kind: z.literal("cart") }), z.object({ kind: z.literal("hand") }),
  z.object({ kind: z.literal("crate"), order: z.string() }), z.object({ kind: z.literal("gantry"), job: z.string() }),
]);
const PartSchema = z.object({ id: z.string(), sku: z.string(), health: n.min(0).max(100), status: z.enum(["ok", "degraded", "failed"]),
  failsAtTick: int.optional(), tempC: n, where: Where });
const Out = z.object({ cpu: n, gpu: n, tb: n });
const ServerSchema = z.object({
  id: z.string(), power: z.enum(["off", "booting", "on", "shutdown_thermal", "no_power"]), bootDoneTick: int.optional(),
  load: n, tempC: n, out: Out, watts: n, bottleneck: z.enum(["none", "ram", "cpu", "nic", "thermal", "psu"]),
  redundantPsu: z.boolean(), pulledOut: z.boolean(), rack: z.string(), bay: int,
  slots: z.partialRecord(Slot, z.string()), wantOn: z.boolean(), thermalAlert: z.union([z.literal(0), z.literal(1), z.literal(2)]),
});
const HallIdSchema = z.enum(["A", "B", "C"]);
const RackSchema = z.object({
  id: z.string(), hall: HallIdSchema, slot: int, servers: z.array(z.string().nullable()),
  pduCapKw: z.union([z.literal(15), z.literal(30)]), rearDoor: z.boolean(), breaker: z.enum(["closed", "tripped"]), doorOpen: z.boolean(),
  seq: int, kw: n, overheatUntilTick: int,
});
const HallSchema = z.object({ id: HallIdSchema, owned: z.boolean(), airC: n, heatKw: n, coolingKw: n,
  gantry: z.object({ busyUntilTick: int, queue: z.array(z.string()), running: z.string().optional() }) });
const ContractSchema = z.object({
  id: z.string(), type: z.enum(["web", "render", "archive", "training", "inference"]), unit: z.enum(["cpu", "gpu", "tb"]),
  demand: n, rate: n, slaPct: n, startTick: int, endTick: int, penaltyPerDay: n, deliveredToday: n, demandedToday: n,
  state: z.enum(["offer", "active", "done", "breached"]), days: int, breachedDays: int, breachStreak: int, atRisk: z.boolean(),
  cancelled: z.boolean().optional(),
});
const OrderSchema = z.object({ id: z.string(), lines: z.array(z.object({ sku: z.string(), qty: int })), express: z.boolean(), cost: n,
  arrivesTick: int, state: z.enum(["transit", "delivered", "opened"]) });
const JobSchema = z.object({ id: z.string(), kind: z.enum(["install", "remove"]), server: z.string(), slot: Slot, part: z.string().optional(),
  by: z.enum(["player", "claude", "director"]), state: z.enum(["queued", "running", "done", "failed"]), reason: z.string().optional(),
  hall: HallIdSchema, fee: n, doneTick: int.optional() });
const AlertSchema = z.object({ id: z.string(), tick: int, severity: z.enum(["info", "warn", "critical"]),
  kind: z.enum(["part_degraded", "part_failed", "thermal", "breaker", "power_cap", "sla_risk", "sla_breach", "delivery", "job_done", "job_failed"]),
  target: z.string().optional(), text: z.string(), cleared: z.boolean() });
const LedgerSchema = z.object({ day: int,
  income: z.object({ spot: n, contracts: n, sales: n }),
  costs: z.object({ power: n, rent: n, parts: n, gantry: n, penalties: n, interest: n, upgrades: n }) });
export const StateSchema = z.object({
  version: z.literal(SAVE_VERSION), seed: int, tick: int.nonnegative(), facilityName: z.string(),
  cash: n, reputation: n.min(0).max(100), speed: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(4)]),
  powerCapKw: n, coolingCapKw: n,
  halls: z.object({ A: HallSchema, B: HallSchema, C: HallSchema }),
  racks: z.record(z.string(), RackSchema), servers: z.record(z.string(), ServerSchema), parts: z.record(z.string(), PartSchema),
  contracts: z.array(ContractSchema), orders: z.array(OrderSchema), jobs: z.array(JobSchema),
  alerts: z.array(AlertSchema), milestones: z.array(z.string()), ledger: z.array(LedgerSchema).min(1),
  settings: z.object({ autonomy: z.enum(["advise", "operate", "full"]), demo: z.boolean() }),
  rngState: int, ids: z.object({ part: int, order: int, job: int, contract: int, alert: int, rack: int }),
  stock: z.object({ racks: int.nonnegative(), chassis: int.nonnegative(), cart: z.boolean() }),
  degrading: z.array(z.string()),
  totals: z.object({ cpu: n, gpu: n, tb: n, gpuTrain: n, gpuInf: n, sold: Out, kw: n, heatKw: n, incomePerHour: n, costPerHour: n }),
  shopBlocked: z.boolean(), powerWarn: z.boolean(), repGainToday: n,
});

type Raw = Record<string, any>;
/** migrations[v] turns a version-v save into version v+1. */
const migrations: Record<number, (s: Raw) => void> = {
  // v1 had no stock counters, no demo flag, no degrading list, no wantOn / thermalAlert on servers and no rack overheat timer.
  1: (s) => {
    s.stock ??= { racks: 0, chassis: 0, cart: false };
    s.settings = { autonomy: s.settings?.autonomy ?? "operate", demo: false };
    s.degrading = Object.values<Raw>(s.parts ?? {}).filter((p) => p.status === "degraded" && p.failsAtTick !== undefined).map((p) => p.id).sort();
    for (const sv of Object.values<Raw>(s.servers ?? {})) { sv.wantOn ??= sv.power === "on" || sv.power === "booting" || sv.power === "no_power"; sv.thermalAlert ??= sv.power === "shutdown_thermal" ? 2 : 0; }
    for (const r of Object.values<Raw>(s.racks ?? {})) r.overheatUntilTick ??= 0;
    for (const d of s.ledger ?? []) { d.income.sales ??= 0; d.costs.upgrades ??= 0; }
    s.version = 2;
  },
};

export function serialize(state: State): string { return JSON.stringify(state); }

/** Parses a save (bare state, or the `{ version, savedAt, state }` file wrapper), migrates it and validates it. Throws when it is bad. */
export function deserialize(json: string, bal: Balance): State {
  let raw: Raw = JSON.parse(json);
  if (raw && typeof raw === "object" && raw.state && typeof raw.state === "object") raw = raw.state;
  if (!raw || typeof raw !== "object" || typeof raw.version !== "number") throw new Error("save: not a save file");
  if (raw.version > SAVE_VERSION) throw new Error(`save: version ${raw.version} is newer than this build (${SAVE_VERSION})`);
  while (raw.version < SAVE_VERSION) {
    const m = migrations[raw.version];
    if (!m) throw new Error(`save: no migration from version ${raw.version}`);
    m(raw);
  }
  const state: State = StateSchema.parse(raw);
  // cross-reference checks zod cannot express
  for (const id in state.parts) {
    const p = state.parts[id];
    if (p.id !== id) throw new Error(`save: part ${id} has the wrong id`);
    if (!Object.prototype.hasOwnProperty.call(bal.catalogue, p.sku)) throw new Error(`save: part ${id} has unknown sku ${p.sku}`);
    if (p.where.kind === "slot" && state.servers[p.where.server]?.slots[p.where.slot] !== id) throw new Error(`save: part ${id} is not in the slot it claims`);
  }
  for (const id in state.servers) {
    const s = state.servers[id];
    if (!state.racks[s.rack] || state.racks[s.rack].servers[s.bay - 1] !== id) throw new Error(`save: server ${id} is not in its rack`);
    for (const slot of SLOTS) {
      const pid = s.slots[slot];
      if (pid === undefined) continue;
      const w = state.parts[pid]?.where;
      if (!w || w.kind !== "slot" || w.server !== id || w.slot !== slot) throw new Error(`save: ${id}/${slot} points at a part that is elsewhere`);
    }
  }
  storeOf(state);          // move the parsed parts into the typed-array store
  getCache(state).listsDirty = true;
  return state;
}

function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (typeof (v as { toJSON?: unknown }).toJSON === "function") return canonical((v as { toJSON: () => unknown }).toJSON());
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
}
/** Deterministic hash of the full state (key order does not matter). 16 hex characters. */
export function stateHash(state: State): string {
  const s = canonical(state);
  let a = 0x811c9dc5, b = 0x9747b28c;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    a = Math.imul(a ^ ch, 0x01000193);
    b = Math.imul(b ^ ch, 0x5bd1e995); b ^= b >>> 15;
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

// ---- compact snapshot (G18: a full snapshot of the mega save under 2 MB) ----
const STATUS = ["ok", "degraded", "failed"] as const;
const LOC = ["shelf", "cart", "hand", "crate", "gantry"] as const;
export interface PackedSnapshot {
  packed: 1; rest: Omit<State, "parts" | "servers">; servers: Omit<Server, "slots">[]; skus: string[];
  parts: { id: number[]; sku: number[]; health: number[]; status: number[]; temp: number[]; loc: number[];
    ref: Record<string, string>; fails: Record<string, number> };
}
/** Encodes the state with parts as column arrays. Exact: unpackSnapshot(packSnapshot(s)) hashes the same as s. */
export function packSnapshot(state: State): PackedSnapshot {
  const { parts, servers, ...rest } = state;
  const serverIds = Object.keys(servers);
  const sIdx = new Map(serverIds.map((id, i) => [id, i]));
  const slotIdx = new Map<string, number>(SLOTS.map((s, i) => [s, i]));
  const skus: string[] = [], skuIdx = new Map<string, number>();
  const out: PackedSnapshot["parts"] = { id: [], sku: [], health: [], status: [], temp: [], loc: [], ref: {}, fails: {} };
  let i = 0;
  for (const pid in parts) {
    const p = parts[pid];
    let k = skuIdx.get(p.sku);
    if (k === undefined) { k = skus.length; skus.push(p.sku); skuIdx.set(p.sku, k); }
    out.id.push(Number(pid.slice(2))); out.sku.push(k); out.health.push(p.health); out.status.push(STATUS.indexOf(p.status)); out.temp.push(p.tempC);
    const w = p.where;
    if (w.kind === "slot") out.loc.push(sIdx.get(w.server)! * 32 + slotIdx.get(w.slot)!);
    else { out.loc.push(-1 - LOC.indexOf(w.kind)); if (w.kind === "crate") out.ref[i] = w.order; else if (w.kind === "gantry") out.ref[i] = w.job; }
    if (p.failsAtTick !== undefined) out.fails[i] = p.failsAtTick;
    i++;
  }
  return { packed: 1, rest, servers: serverIds.map((id) => { const { slots: _slots, ...s } = servers[id]; return s; }), skus, parts: out };
}
export function unpackSnapshot(snap: PackedSnapshot): State {
  const servers: Record<string, Server> = {};
  for (const s of snap.servers) servers[s.id] = { ...s, slots: {} };
  const parts: Record<string, Part> = {};
  const c = snap.parts;
  for (let i = 0; i < c.id.length; i++) {
    const id = `p_${String(c.id[i]).padStart(6, "0")}`;
    const loc = c.loc[i];
    let where: Part["where"];
    if (loc >= 0) {
      const s = snap.servers[Math.floor(loc / 32)], slot = SLOTS[loc % 32];
      where = { kind: "slot", server: s.id, slot };
      servers[s.id].slots[slot] = id;
    } else {
      const kind = LOC[-1 - loc];
      where = kind === "crate" ? { kind, order: c.ref[i] } : kind === "gantry" ? { kind, job: c.ref[i] } : { kind };
    }
    const p: Part = { id, sku: snap.skus[c.sku[i]], health: c.health[i], status: STATUS[c.status[i]], tempC: c.temp[i], where };
    if (c.fails[i] !== undefined) p.failsAtTick = c.fails[i];
    parts[id] = p;
  }
  const state = { ...structuredClone(snap.rest), servers, parts } as State;
  storeOf(state);
  return state;
}
