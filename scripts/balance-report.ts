// G3 balance report: a scripted "sensible player" and an idle run, both driven only through the command bus.
// Run it and print the report with: npx vitest run tests/sim/balance.test.ts --silent=false
import { applyCommand, evalParts, newGame, partSpec, skuOf, slotFamily, SLOTS, HOT_SWAP, tick } from "../src/sim/index";
import type { Balance, Command, Family, PartId, RackId, ServerId, SlotId, Sku, State } from "../src/sim/index";

type Config = Partial<Record<SlotId, Sku>>;
type Change = { slot: SlotId; sku: Sku };
interface Plan {
  kind: "upgrade" | "chassis" | "replace"; server?: ServerId; rack?: RackId; bay?: number; rackSlot?: { hall: "A" | "B" | "C"; slot: number };
  changes: Change[]; order: string; parts: PartId[]; cost: number; dKw: number; first?: boolean;
}
export interface BotReport {
  realMinutes: number;
  firstUpgrade: { what: string; cost: number; gainPerGameHour: number; paybackRealMinutes: number; predictedRealMinutes: number } | null;
  hallBAffordableRealMinutes: number | null;
  cashEnd: number; incomePerHourEnd: number; servers: number; partFailures: number; breaches: number; refusals: string[];
  timeline: { realMinute: number; cash: number; incomePerHour: number; servers: number }[];
}

const realMinutesOf = (bal: Balance, ticks: number): number => (ticks * bal.time.tickMs) / 60000;

/**
 * `jobsPerHour`: how many hands-on jobs (one server upgraded, or one chassis built) the player gets done per game hour. A game hour is
 * 30 real seconds. Ordering, walking to the loading bay and the rack, opening it, powering a server down, swapping parts with the 1.2 s
 * animation each and powering it up again takes a person about 75 seconds, so the default is 0.4 jobs per game hour. Without this limit the bot upgrades every server in the building in the same instant, which no player can do.
 */
export function runSensiblePlayer(bal: Balance, realMinutes: number, opts: { seed?: number; jobsPerHour?: number } = {}): BotReport {
  const jobsPerHour = opts.jobsPerHour ?? 0.4; let jobCredit = 0;
  const state = newGame(bal, { seed: opts.seed ?? 7, facilityName: "Balance bot" });
  const R = bal.rates, tph = bal.time.ticksPerGameHour;
  const refusals: string[] = [];
  const send = (c: Record<string, unknown> & { type: string }): { ok: boolean; data?: any; reason?: string } => {
    const r = applyCommand(state, bal, { by: "player", ...c } as Command);
    if (!r.ok) refusals.push(`${c.type}:${r.reason}`);
    return r as { ok: boolean; data?: any; reason?: string };
  };
  const value = (out: { cpu: number; gpu: number; tb: number }, watts: number): number =>
    (out.cpu * R.cpu + out.gpu * R.gpu + out.tb * R.tb) * R.spotMult - (watts / 1000) * R.overhead * R.powerPerKwh;
  const maxTier = (f: Family): number => { let t = 1; while (partSpec(bal, skuOf(f, t + 1))) t++; return t; };
  const tierOf = (sku: Sku): number => partSpec(bal, sku)!.tier;
  const slotsOf = (f: Family): SlotId[] => SLOTS.filter((s) => slotFamily(s) === f);
  const skus = (cfg: Config): Sku[] => SLOTS.map((s) => cfg[s]).filter((x): x is Sku => !!x);
  const configOf = (sid: ServerId): Config => {
    const cfg: Config = {};
    for (const slot of SLOTS) { const pid = state.servers[sid].slots[slot]; if (pid) cfg[slot] = state.parts[pid].sku; }
    return cfg;
  };
  /** Raises every populated slot of a family one tier (PSU and fan slots are all filled). False at the top tier. */
  const bump = (cfg: Config, f: Family): boolean => {
    const slots = slotsOf(f), fill = f === "psu" || f === "fan";
    let cur = 0;
    for (const s of slots) if (cfg[s]) cur = Math.max(cur, tierOf(cfg[s]!));
    if (cur >= maxTier(f)) return false;
    for (const s of slots) if (cfg[s] || fill) cfg[s] = skuOf(f, cur + 1);
    return true;
  };
  /** Makes a config bootable, cool and unbottlenecked where a part bump can do it. */
  const fixup = (cfg: Config): Config => {
    for (let i = 0; i < 20; i++) {
      const e = evalParts(bal, skus(cfg));
      if (!e.boots) { if (!bump(cfg, "psu")) break; continue; }
      if (e.tempRiseC > 26) { if (!bump(cfg, "fan")) break; continue; }
      const b = e.out.bottleneck;
      if (b === "nic" || b === "ram" || b === "cpu") { if (!bump(cfg, b)) break; continue; }
      break;
    }
    return cfg;
  };
  const diff = (old: Config, neu: Config): { changes: Change[]; cost: number } => {
    const changes: Change[] = [];
    let cost = 0;
    for (const slot of SLOTS) {
      const want = neu[slot];
      if (!want || want === old[slot]) continue;
      changes.push({ slot, sku: want });
      cost += partSpec(bal, want)!.price - (old[slot] ? partSpec(bal, old[slot]!)!.price * bal.shop.sellbackPct : 0);
    }
    return { changes, cost };
  };

  const plans: Plan[] = [];
  const busy = new Set<ServerId>();          // servers with a plan on order
  const cycling = new Set<ServerId>();       // servers this bot powered off and is waiting on
  type First = { server: ServerId; before: number; cost: number; predicted: number; what: string; installed: boolean };
  const firstBox: { v: First | null } = { v: null };
  let firstUpgrade: BotReport["firstUpgrade"] = null;
  let hallBAt: number | null = null;
  const timeline: BotReport["timeline"] = [];
  let partFailures = 0, breaches = 0;

  const order = (plan: Omit<Plan, "order" | "parts">, extra: { sku: string; qty: number }[] = []): boolean => {
    const lines = new Map<string, number>();
    for (const c of plan.changes) lines.set(c.sku, (lines.get(c.sku) ?? 0) + 1);
    const before = state.ids.part;
    const r = send({ type: "placeOrder", lines: [...extra, ...[...lines].map(([sku, qty]) => ({ sku, qty }))] });
    if (!r.ok) return false;
    const parts: PartId[] = [];
    for (let i = before + 1; i <= state.ids.part; i++) parts.push(`p_${String(i).padStart(6, "0")}`);
    plans.push({ ...plan, order: r.data.order, parts });
    if (plan.server) busy.add(plan.server);
    return true;
  };

  const execute = (plan: Plan): void => {
    let sid = plan.server;
    if (plan.kind === "chassis") {
      let rack = plan.rack;
      if (plan.rackSlot) { const r = send({ type: "placeRack", hall: plan.rackSlot.hall, slot: plan.rackSlot.slot }); if (!r.ok) return; rack = r.data.rack; }
      const r = send({ type: "placeChassis", rack, bay: plan.bay });
      if (!r.ok) return;
      sid = r.data.server as ServerId;
    }
    const s = state.servers[sid!];
    const wasWanted = plan.kind === "chassis" || s.wantOn || s.power === "on" || s.power === "booting";
    const needOff = plan.changes.some((c) => !HOT_SWAP[slotFamily(c.slot)] || slotFamily(c.slot) === "psu");
    if (plan.first && firstBox.v) { firstBox.v.before = value(s.out, s.watts); firstBox.v.installed = true; }
    if (needOff && (s.power === "on" || s.power === "booting")) send({ type: "setServerPower", server: s.id, on: false });
    const pool = [...plan.parts];
    for (const c of plan.changes) {
      if (s.slots[c.slot]) { const r = send({ type: "removePart", server: s.id, slot: c.slot }); if (!r.ok) continue; send({ type: "sellPart", part: r.data.part }); }
      const i = pool.findIndex((pid) => state.parts[pid]?.sku === c.sku);
      if (i < 0) continue;
      send({ type: "installPart", server: s.id, slot: c.slot, part: pool.splice(i, 1)[0] });
    }
    if (wasWanted && s.power !== "on" && s.power !== "booting") { send({ type: "setServerPower", server: s.id, on: true }); cycling.add(s.id); }
    busy.delete(s.id);
  };

  const hourlyDecisions = (): void => {
    const totalTicks = state.tick;
    for (const sid of [...cycling]) if (state.servers[sid].power === "on" || state.servers[sid].power === "off" || state.servers[sid].power === "shutdown_thermal") cycling.delete(sid);
    // measure the first upgrade once its server is back up
    const fm = firstBox.v;
    if (fm && fm.installed && !firstUpgrade) {
      const s = state.servers[fm.server];
      if (s.power === "on") {
        const gain = value(s.out, s.watts) - fm.before;
        firstUpgrade = { what: fm.what, cost: Math.round(fm.cost), gainPerGameHour: Math.round(gain * 10) / 10,
          paybackRealMinutes: Math.round(realMinutesOf(bal, (fm.cost / gain) * tph) * 100) / 100,
          predictedRealMinutes: Math.round(fm.predicted * 100) / 100 };
      }
    }
    // 1. open deliveries, run plans that are ready
    for (const o of state.orders) if (o.state === "delivered") send({ type: "openCrate", order: o.id });
    const nServers = Object.keys(state.servers).length;
    const maxCycling = Math.max(1, Math.floor(nServers / 4));
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i];
      if (state.orders.find((o) => o.id === p.order)?.state !== "opened") continue;
      const needsCycle = p.kind !== "chassis" && p.changes.some((c) => !HOT_SWAP[slotFamily(c.slot)] || slotFamily(c.slot) === "psu");
      if (needsCycle && cycling.size >= maxCycling) continue;
      execute(p);
      plans.splice(i--, 1);
    }
    // 2. breakers
    for (const id of Object.keys(state.racks).sort()) if (state.racks[id].breaker === "tripped") send({ type: "resetBreaker", rack: id });
    // 3. failed and degraded parts: order a like-for-like replacement
    for (const sid of Object.keys(state.servers).sort()) {
      if (busy.has(sid)) continue;
      const s = state.servers[sid];
      const changes: Change[] = [];
      for (const slot of SLOTS) { const pid = s.slots[slot]; if (pid && state.parts[pid].status !== "ok") changes.push({ slot, sku: state.parts[pid].sku }); }
      if (changes.length === 0) continue;
      const cost = changes.reduce((a, c) => a + partSpec(bal, c.sku)!.price, 0);
      if (state.cash >= cost) order({ kind: "replace", server: sid, changes, cost, dKw: 0 });
    }
    // 4. contracts it can serve with room to spare
    const committed = { cpu: 0, gpu: 0, tb: 0 };
    for (const c of state.contracts) if (c.state === "active") committed[c.unit] += c.demand;
    for (const c of state.contracts) {
      if (c.state !== "offer" || c.type === "training" || c.type === "inference") continue;
      const cap = c.unit === "cpu" ? state.totals.cpu : c.unit === "gpu" ? state.totals.gpu : state.totals.tb;
      if (c.demand > (cap - committed[c.unit]) * 0.7) continue;
      if (send({ type: "acceptContract", contract: c.id }).ok) committed[c.unit] += c.demand;
    }
    // 5. Hall B the moment it is affordable
    const hallB = bal.facility.halls.B.price;
    if (!state.halls.B.owned && state.cash >= hallB) {
      hallBAt = realMinutesOf(bal, totalTicks);
      send({ type: "buyUpgrade", kind: "hall", target: "B" });
    }
    // 6. investments, best payback first; before Hall B only those that pay back sooner than saving for it would take
    const net = state.totals.incomePerHour - state.totals.costPerHour;
    const goal = !state.halls.B.owned ? hallB : !state.halls.C.owned ? bal.facility.halls.C.price : Infinity;
    const horizon = (): number => Math.min(60, goal === Infinity ? 60 : net > 0 ? Math.max(0, goal - state.cash) / net : 60);
    type Cand = { payback: number; cost: number; dKw: number; gain: number; go: () => boolean; what: string; target: string };
    const cands: Cand[] = [];
    const pendingKw = plans.reduce((a, p) => a + p.dKw, 0);
    const rackPending = (rid: RackId): number => plans.filter((p) => p.rack === rid || (p.server && state.servers[p.server]?.rack === rid)).reduce((a, p) => a + p.dKw, 0);
    for (const sid of Object.keys(state.servers).sort()) {
      const s = state.servers[sid];
      if (busy.has(sid) || s.power !== "on") continue;
      const old = configOf(sid), oldE = evalParts(bal, skus(old));
      const free = slotsOf("gpu").filter((g) => !old[g]);
      if (free.length === 0) continue;
      for (let t = 1; t <= maxTier("gpu"); t++) for (const k of free.length > 1 ? [1, free.length] : [1]) {
        const cfg: Config = { ...old };
        for (let i = 0; i < k; i++) cfg[free[i]] = skuOf("gpu", t);
        fixup(cfg);
        const e = evalParts(bal, skus(cfg));
        if (!e.boots || e.tempRiseC > 30) continue;
        const d = diff(old, cfg), gain = value(e.out, e.watts) - value(oldE.out, oldE.watts);
        if (gain <= 0) continue;
        const dKw = (e.watts - oldE.watts) / 1000;
        cands.push({ payback: d.cost / gain, cost: d.cost, dKw, gain, what: `${k}x ${skuOf("gpu", t)} in ${sid}`, target: sid,
          go: () => order({ kind: "upgrade", server: sid, rack: s.rack, changes: d.changes, cost: d.cost, dKw, first: firstBox.v === null }) });
      }
    }
    // new chassis in free bays (a new rack when there is no bay left)
    const reservedBay = new Set(plans.filter((p) => p.kind === "chassis").map((p) => `${p.rack}:${p.bay}`));
    const reservedSlot = new Set(plans.filter((p) => p.rackSlot).map((p) => `${p.rackSlot!.hall}:${p.rackSlot!.slot}`));
    const freeBays: { rack: RackId; bay: number }[] = [];
    for (const rid of Object.keys(state.racks).sort()) for (let bay = 1; bay <= bal.facility.baysPerRack && freeBays.length < 6; bay++)
      if (!state.racks[rid].servers[bay - 1] && !reservedBay.has(`${rid}:${bay}`)) freeBays.push({ rack: rid, bay });
    let rackSlot: Plan["rackSlot"];
    if (freeBays.length === 0) for (const h of ["A", "B", "C"] as const) {
      if (!state.halls[h].owned || rackSlot) continue;
      for (let i = 0; i < bal.facility.halls[h].slots; i++) {
        const id = `${h}-R${String(i + 1).padStart(2, "0")}`;
        if (!state.racks[id] && !reservedSlot.has(`${h}:${i}`)) { rackSlot = { hall: h, slot: i }; break; }
      }
    }
    for (let t = 1; t <= maxTier("gpu"); t++) {
      const cfg: Config = { CPU1: "cpu.k1", CPU2: "cpu.k1", NIC1: "nic.l1" };
      for (const r of slotsOf("ram")) cfg[r] = "ram.s1";
      for (const g of slotsOf("gpu")) cfg[g] = skuOf("gpu", t);
      for (const f of slotsOf("fan")) cfg[f] = "fan.z1";
      for (const p of slotsOf("psu")) cfg[p] = "psu.b1";
      fixup(cfg);
      const e = evalParts(bal, skus(cfg));
      if (!e.boots || e.tempRiseC > 30) continue;
      const d = diff({}, cfg), gain = value(e.out, e.watts), dKw = e.watts / 1000;
      const mk = (cost: number, where: { rack?: RackId; bay: number; rackSlot?: Plan["rackSlot"] }, extra: { sku: string; qty: number }[]): Cand =>
        ({ payback: cost / gain, cost, dKw, gain, what: `chassis with 4x ${skuOf("gpu", t)}`, target: where.rackSlot ? "new rack" : `${where.rack}:${where.bay}`,
          go: () => order({ kind: "chassis", ...where, changes: d.changes, cost, dKw }, extra) });
      for (const b of freeBays) cands.push(mk(d.cost + bal.shop.items.chassis, b, [{ sku: "chassis", qty: 1 }]));
      if (rackSlot) cands.push(mk(d.cost + bal.shop.items.chassis + bal.shop.items.rack, { bay: 1, rackSlot }, [{ sku: "rack", qty: 1 }, { sku: "chassis", qty: 1 }]));
    }
    cands.sort((a, b) => a.payback - b.payback || a.cost - b.cost || (a.what < b.what ? -1 : 1));
    const usedTargets = new Set<string>();
    let addedKw = 0; jobCredit = Math.min(2, jobCredit + jobsPerHour);
    for (const c of cands) {
      if (jobCredit < 1) break;
      const key = c.target;
      if (usedTargets.has(key)) continue;
      const reserve = 1000;
      // facility power and cooling: buy the next tier when this purchase would run into the cap
      let infra = 0;
      const projected = state.totals.kw + pendingKw + addedKw + c.dKw;
      const nextPower = bal.facility.powerTiers.find((x) => x.kw > state.powerCapKw);
      const nextCool = bal.facility.coolingTiers.find((x) => x.kw > state.coolingCapKw);
      const needPower = projected > state.powerCapKw * 0.85, needCool = projected > state.coolingCapKw * 0.95;
      if (needPower) { if (!nextPower) continue; infra += nextPower.price; }
      if (needCool) { if (!nextCool) continue; infra += nextCool.price; }
      if ((c.cost + infra) / c.gain >= horizon() || state.cash - reserve < c.cost + infra) continue;
      if (needPower) send({ type: "buyUpgrade", kind: "power" });
      if (needCool) send({ type: "buyUpgrade", kind: "cooling" });
      if (c.go()) {
        usedTargets.add(key); addedKw += c.dKw; jobCredit -= 1;
        const plan = plans[plans.length - 1];
        if (plan.first && firstBox.v === null) firstBox.v = { server: plan.server!, before: 0, cost: c.cost, predicted: realMinutesOf(bal, c.payback * tph), what: c.what, installed: false };
        const rid = plan.rack ?? (plan.server ? state.servers[plan.server].rack : undefined);
        if (rid && state.racks[rid] && state.racks[rid].pduCapKw < bal.facility.pduUpgradedKw && state.racks[rid].kw + rackPending(rid) > bal.facility.pduBaseKw * 0.9)
          send({ type: "buyUpgrade", kind: "pdu", target: rid });
      }
    }
  };

  const totalTicks = Math.round((realMinutes * 60000) / bal.time.tickMs);
  for (let i = 0; i < totalTicks; i++) {
    if (i % tph === 0) {
      hourlyDecisions();
      if (i % (tph * 10) === 0) timeline.push({ realMinute: Math.round(realMinutesOf(bal, i) * 10) / 10, cash: Math.round(state.cash), incomePerHour: Math.round(state.totals.incomePerHour), servers: Object.keys(state.servers).length });
    }
    for (const e of tick(state, bal)) {
      if (e.kind === "part_status" && (e.data as { status: string }).status === "degraded") partFailures++;
      if (e.kind === "alert" && (e.data as { kind: string }).kind === "sla_breach") breaches++;
    }
  }
  return { realMinutes, firstUpgrade, hallBAffordableRealMinutes: hallBAt, cashEnd: Math.round(state.cash), incomePerHourEnd: Math.round(state.totals.incomePerHour),
    servers: Object.keys(state.servers).length, partFailures, breaches, refusals, timeline };
}

/** A facility nobody touches: the third balance gate. */
export function runIdle(bal: Balance, gameDays: number, seed = 7): { startCash: number; endCash: number; minCash: number; degraded: number; failed: number; state: State } {
  const state = newGame(bal, { seed, facilityName: "Idle" });
  const startCash = state.cash;
  let minCash = state.cash, degraded = 0, failed = 0;
  const n = gameDays * bal.time.hoursPerDay * bal.time.ticksPerGameHour;
  for (let i = 0; i < n; i++) {
    for (const e of tick(state, bal)) if (e.kind === "part_status") { if ((e.data as { status: string }).status === "degraded") degraded++; else failed++; }
    if (state.cash < minCash) minCash = state.cash;
  }
  return { startCash, endCash: state.cash, minCash, degraded, failed, state };
}
