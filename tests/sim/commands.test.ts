import { expect, test } from "vitest";
import { applyCommand, CommandSchema, markMilestone, newGame, REASONS, stateHash, tick } from "@sim/index";
import type { Balance, Command, State } from "@sim/index";
import { buy, loadBalance, must, run } from "./helpers";

const seen = new Set<string>();
/** Asserts a refusal with this reason, a plain-English sentence, and an untouched state. */
function refused(state: State, bal: Balance, c: Command, reason: string): void {
  const before = stateHash(state);
  const r = applyCommand(state, bal, c);
  expect(r.ok, `${c.type} should be refused with ${reason}`).toBe(false);
  if (r.ok) return;
  expect(r.reason).toBe(reason);
  expect(r.message).toMatch(/^[A-Z"].{12,}[.!?]$/);
  expect(r.message).not.toMatch(/undefined|NaN|\[object/);
  expect(stateHash(state)).toBe(before);
  seen.add(r.reason);
}
const fresh = (bal: Balance, seed = 3) => newGame(bal, { seed, facilityName: "Cmd", demo: true });

test("power, doors, pull-out and part handling refusals", () => {
  const bal = loadBalance(), s = fresh(bal), S1 = "A-R01-S01";
  refused(s, bal, { by: "player", type: "setServerPower", server: S1, on: true }, "already");
  refused(s, bal, { by: "player", type: "setServerPower", server: "A-R09-S09", on: true }, "not_found");
  refused(s, bal, { by: "player", type: "pullServer", server: S1 }, "door_closed");
  must(s, bal, { by: "player", type: "setRackDoor", rack: "A-R01", open: true });
  refused(s, bal, { by: "player", type: "setRackDoor", rack: "A-R01", open: true }, "already");
  refused(s, bal, { by: "player", type: "removePart", server: S1, slot: "GPU1" }, "empty_slot");
  refused(s, bal, { by: "player", type: "removePart", server: S1, slot: "CPU1" }, "needs_power_off");
  // hot swap: the first PSU comes out of a redundant server, the second cannot
  expect(s.servers[S1].redundantPsu).toBe(true);
  const psu = (must(s, bal, { by: "player", type: "removePart", server: S1, slot: "PSU1" }) as { part: string; where: string });
  expect(psu.where).toBe("hand");
  refused(s, bal, { by: "player", type: "removePart", server: S1, slot: "PSU2" }, "psu_not_redundant");
  refused(s, bal, { by: "player", type: "removePart", server: S1, slot: "FAN1" }, "hands_full");
  refused(s, bal, { by: "player", type: "installPart", server: S1, slot: "PSU2", part: psu.part }, "slot_full");
  refused(s, bal, { by: "player", type: "installPart", server: S1, slot: "GPU1", part: psu.part }, "wrong_type");
  refused(s, bal, { by: "player", type: "installPart", server: S1, slot: "PSU1", part: s.servers[S1].slots.CPU1! }, "part_not_available");
  refused(s, bal, { by: "player", type: "stowPart", part: psu.part, to: "cart" }, "hands_full");
  must(s, bal, { by: "player", type: "stowPart", part: psu.part, to: "shelf" });
  // no power supply left at all
  must(s, bal, { by: "player", type: "setServerPower", server: S1, on: false });
  must(s, bal, { by: "player", type: "removePart", server: S1, slot: "PSU2" });
  refused(s, bal, { by: "player", type: "setServerPower", server: S1, on: true }, "no_psu_capacity");
  // a non-hot-swap install needs power off
  const [gpu] = buy(s, bal, [{ sku: "gpu.v1", qty: 1 }]);
  refused(s, bal, { by: "player", type: "installPart", server: "A-R01-S02", slot: "GPU1", part: gpu }, "needs_power_off");
  // gantry busy on the server
  must(s, bal, { by: "claude", type: "queueJob", kind: "remove", server: "A-R01-S02", slot: "FAN1" });
  const j2 = must(s, bal, { by: "claude", type: "queueJob", kind: "remove", server: "A-R01-S03", slot: "FAN1" }) as { job: string; etaSeconds: number };
  expect(j2.etaSeconds).toBe(16);
  run(s, bal, 1);
  refused(s, bal, { by: "player", type: "pullServer", server: "A-R01-S02" }, "gantry_busy_here");
  refused(s, bal, { by: "player", type: "cancelJob", job: s.jobs[0].id }, "already_running");
  must(s, bal, { by: "player", type: "cancelJob", job: j2.job });
  must(s, bal, { by: "player", type: "pullServer", server: "A-R01-S03" });
  refused(s, bal, { by: "player", type: "pullServer", server: "A-R01-S03" }, "already");
});

test("gantry job queue refusals", () => {
  const bal = loadBalance(), s = fresh(bal), S1 = "A-R01-S01";
  const [fan, gpu] = buy(s, bal, [{ sku: "fan.z2", qty: 1 }, { sku: "gpu.v1", qty: 1 }]);
  refused(s, bal, { by: "claude", type: "queueJob", kind: "install", server: S1, slot: "FAN1", part: "p_999999" }, "part_not_available");
  refused(s, bal, { by: "claude", type: "queueJob", kind: "install", server: S1, slot: "FAN1" }, "part_not_available");
  refused(s, bal, { by: "claude", type: "queueJob", kind: "remove", server: S1, slot: "GPU2" }, "empty_slot");
  refused(s, bal, { by: "claude", type: "queueJob", kind: "install", server: S1, slot: "FAN1", part: fan }, "slot_full");
  refused(s, bal, { by: "claude", type: "queueJob", kind: "install", server: S1, slot: "GPU1", part: fan }, "wrong_type");
  must(s, bal, { by: "director", type: "director.addCash", amount: -s.cash - 9990 });
  refused(s, bal, { by: "claude", type: "queueJob", kind: "install", server: S1, slot: "GPU1", part: gpu }, "no_cash");
});

test("breaker refusals", () => {
  const bal = loadBalance();
  bal.facility.powerTiers[0].kw = 1.5;
  const s = fresh(bal);
  refused(s, bal, { by: "player", type: "resetBreaker", rack: "A-R01" }, "not_tripped");
  run(s, bal, 1);
  expect(s.racks["A-R02"].breaker).toBe("tripped");
  refused(s, bal, { by: "player", type: "setServerPower", server: "A-R02-S01", on: true }, "breaker_tripped");
});

test("shop, crates, racks, chassis and selling refusals", () => {
  const bal = loadBalance(), s = fresh(bal);
  refused(s, bal, { by: "player", type: "placeOrder", lines: [{ sku: "gpu.v9", qty: 1 }] }, "unknown_sku");
  refused(s, bal, { by: "player", type: "placeOrder", lines: [{ sku: "constructor", qty: 1 }] }, "unknown_sku");
  refused(s, bal, { by: "player", type: "placeOrder", lines: [{ sku: "gpu.v5", qty: 100 }] }, "no_cash");
  refused(s, bal, { by: "claude", type: "placeOrder", lines: [{ sku: "gpu.v1", qty: 5 }] }, "over_autonomy_cap");
  refused(s, bal, { by: "claude", type: "buyUpgrade", kind: "power" }, "over_autonomy_cap");
  must(s, bal, { by: "claude", type: "placeOrder", lines: [{ sku: "gpu.v1", qty: 4 }] });       // $6,000 of $25,000 is inside the cap
  const o = must(s, bal, { by: "player", type: "placeOrder", lines: [{ sku: "ram.s1", qty: 1 }] }) as { order: string };
  refused(s, bal, { by: "player", type: "openCrate", order: o.order }, "not_delivered");
  refused(s, bal, { by: "player", type: "sellPart", part: Object.keys(s.parts).sort().pop()! }, "not_owned");   // still in transit
  refused(s, bal, { by: "player", type: "placeRack", hall: "A", slot: 0 }, "slot_taken");
  refused(s, bal, { by: "player", type: "placeRack", hall: "B", slot: 0 }, "hall_not_owned");
  refused(s, bal, { by: "player", type: "placeRack", hall: "A", slot: 5 }, "no_rack_in_hand");
  refused(s, bal, { by: "player", type: "placeChassis", rack: "A-R01", bay: 1 }, "bay_taken");
  refused(s, bal, { by: "player", type: "placeChassis", rack: "A-R01", bay: 9 }, "no_chassis_in_hand");
  refused(s, bal, { by: "player", type: "sellPart", part: s.servers["A-R01-S01"].slots.CPU1! }, "installed");
  refused(s, bal, { by: "player", type: "sellPart", part: "p_999999" }, "not_owned");
  refused(s, bal, { by: "player", type: "buyUpgrade", kind: "hall", target: "C" }, "needs_hall_b");
  must(s, bal, { by: "player", type: "buyUpgrade", kind: "pdu", target: "A-R01" });
  refused(s, bal, { by: "player", type: "buyUpgrade", kind: "pdu", target: "A-R01" }, "already_max");
  must(s, bal, { by: "player", type: "buyUpgrade", kind: "rear_door", target: "A-R01" });
  refused(s, bal, { by: "player", type: "buyUpgrade", kind: "rear_door", target: "A-R01" }, "already_max");
  must(s, bal, { by: "director", type: "director.addCash", amount: 5_000_000 });
  for (let i = 0; i < 3; i++) { must(s, bal, { by: "player", type: "buyUpgrade", kind: "power" }); must(s, bal, { by: "player", type: "buyUpgrade", kind: "cooling" }); }
  expect(s.powerCapKw).toBe(1200); expect(s.coolingCapKw).toBe(1100);
  refused(s, bal, { by: "player", type: "buyUpgrade", kind: "power" }, "already_max");
  must(s, bal, { by: "player", type: "buyUpgrade", kind: "hall" });
  must(s, bal, { by: "player", type: "buyUpgrade", kind: "hall" });
  expect(s.halls.C.owned).toBe(true);
  refused(s, bal, { by: "player", type: "buyUpgrade", kind: "hall" }, "already_max");
  expect(s.milestones).toEqual(expect.arrayContaining(["second_hall", "campus"]));
});

test("contract refusals", () => {
  const bal = loadBalance();
  // a start whose offers include a render-farm contract (needs reputation 10)
  let s = fresh(bal, 1);
  for (let seed = 1; seed < 200 && !(s.contracts.some((c) => c.type === "render") && s.contracts.filter((c) => c.type !== "render").length >= 2); seed++) s = fresh(bal, seed);
  const render = s.contracts.find((c) => c.type === "render")!;
  const others = s.contracts.filter((c) => c.type !== "render");
  refused(s, bal, { by: "player", type: "acceptContract", contract: "c_99999" }, "expired");
  refused(s, bal, { by: "player", type: "cancelContract", contract: render.id }, "not_active");
  must(s, bal, { by: "player", type: "acceptContract", contract: others[0].id });
  must(s, bal, { by: "player", type: "acceptContract", contract: others[1].id });
  must(s, bal, { by: "player", type: "cancelContract", contract: others[0].id });
  must(s, bal, { by: "player", type: "cancelContract", contract: others[1].id });
  expect(s.reputation).toBe(0);
  refused(s, bal, { by: "player", type: "acceptContract", contract: render.id }, "reputation_too_low");
  refused(s, bal, { by: "player", type: "acceptContract", contract: others[0].id }, "expired");
  // active limit: 3 + floor(20 / 25) = 3
  const t = fresh(bal, 5);
  expect(t.contracts.length).toBe(4);
  for (let i = 0; i < 3; i++) must(t, bal, { by: "player", type: "acceptContract", contract: t.contracts[i].id });
  refused(t, bal, { by: "player", type: "acceptContract", contract: t.contracts[3].id }, "too_many_active");
});

test("autonomy, speed, settings and director gating", () => {
  const bal = loadBalance(), s = fresh(bal);
  refused(s, bal, { by: "player", type: "setSpeed", speed: 4 }, "not_seated");
  must(s, bal, { by: "player", type: "setSpeed", speed: 4, seated: true });
  must(s, bal, { by: "player", type: "setSpeed", speed: 1 });
  refused(s, bal, { by: "claude", type: "setAutonomy", level: "full" }, "player_only");
  refused(s, bal, { by: "director", type: "setDemoMode", on: false }, "player_only");
  refused(s, bal, { by: "player", type: "director.addCash", amount: 1 }, "director_only");
  refused(s, bal, { by: "bogus", type: "setSpeed", speed: 1 } as unknown as Command, "invalid");
  refused(s, bal, { by: "player", type: "removePart", server: "A-R01-S01", slot: "GPU9" } as unknown as Command, "invalid");
  refused(s, bal, { by: "player", type: "director.addCash", amount: Infinity } as unknown as Command, "invalid");
  // operate: gantry fees and contract actions are allowed
  must(s, bal, { by: "claude", type: "queueJob", kind: "remove", server: "A-R01-S01", slot: "FAN1" });
  must(s, bal, { by: "claude", type: "acceptContract", contract: s.contracts[0].id });
  // advise: every mutating command from Claude is refused
  must(s, bal, { by: "player", type: "setAutonomy", level: "advise" });
  const all: Command[] = [
    { by: "claude", type: "setServerPower", server: "A-R01-S01", on: false }, { by: "claude", type: "placeOrder", lines: [{ sku: "fan.z1", qty: 1 }] },
    { by: "claude", type: "queueJob", kind: "remove", server: "A-R01-S01", slot: "FAN2" }, { by: "claude", type: "buyUpgrade", kind: "power" },
    { by: "claude", type: "resetBreaker", rack: "A-R01" }, { by: "claude", type: "cancelContract", contract: s.contracts[0].id }, { by: "claude", type: "setSpeed", speed: 0 },
  ];
  for (const c of all) refused(s, bal, c, "advise_only");
  must(s, bal, { by: "player", type: "setServerPower", server: "A-R01-S02", on: false });     // the player is not restricted
  // full: no purchase cap
  must(s, bal, { by: "player", type: "setAutonomy", level: "full" });
  must(s, bal, { by: "claude", type: "placeOrder", lines: [{ sku: "gpu.v1", qty: 10 }] });
  // director commands need demo mode
  must(s, bal, { by: "player", type: "setDemoMode", on: false });
  refused(s, bal, { by: "director", type: "director.deliverAll" }, "demo_off");
  expect(markMilestone(s, "hands_off")).toBe(true);
  expect(markMilestone(s, "hands_off")).toBe(false);
  expect(tick(s, bal).some((e) => e.kind === "milestone" && e.target === "hands_off")).toBe(true);
});

test("every refusal reason code is reachable, and every command type is in the schema", () => {
  const missing = REASONS.filter((r) => !seen.has(r));
  expect(missing).toEqual([]);
  const types = CommandSchema.options.map((o) => o.shape.type.value);
  for (const t of ["setServerPower", "setRackDoor", "pullServer", "pushServer", "removePart", "installPart", "queueJob", "cancelJob", "resetBreaker",
    "placeOrder", "openCrate", "placeRack", "placeChassis", "sellPart", "acceptContract", "cancelContract", "buyUpgrade", "setSpeed", "setAutonomy"])
    expect(types).toContain(t);
  expect(types.filter((t) => t.startsWith("director.")).length).toBe(5);
});
