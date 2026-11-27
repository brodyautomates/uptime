import { expect, test } from "vitest";
import { newGame, packSnapshot, serialize, stateHash, tick, unpackSnapshot } from "@sim/index";
import { loadBalance } from "./helpers";

test("G18 mega preset: 600 servers, 15,000 parts, one tick under 4 ms, snapshot under 2 MB", () => {
  const bal = loadBalance();
  const s = newGame(bal, { seed: 1, facilityName: "Mega", preset: "mega" });
  expect(Object.keys(s.racks).length).toBe(60);
  expect(Object.keys(s.servers).length).toBe(600);
  expect(Object.keys(s.parts).length).toBe(15000);
  expect(s.cash).toBe(2000000);
  for (let i = 0; i < 300; i++) tick(s, bal);      // warm up
  let worst = 0;
  const t0 = performance.now();
  for (let i = 0; i < 600; i++) { const a = performance.now(); tick(s, bal); const d = performance.now() - a; if (d > worst) worst = d; }
  const avg = (performance.now() - t0) / 600;
  expect(s.totals.kw).toBeGreaterThanOrEqual(1000);
  expect(s.totals.kw).toBeLessThanOrEqual(s.powerCapKw);
  expect(Object.values(s.racks).every((r) => r.breaker === "closed")).toBe(true);
  expect(s.milestones).toContain("megawatt");
  const plain = serialize(s).length;
  const packed = JSON.stringify(packSnapshot(s));
  console.log(`G18 mega: avg tick ${avg.toFixed(3)} ms, worst ${worst.toFixed(3)} ms over 600 ticks; plain JSON ${(plain / 1e6).toFixed(2)} MB, packed snapshot ${(packed.length / 1e6).toFixed(2)} MB; draw ${s.totals.kw.toFixed(0)} kW`);
  expect(avg).toBeLessThan(4);
  expect(packed.length).toBeLessThan(2_000_000);
  expect(stateHash(unpackSnapshot(JSON.parse(packed)))).toBe(stateHash(s));
});

test("showcase preset matches its description", () => {
  const bal = loadBalance();
  const s = newGame(bal, { seed: 1, facilityName: "Showcase", preset: "showcase" });
  expect(Object.values(s.racks).filter((r) => r.hall === "A").length).toBe(12);
  expect(Object.values(s.racks).filter((r) => r.hall === "B").length).toBe(6);
  expect(s.halls.B.owned).toBe(true);
  expect(s.cash).toBe(180000);
  expect(s.reputation).toBe(55);
  expect(s.contracts.filter((c) => c.state === "active").length).toBe(2);
  const tiers = new Set(Object.values(s.parts).filter((p) => p.sku.startsWith("gpu.")).map((p) => p.sku));
  expect([...tiers].sort()).toEqual(["gpu.v1", "gpu.v2", "gpu.v3"]);
  for (let i = 0; i < 7200; i++) tick(s, bal);
  expect(Object.values(s.racks).every((r) => r.breaker === "closed")).toBe(true);
  expect(Object.values(s.servers).every((x) => x.power === "on")).toBe(true);
  expect(s.totals.kw).toBeLessThan(s.powerCapKw);
  expect(s.halls.A.airC).toBeLessThan(23);
  expect(s.alerts.some((a) => a.kind === "sla_breach")).toBe(false);
});
