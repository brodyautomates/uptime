import { expect, test } from "vitest";
import { applyCommand, deserialize, newGame, serialize, stateHash, tick, ticksPerDay } from "@sim/index";
import type { Balance, Command, State } from "@sim/index";
import { loadBalance } from "./helpers";

/** A fixed script: what a player and Claude might do over three game days. Commands that get refused are part of the script. */
function script(state: State, t: number): Command[] {
  const firstOffer = state.contracts.find((c) => c.state === "offer")?.id ?? "none";
  const shelf = (sku: string) => Object.keys(state.parts).sort().find((id) => state.parts[id].sku === sku && state.parts[id].where.kind !== "slot" && state.parts[id].where.kind !== "gantry") ?? "none";
  switch (t) {
    case 5: return [{ by: "player", type: "placeOrder", lines: [{ sku: "gpu.v1", qty: 6 }, { sku: "fan.z2", qty: 2 }, { sku: "chassis", qty: 1 }, { sku: "cart", qty: 1 }], express: true }];
    case 10: return [{ by: "player", type: "acceptContract", contract: firstOffer }, { by: "player", type: "setDemoMode", on: true }];
    case 300: return [{ by: "player", type: "openCrate", order: "o_00001" }, { by: "player", type: "setServerPower", server: "A-R01-S01", on: false }];
    case 301: return [
      { by: "player", type: "installPart", server: "A-R01-S01", slot: "GPU1", part: shelf("gpu.v1") },
      { by: "player", type: "setServerPower", server: "A-R01-S01", on: true },
      { by: "player", type: "placeChassis", rack: "A-R01", bay: 5 },
      { by: "claude", type: "setServerPower", server: "A-R01-S02", on: false },
    ];
    case 320: return [
      { by: "claude", type: "queueJob", kind: "install", server: "A-R01-S02", slot: "GPU1", part: shelf("gpu.v1") },
      { by: "claude", type: "queueJob", kind: "remove", server: "A-R02-S01", slot: "FAN1" },
      { by: "claude", type: "queueJob", kind: "install", server: "A-R02-S01", slot: "FAN1", part: shelf("fan.z2") },
    ];
    case 600: return [{ by: "claude", type: "setServerPower", server: "A-R01-S02", on: true }, { by: "claude", type: "placeOrder", lines: [{ sku: "ram.s2", qty: 4 }] }];
    case 900: return [{ by: "director", type: "director.failPart", rack: "A-R02" }, { by: "director", type: "director.overheatRack", rack: "A-R01" }];
    case 2000: return [{ by: "player", type: "buyUpgrade", kind: "rear_door", target: "A-R01" }, { by: "player", type: "setServerPower", server: "A-R01-S03", on: true }];
    case 7300: return [{ by: "player", type: "acceptContract", contract: firstOffer }, { by: "player", type: "sellPart", part: shelf("fan.z1") }];
    case 9000: return [{ by: "player", type: "cancelContract", contract: state.contracts.find((c) => c.state === "active")?.id ?? "none" }];
    default: return [];
  }
}
function play(bal: Balance, seed: number, ticks: number, reloadAt = -1): { hash: string; refused: number; state: State } {
  let state = newGame(bal, { seed, facilityName: "Determinism" });
  let refused = 0;
  for (let t = 0; t < ticks; t++) {
    if (t === reloadAt) state = deserialize(serialize(state), bal);
    for (const c of script(state, t)) if (!applyCommand(state, bal, c).ok) refused++;
    tick(state, bal);
  }
  return { hash: stateHash(state), refused, state };
}

test("G1 same seed and commands for 3 game days give the same hash; a different seed does not", () => {
  const bal = loadBalance();
  const n = 3 * ticksPerDay(bal);
  const a = play(bal, 42, n), b = play(bal, 42, n), c = play(bal, 43, n);
  expect(a.state.tick).toBe(21600);
  expect(a.hash).toBe(b.hash);
  expect(a.refused).toBe(b.refused);
  expect(a.hash).not.toBe(c.hash);
  // the script really did things
  expect(a.state.servers["A-R01-S01"].slots.GPU1).toBeDefined();
  expect(a.state.servers["A-R01-S02"].slots.GPU1).toBeDefined();
  expect(a.state.jobs.filter((j) => j.state === "done").length).toBe(3);
});

test("G1 a run that is saved and reloaded part-way ends on the same hash (no hidden state outside State)", () => {
  const bal = loadBalance();
  const n = ticksPerDay(bal) + 500;
  const straight = play(bal, 9, n);
  for (const at of [1, 321, 350, 905, 960, 7000]) expect(play(bal, 9, n, at).hash).toBe(straight.hash);
});
