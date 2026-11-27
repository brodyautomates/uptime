// Command bus (SPEC Appendix D). Every state change goes through applyCommand; every command is zod-validated.
import { z } from "zod";
import type { Balance } from "./balance";
import { partSpec, ticksPerDay } from "./balance";
import {
  addMilestone, canSpend, clearAlerts, createPart, getCache, nextId, rackId, rndInt, serverId, settleCash, timeOfTick, today,
} from "./core";
import { checkInstall, checkRemove, doInstall, doRemove, freshStat, isRunning, partAvailable, refuse } from "./ops";
import type { Refusal } from "./ops";
import { HALLS, SLOTS, slotFamily } from "./state";
import type { HallId, Job, Order, Part, Rack, Server, SimEvent, SlotId, State } from "./state";
import { contractDayValue, degradePart, tick } from "./tick";

const By = z.enum(["player", "claude", "director"]);
const Slot = z.enum(SLOTS);
const Hall = z.enum(["A", "B", "C"]);
const id = z.string().min(1).max(40);
const cmd = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) => z.object({ by: By, type: z.literal(type), ...shape });
export const CommandSchema = z.discriminatedUnion("type", [
  cmd("setServerPower", { server: id, on: z.boolean() }),
  cmd("setRackDoor", { rack: id, open: z.boolean() }),
  cmd("pullServer", { server: id }),
  cmd("pushServer", { server: id }),
  cmd("removePart", { server: id, slot: Slot }),
  cmd("installPart", { server: id, slot: Slot, part: id }),
  cmd("stowPart", { part: id, to: z.enum(["hand", "cart", "shelf"]) }),
  cmd("queueJob", { kind: z.enum(["install", "remove"]), server: id, slot: Slot, part: id.optional() }),
  cmd("cancelJob", { job: id }),
  cmd("resetBreaker", { rack: id }),
  cmd("placeOrder", { lines: z.array(z.object({ sku: id, qty: z.number().int().min(1).max(1000) })).min(1).max(50), express: z.boolean().optional() }),
  cmd("openCrate", { order: id }),
  cmd("placeRack", { hall: Hall, slot: z.number().int().min(0).max(63) }),
  cmd("placeChassis", { rack: id, bay: z.number().int().min(1).max(64) }),
  cmd("sellPart", { part: id }),
  cmd("acceptContract", { contract: id }),
  cmd("cancelContract", { contract: id }),
  cmd("buyUpgrade", { kind: z.enum(["power", "cooling", "pdu", "rear_door", "hall"]), target: id.optional() }),
  cmd("setSpeed", { speed: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(4)]), seated: z.boolean().optional() }),
  cmd("setAutonomy", { level: z.enum(["advise", "operate", "full"]) }),
  cmd("setDemoMode", { on: z.boolean() }),
  cmd("director.overheatRack", { rack: id }),
  cmd("director.failPart", { rack: id, family: z.enum(["cpu", "gpu", "ram", "drv", "psu", "fan", "nic"]).optional() }),
  cmd("director.deliverAll", {}),
  cmd("director.addCash", { amount: z.number().finite().min(-1e9).max(1e9) }),
  cmd("director.skipDay", {}),
]);
export type Command = z.infer<typeof CommandSchema>;
export type CommandType = Command["type"];
export type Result = { ok: true; data?: unknown } | { ok: false; reason: string; message: string };
/** Every refusal code a command can return. The first block is SPEC Appendix D; the last line is added by this build. */
export const REASONS = [
  "no_psu_capacity", "breaker_tripped", "already", "door_closed", "gantry_busy_here", "empty_slot", "needs_power_off",
  "psu_not_redundant", "hands_full", "slot_full", "wrong_type", "part_not_available", "no_cash", "already_running",
  "not_tripped", "over_autonomy_cap", "advise_only", "unknown_sku", "not_delivered", "slot_taken", "hall_not_owned",
  "no_rack_in_hand", "bay_taken", "no_chassis_in_hand", "installed", "not_owned", "reputation_too_low", "too_many_active",
  "expired", "not_active", "already_max", "needs_hall_b", "not_seated",
  "invalid", "not_found", "player_only", "director_only", "demo_off",
] as const;

const ok = (data?: unknown): Result => (data === undefined ? { ok: true } : { ok: true, data });
const no = (r: Refusal): Result => ({ ok: false, reason: r.reason, message: r.message });
const money = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;
const noCash = (state: State, cost: number, what: string): Refusal =>
  state.shopBlocked
    ? refuse("no_cash", `The shop is blocked while the facility is at its debt limit. Get cash above $0 first (${what} costs ${money(cost)}).`)
    : refuse("no_cash", `${what} costs ${money(cost)} and there is only ${money(state.cash)}.`);
const overCap = (state: State, bal: Balance, cost: number): Refusal =>
  refuse("over_autonomy_cap", `That costs ${money(cost)}, more than ${Math.round(bal.money.operateCapPct * 100)}% of current cash (${money(state.cash)}). The player has to approve it or raise autonomy to Full.`);
const capExceeded = (state: State, bal: Balance, c: Command, cost: number): boolean =>
  c.by === "claude" && state.settings.autonomy === "operate" && cost > Math.max(0, state.cash) * bal.money.operateCapPct;

function pendingOccupied(state: State, s: Server, slot: SlotId): boolean {
  let occ = s.slots[slot] !== undefined;
  for (const j of state.jobs) {
    if ((j.state !== "queued" && j.state !== "running") || j.server !== s.id || j.slot !== slot) continue;
    occ = j.kind === "install";
  }
  return occ;
}
function handAndCart(state: State): { hand: number; cart: number } {
  let hand = 0, cart = 0;
  for (const pid in state.parts) { const k = state.parts[pid].where.kind; if (k === "hand") hand++; else if (k === "cart") cart++; }
  return { hand, cart };
}
const hallOfServer = (state: State, s: Server): HallId => state.racks[s.rack].hall;
const gantryBusyOn = (state: State, s: Server): boolean => {
  const g = state.halls[hallOfServer(state, s)].gantry;
  return g.running !== undefined && state.jobs.some((j) => j.id === g.running && j.server === s.id);
};
export function newRack(state: State, hall: HallId, slot: number): Rack {
  const r: Rack = { id: rackId(hall, slot), hall, slot, servers: [], pduCapKw: 15, rearDoor: false, breaker: "closed", doorOpen: false,
    seq: ++state.ids.rack, kw: 0, overheatUntilTick: 0 };
  state.racks[r.id] = r;
  getCache(state).listsDirty = true;
  return r;
}
export function newServer(state: State, bal: Balance, rack: Rack, bay: number): Server {
  while (rack.servers.length < bal.facility.baysPerRack) rack.servers.push(null);
  const s: Server = { id: serverId(rack.id, bay), power: "off", load: 0, tempC: state.halls[rack.hall].airC, out: { cpu: 0, gpu: 0, tb: 0 }, watts: 0,
    bottleneck: "none", redundantPsu: false, pulledOut: false, rack: rack.id, bay, slots: {}, wantOn: false, thermalAlert: 0 };
  state.servers[s.id] = s;
  rack.servers[bay - 1] = s.id;
  getCache(state).listsDirty = true;
  return s;
}

/** Applies one command now and mutates state. A refused command changes nothing. */
export function applyCommand(state: State, bal: Balance, input: Command): Result {
  const parsed = CommandSchema.safeParse(input);
  if (!parsed.success) return no(refuse("invalid", `That command is not valid: ${parsed.error.issues[0]?.path.join(".") || "command"} ${parsed.error.issues[0]?.message ?? ""}`.trim() + "."));
  const c = parsed.data;
  const ev: SimEvent[] = getCache(state).pending;
  if (c.type.startsWith("director.")) {
    if (c.by !== "director") return no(refuse("director_only", "Only the demo director can use that command."));
    if (!state.settings.demo) return no(refuse("demo_off", "Director commands only work while demo mode is on."));
  } else if (c.by === "claude") {
    if (state.settings.autonomy === "advise") return no(refuse("advise_only", "Autonomy is set to Advise, so Claude can read but not change anything. The player can change this in the ops app."));
    if (c.type === "setAutonomy" || c.type === "setDemoMode") return no(refuse("player_only", "Only the player can change that setting."));
  } else if (c.by === "director" && (c.type === "setAutonomy" || c.type === "setDemoMode")) {
    return no(refuse("player_only", "Only the player can change that setting."));
  }
  const server = (sid: string): Server | undefined => (Object.prototype.hasOwnProperty.call(state.servers, sid) ? state.servers[sid] : undefined);
  const rack = (rid: string): Rack | undefined => (Object.prototype.hasOwnProperty.call(state.racks, rid) ? state.racks[rid] : undefined);
  const part = (pid: string): Part | undefined => (Object.prototype.hasOwnProperty.call(state.parts, pid) ? state.parts[pid] : undefined);
  const noServer = (sid: string): Result => no(refuse("not_found", `There is no server called ${sid}.`));
  const noRack = (rid: string): Result => no(refuse("not_found", `There is no rack called ${rid}.`));
  const spend = (cost: number, bucket: "parts" | "gantry" | "upgrades" | "penalties"): void => {
    state.cash -= cost; today(state).costs[bucket] += cost; settleCash(state, bal);
  };

  switch (c.type) {
    case "setServerPower": {
      const s = server(c.server); if (!s) return noServer(c.server);
      if (!c.on) {
        if (s.power === "off") return no(refuse("already", `${s.id} is already off.`));
        s.power = "off"; s.wantOn = false; delete s.bootDoneTick; s.load = 0; s.watts = 0;
        ev.push({ kind: "server_power", target: s.id, data: { power: "off", by: c.by } });
        return ok({ power: s.power });
      }
      if (s.power === "on" || s.power === "booting") return no(refuse("already", `${s.id} is already ${s.power === "on" ? "on" : "booting"}.`));
      if (state.racks[s.rack].breaker === "tripped") return no(refuse("breaker_tripped", `The breaker on rack ${s.rack} is tripped. Reset it first.`));
      const st = freshStat(state, bal, s);
      if (!(st.supply > 0 && st.supply >= st.watts))
        return no(refuse("no_psu_capacity", `${s.id} needs ${Math.round(st.watts)} W but its working power supplies give ${Math.round(st.supply)} W.`));
      s.power = "booting"; s.wantOn = true; s.bootDoneTick = state.tick + bal.time.bootTicks;
      ev.push({ kind: "server_power", target: s.id, data: { power: "booting", by: c.by } });
      return ok({ power: s.power });
    }
    case "setRackDoor": {
      const r = rack(c.rack); if (!r) return noRack(c.rack);
      if (r.doorOpen === c.open) return no(refuse("already", `The door on ${r.id} is already ${c.open ? "open" : "closed"}.`));
      r.doorOpen = c.open;
      ev.push({ kind: "rack_door", target: r.id, data: { open: c.open } });
      return ok();
    }
    case "pullServer": case "pushServer": {
      const s = server(c.server); if (!s) return noServer(c.server);
      const pull = c.type === "pullServer";
      if (s.pulledOut === pull) return no(refuse("already", `${s.id} is already ${pull ? "pulled out" : "pushed in"}.`));
      if (!state.racks[s.rack].doorOpen) return no(refuse("door_closed", `Open the door on rack ${s.rack} first.`));
      if (gantryBusyOn(state, s)) return no(refuse("gantry_busy_here", `The gantry is working on ${s.id}. Wait for it to finish.`));
      s.pulledOut = pull;
      ev.push({ kind: "server_pull", target: s.id, data: { pulledOut: pull } });
      return ok();
    }
    case "removePart": {
      const s = server(c.server); if (!s) return noServer(c.server);
      const bad = checkRemove(state, bal, s, c.slot); if (bad) return no(bad);
      let dest: Part["where"] = { kind: "shelf" };
      if (c.by === "player") {
        const hc = handAndCart(state);
        if (hc.hand === 0) dest = { kind: "hand" };
        else if (state.stock.cart && hc.cart < bal.shop.cartCapacity) dest = { kind: "cart" };
        else return no(refuse("hands_full", state.stock.cart ? "Your hands and the cart are full. Put something on the shelf first." : "You are already holding a part. Put it down first, or buy a hand cart."));
      }
      const p = doRemove(state, ev, s, c.slot, dest);
      return ok({ part: p.id, where: dest.kind });
    }
    case "installPart": {
      const s = server(c.server); if (!s) return noServer(c.server);
      const p = part(c.part);
      if (!partAvailable(state, p)) return no(refuse("part_not_available", `Part ${c.part} is not in hand, on the cart, on the shelf or in a delivered crate.`));
      const bad = checkInstall(bal, s, c.slot, p, s.slots[c.slot] !== undefined); if (bad) return no(bad);
      doInstall(state, bal, ev, s, c.slot, p);
      return ok();
    }
    case "stowPart": {
      const p = part(c.part);
      if (!partAvailable(state, p)) return no(refuse("part_not_available", `Part ${c.part} is not in hand, on the cart, on the shelf or in a delivered crate.`));
      if (p.where.kind === c.to) return no(refuse("already", `Part ${p.id} is already there.`));
      const hc = handAndCart(state);
      if (c.to === "hand" && hc.hand > 0) return no(refuse("hands_full", "You are already holding a part."));
      if (c.to === "cart" && (!state.stock.cart || hc.cart >= bal.shop.cartCapacity)) return no(refuse("hands_full", state.stock.cart ? "The cart is full." : "There is no hand cart yet."));
      p.where = { kind: c.to };
      return ok();
    }
    case "queueJob": {
      const s = server(c.server); if (!s) return noServer(c.server);
      const occupied = pendingOccupied(state, s, c.slot);
      let p: Part | undefined;
      if (c.kind === "install") {
        p = c.part !== undefined ? part(c.part) : undefined;
        if (!partAvailable(state, p)) return no(refuse("part_not_available", c.part ? `Part ${c.part} is not on the shelf or in a delivered crate.` : "An install job needs a part."));
        if (bal.catalogue[p.sku].family !== slotFamily(c.slot)) return no(refuse("wrong_type", `${bal.catalogue[p.sku].name} does not fit slot ${c.slot}.`));
        if (occupied) return no(refuse("slot_full", `Slot ${c.slot} on ${s.id} already holds a part. Queue a remove job first.`));
      } else if (!occupied) return no(refuse("empty_slot", `Slot ${c.slot} on ${s.id} is empty.`));
      const fee = bal.gantry.fee;
      if (!canSpend(state, bal, fee)) return no(noCash(state, fee, "A gantry job"));
      const hall = hallOfServer(state, s);
      const job: Job = { id: nextId(state, "job"), kind: c.kind, server: s.id, slot: c.slot, by: c.by, state: "queued", hall, fee };
      if (p) { job.part = p.id; p.where = { kind: "gantry", job: job.id }; }
      state.jobs.push(job);
      const g = state.halls[hall].gantry;
      g.queue.push(job.id);
      spend(fee, "gantry");
      const wait = (g.running !== undefined ? Math.max(0, g.busyUntilTick - state.tick) : 0) + g.queue.length * bal.gantry.jobTicks;
      return ok({ job: job.id, etaSeconds: Math.round((wait * bal.time.tickMs) / 1000) });
    }
    case "cancelJob": {
      const j = state.jobs.find((x) => x.id === c.job);
      if (!j) return no(refuse("not_found", `There is no job called ${c.job}.`));
      if (j.state !== "queued") return no(refuse("already_running", j.state === "running" ? `Job ${j.id} is already running and cannot be cancelled.` : `Job ${j.id} has already finished.`));
      const g = state.halls[j.hall].gantry;
      g.queue = g.queue.filter((x) => x !== j.id);
      j.state = "failed"; j.reason = "cancelled"; j.doneTick = state.tick;
      if (j.part) { const p = state.parts[j.part]; if (p && p.where.kind === "gantry") p.where = { kind: "shelf" }; }
      state.cash += j.fee; today(state).costs.gantry -= j.fee; settleCash(state, bal);
      return ok();
    }
    case "resetBreaker": {
      const r = rack(c.rack); if (!r) return noRack(c.rack);
      if (r.breaker !== "tripped") return no(refuse("not_tripped", `The breaker on ${r.id} is not tripped.`));
      r.breaker = "closed";
      clearAlerts(state, ev, ["breaker"], r.id);
      ev.push({ kind: "breaker_reset", target: r.id, data: { by: c.by } });
      return ok({ breaker: r.breaker });
    }
    case "placeOrder": {
      let cost = 0;
      for (const l of c.lines) {
        const price = l.sku === "rack" || l.sku === "chassis" || l.sku === "cart" ? bal.shop.items[l.sku] : partSpec(bal, l.sku)?.price;
        if (price === undefined) return no(refuse("unknown_sku", `The shop does not sell "${l.sku}".`));
        cost += price * l.qty;
      }
      const express = c.express === true;
      cost = Math.round(cost * (express ? bal.shop.expressMult : 1));
      if (!canSpend(state, bal, cost)) return no(noCash(state, cost, "That order"));
      if (capExceeded(state, bal, c, cost)) return no(overCap(state, bal, cost));
      const order: Order = { id: nextId(state, "order"), lines: c.lines.map((l) => ({ sku: l.sku, qty: l.qty })), express, cost,
        arrivesTick: state.tick + (express ? bal.shop.expressTicks : Math.round(bal.shop.standardHours * bal.time.ticksPerGameHour)), state: "transit" };
      state.orders.push(order);
      for (const l of c.lines) if (partSpec(bal, l.sku)) for (let i = 0; i < l.qty; i++) createPart(state, l.sku, { kind: "crate", order: order.id });
      spend(cost, "parts");
      ev.push({ kind: "order_placed", target: order.id, data: { order: order.id, cost, express, by: c.by } });
      return ok({ order: order.id, cost, arrivesTick: order.arrivesTick, arrives: timeOfTick(order.arrivesTick, bal) });
    }
    case "openCrate": {
      const o = state.orders.find((x) => x.id === c.order);
      if (!o) return no(refuse("not_found", `There is no order called ${c.order}.`));
      if (o.state !== "delivered") return no(refuse("not_delivered", o.state === "transit" ? `Order ${o.id} has not arrived yet.` : `Order ${o.id} has already been opened.`));
      for (const pid in state.parts) { const w = state.parts[pid].where; if (w.kind === "crate" && w.order === o.id) state.parts[pid].where = { kind: "shelf" }; }
      for (const l of o.lines) {
        if (l.sku === "rack") state.stock.racks += l.qty;
        else if (l.sku === "chassis") state.stock.chassis += l.qty;
        else if (l.sku === "cart") state.stock.cart = true;
      }
      o.state = "opened";
      clearAlerts(state, ev, ["delivery"], o.id);
      ev.push({ kind: "crate_opened", target: o.id });
      return ok({ stock: { ...state.stock } });
    }
    case "placeRack": {
      if (!state.halls[c.hall].owned) return no(refuse("hall_not_owned", `Hall ${c.hall} has not been bought yet.`));
      if (c.slot >= bal.facility.halls[c.hall].slots) return no(refuse("invalid", `Hall ${c.hall} has rack slots 0 to ${bal.facility.halls[c.hall].slots - 1}.`));
      if (rack(rackId(c.hall, c.slot))) return no(refuse("slot_taken", `Rack slot ${c.slot} in Hall ${c.hall} already has a rack.`));
      if (state.stock.racks < 1) return no(refuse("no_rack_in_hand", "There is no rack to place. Order one and open its crate first."));
      state.stock.racks--;
      const r = newRack(state, c.hall, c.slot);
      ev.push({ kind: "rack_placed", target: r.id });
      return ok({ rack: r.id });
    }
    case "placeChassis": {
      const r = rack(c.rack); if (!r) return noRack(c.rack);
      if (c.bay > bal.facility.baysPerRack) return no(refuse("invalid", `Racks have bays 1 to ${bal.facility.baysPerRack}.`));
      if (r.servers[c.bay - 1]) return no(refuse("bay_taken", `Bay ${c.bay} of ${r.id} already holds a server.`));
      if (state.stock.chassis < 1) return no(refuse("no_chassis_in_hand", "There is no chassis to place. Order one and open its crate first."));
      state.stock.chassis--;
      const s = newServer(state, bal, r, c.bay);
      ev.push({ kind: "chassis_placed", target: s.id });
      return ok({ server: s.id });
    }
    case "sellPart": {
      const p = part(c.part);
      if (!p) return no(refuse("not_owned", `There is no part called ${c.part}.`));
      if (p.where.kind === "slot" || p.where.kind === "gantry") return no(refuse("installed", `Part ${p.id} is installed or on the gantry. Remove it before selling.`));
      if (!partAvailable(state, p)) return no(refuse("not_owned", `Part ${c.part} has not been delivered yet.`));
      const mult = p.status === "ok" ? 1 : p.status === "degraded" ? bal.shop.sellbackDegradedMult : bal.shop.sellbackFailedMult;
      const amount = Math.round(bal.catalogue[p.sku].price * bal.shop.sellbackPct * mult);
      delete state.parts[p.id];
      state.cash += amount; today(state).income.sales += amount; settleCash(state, bal);
      return ok({ amount });
    }
    case "acceptContract": {
      const k = state.contracts.find((x) => x.id === c.contract);
      if (!k || k.state !== "offer") return no(refuse("expired", `Offer ${c.contract} is no longer available.`));
      if (bal.contracts.types[k.type].minRep > state.reputation) return no(refuse("reputation_too_low", `A ${k.type} contract needs reputation ${bal.contracts.types[k.type].minRep}; the facility has ${Math.floor(state.reputation)}.`));
      const limit = bal.contracts.activeBase + Math.floor(state.reputation / bal.contracts.activePerRep);
      if (state.contracts.filter((x) => x.state === "active").length >= limit) return no(refuse("too_many_active", `The facility can hold ${limit} active contracts at its current reputation.`));
      k.state = "active"; k.startTick = state.tick; k.endTick = state.tick + k.days * ticksPerDay(bal);
      ev.push({ kind: "contract", target: k.id, text: `Contract ${k.id} (${k.type}) accepted.`, data: { state: k.state, by: c.by } });
      return ok({ state: k.state });
    }
    case "cancelContract": {
      const k = state.contracts.find((x) => x.id === c.contract);
      if (!k || k.state !== "active") return no(refuse("not_active", `Contract ${c.contract} is not active.`));
      k.state = "done"; k.cancelled = true; k.endTick = state.tick;
      if (k.atRisk) { k.atRisk = false; clearAlerts(state, ev, ["sla_risk"], k.id); }
      state.reputation = Math.max(0, Math.min(100, state.reputation + bal.contracts.repCancel));
      spend(contractDayValue(k, bal), "penalties");
      ev.push({ kind: "contract", target: k.id, text: `Contract ${k.id} (${k.type}) cancelled.`, data: { state: "cancelled", by: c.by } });
      return ok({ state: "cancelled" });
    }
    case "buyUpgrade": {
      const F = bal.facility;
      let cost = 0, what = "", apply: () => unknown;
      if (c.kind === "power" || c.kind === "cooling") {
        const tiers = c.kind === "power" ? F.powerTiers : F.coolingTiers;
        const cur = c.kind === "power" ? state.powerCapKw : state.coolingCapKw;
        const next = tiers.find((t) => t.kw > cur);
        if (!next) return no(refuse("already_max", `Facility ${c.kind} is already at its top tier (${cur} kW).`));
        cost = next.price; what = `The ${next.kw} kW ${c.kind} upgrade`;
        apply = () => (c.kind === "power" ? (state.powerCapKw = next.kw) : (state.coolingCapKw = next.kw));
      } else if (c.kind === "pdu" || c.kind === "rear_door") {
        const r = c.target !== undefined ? rack(c.target) : undefined;
        if (!r) return no(refuse("not_found", c.target ? `There is no rack called ${c.target}.` : "That upgrade needs a rack as its target."));
        if (c.kind === "pdu") {
          if (r.pduCapKw === F.pduUpgradedKw) return no(refuse("already_max", `${r.id} already has the ${F.pduUpgradedKw} kW PDU.`));
          cost = F.pduUpgradePrice; what = "The PDU upgrade"; apply = () => (r.pduCapKw = F.pduUpgradedKw);
        } else {
          if (r.rearDoor) return no(refuse("already_max", `${r.id} already has a rear-door cooler.`));
          cost = F.rearDoorPrice; what = "A rear-door cooler"; apply = () => (r.rearDoor = true);
        }
      } else {
        const want = (c.target ?? (state.halls.B.owned ? "C" : "B")) as HallId;
        if (!HALLS.includes(want)) return no(refuse("not_found", `There is no hall called ${c.target}.`));
        if (state.halls[want].owned) return no(refuse("already_max", `Hall ${want} is already owned.`));
        if (want === "C" && !state.halls.B.owned) return no(refuse("needs_hall_b", "Hall C can only be bought after Hall B."));
        cost = F.halls[want].price; what = `Hall ${want}`;
        apply = () => {
          state.halls[want].owned = true;
          ev.push({ kind: "hall_bought", target: want, text: `Hall ${want} bought.`, data: { by: c.by } });
          addMilestone(state, ev, want === "B" ? "second_hall" : "campus");
          return want;
        };
      }
      if (!canSpend(state, bal, cost)) return no(noCash(state, cost, what));
      if (capExceeded(state, bal, c, cost)) return no(overCap(state, bal, cost));
      const newValue = apply();
      spend(cost, "upgrades");
      ev.push({ kind: "upgrade", target: c.target, data: { upgrade: c.kind, cost, newValue, by: c.by } });
      return ok({ cost, newValue });
    }
    case "setSpeed": {
      if (c.speed > 1 && c.seated !== true) return no(refuse("not_seated", "Faster speeds are only available while seated at the master computer."));
      state.speed = c.speed;
      return ok({ speed: c.speed });
    }
    case "setAutonomy": state.settings.autonomy = c.level; return ok({ autonomy: c.level });
    case "setDemoMode": state.settings.demo = c.on; return ok({ demo: c.on });
    case "director.overheatRack": {
      const r = rack(c.rack); if (!r) return noRack(c.rack);
      r.overheatUntilTick = state.tick + bal.director.overheatTicks;
      return ok({ untilTick: r.overheatUntilTick });
    }
    case "director.failPart": {
      const r = rack(c.rack); if (!r) return noRack(c.rack);
      const pool: string[] = [];
      for (const sid of r.servers) { if (!sid) continue; const s = state.servers[sid]; for (const slot of SLOTS) { const pid = s.slots[slot]; if (pid !== undefined && state.parts[pid].status === "ok" && (!c.family || slotFamily(slot) === c.family) && (!c.family || s.power === "on")) pool.push(pid); } }
      if (pool.length === 0) return no(refuse("not_found", `Rack ${r.id} has no healthy installed part to fail.`));
      const pid = pool[rndInt(state, 0, pool.length - 1)];
      degradePart(state, bal, ev, pid, state.tick + bal.director.failDelayTicks);
      return ok({ part: pid, where: state.parts[pid].where });
    }
    case "director.deliverAll": {
      let n = 0;
      for (const o of state.orders) if (o.state === "transit") { o.arrivesTick = state.tick; n++; }
      return ok({ orders: n });
    }
    case "director.addCash": state.cash += c.amount; settleCash(state, bal); return ok({ cash: state.cash });
    case "director.skipDay": {
      const counts: Record<string, number> = {};
      const carried = ev.splice(0);
      for (let i = ticksPerDay(bal); i > 0; i--) for (const e of tick(state, bal)) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
      ev.push(...carried, { kind: "day_skipped", data: { events: counts } });
      return ok({ events: counts, time: timeOfTick(state.tick, bal) });
    }
  }
}

/** Sets a milestone from outside the sim (the host sets "hands_off"). Returns true when it was new. */
export function markMilestone(state: State, idOf: string): boolean {
  return addMilestone(state, getCache(state).pending, idOf);
}
