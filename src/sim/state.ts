// Data model (SPEC Appendix C). Plain JSON-safe objects; derived sums live in a non-serialized cache (core.ts).
export type HallId = "A" | "B" | "C";
export const HALLS: readonly HallId[] = ["A", "B", "C"];
export type RackId = string;
export type ServerId = string;
export const SLOTS = [
  "CPU1", "CPU2",
  "RAM1", "RAM2", "RAM3", "RAM4", "RAM5", "RAM6", "RAM7", "RAM8",
  "GPU1", "GPU2", "GPU3", "GPU4",
  "DRV1", "DRV2", "DRV3", "DRV4",
  "PSU1", "PSU2",
  "FAN1", "FAN2", "FAN3", "FAN4",
  "NIC1",
] as const;
export type SlotId = (typeof SLOTS)[number];
export type Sku = string;
export type PartId = string;
export type Family = "cpu" | "gpu" | "ram" | "drv" | "psu" | "fan" | "nic";
export const FAMILIES: readonly Family[] = ["cpu", "gpu", "ram", "drv", "psu", "fan", "nic"];
const PREFIX: Record<string, Family> = { CPU: "cpu", RAM: "ram", GPU: "gpu", DRV: "drv", PSU: "psu", FAN: "fan", NIC: "nic" };
/** Which part family fits a slot. */
export function slotFamily(slot: SlotId): Family { return PREFIX[slot.slice(0, 3)]; }
/** Families that can be swapped while the server is running. */
export const HOT_SWAP: Record<Family, boolean> = { cpu: false, ram: false, gpu: false, nic: false, drv: true, psu: true, fan: true };

export type PartWhere =
  | { kind: "slot"; server: ServerId; slot: SlotId }
  | { kind: "shelf" } | { kind: "cart" } | { kind: "hand" }
  | { kind: "crate"; order: string } | { kind: "gantry"; job: string };

export interface Part {
  id: PartId; sku: Sku; health: number; status: "ok" | "degraded" | "failed";
  failsAtTick?: number; tempC: number; where: PartWhere;
}
export type PowerState = "off" | "booting" | "on" | "shutdown_thermal" | "no_power";
export type Bottleneck = "none" | "ram" | "cpu" | "nic" | "thermal" | "psu";
export interface Server {
  id: ServerId; power: PowerState; bootDoneTick?: number; load: number; tempC: number;
  out: { cpu: number; gpu: number; tb: number }; watts: number;
  bottleneck: Bottleneck; redundantPsu: boolean; pulledOut: boolean;
  // additions
  rack: RackId; bay: number;                       // bay 1 (bottom) .. 10
  slots: Partial<Record<SlotId, PartId>>;          // mirror of part.where for fast lookup
  wantOn: boolean;                                 // comes back by itself when power returns
  thermalAlert: 0 | 1 | 2;                         // 0 none, 1 throttling, 2 shut down
}
export interface Rack {
  id: RackId; hall: HallId; slot: number; servers: (ServerId | null)[];
  pduCapKw: 15 | 30; rearDoor: boolean; breaker: "closed" | "tripped"; doorOpen: boolean;
  seq: number; kw: number; overheatUntilTick: number;   // additions
}
export interface Hall {
  id: HallId; owned: boolean; airC: number; heatKw: number; coolingKw: number;
  gantry: { busyUntilTick: number; queue: string[]; running?: string };
}
export type ContractType = "web" | "render" | "archive" | "training" | "inference";
export type Unit = "cpu" | "gpu" | "tb";
export interface Contract {
  id: string; type: ContractType; unit: Unit; demand: number; rate: number; slaPct: number;
  startTick: number; endTick: number; penaltyPerDay: number;
  deliveredToday: number; demandedToday: number; state: "offer" | "active" | "done" | "breached";
  days: number; breachedDays: number; breachStreak: number; atRisk: boolean; cancelled?: boolean;  // additions
}
export type ItemSku = "rack" | "chassis" | "cart";
export interface Order {
  id: string; lines: { sku: Sku | ItemSku; qty: number }[];
  express: boolean; cost: number; arrivesTick: number; state: "transit" | "delivered" | "opened";
}
export type By = "player" | "claude" | "director";
export interface Job {
  id: string; kind: "install" | "remove"; server: ServerId; slot: SlotId; part?: PartId;
  by: By; state: "queued" | "running" | "done" | "failed"; reason?: string;
  hall: HallId; fee: number; doneTick?: number;   // additions
}
export type AlertKind = "part_degraded" | "part_failed" | "thermal" | "breaker" | "power_cap"
  | "sla_risk" | "sla_breach" | "delivery" | "job_done" | "job_failed";
export interface Alert {
  id: string; tick: number; severity: "info" | "warn" | "critical"; kind: AlertKind;
  target?: string; text: string; cleared: boolean;
}
export interface LedgerDay {
  day: number;
  income: { spot: number; contracts: number; sales: number };
  costs: { power: number; rent: number; parts: number; gantry: number; penalties: number; interest: number; upgrades: number };
}
export interface Totals {
  cpu: number; gpu: number; tb: number; gpuTrain: number; gpuInf: number;   // capacity being delivered now
  sold: { cpu: number; gpu: number; tb: number };                           // sold to contracts (the rest goes to spot)
  kw: number; heatKw: number; incomePerHour: number; costPerHour: number;
}
export type Autonomy = "advise" | "operate" | "full";
export interface State {
  version: number; seed: number; tick: number; facilityName: string;
  cash: number; reputation: number; speed: 0 | 1 | 2 | 4;
  powerCapKw: number; coolingCapKw: number;
  halls: Record<HallId, Hall>; racks: Record<RackId, Rack>;
  servers: Record<ServerId, Server>; parts: Record<PartId, Part>;
  contracts: Contract[]; orders: Order[]; jobs: Job[];
  alerts: Alert[]; milestones: string[]; ledger: LedgerDay[];
  settings: { autonomy: Autonomy; demo: boolean };
  // additions
  rngState: number;
  ids: { part: number; order: number; job: number; contract: number; alert: number; rack: number };
  stock: { racks: number; chassis: number; cart: boolean };
  degrading: PartId[];           // degraded parts with a pending failure, checked every tick
  totals: Totals;
  shopBlocked: boolean; powerWarn: boolean; repGainToday: number;
}
export type SimEvent = { kind: string; target?: string; text?: string; data?: unknown };
export const MILESTONES = ["first_light", "in_the_black", "five_nines", "hands_off", "full_house", "second_hall", "megawatt", "campus"] as const;
export type MilestoneId = (typeof MILESTONES)[number];
