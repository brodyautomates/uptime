import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { deserialize, newGame, SAVE_VERSION, serialize, stateHash } from "@sim/index";
import { packSave, unpackSave } from "@sim/saveNode";
import { buy, loadBalance, must, run } from "./helpers";

function midGame() {
  const bal = loadBalance();
  const s = newGame(bal, { seed: 77, facilityName: "Round Trip", demo: true });
  const gpus = buy(s, bal, [{ sku: "gpu.v1", qty: 3 }, { sku: "cart", qty: 1 }, { sku: "rack", qty: 1 }]);
  must(s, bal, { by: "player", type: "setServerPower", server: "A-R01-S01", on: false });
  must(s, bal, { by: "player", type: "installPart", server: "A-R01-S01", slot: "GPU1", part: gpus[0] });
  must(s, bal, { by: "player", type: "setServerPower", server: "A-R01-S01", on: true });
  must(s, bal, { by: "claude", type: "queueJob", kind: "remove", server: "A-R02-S02", slot: "DRV1" });
  must(s, bal, { by: "player", type: "placeOrder", lines: [{ sku: "ram.s2", qty: 2 }] });
  must(s, bal, { by: "player", type: "acceptContract", contract: s.contracts.find((c) => c.state === "offer")!.id });
  must(s, bal, { by: "director", type: "director.failPart", rack: "A-R02" });
  must(s, bal, { by: "player", type: "stowPart", part: gpus[1], to: "hand" });
  run(s, bal, 40);     // gantry job running, order in transit, a part degraded, a server booting
  return { bal, s };
}

test("G4 serialize -> deserialize gives the same hash, and both copies stay in step afterwards", () => {
  const { bal, s } = midGame();
  const copy = deserialize(serialize(s), bal);
  expect(stateHash(copy)).toBe(stateHash(s));
  run(s, bal, 900); run(copy, bal, 900);
  expect(stateHash(copy)).toBe(stateHash(s));
});

test("G4 the gzip save file of Appendix H round-trips", () => {
  const { bal, s } = midGame();
  const file = packSave(s, "2026-11-11T12:00:00.000Z");
  expect(file[0]).toBe(0x1f);
  const back = unpackSave(file, bal);
  expect(back.savedAt).toBe("2026-11-11T12:00:00.000Z");
  expect(stateHash(back.state)).toBe(stateHash(s));
});

test("G4 a version-1 fixture migrates to the current version and keeps running", () => {
  const bal = loadBalance();
  const text = readFileSync(resolve(__dirname, "fixtures/save-v1.json"), "utf8");
  expect(JSON.parse(text).state.version).toBe(1);
  expect(JSON.parse(text).state.stock).toBeUndefined();
  const s = deserialize(text, bal);
  expect(s.version).toBe(SAVE_VERSION);
  expect(s.facilityName).toBe("Old Save");
  expect(s.stock).toEqual({ racks: 0, chassis: 0, cart: false });
  expect(s.settings.demo).toBe(false);
  expect(s.servers["A-R01-S01"].wantOn).toBe(true);
  const cash = s.cash;
  run(s, bal, 600);
  expect(s.cash).toBeGreaterThan(cash);
  expect(stateHash(deserialize(serialize(s), bal))).toBe(stateHash(s));
});

test("G4 corrupted saves throw", () => {
  const { bal, s } = midGame();
  const good = serialize(s);
  expect(() => deserialize(good.slice(0, good.length - 40), bal)).toThrow();                 // truncated
  expect(() => deserialize("not json at all", bal)).toThrow();
  expect(() => deserialize("{}", bal)).toThrow();
  const edit = (f: (raw: any) => void): string => { const raw = JSON.parse(good); f(raw); return JSON.stringify(raw); };
  expect(() => deserialize(edit((r) => { r.cash = "lots"; }), bal)).toThrow();
  expect(() => deserialize(edit((r) => { r.cash = null; }), bal)).toThrow();
  expect(() => deserialize(edit((r) => { delete r.halls.B; }), bal)).toThrow();
  expect(() => deserialize(edit((r) => { r.version = SAVE_VERSION + 1; }), bal)).toThrow();
  expect(() => deserialize(edit((r) => { r.version = 0; }), bal)).toThrow();
  expect(() => deserialize(edit((r) => { r.parts.p_000001.sku = "cpu.k99"; }), bal)).toThrow();
  expect(() => deserialize(edit((r) => { r.parts.p_000001.where = { kind: "shelf" }; }), bal)).toThrow();   // slot still points at it
  expect(() => deserialize(edit((r) => { r.servers["A-R01-S01"].power = "sideways"; }), bal)).toThrow();
  expect(() => unpackSave(new Uint8Array([0x1f, 0x8b, 1, 2, 3, 4]), bal)).toThrow();
  expect(() => deserialize(good, bal)).not.toThrow();
});
