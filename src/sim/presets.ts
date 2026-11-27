// newGame and the three bundled presets (SPEC section 9 "Start state" and "Saves").
import type { Balance } from "./balance";
import { ticksPerDay } from "./balance";
import { createPart, getCache, newLedgerDay } from "./core";
import { newRack, newServer } from "./commands";
import { SAVE_VERSION } from "./version";
import { HALLS, SLOTS, slotFamily } from "./state";
import type { Family, HallId, Rack, Server, SimEvent, State } from "./state";
import { physics, refreshOffers } from "./tick";

export type Preset = "fresh" | "showcase" | "mega" | "demo";
/** Tier per family, and how many of each (default: every slot of that family). */
export interface Build { tier: Record<Family, number>; count?: Partial<Record<Family, number>>; on?: boolean }
const LETTER: Record<Family, string> = { cpu: "k", gpu: "v", ram: "s", drv: "f", psu: "b", fan: "z", nic: "l" };
export const skuOf = (family: Family, tier: number): string => `${family}.${LETTER[family]}${tier}`;

function addServer(state: State, bal: Balance, rack: Rack, bay: number, b: Build): Server {
  const s = newServer(state, bal, rack, bay);
  const used: Partial<Record<Family, number>> = {};
  for (const slot of SLOTS) {
    const f = slotFamily(slot), n = used[f] ?? 0;
    if (n >= (b.count?.[f] ?? 99) || b.tier[f] < 1) continue;
    used[f] = n + 1;
    const p = createPart(state, skuOf(f, b.tier[f]), { kind: "slot", server: s.id, slot });
    s.slots[slot] = p.id;
  }
  if (b.on !== false) { s.power = "on"; s.wantOn = true; }
  return s;
}

export function newGame(bal: Balance, opts: { seed: number; facilityName: string; preset?: Preset; demo?: boolean }): State {
  const preset = opts.preset ?? "fresh";
  const start = bal.start[preset === "demo" ? "showcase" : preset];
  const hall = (id: HallId, owned: boolean) => ({ id, owned, airC: bal.thermal.baseAirC, heatKw: 0, coolingKw: 0, gantry: { busyUntilTick: 0, queue: [] } });
  const state: State = {
    version: SAVE_VERSION, seed: opts.seed >>> 0, tick: 0, facilityName: opts.facilityName,
    cash: start.cash, reputation: start.reputation, speed: 1,
    powerCapKw: bal.facility.powerTiers[0].kw, coolingCapKw: bal.facility.coolingTiers[0].kw,
    halls: { A: hall("A", true), B: hall("B", false), C: hall("C", false) },
    racks: {}, servers: {}, parts: {}, contracts: [], orders: [], jobs: [], alerts: [], milestones: [],
    ledger: [newLedgerDay(1)],
    settings: { autonomy: "operate", demo: opts.demo === true },
    rngState: (opts.seed ^ 0x9e3779b9) >>> 0,
    ids: { part: 0, order: 0, job: 0, contract: 0, alert: 0, rack: 0 },
    stock: { racks: 0, chassis: 0, cart: false }, degrading: [],
    totals: { cpu: 0, gpu: 0, tb: 0, gpuTrain: 0, gpuInf: 0, sold: { cpu: 0, gpu: 0, tb: 0 }, kw: 0, heatKw: 0, incomePerHour: 0, costPerHour: 0 },
    shopBlocked: false, powerWarn: false, repGainToday: 0,
  };
  const F = bal.facility, bays = F.baysPerRack;
  const top = <T,>(a: T[]): T => a[a.length - 1];
  const SPARE = (sku: string) => createPart(state, sku, { kind: "shelf" });
  const fullRack = (h: HallId, slot: number): Rack => { const r = newRack(state, h, slot); r.pduCapKw = F.pduUpgradedKw; return r; };

  if (preset === "fresh") {
    const t1: Build = { tier: { cpu: 1, ram: 1, gpu: 0, drv: 1, psu: 1, fan: 1, nic: 1 }, count: { drv: 2 } };
    for (let r = 0; r < 2; r++) { const rack = newRack(state, "A", r); for (let bay = 1; bay <= 4; bay++) addServer(state, bal, rack, bay, t1); }
  } else if (preset === "showcase" || preset === "demo") {
    // "demo" is the stage for the 75-second run: Hall A full, Hall B still to buy, spares on the shelf.
    state.halls.B.owned = preset === "showcase";
    state.powerCapKw = F.powerTiers[Math.min(2, F.powerTiers.length - 1)].kw;
    state.coolingCapKw = F.coolingTiers[Math.min(2, F.coolingTiers.length - 1)].kw;
    state.stock.cart = true;
    const build = (i: number): Build => {
      const g = (i % 3) + 1;       // GPU tier 1..3
      return { tier: { cpu: g === 3 ? 3 : 2, ram: g === 3 ? 3 : 2, gpu: g, drv: g, psu: g === 1 ? 3 : 4, fan: 2, nic: g === 1 ? 1 : 2 } };
    };
    for (let r = 0; r < F.halls.A.slots; r++) { const rack = fullRack("A", r); for (let bay = 1; bay <= bays; bay++) addServer(state, bal, rack, bay, build(r + bay)); }
    if (preset === "showcase") for (let r = 0; r < 6; r++) { const rack = fullRack("B", r); for (let bay = 1; bay <= bays / 2; bay++) addServer(state, bal, rack, bay, build(r + bay)); }
    state.milestones.push("first_light", "full_house"); if (preset === "showcase") state.milestones.push("second_hall");
    if (preset === "demo") for (const sku of ["fan.z2", "fan.z2", "fan.z2", "fan.z2", "psu.b4", "psu.b4", "gpu.v2", "gpu.v2"]) SPARE(sku);
  } else {
    state.halls.B.owned = true; state.halls.C.owned = true;
    state.powerCapKw = top(F.powerTiers).kw; state.coolingCapKw = top(F.coolingTiers).kw;
    state.stock.cart = true;
    // 600 servers, all 25 slots filled (15,000 parts). A fully populated tier-3 server draws about 2.07 kW, so 600 running
    // servers would need 1,240 kW against the 1,200 kW top tier: the top bay of every rack is a powered-off spare.
    for (const h of HALLS) for (let r = 0; r < F.halls[h].slots; r++) {
      const rack = fullRack(h, r); rack.rearDoor = true;
      const hi = 3 + (r % 3);
      for (let bay = 1; bay <= bays; bay++) addServer(state, bal, rack, bay, {
        tier: { cpu: bay === 2 ? 5 : 3, gpu: bay === 1 ? 4 : 3, ram: hi, drv: hi, psu: 5, fan: 3, nic: r % 2 ? 4 : 3 }, on: bay !== bays,
      });
    }
    state.milestones.push("first_light", "full_house", "second_hall", "campus");
  }
  getCache(state).listsDirty = true;
  const ev: SimEvent[] = [];
  physics(state, bal, ev, true);
  physics(state, bal, ev, true);     // second pass: server temperatures against the settled hall air
  if (preset === "showcase" || preset === "demo") {
    const t = state.totals, tpd = ticksPerDay(bal);
    const mk = (id: string, type: "web" | "render", unit: "cpu" | "gpu", demand: number, mult: number, days: number) => {
      const spec = bal.contracts.types[type], rate = Math.round(bal.rates[unit] * mult * 100) / 100;
      state.contracts.push({ id, type, unit, demand, rate, slaPct: spec.slaPct, startTick: 0, endTick: days * tpd,
        penaltyPerDay: Math.round(bal.contracts.penaltyPct * demand * rate * bal.time.hoursPerDay),
        deliveredToday: 0, demandedToday: 0, state: "active", days, breachedDays: 0, breachStreak: 0, atRisk: false });
    };
    mk("c_00001", "web", "cpu", Math.round(t.cpu * 0.5), 0.95, 8);
    mk("c_00002", "render", "gpu", Math.round(t.gpu * 0.4), 1.2, 3);
    state.ids.contract = 2;
  }
  refreshOffers(state, bal, ev);
  getCache(state).pending.length = 0;
  return state;
}
