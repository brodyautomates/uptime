// Typed, zod-validated shape of balance/balance.json (SPEC Appendix H). Every tunable number lives there.
import { z } from "zod";
import type { Family, Sku } from "./state";

const num = z.number().finite();
const pos = num.positive();
const tier = z.object({ kw: pos, price: num.nonnegative() });
const hall = z.object({ slots: z.number().int().positive(), price: num.nonnegative() });
const ctype = z.object({
  unit: z.enum(["cpu", "gpu", "tb"]), multMin: pos, multMax: pos, slaPct: pos,
  daysMin: z.number().int().positive(), daysMax: z.number().int().positive(), minRep: num.nonnegative(),
});
const startPreset = z.object({ cash: num, reputation: num });
export const BalanceSchema = z.object({
  time: z.object({ tickMs: pos, ticksPerGameHour: z.number().int().positive(), hoursPerDay: z.number().int().positive(), startHour: num.nonnegative(), bootTicks: z.number().int().positive() }),
  rates: z.object({ cpu: pos, gpu: pos, tb: pos, spotMult: pos, powerPerKwh: num.nonnegative(), overhead: pos, rentPerHallHour: num.nonnegative() }),
  catalogue: z.record(z.string(), z.object({
    name: z.string(), family: z.enum(["cpu", "gpu", "ram", "drv", "psu", "fan", "nic"]),
    tier: z.number().int().positive(), price: pos, watts: num.nonnegative(), value: pos,
  })),
  facility: z.object({
    powerTiers: z.array(tier).min(1), coolingTiers: z.array(tier).min(1),
    pduBaseKw: z.literal(15), pduUpgradedKw: z.literal(30), pduUpgradePrice: pos, rearDoorPrice: pos, rearDoorKw: pos,
    halls: z.object({ A: hall, B: hall, C: hall }), baysPerRack: z.number().int().positive(), powerWarnPct: pos,
  }),
  server: z.object({ cpuRamGbPerUnit: pos, gpuRamGbPerUnit: pos, gpuPerCpuUnit: pos, unitsPerGbps: pos }),
  thermal: z.object({
    baseAirC: num, degPerKwOver: pos, maxAirC: num, airTauHours: pos, serverK: pos, serverTauTicks: pos, maxServerC: num,
    cpuOffsetC: num, gpuOffsetC: num, throttleC: num, shutdownC: num, throttleMult: pos, alertHysteresisC: num,
  }),
  wear: z.object({
    healthLossPerHour: num.nonnegative(), refC: num, doubleEveryC: pos, failChancePerHour: num.nonnegative(), healthDivisor: pos,
    failDelayHoursMin: pos, failDelayHoursMax: pos, degradedMult: pos,
  }),
  contracts: z.object({
    refreshHour: num.nonnegative(), offersBase: num, offersPerRep: pos, activeBase: num, activePerRep: pos,
    demandMinPct: pos, demandMaxPct: pos, stretchChance: num.nonnegative(), stretchPct: pos,
    floors: z.object({ cpu: pos, gpu: pos, tb: pos }),
    penaltyPct: num.nonnegative(), repPerGoodDay: num, repMaxPerDay: num, repPerBreach: num, repCancel: num,
    breachStreakEnd: z.number().int().positive(), riskPoints: num, trainingMinGpuTier: num, inferenceMinGbps: num,
    types: z.object({ web: ctype, archive: ctype, render: ctype, inference: ctype, training: ctype }),
  }),
  shop: z.object({
    standardHours: pos, expressTicks: z.number().int().positive(), expressMult: pos, sellbackPct: num.nonnegative(),
    sellbackDegradedMult: num.nonnegative(), sellbackFailedMult: num.nonnegative(),
    items: z.object({ rack: pos, chassis: pos, cart: pos }), cartCapacity: z.number().int().positive(),
  }),
  gantry: z.object({ jobTicks: z.number().int().positive(), fee: num.nonnegative() }),
  money: z.object({ debtFloor: num.nonpositive(), interestPctPerDay: num.nonnegative(), operateCapPct: pos }),
  director: z.object({ overheatTicks: z.number().int().positive(), failDelayTicks: z.number().int().positive() }),
  start: z.object({ fresh: startPreset, showcase: startPreset, mega: startPreset }),
  milestones: z.object({ inTheBlackPerHour: pos, megawattKw: pos }),
});
export type Balance = z.infer<typeof BalanceSchema>;

/** Validates balance.json. Throws (with the zod issue list) when the file is bad. */
export function parseBalance(json: unknown): Balance {
  const bal = BalanceSchema.parse(json);
  for (const [sku, spec] of Object.entries(bal.catalogue))
    if (!sku.startsWith(spec.family + ".")) throw new Error(`balance: sku ${sku} does not match its family ${spec.family}`);
  return bal;
}
export interface PartSpec { name: string; family: Family; tier: number; price: number; watts: number; value: number }
/** Catalogue entry for a sku, or undefined when the sku is not a part. */
export function partSpec(bal: Balance, sku: Sku): PartSpec | undefined {
  return Object.prototype.hasOwnProperty.call(bal.catalogue, sku) ? bal.catalogue[sku] : undefined;
}
export const ticksPerHour = (bal: Balance): number => bal.time.ticksPerGameHour;
export const ticksPerDay = (bal: Balance): number => bal.time.ticksPerGameHour * bal.time.hoursPerDay;
