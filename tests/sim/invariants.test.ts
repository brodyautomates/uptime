import { expect, test } from "vitest";
import { applyCommand, newGame, partSpec, slotFamily, SLOTS, stateHash, tick } from "@sim/index";
import type { Balance, Command, State } from "@sim/index";
import { loadBalance } from "./helpers";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), a | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function randomCommand(state: State, bal: Balance, r: () => number): Command {
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(r() * a.length)];
  const by = pick(["player", "player", "claude", "director"] as const);
  const servers = [...Object.keys(state.servers), "A-R09-S01"], racks = [...Object.keys(state.racks), "B-R01", "Z-R77"];
  const parts = [...Object.keys(state.parts), "p_999999"];
  const loose = parts.filter((p) => state.parts[p] && state.parts[p].where.kind !== "slot");
  const skus = [...Object.keys(bal.catalogue), "rack", "chassis", "cart", "gpu.v9"];
  const orders = [...state.orders.map((o) => o.id), "o_99999"], jobs = [...state.jobs.map((j) => j.id), "j_99999"];
  const contracts = [...state.contracts.map((c) => c.id), "c_99999"];
  const server = pick(servers), rack = pick(racks), slot = pick(SLOTS);
  const k = Math.floor(r() * 26);
  switch (k) {
    case 0: case 1: return { by, type: "setServerPower", server, on: r() < 0.6 };
    case 2: return { by, type: "setRackDoor", rack, open: r() < 0.5 };
    case 3: return { by, type: r() < 0.5 ? "pullServer" : "pushServer", server };
    case 4: case 5: return { by, type: "removePart", server, slot };
    case 6: case 7: case 8: return { by, type: "installPart", server, slot, part: pick(loose.length && r() < 0.8 ? loose : parts) };
    case 9: return { by, type: "stowPart", part: pick(loose.length ? loose : parts), to: pick(["hand", "cart", "shelf"] as const) };
    case 10: case 11: return r() < 0.5 ? { by, type: "queueJob", kind: "remove", server, slot } : { by, type: "queueJob", kind: "install", server, slot, part: pick(loose.length ? loose : parts) };
    case 12: return { by, type: "cancelJob", job: pick(jobs) };
    case 13: return { by, type: "resetBreaker", rack };
    case 14: case 15: return { by, type: "placeOrder", lines: [{ sku: pick(skus), qty: 1 + Math.floor(r() * 4) }, { sku: pick(skus), qty: 1 }], express: r() < 0.7 };
    case 16: case 17: return { by, type: "openCrate", order: pick(orders) };
    case 18: return { by, type: "placeRack", hall: pick(["A", "A", "B", "C"] as const), slot: Math.floor(r() * 14) };
    case 19: return { by, type: "placeChassis", rack, bay: 1 + Math.floor(r() * 11) };
    case 20: return { by, type: "sellPart", part: pick(parts) };
    case 21: return r() < 0.7 ? { by, type: "acceptContract", contract: pick(contracts) } : { by, type: "cancelContract", contract: pick(contracts) };
    case 22: return { by, type: "buyUpgrade", kind: pick(["power", "cooling", "pdu", "rear_door", "hall"] as const), target: r() < 0.7 ? rack : pick(["B", "C"]) };
    case 23: return r() < 0.5 ? { by, type: "setSpeed", speed: pick([0, 1, 2, 4] as const), seated: r() < 0.5 } : { by, type: "setAutonomy", level: pick(["advise", "operate", "operate", "full"] as const) };
    case 24: return pick<Command>([
      { by, type: "director.overheatRack", rack }, { by, type: "director.failPart", rack }, { by, type: "director.deliverAll" },
      { by, type: "director.addCash", amount: Math.round((r() - 0.1) * 40000) },
    ]);
    default: return { by, type: "badCommand", server } as unknown as Command;
  }
}
const must = (cond: boolean, what: string): void => { if (!cond) throw new Error(`invariant broken: ${what}`); };
function checkInvariants(state: State, bal: Balance): void {
  must(Number.isFinite(state.cash), 'state.cash finite');
  must(state.cash >= bal.money.debtFloor, 'state.cash >= bal.money.debtFloor');
  must(state.reputation >= 0, 'state.reputation >= 0');
  must(state.reputation <= 100, 'state.reputation <= 100');
  must(state.stock.racks >= 0, 'state.stock.racks >= 0');
  must(state.stock.chassis >= 0, 'state.stock.chassis >= 0');
  // power never above a cap at the end of any tick (so never for more than one tick)
  must(state.totals.kw <= state.powerCapKw + 1e-6, 'state.totals.kw <= state.powerCapKw + 1e-6');
  let kw = 0;
  for (const id in state.racks) { const r = state.racks[id]; must(r.kw <= r.pduCapKw + 1e-6, 'r.kw <= r.pduCapKw + 1e-6'); if (r.breaker === "tripped") must(r.kw === 0, `r.kw is 0`); kw += r.kw; }
  must(Math.abs(kw - state.totals.kw) < 1e-6, 'Math.abs(kw - state.totals.kw) < 1e-6');
  // every part is in exactly one place and installed parts match their slot
  const seen = new Set<string>();
  let hand = 0, cart = 0;
  for (const sid in state.servers) {
    const s = state.servers[sid];
    must(state.racks[s.rack].servers[s.bay - 1] === sid, `state.racks[s.rack].servers[s.bay - 1] is sid`);
    for (const slot of SLOTS) {
      const pid = s.slots[slot];
      if (pid === undefined) continue;
      must(seen.has(pid) === false, `seen.has(pid) is false`);
      seen.add(pid);
      const p = state.parts[pid];
      must(p.where.kind === 'slot' && p.where.server === sid && p.where.slot === slot, `part ${pid} where matches ${sid}/${slot}`);
      must(partSpec(bal, p.sku)!.family === slotFamily(slot), `partSpec(bal, p.sku)!.family is slotFamily(slot)`);
    }
    for (const v of [s.out.cpu, s.out.gpu, s.out.tb, s.watts, s.tempC]) { must(Number.isFinite(v), 'v finite'); must(v >= 0, 'v >= 0'); }
  }
  for (const pid in state.parts) {
    const p = state.parts[pid];
    must(p.health >= 0, 'p.health >= 0');
    if (p.where.kind === "slot") must(seen.has(pid) === true, `seen.has(pid) is true`);
    else if (p.where.kind === "hand") hand++;
    else if (p.where.kind === "cart") cart++;
    else if (p.where.kind === "crate") must(state.orders.some((o) => o.id === (p.where as { order: string }).order) === true, `state.orders.some((o) => o.id === (p.where as { order: string }).order) is true`);
    else if (p.where.kind === "gantry") must(state.jobs.some((j) => j.id === (p.where as { job: string }).job && j.part === pid && (j.state === "queued" || j.state === "running")) === true, `state.jobs.some((j) => j.id === (p.where as { job: string }).job && j.part === pid && (j.state === "queued" || j.state === "running")) is true`);
  }
  must(hand <= 1, 'hand <= 1');
  must(cart <= (state.stock.cart ? bal.shop.cartCapacity : 0), 'cart within capacity');
  must(state.alerts.length <= 200, 'state.alerts.length <= 200');
  must(state.ledger.length <= 30, 'state.ledger.length <= 30');
}

function fuzz(bal: Balance, seed: number, ticks: number, preset: "fresh" | "showcase"): { applied: number; refused: number; reasons: Set<string> } {
  const state = newGame(bal, { seed, facilityName: "Fuzz", preset, demo: true });
  const r = rng(seed * 7919 + 1);
  let applied = 0, refused = 0;
  const reasons = new Set<string>();
  for (let t = 0; t < ticks; t++) {
    const n = r() < 0.5 ? Math.floor(r() * 4) : 0;
    for (let i = 0; i < n; i++) {
      const c = randomCommand(state, bal, r);
      const before = stateHash(state);
      const res = applyCommand(state, bal, c);
      if (res.ok) applied++;
      else {
        refused++; reasons.add(res.reason);
        expect(res.message.length).toBeGreaterThan(8);
        expect(stateHash(state), `refused ${c.type} (${res.reason}) changed the state`).toBe(before);
      }
    }
    tick(state, bal);
    checkInvariants(state, bal);
  }
  return { applied, refused, reasons };
}

test("G2 invariants hold over random play (fresh start)", () => {
  const bal = loadBalance();
  for (const seed of [1, 2, 3]) {
    const res = fuzz(bal, seed, 3000, "fresh");
    expect(res.applied).toBeGreaterThan(150);
    expect(res.refused).toBeGreaterThan(300);
    console.log(`G2 fuzz seed ${seed}: ${res.applied} applied, ${res.refused} refused, ${res.reasons.size} distinct refusal reasons`);
  }
});
test("G2 invariants hold when the facility power cap is far too small (breakers trip and get reset at random)", () => {
  const bal = loadBalance();
  bal.facility.powerTiers[0].kw = 1.5;
  bal.facility.coolingTiers[0].kw = 1;
  const res = fuzz(bal, 11, 3000, "fresh");
  expect(res.applied).toBeGreaterThan(150);
});
test("G2 invariants hold over random play on the showcase save, including a skipped day", () => {
  const bal = loadBalance();
  const res = fuzz(bal, 5, 600, "showcase");
  expect(res.applied).toBeGreaterThan(50);
  const state = newGame(bal, { seed: 6, facilityName: "Skip", preset: "showcase", demo: true });
  const day = applyCommand(state, bal, { by: "director", type: "director.skipDay" });
  expect(day.ok).toBe(true);
  expect(state.tick).toBe(7200);
  checkInvariants(state, bal);
});
