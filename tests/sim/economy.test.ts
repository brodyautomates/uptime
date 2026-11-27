import { expect, test } from "vitest";
import { deserialize, evalParts, gameTime, newGame, partSpec, serialize, slotFamily, views } from "@sim/index";
import type { Balance, State } from "@sim/index";
import { buy, cmd, loadBalance, must, run } from "./helpers";

const rep = (sku: string, n: number): string[] => Array.from({ length: n }, () => sku);
const base = [...rep("psu.b5", 2), ...rep("fan.z3", 4)];
/** Edits a state the way a test needs and reloads it so derived sums are rebuilt. */
const edited = (s: State, bal: Balance, f: (s: State) => void): State => { f(s); return deserialize(serialize(s), bal); };

test("what a server delivers (section 9 formulas)", () => {
  const bal = loadBalance();
  // cpuUnits = min(sum of CPU units, RAM GB / 4)
  let e = evalParts(bal, [...base, ...rep("cpu.k1", 2), ...rep("ram.s1", 8), "nic.l1"]);
  expect(e.out.cpu).toBe(20); expect(e.out.bottleneck).toBe("none");
  e = evalParts(bal, [...base, ...rep("cpu.k5", 2), ...rep("ram.s1", 8), "nic.l4"]);
  expect(e.out.cpu).toBe(64); expect(e.out.bottleneck).toBe("ram");                 // 256 GB / 4
  // gpuUnits = min(sum of GPU units, RAM GB / 2, sum of CPU units x 10)
  e = evalParts(bal, [...base, ...rep("cpu.k1", 2), ...rep("ram.s2", 8), ...rep("gpu.v2", 4), "nic.l4"]);
  expect(e.out.gpu).toBe(180); expect(e.out.bottleneck).toBe("none");
  e = evalParts(bal, [...base, ...rep("cpu.k1", 2), ...rep("ram.s1", 8), ...rep("gpu.v2", 4), "nic.l4"]);
  expect(e.out.gpu).toBe(128); expect(e.out.bottleneck).toBe("ram");                 // 256 GB / 2
  e = evalParts(bal, [...base, ...rep("cpu.k1", 2), ...rep("ram.s5", 8), ...rep("gpu.v3", 4), "nic.l4"]);
  expect(e.out.gpu).toBe(200); expect(e.out.bottleneck).toBe("cpu");                 // 20 CPU units x 10
  // storage, and the NIC cap on cpu + gpu units (Gbps x 20)
  e = evalParts(bal, [...base, ...rep("cpu.k3", 2), ...rep("ram.s4", 8), ...rep("gpu.v3", 4), ...rep("drv.f3", 4), "nic.l1"]);
  expect(e.out.tb).toBe(32);
  expect(e.out.cpu + e.out.gpu).toBeCloseTo(200, 9); expect(e.out.bottleneck).toBe("nic");
  expect(e.out.gpu / e.out.cpu).toBeCloseTo(400 / 64, 9);
  expect(evalParts(bal, [...base, ...rep("cpu.k1", 2), ...rep("ram.s1", 8)]).out.cpu).toBe(0);     // no NIC, nothing gets out
  // power draw = sum of part watts; PSU supply and redundancy
  e = evalParts(bal, [...rep("psu.b1", 2), ...rep("fan.z1", 4), ...rep("cpu.k1", 2), ...rep("ram.s1", 8), ...rep("drv.f1", 2), "nic.l1"]);
  expect(e.watts).toBe(2 * 120 + 8 * 4 + 2 * 8); expect(e.supply).toBe(1600); expect(e.redundant).toBe(true); expect(e.boots).toBe(true);
  e = evalParts(bal, [...rep("psu.b1", 2), ...rep("fan.z1", 4), ...rep("cpu.k1", 2), ...rep("ram.s1", 8), ...rep("gpu.v1", 4), "nic.l1"]);
  expect(e.watts).toBe(1272); expect(e.redundant).toBe(false); expect(e.boots).toBe(true);        // one 800 W PSU cannot carry it
  e = evalParts(bal, [...rep("psu.b1", 2), ...rep("fan.z1", 4), ...rep("cpu.k1", 2), ...rep("ram.s1", 8), ...rep("gpu.v3", 4), "nic.l1"]);
  expect(e.boots).toBe(false);                                                                     // 1,872 W against 1,600 W
});

test("the start state: 160 compute units, about $290 per game hour on spot", () => {
  const bal = loadBalance(), s = newGame(bal, { seed: 1, facilityName: "Start" });
  expect(s.cash).toBe(25000); expect(s.reputation).toBe(20);
  expect(Object.keys(s.racks)).toEqual(["A-R01", "A-R02"]);
  expect(Object.keys(s.servers).length).toBe(8);
  expect(s.racks["A-R01"].servers.slice(0, 4)).toEqual(["A-R01-S01", "A-R01-S02", "A-R01-S03", "A-R01-S04"]);
  expect(Object.keys(s.parts).length).toBe(8 * 19);
  expect(Object.values(s.parts).some((p) => p.sku.startsWith("gpu."))).toBe(false);
  expect(Object.values(s.parts).every((p) => partSpec(bal, p.sku)!.tier === 1 && p.where.kind === "slot" && slotFamily(p.where.slot) === partSpec(bal, p.sku)!.family)).toBe(true);
  expect(s.totals.cpu).toBe(160);
  expect(gameTime(s, bal)).toEqual({ day: 1, hour: 6, minute: 0 });
  run(s, bal, bal.time.ticksPerGameHour);
  expect(gameTime(s, bal)).toEqual({ day: 1, hour: 7, minute: 0 });
  const led = s.ledger[0];
  expect(led.income.spot).toBeCloseTo((160 * bal.rates.cpu + 32 * bal.rates.tb) * bal.rates.spotMult, 6);   // 292.8
  expect(led.income.spot).toBeGreaterThan(280); expect(led.income.spot).toBeLessThan(300);
  expect(led.costs.power).toBeCloseTo(8 * 0.288 * bal.rates.overhead * bal.rates.powerPerKwh, 6);
  expect(led.costs.rent).toBeCloseTo(50, 6);
  expect(s.cash).toBeCloseTo(25000 + led.income.spot - led.costs.power - led.costs.rent, 6);
});

test("degraded parts count at 50%, failed parts at zero; a failure goes degraded first and fails 2 to 6 game hours later", () => {
  const bal = loadBalance();
  let s = newGame(bal, { seed: 1, facilityName: "Wear", demo: true });
  const cpu = s.servers["A-R01-S01"].slots.CPU1!;
  s = edited(s, bal, (x) => { x.parts[cpu].status = "degraded"; });
  run(s, bal, 1);
  expect(s.servers["A-R01-S01"].out.cpu).toBe(15);
  s = edited(s, bal, (x) => { x.parts[cpu].status = "failed"; });
  run(s, bal, 1);
  expect(s.servers["A-R01-S01"].out.cpu).toBe(10);
  expect(s.servers["A-R01-S01"].watts).toBe(288 - 120);
  // health loss per game hour = 0.02 x load x 2^((temp - 60) / 10)
  const t = newGame(bal, { seed: 4, facilityName: "Wear" });
  const ram = t.parts[t.servers["A-R02-S03"].slots.RAM1!], c2 = t.parts[t.servers["A-R02-S03"].slots.CPU2!];
  run(t, bal, bal.time.ticksPerGameHour);
  const temp = 22 + 18 * (288 / 1600);
  expect(t.servers["A-R02-S03"].tempC).toBeCloseTo(temp, 6);
  expect(ram.health).toBeCloseTo(100 - 0.02 * Math.pow(2, (temp - 60) / 10), 9);
  expect(c2.tempC).toBeCloseTo(temp + 25, 6);
  expect(c2.health).toBeCloseTo(100 - 0.02 * Math.pow(2, (temp + 25 - 60) / 10), 9);
  // natural failures over 6 game days: each is degraded first, then fails 2 to 6 game hours later
  const u = newGame(bal, { seed: 12, facilityName: "Wear" });
  const degradedAt = new Map<string, number>();
  let failures = 0;
  for (let i = 0; i < 6 * 7200; i++) for (const e of run(u, bal, 1)) {
    if (e.kind !== "part_status") continue;
    const d = e.data as { part: string; status: string };
    if (d.status === "degraded") degradedAt.set(d.part, u.tick);
    else {
      failures++;
      const hours = (u.tick - degradedAt.get(d.part)!) / bal.time.ticksPerGameHour;
      expect(hours).toBeGreaterThanOrEqual(2); expect(hours).toBeLessThanOrEqual(6.01);
    }
  }
  expect(degradedAt.size).toBeGreaterThanOrEqual(3);      // about 0.076 events per game hour expected
  expect(degradedAt.size).toBeLessThanOrEqual(25);
  expect(failures).toBeGreaterThanOrEqual(1);
  expect(u.alerts.some((a) => a.kind === "part_failed" && !a.cleared)).toBe(true);
});

test("heat: hall air, server temperature, throttling at 85 and shutdown at 95", () => {
  const bal = loadBalance();
  bal.facility.coolingTiers[0].kw = 1;
  const s = newGame(bal, { seed: 1, facilityName: "Heat", demo: true });
  const heat = 8 * 0.288;
  expect(s.halls.A.heatKw).toBeCloseTo(heat, 9);
  expect(s.halls.A.coolingKw).toBeCloseTo(1, 9);
  expect(s.halls.A.airC).toBeCloseTo(22 + 1.5 * (heat - 1), 6);        // newGame starts settled
  expect(s.servers["A-R01-S01"].tempC).toBeCloseTo(s.halls.A.airC + 18 * (288 / 1600), 6);
  // a rear-door cooler removes up to 10 kW of that rack's heat; air then relaxes with a 2 game-hour time constant
  must(s, bal, { by: "player", type: "buyUpgrade", kind: "rear_door", target: "A-R01" });
  const before = s.halls.A.airC, target = 22 + 1.5 * (heat / 2 - 1);
  run(s, bal, 600);
  expect(s.halls.A.heatKw).toBeCloseTo(heat / 2, 9);
  expect((s.halls.A.airC - target) / (before - target)).toBeCloseTo(Math.exp(-1), 2);
  // overheat a rack: amber (throttle, 50% output) then red (shutdown) within about 8 real seconds
  const t = newGame(loadBalance(), { seed: 1, facilityName: "Heat", demo: true });
  const b2 = loadBalance();
  must(t, b2, { by: "director", type: "director.overheatRack", rack: "A-R01" });
  let throttledAt = -1, shutAt = -1;
  for (let i = 1; i <= 80; i++) {
    run(t, b2, 1);
    const sv = t.servers["A-R01-S01"];
    if (throttledAt < 0 && sv.bottleneck === "thermal") { throttledAt = i; expect(sv.out.cpu).toBe(10); expect(sv.tempC + 25).toBeGreaterThan(85); }
    if (shutAt < 0 && sv.power === "shutdown_thermal") { shutAt = i; expect(sv.tempC + 25).toBeGreaterThan(95); }
  }
  expect(throttledAt).toBeGreaterThan(0); expect(shutAt).toBeGreaterThan(throttledAt); expect(shutAt).toBeLessThanOrEqual(80);
  expect(t.servers["A-R02-S01"].power).toBe("on");
  expect(t.alerts.filter((a) => a.kind === "thermal" && a.severity === "critical" && !a.cleared).length).toBe(4);
  expect(t.servers["A-R01-S01"].out.cpu).toBe(0);
  // a director-forced overheat (the demo) passes by itself: the server cools, boots and the alert clears with no command
  run(t, b2, b2.director.overheatTicks + 40);
  expect(["booting", "on"]).toContain(t.servers["A-R01-S01"].power);
  run(t, b2, b2.time.bootTicks + 60);
  expect(t.servers["A-R01-S01"].power).toBe("on");
  expect(t.servers["A-R01-S01"].power).toBe("on");
  expect(t.alerts.some((a) => a.kind === "thermal" && a.target === "A-R01-S01" && !a.cleared)).toBe(false);
});

test("PSU redundancy: a redundant server survives a PSU failure, a non-redundant one loses power and comes back when fixed", () => {
  const bal = loadBalance();
  let s = newGame(bal, { seed: 1, facilityName: "PSU" });
  const S1 = "A-R01-S01";
  expect(s.servers[S1].redundantPsu).toBe(true);
  s = edited(s, bal, (x) => { x.parts[x.servers[S1].slots.PSU1!].status = "failed"; });
  run(s, bal, 2);
  expect(s.servers[S1].power).toBe("on"); expect(s.servers[S1].redundantPsu).toBe(false);
  // load it up with 4 GPUs: 1,288 W on 2 x 800 W, no longer redundant
  const t = newGame(bal, { seed: 1, facilityName: "PSU" });
  const gpus = buy(t, bal, [{ sku: "gpu.v1", qty: 4 }, { sku: "psu.b1", qty: 1 }]);
  must(t, bal, { by: "player", type: "setServerPower", server: S1, on: false });
  (["GPU1", "GPU2", "GPU3", "GPU4"] as const).forEach((slot, i) => must(t, bal, { by: "player", type: "installPart", server: S1, slot, part: gpus[i] }));
  expect(t.milestones).toContain("first_light");
  must(t, bal, { by: "player", type: "setServerPower", server: S1, on: true });
  expect(t.servers[S1].power).toBe("booting");
  run(t, bal, bal.time.bootTicks - 1); expect(t.servers[S1].power).toBe("booting"); expect(t.servers[S1].out.gpu).toBe(0);
  run(t, bal, 2); expect(t.servers[S1].power).toBe("on");
  expect(t.servers[S1].out).toEqual({ cpu: 20, gpu: 80, tb: 4 });
  expect(t.servers[S1].watts).toBe(1288); expect(t.servers[S1].redundantPsu).toBe(false);
  expect(cmd(t, bal, { by: "player", type: "removePart", server: S1, slot: "PSU1" })).toMatchObject({ ok: false, reason: "psu_not_redundant" });
  let u = edited(t, bal, (x) => { x.parts[x.servers[S1].slots.PSU2!].status = "failed"; });
  run(u, bal, 1);
  expect(u.servers[S1].power).toBe("no_power"); expect(u.servers[S1].bottleneck).toBe("psu"); expect(u.servers[S1].out.gpu).toBe(0);
  // swap the dead PSU by hand (hot swap): the server boots by itself
  const dead = must(u, bal, { by: "player", type: "removePart", server: S1, slot: "PSU2" }) as { part: string };
  expect((must(u, bal, { by: "player", type: "sellPart", part: dead.part }) as { amount: number }).amount).toBe(Math.round(250 * 0.4 * bal.shop.sellbackFailedMult));
  must(u, bal, { by: "player", type: "installPart", server: S1, slot: "PSU2", part: gpus[4] });
  run(u, bal, 1); expect(u.servers[S1].power).toBe("booting");
  run(u, bal, bal.time.bootTicks + 1); expect(u.servers[S1].power).toBe("on");
  u = u;
});

test("breakers: facility cap trips the newest rack, a PDU cap trips its own rack, reset re-trips within one tick if still over", () => {
  const bal = loadBalance();
  bal.facility.powerTiers[0].kw = 2;                        // 8 servers draw 2.304 kW
  const s = newGame(bal, { seed: 1, facilityName: "Breaker" });
  run(s, bal, 1);
  expect(s.racks["A-R02"].breaker).toBe("tripped"); expect(s.racks["A-R01"].breaker).toBe("closed");
  expect(s.totals.kw).toBeCloseTo(1.152, 9);
  expect(s.servers["A-R02-S01"].power).toBe("no_power"); expect(s.totals.cpu).toBe(80);
  expect(s.alerts.filter((a) => !a.cleared).map((a) => a.kind).sort()).toEqual(["breaker", "power_cap"]);
  run(s, bal, 50); expect(s.racks["A-R02"].breaker).toBe("tripped");                 // stays tripped until someone resets it
  expect(must(s, bal, { by: "claude", type: "resetBreaker", rack: "A-R02" })).toEqual({ breaker: "closed" });
  expect(s.alerts.some((a) => a.kind === "breaker" && !a.cleared)).toBe(false);
  const again = run(s, bal, 1);
  expect(s.racks["A-R02"].breaker).toBe("tripped");                                  // load still over: trips again within one tick
  expect(again.some((e) => e.kind === "breaker_trip" && e.target === "A-R02")).toBe(true);
  // shed load, then the reset holds and the rack's servers boot by themselves
  must(s, bal, { by: "player", type: "setServerPower", server: "A-R01-S01", on: false });
  must(s, bal, { by: "player", type: "setServerPower", server: "A-R01-S02", on: false });
  must(s, bal, { by: "player", type: "resetBreaker", rack: "A-R02" });
  run(s, bal, bal.time.bootTicks + 2);
  expect(s.racks["A-R02"].breaker).toBe("closed"); expect(s.servers["A-R02-S01"].power).toBe("on"); expect(s.totals.cpu).toBe(120);
  // PDU cap: a showcase rack with its PDU put back to 15 kW
  const b2 = loadBalance();
  let t = newGame(b2, { seed: 1, facilityName: "PDU", preset: "showcase" });
  expect(t.racks["A-R03"].kw).toBeGreaterThan(15);
  t = edited(t, b2, (x) => { x.racks["A-R03"].pduCapKw = 15; });
  run(t, b2, 1);
  expect(t.racks["A-R03"].breaker).toBe("tripped"); expect(t.racks["A-R03"].kw).toBe(0);
  expect(Object.values(t.racks).filter((r) => r.breaker === "tripped").length).toBe(1);
  must(t, b2, { by: "player", type: "buyUpgrade", kind: "pdu", target: "A-R03" });
  must(t, b2, { by: "player", type: "resetBreaker", rack: "A-R03" });
  run(t, b2, b2.time.bootTicks + 2);
  expect(t.racks["A-R03"].breaker).toBe("closed"); expect(t.racks["A-R03"].kw).toBeGreaterThan(15);
});

test("delivery times, crates, gantry jobs ($25, 8 real seconds, one per hall, first in first out)", () => {
  const bal = loadBalance(), s = newGame(bal, { seed: 1, facilityName: "Shop" });
  const std = must(s, bal, { by: "player", type: "placeOrder", lines: [{ sku: "fan.z2", qty: 2 }, { sku: "rack", qty: 1 }, { sku: "chassis", qty: 2 }, { sku: "cart", qty: 1 }] }) as { order: string; cost: number; arrivesTick: number };
  expect(std.cost).toBe(240 + 3000 + 2400 + 300); expect(std.arrivesTick).toBe(600);
  const exp = must(s, bal, { by: "player", type: "placeOrder", lines: [{ sku: "drv.f1", qty: 1 }], express: true }) as { order: string; cost: number; arrivesTick: number };
  expect(exp.cost).toBe(250); expect(exp.arrivesTick).toBe(200);
  expect(s.cash).toBe(25000 - 5940 - 250);
  run(s, bal, 200); expect(s.orders[1].state).toBe("transit");
  run(s, bal, 1); expect(s.orders[1].state).toBe("delivered"); expect(s.orders[0].state).toBe("transit");
  expect(s.alerts.some((a) => a.kind === "delivery" && a.target === exp.order && !a.cleared)).toBe(true);
  run(s, bal, 400); expect(s.orders[0].state).toBe("delivered");
  must(s, bal, { by: "player", type: "openCrate", order: std.order });
  expect(s.stock).toEqual({ racks: 1, chassis: 2, cart: true });
  expect((must(s, bal, { by: "player", type: "placeRack", hall: "A", slot: 2 }) as { rack: string }).rack).toBe("A-R03");
  expect(s.racks["A-R03"].slot).toBe(2);
  expect((must(s, bal, { by: "player", type: "placeChassis", rack: "A-R03", bay: 10 }) as { server: string }).server).toBe("A-R03-S10");
  expect(s.stock).toEqual({ racks: 0, chassis: 1, cart: true });
  // gantry: Claude swaps a fan using a part from a delivered crate and the shelf
  const fans = Object.values(s.parts).filter((p) => p.sku === "fan.z2").map((p) => p.id);
  const cash = s.cash, old = s.servers["A-R01-S01"].slots.FAN1!;
  const j1 = must(s, bal, { by: "claude", type: "queueJob", kind: "remove", server: "A-R01-S01", slot: "FAN1" }) as { job: string; etaSeconds: number };
  const j2 = must(s, bal, { by: "claude", type: "queueJob", kind: "install", server: "A-R01-S01", slot: "FAN1", part: fans[0] }) as { job: string; etaSeconds: number };
  expect(j1.etaSeconds).toBe(8); expect(j2.etaSeconds).toBe(16);
  expect(s.cash).toBeCloseTo(cash - 50, 6);
  expect(s.parts[fans[0]].where).toEqual({ kind: "gantry", job: j2.job });
  const starts: number[] = [], dones: number[] = [];
  for (let i = 0; i < 170; i++) for (const e of run(s, bal, 1)) { if (e.kind === "job_start") starts.push(s.tick); if (e.kind === "job_done") dones.push(s.tick); }
  expect(dones.length).toBe(2);
  expect(dones[0] - starts[0]).toBe(bal.gantry.jobTicks); expect(dones[1] - dones[0]).toBe(bal.gantry.jobTicks);
  expect(s.servers["A-R01-S01"].slots.FAN1).toBe(fans[0]);
  expect(s.parts[old].where).toEqual({ kind: "shelf" });
  expect(s.servers["A-R01-S01"].power).toBe("on");                 // fans are hot-swap
  // a job that cannot run fails with a reason and gives the fee back
  const c3 = s.cash;
  must(s, bal, { by: "claude", type: "queueJob", kind: "remove", server: "A-R01-S02", slot: "CPU1" });
  const ev = run(s, bal, 2);
  expect(s.jobs[2]).toMatchObject({ state: "failed", reason: "needs_power_off" });
  expect(ev.some((e) => e.kind === "job_failed")).toBe(true);
  expect(s.alerts.some((a) => a.kind === "job_failed" && !a.cleared)).toBe(true);
  expect(s.cash - c3).toBeGreaterThan(0);
  // sell-back at 40%
  expect((must(s, bal, { by: "player", type: "sellPart", part: old }) as { amount: number }).amount).toBe(16);
  // the player can carry one part in hand and 12 on the cart
  const r1 = must(s, bal, { by: "player", type: "removePart", server: "A-R02-S01", slot: "FAN1" }) as { where: string };
  const r2 = must(s, bal, { by: "player", type: "removePart", server: "A-R02-S01", slot: "FAN2" }) as { where: string };
  expect([r1.where, r2.where]).toEqual(["hand", "cart"]);
});

test("contracts: served before spot, highest rate first; SLA breach pays the penalty and costs reputation", () => {
  const bal = loadBalance();
  let s = newGame(bal, { seed: 1, facilityName: "Contracts" });
  const tpd = 7200;
  const mk = (id: string, demand: number, rate: number, slaPct: number, days: number) => ({ id, type: "web" as const, unit: "cpu" as const, demand, rate, slaPct,
    startTick: 0, endTick: days * tpd, penaltyPerDay: Math.round(0.2 * demand * rate * 24), deliveredToday: 0, demandedToday: 0, state: "active" as const, days, breachedDays: 0, breachStreak: 0, atRisk: false });
  s = edited(s, bal, (x) => { x.contracts = [mk("c_a", 200, 2.5, 95, 9), mk("c_b", 100, 3.0, 99, 1)]; });
  run(s, bal, 300);
  // 160 units: c_b (higher rate) gets its 100, c_a gets the remaining 60 of its 200, nothing is left for spot
  expect(s.totals.sold.cpu).toBe(160);
  expect(s.ledger[0].income.contracts).toBeCloseTo(100 * 3.0 + 60 * 2.5, 6);
  expect(s.ledger[0].income.spot).toBeCloseTo(32 * 0.25 * 0.6, 6);
  expect((views.contracts(s, bal, "active") as { id: string; deliveredPctToday: number }[]).map((c) => [c.id, c.deliveredPctToday])).toEqual([["c_a", 30], ["c_b", 100]]);
  expect(s.alerts.some((a) => a.kind === "sla_risk" && a.target === "c_a" && !a.cleared)).toBe(true);
  const cashBefore = s.cash;
  run(s, bal, 18 * 300 - 300);                    // to midnight of day 1
  expect(gameTime(s, bal)).toEqual({ day: 2, hour: 0, minute: 0 });
  const a = s.contracts.find((c) => c.id === "c_a")!, b = s.contracts.find((c) => c.id === "c_b")!;
  expect(a.breachedDays).toBe(1); expect(b.breachedDays).toBe(0);
  expect(s.ledger[0].costs.penalties).toBe(a.penaltyPerDay);
  expect(a.penaltyPerDay).toBe(0.2 * 200 * 2.5 * 24);          // 20% of one day's value
  expect(s.reputation).toBe(20 - 5 + 1);
  expect(s.cash).toBeLessThan(cashBefore + 17 * 500);
  expect(s.alerts.some((x) => x.kind === "sla_breach" && x.target === "c_a")).toBe(true);
  // c_b (99% SLA, 1 day) runs its full length clean: Five nines
  run(s, bal, 6 * 300);
  expect(b.state).toBe("done"); expect(s.milestones).toContain("five_nines");
  // three breached days in a row end the contract as breached
  expect(s.reputation).toBe(17);
  run(s, bal, 2 * tpd);                           // alone, c_a gets 160 of 200 = 80%: two more breached days
  expect(a.state).toBe("breached"); expect(a.breachedDays).toBe(3);
  expect(s.reputation).toBe(17 - 10);
  // cancelling costs 10 reputation and one day's value
  const t = newGame(bal, { seed: 5, facilityName: "Cancel" });
  const offer = t.contracts[0];
  must(t, bal, { by: "player", type: "acceptContract", contract: offer.id });
  const c0 = t.cash;
  must(t, bal, { by: "player", type: "cancelContract", contract: offer.id });
  expect(t.reputation).toBe(10); expect(t.cash).toBeCloseTo(c0 - offer.demand * offer.rate * 24, 6);
});

test("contract offers follow Appendix G", () => {
  const bal = loadBalance();
  for (const [preset, rep] of [["fresh", 20], ["showcase", 55], ["mega", 80]] as const) {
    const s = newGame(bal, { seed: 3, facilityName: "Offers", preset });
    const offers = s.contracts.filter((c) => c.state === "offer");
    expect(offers.length).toBe(3 + Math.floor(rep / 20));
    for (const o of offers) {
      const spec = bal.contracts.types[o.type];
      expect(spec.minRep).toBeLessThanOrEqual(rep);
      expect(o.unit).toBe(spec.unit); expect(o.slaPct).toBe(spec.slaPct);
      expect(o.days).toBeGreaterThanOrEqual(spec.daysMin); expect(o.days).toBeLessThanOrEqual(spec.daysMax);
      const mult = o.rate / bal.rates[o.unit];
      expect(mult).toBeGreaterThanOrEqual(spec.multMin - 0.01); expect(mult).toBeLessThanOrEqual(spec.multMax + 0.01);
      const capacity = s.totals[o.unit];
      expect(o.demand).toBeGreaterThanOrEqual(Math.min(bal.contracts.floors[o.unit], Math.round(capacity * 0.1)));
      expect(o.demand).toBeLessThanOrEqual(Math.max(bal.contracts.floors[o.unit], Math.round(capacity * 1.2)));
      expect(o.penaltyPerDay).toBe(Math.round(0.2 * o.demand * o.rate * 24));
    }
    // offers refresh at 06:00 each game day; unaccepted ones go
    const first = offers.map((o) => o.id);
    run(s, bal, 7199); expect(s.contracts.filter((c) => c.state === "offer").map((o) => o.id)).toEqual(first);
    run(s, bal, 1); expect(s.contracts.filter((c) => c.state === "offer").some((o) => first.includes(o.id))).toBe(false);
  }
});

test("money trouble: debt floor, 2% interest per game day, shop blocked until cash is above zero", () => {
  const bal = loadBalance(), s = newGame(bal, { seed: 1, facilityName: "Debt", demo: true });
  for (const sid of Object.keys(s.servers)) must(s, bal, { by: "player", type: "setServerPower", server: sid, on: false });   // no income, rent only
  must(s, bal, { by: "director", type: "director.addCash", amount: -25000 - 5000 });
  expect(s.cash).toBe(-5000); expect(s.shopBlocked).toBe(false);
  must(s, bal, { by: "player", type: "placeOrder", lines: [{ sku: "fan.z1", qty: 1 }] });       // credit is allowed down to the floor
  run(s, bal, 18 * 300);                                                                         // to midnight: interest on the debt
  expect(s.ledger[0].costs.interest).toBeCloseTo(-(-5040 - 18 * 50) * 0.02, 4);
  must(s, bal, { by: "director", type: "director.addCash", amount: -20000 });
  expect(s.cash).toBe(-10000); expect(s.shopBlocked).toBe(true);
  run(s, bal, 600); expect(s.cash).toBe(-10000);                                                  // never below the floor
  must(s, bal, { by: "director", type: "director.addCash", amount: 9000 });
  expect(cmd(s, bal, { by: "player", type: "placeOrder", lines: [{ sku: "fan.z1", qty: 1 }] })).toMatchObject({ ok: false, reason: "no_cash" });   // still blocked under $0
  expect(cmd(s, bal, { by: "player", type: "buyUpgrade", kind: "pdu", target: "A-R01" })).toMatchObject({ ok: false, reason: "no_cash" });
  // parts can still be sold at 40%
  const p = (must(s, bal, { by: "player", type: "removePart", server: "A-R01-S01", slot: "CPU1" }) as { part: string }).part;
  expect((must(s, bal, { by: "player", type: "sellPart", part: p }) as { amount: number }).amount).toBe(160);
  must(s, bal, { by: "director", type: "director.addCash", amount: 2000 });
  expect(s.shopBlocked).toBe(false);
  must(s, bal, { by: "player", type: "placeOrder", lines: [{ sku: "fan.z1", qty: 1 }] });
});

test("director commands and views", () => {
  const bal = loadBalance(), s = newGame(bal, { seed: 8, facilityName: "Director", demo: true });
  const f = must(s, bal, { by: "director", type: "director.failPart", rack: "A-R01" }) as { part: string };
  expect(s.parts[f.part].status).toBe("degraded");
  run(s, bal, bal.director.failDelayTicks + 1);
  expect(s.parts[f.part].status).toBe("failed");
  expect(s.alerts.filter((a) => !a.cleared).map((a) => a.kind)).toEqual(["part_failed"]);
  must(s, bal, { by: "player", type: "placeOrder", lines: [{ sku: "gpu.v1", qty: 1 }] });
  must(s, bal, { by: "director", type: "director.deliverAll" });
  run(s, bal, 1); expect(s.orders[0].state).toBe("delivered");
  const day = must(s, bal, { by: "director", type: "director.skipDay" }) as { events: Record<string, number>; time: { day: number } };
  expect(day.time.day).toBe(2); expect(day.events.day).toBe(1);
  // views are JSON-safe and shaped as Appendix F
  const all = { overview: views.overview(s, bal), alerts: views.alerts(s, true, bal), racks: views.racks(s, bal, "A"), rack: views.rack(s, bal, "A-R01"),
    server: views.server(s, bal, "A-R01-S01"), inventory: views.inventory(s, bal), catalog: views.catalog(bal), gpus: views.catalog(bal, "gpu"),
    orders: views.orders(s), contracts: views.contracts(s, bal), finance: views.finance(s, bal, 30) };
  expect(JSON.parse(JSON.stringify(all))).toEqual(all);
  expect(Object.keys(all.overview)).toEqual(expect.arrayContaining(["facility", "time", "cash", "incomePerHour", "costPerHour", "power", "cooling", "halls", "reputation", "capacity", "sold", "autonomy"]));
  expect((all.racks as { id: string }[]).map((r) => r.id)).toEqual(["A-R01", "A-R02"]);
  expect(Object.keys((all.racks as object[])[0])).toEqual(expect.arrayContaining(["id", "hall", "servers", "kw", "pduCapKw", "breaker", "worstStatus", "maxTempC"]));
  expect((all.rack as { worstStatus: string }).worstStatus).toBe("failed");
  expect((all.server as { slots: unknown[] }).slots.length).toBe(25);
  expect((all.catalog as unknown[]).length).toBe(32 + 3); expect((all.gpus as unknown[]).length).toBe(5);
  expect((all.finance as { byDay: unknown[] }).byDay.length).toBe(2);
  expect(views.rack(s, bal, "nope")).toBeNull(); expect(views.server(s, bal, "constructor")).toBeNull();
  expect((all.inventory as { sku: string; where: string }[]).some((i) => i.sku === "gpu.v1" && i.where.startsWith("crate:"))).toBe(true);
});
