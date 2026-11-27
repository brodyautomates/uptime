import { expect, test } from "vitest";
import { newGame, serialize, deserialize, stateHash, storeOf, PartRec, applyCommand, tick } from "../../src/sim/index";
import { loadBalance } from "./helpers";

test("parts are stored in typed arrays and seen through records (SPEC appendix C)", () => {
  const bal = loadBalance();
  const s = newGame(bal, { seed: 3, facilityName: "Store", preset: "mega" });
  const st = storeOf(s);
  expect(st.n).toBe(15000);
  expect(st.health).toBeInstanceOf(Float64Array); expect(st.temp).toBeInstanceOf(Float64Array);
  expect(st.status).toBeInstanceOf(Uint8Array); expect(st.sku).toBeInstanceOf(Uint16Array); expect(st.kind).toBeInstanceOf(Uint8Array); expect(st.ref).toBeInstanceOf(Int32Array);
  const id = Object.keys(s.parts)[100], p = s.parts[id];
  expect(p).toBeInstanceOf(PartRec);
  // a write through the record lands in the array, and a write to the array is seen through the record
  const i = st.id.indexOf(id);
  p.health = 41.5; expect(st.health[i]).toBe(41.5);
  st.status[i] = 2; expect(p.status).toBe("failed");
  p.failsAtTick = 77; expect(st.fails[i]).toBe(77); p.failsAtTick = undefined; expect(Number.isNaN(st.fails[i])).toBe(true); expect(p.failsAtTick).toBeUndefined();
  expect(p.where.kind).toBe("slot");
  p.where = { kind: "crate", order: "o_00009" }; expect(p.where).toEqual({ kind: "crate", order: "o_00009" });
});

test("a save round-trips through the typed store with the same hash, and the sim keeps running on it", () => {
  const bal = loadBalance();
  const a = newGame(bal, { seed: 9, facilityName: "RT", preset: "showcase", demo: true });
  applyCommand(a, bal, { by: "director", type: "director.failPart", rack: "A-R02", family: "fan" });
  for (let i = 0; i < 400; i++) tick(a, bal);
  const b = deserialize(serialize(a), bal);
  expect(stateHash(b)).toBe(stateHash(a));
  expect(Object.values(b.parts).every((p) => p instanceof PartRec)).toBe(true);
  for (let i = 0; i < 400; i++) { tick(a, bal); tick(b, bal); }
  expect(stateHash(b)).toBe(stateHash(a));
  expect(Object.values(a.parts).some((p) => p.status === "failed")).toBe(true);
});
