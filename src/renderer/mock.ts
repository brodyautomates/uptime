// Stand-in world used before the sim is connected and for visual tests.
import { rackId, serverId, HALLS, type HallId } from "@shared/layout";
import type { WorldView, RackView, ServerView, PartView } from "@shared/view";

function rnd(seed: number) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export function mockWorld(preset: "fresh" | "showcase" | "mega" = "showcase"): WorldView {
  const r = rnd(7);
  const racks: RackView[] = [];
  const mkPart = (family: string, tier: number, i: number): PartView => ({ id: `p_${Math.floor(r() * 1e6)}`, sku: `${family}.${tier}`, name: family.toUpperCase() + " T" + tier, family, tier, health: 60 + r() * 40, status: "ok", tempC: 45 + r() * 25, watts: 100 });
  const mkServer = (rack: string, bay: number, gpus: number): ServerView => {
    const slots: Record<string, PartView | null> = {};
    for (let i = 1; i <= 2; i++) slots[`CPU${i}`] = mkPart("cpu", 1 + Math.floor(r() * 3), i);
    for (let i = 1; i <= 8; i++) slots[`RAM${i}`] = mkPart("ram", 1 + Math.floor(r() * 3), i);
    for (let i = 1; i <= 4; i++) slots[`GPU${i}`] = i <= gpus ? mkPart("gpu", 1 + Math.floor(r() * 3), i) : null;
    for (let i = 1; i <= 4; i++) slots[`DRV${i}`] = i <= 2 + Math.floor(r() * 3) ? mkPart("drv", 1, i) : null;
    for (let i = 1; i <= 2; i++) slots[`PSU${i}`] = mkPart("psu", 2, i);
    for (let i = 1; i <= 4; i++) slots[`FAN${i}`] = mkPart("fan", 1, i);
    slots.NIC1 = mkPart("nic", 1, 1);
    const roll = r();
    const status = roll > 0.992 ? "failed" : roll > 0.975 ? "degraded" : "ok";
    return { id: serverId(rack, bay), bay, power: r() > 0.03 ? "on" : "off", status, load: 0.35 + r() * 0.6, tempC: 50 + r() * 30, out: { cpu: 20, gpu: gpus * 20, tb: 4 }, watts: 600, bottleneck: "none", pulledOut: false, slots, drives: [1, 2, 3, 4].map((i) => (slots[`DRV${i}`] ? 1 : 0)) };
  };
  const fill = (hall: HallId, nRacks: number, perRack: number, gpus: number) => {
    for (let i = 0; i < nRacks; i++) {
      const id = rackId(hall, i + 1);
      const servers: (ServerView | null)[] = [];
      for (let b = 1; b <= 10; b++) servers.push(b <= perRack ? mkServer(id, b, gpus) : null);
      racks.push({ id, hall, slot: i, doorOpen: false, breaker: "closed", pduCapKw: 15, rearDoor: false, kw: 6, servers });
    }
  };
  const owned = { A: true, B: preset !== "fresh", C: preset === "mega" };
  if (preset === "fresh") fill("A", 2, 4, 0);
  if (preset === "showcase") { fill("A", 12, 10, 2); fill("B", 6, 10, 3); }
  if (preset === "mega") { fill("A", 12, 10, 4); fill("B", 16, 10, 4); fill("C", 32, 10, 4); }
  const hall = (id: HallId) => ({ id, owned: owned[id], airC: 23, heatKw: 20, coolingKw: 30 });
  void HALLS;
  return { tick: 0, cash: 180000, incomePerHour: 4200, costPerHour: 610, reputation: 55, power: { usedKw: 62, capKw: 120 }, cooling: { heatKw: 58, capKw: 100 }, time: { day: 4, hour: 14, minute: 20 }, speed: 1, facilityName: "UPTIME", halls: { A: hall("A"), B: hall("B"), C: hall("C") }, racks, alertCount: 2 };
}
