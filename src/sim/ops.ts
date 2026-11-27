// Physical part operations shared by the command bus and the gantry.
import type { Balance } from "./balance";
import { addMilestone, clearAlerts, fillStat, getCache, markDirty, rebuildLists, slotFamily, statusMult } from "./core";
import type { Stat } from "./core";
import { HOT_SWAP } from "./state";
import type { Part, Server, SimEvent, SlotId, State } from "./state";

export type Refusal = { reason: string; message: string };
export const refuse = (reason: string, message: string): Refusal => ({ reason, message });
export const isRunning = (s: Server): boolean => s.power === "on" || s.power === "booting";

export function freshStat(state: State, bal: Balance, s: Server): Stat {
  const cache = getCache(state);
  if (cache.listsDirty) rebuildLists(state, cache);
  const st = cache.statById.get(s.id)!;
  if (st.dirty) fillStat(state, bal, s, st);
  return st;
}
/** A part can be used when it is on the shelf, on the cart, in hand, or in a crate that has arrived. */
export function partAvailable(state: State, part: Part | undefined): part is Part {
  if (!part) return false;
  const w = part.where;
  if (w.kind === "shelf" || w.kind === "cart" || w.kind === "hand") return true;
  if (w.kind === "crate") { const o = state.orders.find((x) => x.id === w.order); return !!o && o.state !== "transit"; }
  return false;
}
export function checkInstall(bal: Balance, s: Server, slot: SlotId, part: Part, slotOccupied: boolean): Refusal | null {
  const fam = slotFamily(slot);
  if (bal.catalogue[part.sku].family !== fam) return refuse("wrong_type", `${bal.catalogue[part.sku].name} does not fit slot ${slot}; that slot takes a ${fam} part.`);
  if (slotOccupied) return refuse("slot_full", `Slot ${slot} on ${s.id} already holds a part.`);
  if (!HOT_SWAP[fam] && isRunning(s)) return refuse("needs_power_off", `${s.id} must be powered off before a ${fam} part is installed.`);
  return null;
}
export function checkRemove(state: State, bal: Balance, s: Server, slot: SlotId): Refusal | null {
  const pid = s.slots[slot];
  if (pid === undefined) return refuse("empty_slot", `Slot ${slot} on ${s.id} is empty.`);
  const fam = slotFamily(slot);
  if (!HOT_SWAP[fam] && isRunning(s)) return refuse("needs_power_off", `${s.id} must be powered off before its ${fam} part is removed.`);
  if (fam === "psu" && isRunning(s)) {
    const st = freshStat(state, bal, s);
    const p = state.parts[pid];
    const mine = bal.catalogue[p.sku].value * statusMult(bal, p.status);
    if (st.supply - mine < st.watts) return refuse("psu_not_redundant", `${s.id} is running and the other power supply cannot carry ${Math.round(st.watts)} W alone.`);
  }
  return null;
}
export function doInstall(state: State, bal: Balance, ev: SimEvent[], s: Server, slot: SlotId, part: Part): void {
  part.where = { kind: "slot", server: s.id, slot };
  part.tempC = s.tempC;
  s.slots[slot] = part.id;
  markDirty(state, s.id);
  ev.push({ kind: "part_installed", target: `${s.id}/${slot}`, data: { part: part.id, sku: part.sku } });
  if (bal.catalogue[part.sku].family === "gpu") addMilestone(state, ev, "first_light");
}
export function doRemove(state: State, ev: SimEvent[], s: Server, slot: SlotId, dest: Part["where"]): Part {
  const part = state.parts[s.slots[slot]!];
  delete s.slots[slot];
  part.failsAtTick = undefined;
  part.where = dest;
  markDirty(state, s.id);
  clearAlerts(state, ev, ["part_degraded", "part_failed"], `${s.id}/${slot}`);
  ev.push({ kind: "part_removed", target: `${s.id}/${slot}`, data: { part: part.id, sku: part.sku } });
  return part;
}
