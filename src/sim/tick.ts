// One 100 ms sim tick (SPEC section 9).
import type { Balance } from "./balance";
import { ticksPerDay, ticksPerHour } from "./balance";
import {
  addMilestone, clearAlerts, computeOutput, dayIndex, fillStat, getCache, markDirty, newLedgerDay, nextId, partTempOffset,
  raise, rebuildLists, rnd, rndInt, rndRange, settleCash, timeOfTick, today,
} from "./core";
import type { Cache } from "./core";
import { checkInstall, checkRemove, doInstall, doRemove } from "./ops";
import { HALLS, SLOTS } from "./state";
import type { Contract, ContractType, Hall, Job, PowerState, Rack, SimEvent, State } from "./state";

const POWER_CODE: Record<PowerState, number> = { off: 0, booting: 1, on: 2, shutdown_thermal: 3, no_power: 4 };

function trip(state: State, cache: Cache, ev: SimEvent[], rack: Rack, why: "pdu" | "facility"): void {
  rack.breaker = "tripped";
  for (const sid of rack.servers) {
    if (!sid) continue;
    const s = state.servers[sid];
    if (s.power === "on" || s.power === "booting") {
      s.power = "no_power"; delete s.bootDoneTick; s.watts = 0; s.load = 0;
      s.out = { cpu: 0, gpu: 0, tb: 0 }; s.bottleneck = "none";
      const st = cache.statById.get(sid)!; st.outKey = -1; st.gpuT3Out = 0; st.gpuInfOut = 0;
    }
  }
  const text = why === "pdu"
    ? `Rack ${rack.id} drew ${rack.kw.toFixed(1)} kW, over its ${rack.pduCapKw} kW PDU. Its breaker tripped.`
    : `Facility power went over the ${state.powerCapKw} kW cap. The breaker on ${rack.id}, the newest rack, tripped.`;
  rack.kw = 0;
  raise(state, ev, "breaker", "critical", rack.id, text);
  if (why === "facility") raise(state, ev, "power_cap", "critical", "facility", `Facility power cap of ${state.powerCapKw} kW exceeded.`);
  ev.push({ kind: "breaker_trip", target: rack.id, text, data: { why } });
}

/** Power states, temperatures, output, breakers, facility totals, hall air. `settle` jumps temperatures to their targets. */
export function physics(state: State, bal: Balance, ev: SimEvent[], settle = false): void {
  const cache = getCache(state);
  if (cache.listsDirty) rebuildLists(state, cache);
  const T = bal.thermal, tick = state.tick, servers = cache.servers, stats = cache.stats, racks = cache.racks;
  for (const r of racks) r.kw = 0;
  for (let i = 0; i < servers.length; i++) {
    const s = servers[i], st = stats[i], rack = cache.rackOf[i];
    if (st.dirty) fillStat(state, bal, s, st);
    let p = s.power;
    const powered = rack.breaker === "closed";
    const psuOk = st.supply > 0 && st.supply >= st.watts;
    if (p === "on" || p === "booting") {
      if (!powered || !psuOk) {
        p = "no_power";
        ev.push({ kind: "server_power", target: s.id, data: { power: p }, text: psuOk ? undefined : `${s.id} lost power: its power supplies cannot carry the load.` });
      }
    } else if (p === "no_power") {
      if (!s.wantOn) p = "off";
      else if (powered && psuOk) { p = "booting"; s.bootDoneTick = tick + bal.time.bootTicks; ev.push({ kind: "server_power", target: s.id, data: { power: p } }); }
    }
    // A server that shut down under a director-forced overheat (the demo) comes back by itself once the overheat has passed and it has cooled.
    // An ordinary thermal shutdown still has to be powered on by hand or by Claude.
    if (p === "shutdown_thermal" && s.wantOn && rack.overheatUntilTick <= tick && powered && psuOk && s.tempC + Math.max(st.hasCpu ? T.cpuOffsetC : 0, st.hasGpu ? T.gpuOffsetC : 0) < T.throttleC - T.alertHysteresisC) {
      p = "booting"; s.bootDoneTick = tick + bal.time.bootTicks; ev.push({ kind: "server_power", target: s.id, data: { power: p } });
    }
    if (p === "booting" && tick >= (s.bootDoneTick ?? 0)) { p = "on"; ev.push({ kind: "server_power", target: s.id, data: { power: p } }); }
    if (p !== "booting" && s.bootDoneTick !== undefined) delete s.bootDoneTick;
    let running = p === "on" || p === "booting";
    const air = state.halls[rack.hall].airC;
    let target = air;
    if (running) {
      const fan = rack.overheatUntilTick > tick ? 0 : st.fanCap;
      target = fan > 0 ? Math.min(T.maxServerC, air + (T.serverK * st.watts) / fan) : st.watts > 0 ? T.maxServerC : air;
    }
    s.tempC = settle ? target : s.tempC + (target - s.tempC) / T.serverTauTicks;
    const cpuT = st.hasCpu ? s.tempC + T.cpuOffsetC : s.tempC, gpuT = st.hasGpu ? s.tempC + T.gpuOffsetC : s.tempC;
    const hot = cpuT > gpuT ? cpuT : gpuT;
    if (running && hot > T.shutdownC) {
      p = "shutdown_thermal"; s.wantOn = rack.overheatUntilTick > tick; running = false; delete s.bootDoneTick;
      ev.push({ kind: "server_power", target: s.id, data: { power: p }, text: `${s.id} shut down at ${Math.round(hot)} °C.` });
    }
    const cpuThr = running && st.hasCpu && cpuT > T.throttleC, gpuThr = running && st.hasGpu && gpuT > T.throttleC;
    const lvl = p === "shutdown_thermal" ? 2 : cpuThr || gpuThr ? 1 : 0;
    if (lvl > s.thermalAlert) {
      if (lvl === 2) raise(state, ev, "thermal", "critical", s.id, `${s.id} overheated and shut down (${Math.round(hot)} °C). Fix its cooling, then power it on.`);
      else raise(state, ev, "thermal", "warn", s.id, `${s.id} is running hot (${Math.round(hot)} °C) and throttling to ${Math.round(T.throttleMult * 100)}%.`);
      s.thermalAlert = lvl;
    } else if (lvl < s.thermalAlert && (lvl > 0 || hot < T.throttleC - T.alertHysteresisC)) {
      if (lvl === 0) clearAlerts(state, ev, ["thermal"], s.id);
      s.thermalAlert = lvl as 0 | 1;
    }
    s.power = p;
    const w = running ? st.watts : 0;
    s.watts = w; s.load = running ? 1 : 0;
    rack.kw += w / 1000;
    const key = POWER_CODE[p] * 8 + (psuOk ? 4 : 0) + (cpuThr ? 1 : 0) + (gpuThr ? 2 : 0);
    if (key !== st.outKey) {
      st.outKey = key;
      if (p === "on") {
        const o = computeOutput(bal, st, cpuThr, gpuThr);
        s.out = { cpu: o.cpu, gpu: o.gpu, tb: o.tb }; s.bottleneck = o.bottleneck;
        st.gpuT3Out = o.gpuT3;
        st.gpuInfOut = st.nic >= bal.contracts.inferenceMinGbps && !cpuThr && !gpuThr ? o.gpu : 0;
      } else {
        s.out = { cpu: 0, gpu: 0, tb: 0 }; st.gpuT3Out = 0; st.gpuInfOut = 0;
        s.bottleneck = p === "no_power" && !psuOk ? "psu" : "none";
      }
      s.redundantPsu = st.psuCount >= 2 && st.supplyMinusMax >= st.watts;
    }
  }
  // breakers
  let total = 0;
  for (const r of racks) {
    if (r.breaker === "closed" && r.kw > r.pduCapKw + 1e-9) trip(state, cache, ev, r, "pdu");
    total += r.kw;
  }
  while (total > state.powerCapKw + 1e-9) {
    let newest: Rack | undefined;
    for (const r of racks) if (r.breaker === "closed" && r.kw > 0 && (!newest || r.seq > newest.seq)) newest = r;
    if (!newest) break;
    total -= newest.kw;
    trip(state, cache, ev, newest, "facility");
  }
  // totals and hall heat
  const t = state.totals;
  let cpu = 0, gpu = 0, tb = 0, gT = 0, gI = 0;
  for (let i = 0; i < servers.length; i++) {
    const o = servers[i].out;
    cpu += o.cpu; gpu += o.gpu; tb += o.tb; gT += stats[i].gpuT3Out; gI += stats[i].gpuInfOut;
  }
  t.cpu = cpu; t.gpu = gpu; t.tb = tb; t.gpuTrain = gT; t.gpuInf = gI; t.kw = total;
  for (const h of HALLS) state.halls[h].heatKw = 0;
  let heat = 0;
  for (const r of racks) {
    const h = r.rearDoor ? Math.max(0, r.kw - bal.facility.rearDoorKw) : r.kw;
    state.halls[r.hall].heatKw += h; heat += h;
  }
  t.heatKw = heat;
  const tau = T.airTauHours * bal.time.ticksPerGameHour;
  for (const h of HALLS) {
    const hall = state.halls[h];
    hall.coolingKw = heat > 0 ? (state.coolingCapKw * hall.heatKw) / heat : 0;
    if (!hall.owned) continue;
    const target = Math.min(T.maxAirC, T.baseAirC + T.degPerKwOver * Math.max(0, hall.heatKw - hall.coolingKw));
    hall.airC = settle ? target : hall.airC + (target - hall.airC) / tau;
  }
  const warn = total > state.powerCapKw * bal.facility.powerWarnPct;
  if (warn && !state.powerWarn) raise(state, ev, "power_cap", "warn", "facility", `Facility power is at ${Math.round((total / state.powerCapKw) * 100)}% of the ${state.powerCapKw} kW cap.`);
  if (!warn && state.powerWarn) clearAlerts(state, ev, ["power_cap"], "facility");
  state.powerWarn = warn;
}

function deliveries(state: State, ev: SimEvent[]): void {
  for (const o of state.orders) {
    if (o.state !== "transit" || state.tick < o.arrivesTick) continue;
    o.state = "delivered";
    const text = `Order ${o.id} has arrived in the loading bay.`;
    raise(state, ev, "delivery", "info", o.id, text);
    ev.push({ kind: "delivery", target: o.id, text, data: { order: o.id, lines: o.lines } });
  }
}

function failJob(state: State, bal: Balance, ev: SimEvent[], job: Job, reason: string, message: string, refund: boolean): void {
  job.state = "failed"; job.reason = reason; job.doneTick = state.tick;
  if (job.part) { const p = state.parts[job.part]; if (p && p.where.kind === "gantry") p.where = { kind: "shelf" }; }
  if (refund) { state.cash += job.fee; today(state).costs.gantry -= job.fee; settleCash(state, bal); }
  const text = `Gantry job ${job.id} (${job.kind} ${job.slot} on ${job.server}) failed: ${message}`;
  raise(state, ev, "job_failed", "warn", job.id, text);
  ev.push({ kind: "job_failed", target: job.server, text, data: { job: job.id, reason, slot: job.slot } });
}
function jobProblem(state: State, bal: Balance, job: Job): { reason: string; message: string } | null {
  const s = state.servers[job.server];
  if (!s) return { reason: "not_found", message: `Server ${job.server} no longer exists.` };
  if (job.kind === "remove") return checkRemove(state, bal, s, job.slot);
  const part = job.part ? state.parts[job.part] : undefined;
  if (!part || part.where.kind !== "gantry") return { reason: "part_not_available", message: "The part is no longer available." };
  return checkInstall(bal, s, job.slot, part, s.slots[job.slot] !== undefined);
}
function gantry(state: State, bal: Balance, ev: SimEvent[], hall: Hall): void {
  const g = hall.gantry;
  if (g.running !== undefined) {
    if (state.tick < g.busyUntilTick) return;
    const job = state.jobs.find((j) => j.id === g.running)!;
    delete g.running;
    const bad = jobProblem(state, bal, job);
    if (bad) failJob(state, bal, ev, job, bad.reason, bad.message, false);
    else {
      const s = state.servers[job.server];
      if (job.kind === "install") doInstall(state, bal, ev, s, job.slot, state.parts[job.part!]);
      else job.part = doRemove(state, ev, s, job.slot, { kind: "shelf" }).id;
      job.state = "done"; job.doneTick = state.tick;
      const text = `Gantry job ${job.id} done: ${job.kind === "install" ? "installed" : "removed"} ${job.slot} on ${job.server}.`;
      raise(state, ev, "job_done", "info", job.id, text);
      ev.push({ kind: "job_done", target: job.server, text, data: { job: job.id, slot: job.slot, by: job.by, jobKind: job.kind } });
    }
  }
  while (g.running === undefined && g.queue.length > 0) {
    const job = state.jobs.find((j) => j.id === g.queue[0])!;
    g.queue.shift();
    const bad = jobProblem(state, bal, job);
    if (bad) { failJob(state, bal, ev, job, bad.reason, bad.message, true); continue; }
    job.state = "running"; g.running = job.id; g.busyUntilTick = state.tick + bal.gantry.jobTicks;
    ev.push({ kind: "job_start", target: job.server, data: { job: job.id, slot: job.slot, by: job.by, jobKind: job.kind, hall: hall.id, doneTick: g.busyUntilTick } });
  }
  if (state.jobs.length > 150) {
    const keep = state.jobs.filter((j) => j.state === "queued" || j.state === "running");
    const old = state.jobs.filter((j) => j.state === "done" || j.state === "failed").slice(-60);
    state.jobs = state.jobs.filter((j) => keep.includes(j) || old.includes(j));
  }
}

/** Marks an ok part degraded with a pending failure. */
export function degradePart(state: State, bal: Balance, ev: SimEvent[], partId: string, failsAtTick: number): void {
  const p = state.parts[partId];
  if (p.where.kind !== "slot") return;
  p.status = "degraded"; p.failsAtTick = failsAtTick;
  if (!state.degrading.includes(partId)) state.degrading.push(partId);
  markDirty(state, p.where.server);
  const target = `${p.where.server}/${p.where.slot}`;
  const text = `${bal.catalogue[p.sku].name} in ${p.where.slot} on ${p.where.server} is degraded and will fail soon.`;
  raise(state, ev, "part_degraded", "warn", target, text);
  ev.push({ kind: "part_status", target, text, data: { part: p.id, status: "degraded", sku: p.sku } });
}
function degradingPass(state: State, bal: Balance, ev: SimEvent[]): void {
  const list = state.degrading;
  let keep = 0;
  for (let i = 0; i < list.length; i++) {
    const p = state.parts[list[i]];
    if (!p || p.status !== "degraded" || p.failsAtTick === undefined || p.where.kind !== "slot") continue;
    if (state.tick < p.failsAtTick) { list[keep++] = list[i]; continue; }
    p.status = "failed"; p.failsAtTick = undefined;
    markDirty(state, p.where.server);
    const target = `${p.where.server}/${p.where.slot}`;
    clearAlerts(state, ev, ["part_degraded"], target);
    const text = `${bal.catalogue[p.sku].name} in ${p.where.slot} on ${p.where.server} has failed.`;
    raise(state, ev, "part_failed", "critical", target, text);
    ev.push({ kind: "part_status", target, text, data: { part: p.id, status: "failed", sku: p.sku } });
  }
  list.length = keep;
}

/** Wear and failure rolls, once per game hour per server, staggered across the hour. */
function wear(state: State, bal: Balance, ev: SimEvent[], cache: Cache): void {
  const tph = ticksPerHour(bal), W = bal.wear, servers = cache.servers;
  for (let i = state.tick % tph; i < servers.length; i += tph) {
    const s = servers[i];
    if (s.power !== "on" && s.power !== "booting") continue;
    for (const slot of SLOTS) {
      const pid = s.slots[slot];
      if (pid === undefined) continue;
      const p = state.parts[pid];
      if (p.status === "failed") continue;
      p.tempC = s.tempC + partTempOffset(bal, p.sku);
      p.health = Math.max(0, p.health - W.healthLossPerHour * s.load * Math.pow(2, (p.tempC - W.refC) / W.doubleEveryC));
      if (p.status === "degraded") {
        if (p.failsAtTick === undefined) { p.failsAtTick = state.tick + rndInt(state, W.failDelayHoursMin * tph, W.failDelayHoursMax * tph); state.degrading.push(pid); }
        continue;
      }
      const chance = W.failChancePerHour * (1 + (100 - p.health) / W.healthDivisor);
      if (rnd(state) < chance || p.health <= 0)
        degradePart(state, bal, ev, pid, state.tick + rndInt(state, W.failDelayHoursMin * tph, W.failDelayHoursMax * tph));
    }
  }
}

export const contractDayValue = (c: Contract, bal: Balance): number => c.demand * c.rate * bal.time.hoursPerDay;

function economy(state: State, bal: Balance): void {
  const tph = ticksPerHour(bal), R = bal.rates, t = state.totals, led = today(state);
  let cpu = t.cpu, tb = t.tb, G = t.gpu, T = t.gpuTrain, I = t.gpuInf;
  let contractPerHour = 0, soldCpu = 0, soldGpu = 0, soldTb = 0;
  let active: Contract[] | undefined;
  for (const c of state.contracts) if (c.state === "active") (active ??= []).push(c);
  if (active) {
    if (active.length > 1) active.sort((a, b) => b.rate - a.rate || (a.id < b.id ? -1 : 1));
    for (const c of active) {
      let d = 0;
      if (c.unit === "cpu") { d = Math.min(c.demand, cpu); cpu -= d; soldCpu += d; }
      else if (c.unit === "tb") { d = Math.min(c.demand, tb); tb -= d; soldTb += d; }
      else {
        const avail = c.type === "training" ? Math.min(G, T) : c.type === "inference" ? Math.min(G, I) : G;
        d = Math.min(c.demand, avail);
        if (d > 0) {
          const fT = T / G, fI = I / G;
          G -= d;
          T = Math.max(0, T - (c.type === "training" ? d : d * fT));
          I = Math.max(0, I - (c.type === "inference" ? d : d * fI));
          soldGpu += d;
        }
      }
      c.deliveredToday += d; c.demandedToday += c.demand;
      contractPerHour += d * c.rate;
    }
  }
  const spotPerHour = (cpu * R.cpu + G * R.gpu + tb * R.tb) * R.spotMult;
  const powerPerHour = t.kw * R.overhead * R.powerPerKwh;
  let halls = 0;
  for (const h of HALLS) if (state.halls[h].owned) halls++;
  const rentPerHour = halls * R.rentPerHallHour;
  led.income.spot += spotPerHour / tph; led.income.contracts += contractPerHour / tph;
  led.costs.power += powerPerHour / tph; led.costs.rent += rentPerHour / tph;
  state.cash += (spotPerHour + contractPerHour - powerPerHour - rentPerHour) / tph;
  t.sold.cpu = soldCpu; t.sold.gpu = soldGpu; t.sold.tb = soldTb;
  t.incomePerHour = spotPerHour + contractPerHour; t.costPerHour = powerPerHour + rentPerHour;
  settleCash(state, bal);
}

function setReputation(state: State, delta: number): void {
  state.reputation = Math.max(0, Math.min(100, state.reputation + delta));
}
/** Scores one contract's day (or its last part-day). SPEC Appendix G. */
function scoreContractDay(state: State, bal: Balance, ev: SimEvent[], c: Contract): void {
  const C = bal.contracts;
  if (c.demandedToday > 0) {
    const pct = (c.deliveredToday / c.demandedToday) * 100;
    if (pct < c.slaPct) {
      c.breachedDays++; c.breachStreak++;
      state.cash -= c.penaltyPerDay; today(state).costs.penalties += c.penaltyPerDay;
      setReputation(state, C.repPerBreach);
      const text = `Contract ${c.id} (${c.type}) delivered ${pct.toFixed(1)}% against a ${c.slaPct}% SLA. Penalty $${Math.round(c.penaltyPerDay)}.`;
      raise(state, ev, "sla_breach", "critical", c.id, text);
      if (c.breachStreak >= C.breachStreakEnd) {
        c.state = "breached";
        ev.push({ kind: "contract", target: c.id, text: `Contract ${c.id} ended: breached ${C.breachStreakEnd} days in a row.`, data: { state: c.state } });
      }
    } else {
      c.breachStreak = 0;
      if (state.repGainToday < C.repMaxPerDay) { state.repGainToday += C.repPerGoodDay; setReputation(state, C.repPerGoodDay); }
    }
  }
  c.deliveredToday = 0; c.demandedToday = 0;
  if (c.atRisk) { c.atRisk = false; clearAlerts(state, ev, ["sla_risk"], c.id); }
  settleCash(state, bal);
}

const TYPE_ORDER: ContractType[] = ["web", "archive", "render", "inference", "training"];
export function refreshOffers(state: State, bal: Balance, ev: SimEvent[]): void {
  const C = bal.contracts, R = bal.rates, t = state.totals;
  const finished = state.contracts.filter((c) => c.state === "done" || c.state === "breached").slice(-20);
  state.contracts = state.contracts.filter((c) => c.state === "active" || finished.includes(c));
  const unlocked = TYPE_ORDER.filter((k) => C.types[k].minRep <= state.reputation);
  const count = C.offersBase + Math.floor(state.reputation / C.offersPerRep);
  for (let i = 0; i < count; i++) {
    const type = unlocked[rndInt(state, 0, unlocked.length - 1)];
    const spec = C.types[type];
    const capacity = spec.unit === "cpu" ? t.cpu : spec.unit === "gpu" ? t.gpu : t.tb;
    const pct = rnd(state) < C.stretchChance ? C.stretchPct : rndRange(state, C.demandMinPct, C.demandMaxPct);
    const demand = Math.max(C.floors[spec.unit], Math.round(capacity * pct));
    const rate = Math.round(R[spec.unit] * rndRange(state, spec.multMin, spec.multMax) * 100) / 100;
    const days = rndInt(state, spec.daysMin, spec.daysMax);
    state.contracts.push({
      id: nextId(state, "contract"), type, unit: spec.unit, demand, rate, slaPct: spec.slaPct, startTick: 0, endTick: 0,
      penaltyPerDay: Math.round(C.penaltyPct * demand * rate * bal.time.hoursPerDay),
      deliveredToday: 0, demandedToday: 0, state: "offer", days, breachedDays: 0, breachStreak: 0, atRisk: false,
    });
  }
  ev.push({ kind: "offers", text: `${count} new contract offers are in.`, data: { count } });
}

function hourly(state: State, bal: Balance, ev: SimEvent[]): void {
  const tph = ticksPerHour(bal), C = bal.contracts;
  for (const a of state.alerts)
    if (!a.cleared && (a.kind === "job_done" || a.kind === "job_failed" || a.kind === "sla_breach") && state.tick - a.tick >= tph) a.cleared = true;
  for (const c of state.contracts) {
    if (c.state !== "active" || c.demandedToday <= 0) continue;
    const pct = (c.deliveredToday / c.demandedToday) * 100;
    const risk = pct < Math.min(100, c.slaPct + C.riskPoints);
    if (risk && !c.atRisk) raise(state, ev, "sla_risk", "warn", c.id, `Contract ${c.id} (${c.type}) is at ${pct.toFixed(1)}% today against a ${c.slaPct}% SLA.`);
    if (!risk && c.atRisk) clearAlerts(state, ev, ["sla_risk"], c.id);
    c.atRisk = risk;
  }
  if (state.totals.incomePerHour > bal.milestones.inTheBlackPerHour) addMilestone(state, ev, "in_the_black");
  if (state.totals.kw >= bal.milestones.megawattKw) addMilestone(state, ev, "megawatt");
  let hallA = 0;
  for (const id in state.racks) if (state.racks[id].hall === "A") hallA++;
  if (hallA >= bal.facility.halls.A.slots) addMilestone(state, ev, "full_house");
  if (state.halls.B.owned) addMilestone(state, ev, "second_hall");
  if (state.halls.C.owned) addMilestone(state, ev, "campus");
  if (state.orders.length > 60) state.orders = state.orders.filter((o) => o.state !== "opened").concat(state.orders.filter((o) => o.state === "opened").slice(-20)).sort((a, b) => (a.id < b.id ? -1 : 1));
}

function endOfDay(state: State, bal: Balance, ev: SimEvent[], newDay: number): void {
  for (const c of state.contracts) if (c.state === "active") scoreContractDay(state, bal, ev, c);
  if (state.cash < 0) {
    const interest = -state.cash * bal.money.interestPctPerDay;
    state.cash -= interest; today(state).costs.interest += interest;
    settleCash(state, bal);
  }
  state.repGainToday = 0;
  state.ledger.push(newLedgerDay(newDay + 1));
  if (state.ledger.length > 30) state.ledger.splice(0, state.ledger.length - 30);
  ev.push({ kind: "day", data: { day: newDay + 1 } });
}

/** Advance exactly one 100 ms sim tick (12 game seconds). Returns what happened. */
export function tick(state: State, bal: Balance): SimEvent[] {
  const cache = getCache(state);
  const ev: SimEvent[] = cache.pending.length ? cache.pending.splice(0) : [];
  const tph = ticksPerHour(bal);
  deliveries(state, ev);
  for (const h of HALLS) { const hall = state.halls[h]; if (hall.gantry.running !== undefined || hall.gantry.queue.length > 0) gantry(state, bal, ev, hall); }
  if (state.degrading.length > 0) degradingPass(state, bal, ev);
  physics(state, bal, ev);
  wear(state, bal, ev, cache);
  economy(state, bal);
  for (const c of state.contracts) {
    if (c.state !== "active" || state.tick + 1 < c.endTick) continue;
    scoreContractDay(state, bal, ev, c);
    if (c.state === "active") {
      c.state = "done";
      ev.push({ kind: "contract", target: c.id, text: `Contract ${c.id} (${c.type}) ran its full length.`, data: { state: c.state } });
      if (c.slaPct >= 99 && c.breachedDays === 0) addMilestone(state, ev, "five_nines");
    }
  }
  const next = state.tick + 1;
  if (next % tph === 0) hourly(state, bal, ev);
  const d = dayIndex(next, bal);
  if (d !== dayIndex(state.tick, bal)) endOfDay(state, bal, ev, d);
  const tm = timeOfTick(next, bal);
  if (next % tph === 0 && tm.hour === bal.contracts.refreshHour && tm.minute === 0) refreshOffers(state, bal, ev);
  state.tick = next;
  return ev;
}
export { ticksPerDay };
