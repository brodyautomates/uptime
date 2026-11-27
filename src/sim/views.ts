// Read-only views for the ops UI and the MCP tools (output shapes of SPEC Appendix F). Plain JSON-safe objects.
import type { Balance } from "./balance";
import { partTempOffset, timeOfTick } from "./core";
import { HALLS, SLOTS } from "./state";
import type { HallId, Part, Rack, RackId, Server, ServerId, State } from "./state";

const r1 = (x: number): number => Math.round(x * 10) / 10;
const r0 = (x: number): number => Math.round(x);
const outOf = (s: Server) => ({ cpu: r1(s.out.cpu), gpu: r1(s.out.gpu), tb: r1(s.out.tb) });
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const specText = (b: Balance, sku: string): string => {
  const s = b.catalogue[sku];
  const unit = { cpu: "compute units", gpu: "GPU units", ram: "GB", drv: "TB", psu: "W supplied", fan: "W of heat moved", nic: "Gbps" }[s.family];
  return `${s.value} ${unit}${s.watts > 0 ? `, draws ${s.watts} W` : ""}`;
};
function whereText(s: State, p: Part): string {
  const w = p.where;
  if (w.kind === "slot") return `${w.server}/${w.slot}`;
  if (w.kind === "crate") { const o = s.orders.find((x) => x.id === w.order); return `${o && o.state === "transit" ? "transit" : "crate"}:${w.order}`; }
  if (w.kind === "gantry") return `gantry:${w.job}`;
  return w.kind;
}
function rackRow(s: State, rack: Rack) {
  let worst: "ok" | "degraded" | "failed" = "ok", maxTemp = 0, count = 0;
  for (const sid of rack.servers) {
    if (!sid) continue;
    count++;
    const sv = s.servers[sid];
    if (sv.tempC > maxTemp) maxTemp = sv.tempC;
    for (const slot of SLOTS) {
      const pid = sv.slots[slot];
      if (pid === undefined) continue;
      const st = s.parts[pid].status;
      if (st === "failed") worst = "failed"; else if (st === "degraded" && worst === "ok") worst = "degraded";
    }
  }
  return { id: rack.id, hall: rack.hall, slot: rack.slot, servers: count, kw: r1(rack.kw), pduCapKw: rack.pduCapKw, breaker: rack.breaker,
    worstStatus: worst, maxTempC: r1(maxTemp), rearDoor: rack.rearDoor, doorOpen: rack.doorOpen };
}
const serverRow = (sv: Server) => ({ id: sv.id, power: sv.power, tempC: r1(sv.tempC), load: sv.load, out: outOf(sv), bottleneck: sv.bottleneck });

export const views = {
  overview(s: State, b: Balance): object {
    const t = s.totals, tm = timeOfTick(s.tick, b);
    return {
      facility: s.facilityName, time: { day: tm.day, hour: tm.hour }, cash: r0(s.cash),
      incomePerHour: r0(t.incomePerHour), costPerHour: r0(t.costPerHour),
      power: { usedKw: r1(t.kw), capKw: s.powerCapKw }, cooling: { heatKw: r1(t.heatKw), capKw: s.coolingCapKw },
      halls: HALLS.filter((h) => s.halls[h].owned).map((h) => ({ id: h, airC: r1(s.halls[h].airC) })),
      reputation: r0(s.reputation),
      capacity: { cpu: r1(t.cpu), gpu: r1(t.gpu), tb: r1(t.tb) }, sold: { cpu: r1(t.sold.cpu), gpu: r1(t.sold.gpu), tb: r1(t.sold.tb) },
      autonomy: s.settings.autonomy, speed: s.speed, milestones: [...s.milestones], shopBlocked: s.shopBlocked,
    };
  },
  /** `b` is optional; with it each alert also carries `time: { day, hour }`. */
  alerts(s: State, includeCleared = false, b?: Balance): object[] {
    return s.alerts.filter((a) => includeCleared || !a.cleared).map((a) => {
      const tm = b ? timeOfTick(a.tick, b) : undefined;
      return { id: a.id, severity: a.severity, kind: a.kind, target: a.target ?? null, text: a.text,
        time: tm ? { day: tm.day, hour: tm.hour } : { tick: a.tick }, tick: a.tick, cleared: a.cleared };
    });
  },
  racks(s: State, _b: Balance, hall?: HallId): object[] {
    return Object.keys(s.racks).sort().map((id) => s.racks[id]).filter((r) => !hall || r.hall === hall).map((r) => rackRow(s, r));
  },
  rack(s: State, _b: Balance, id: RackId): object | null {
    if (!has(s.racks, id)) return null;
    const rack = s.racks[id];
    return { ...rackRow(s, rack), servers: rack.servers.filter((x): x is string => !!x).map((sid) => serverRow(s.servers[sid])), bays: rack.servers.length };
  },
  server(s: State, b: Balance, id: ServerId): object | null {
    if (!has(s.servers, id)) return null;
    const sv = s.servers[id];
    const running = sv.power === "on" || sv.power === "booting";
    return {
      ...serverRow(sv), rack: sv.rack, bay: sv.bay, watts: r0(sv.watts), redundantPsu: sv.redundantPsu, pulledOut: sv.pulledOut,
      slots: SLOTS.map((slot) => {
        const pid = sv.slots[slot];
        if (pid === undefined) return { slot, part: null };
        const p = s.parts[pid], spec = b.catalogue[p.sku];
        return { slot, part: { id: p.id, sku: p.sku, name: spec.name, tier: spec.tier, health: r1(p.health), status: p.status,
          tempC: r1(sv.tempC + partTempOffset(b, p.sku)), watts: running && p.status !== "failed" ? spec.watts : 0 } };
      }),
    };
  },
  inventory(s: State, b: Balance): object[] {
    const rows: object[] = [];
    for (const id of Object.keys(s.parts).sort()) {
      const p = s.parts[id];
      if (p.where.kind === "slot") continue;
      rows.push({ part: p.id, sku: p.sku, name: b.catalogue[p.sku].name, where: whereText(s, p), status: p.status, health: r1(p.health) });
    }
    if (s.stock.racks > 0) rows.push({ part: null, sku: "rack", name: "Empty rack", where: "loading bay", qty: s.stock.racks });
    if (s.stock.chassis > 0) rows.push({ part: null, sku: "chassis", name: "Empty chassis", where: "loading bay", qty: s.stock.chassis });
    return rows;
  },
  catalog(b: Balance, family?: string): object[] {
    const deliveryHours = b.shop.standardHours, expressSeconds = Math.round((b.shop.expressTicks * b.time.tickMs) / 1000);
    const rows: object[] = [];
    for (const sku of Object.keys(b.catalogue)) {
      const c = b.catalogue[sku];
      if (family && c.family !== family) continue;
      rows.push({ sku, name: c.name, family: c.family, tier: c.tier, price: c.price, spec: specText(b, sku), watts: c.watts, value: c.value, deliveryHours, expressSeconds });
    }
    if (!family || family === "item") {
      rows.push({ sku: "rack", name: "Empty rack", family: "item", tier: 1, price: b.shop.items.rack, spec: `${b.facility.baysPerRack} bays, ${b.facility.pduBaseKw} kW PDU`, deliveryHours, expressSeconds });
      rows.push({ sku: "chassis", name: "Empty 4U chassis", family: "item", tier: 1, price: b.shop.items.chassis, spec: "25 slots", deliveryHours, expressSeconds });
      rows.push({ sku: "cart", name: "Hand cart", family: "item", tier: 1, price: b.shop.items.cart, spec: `carries ${b.shop.cartCapacity} parts`, deliveryHours, expressSeconds });
    }
    return rows;
  },
  orders(s: State, b?: Balance): object {
    return {
      orders: s.orders.map((o) => ({ id: o.id, lines: o.lines, express: o.express, cost: o.cost, state: o.state, arrivesTick: o.arrivesTick,
        arrives: b ? (({ day, hour }) => ({ day, hour }))(timeOfTick(o.arrivesTick, b)) : undefined })),
      gantryJobs: s.jobs.filter((j) => j.state === "queued" || j.state === "running" || s.tick - (j.doneTick ?? 0) < 600)
        .map((j) => ({ id: j.id, kind: j.kind, server: j.server, slot: j.slot, part: j.part ?? null, by: j.by, state: j.state, reason: j.reason ?? null, hall: j.hall })),
      stock: { ...s.stock },
    };
  },
  contracts(s: State, b: Balance, st?: "offer" | "active"): object[] {
    return s.contracts.filter((c) => (st ? c.state === st : c.state === "offer" || c.state === "active")).map((c) => ({
      id: c.id, type: c.type, unit: c.unit, demand: c.demand, ratePerUnitHour: c.rate, slaPct: c.slaPct, days: c.days,
      penaltyPerDay: c.penaltyPerDay, deliveredPctToday: c.demandedToday > 0 ? r1((c.deliveredToday / c.demandedToday) * 100) : null,
      state: c.state, minReputation: b.contracts.types[c.type].minRep,
      ends: c.state === "active" ? (({ day, hour }) => ({ day, hour }))(timeOfTick(c.endTick, b)) : null,
    }));
  },
  finance(s: State, _b: Balance, days = 7): object {
    const list = s.ledger.slice(-Math.max(1, Math.min(30, Math.floor(days))));
    const income = { spot: 0, contracts: 0, sales: 0 };
    const costs = { power: 0, rent: 0, parts: 0, gantry: 0, penalties: 0, interest: 0, upgrades: 0 };
    const byDay = list.map((d) => {
      let i = 0, c = 0;
      for (const k of Object.keys(income) as (keyof typeof income)[]) { income[k] += d.income[k]; i += d.income[k]; }
      for (const k of Object.keys(costs) as (keyof typeof costs)[]) { costs[k] += d.costs[k]; c += d.costs[k]; }
      return { day: d.day, income: r0(i), costs: r0(c), net: r0(i - c) };
    });
    let ti = 0, tc = 0;
    for (const k of Object.keys(income) as (keyof typeof income)[]) { ti += income[k]; income[k] = r0(income[k]); }
    for (const k of Object.keys(costs) as (keyof typeof costs)[]) { tc += costs[k]; costs[k] = r0(costs[k]); }
    return { income, costs, net: r0(ti - tc), byDay };
  },
};
