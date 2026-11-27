// The renderer's picture of the facility. Filled from sim snapshots/deltas (or a mock before the sim is wired).
import type { HallId } from "./layout";

export type Status = "ok" | "degraded" | "failed";
export type Power = "off" | "booting" | "on" | "shutdown_thermal" | "no_power";

export interface PartView { id: string; sku: string; name: string; family: string; tier: number; health: number; status: Status; tempC: number; watts: number; /** what the part adds, in words: "18 compute units" */ contrib?: string; price?: number }
export interface ServerView {
  id: string; bay: number; power: Power; status: Status; load: number; tempC: number;
  out: { cpu: number; gpu: number; tb: number }; watts: number; bottleneck: string; pulledOut: boolean;
  /** drive bay states for the front LEDs: 0 empty, 1 ok, 2 degraded, 3 failed */
  drives: number[];
  /** full part detail; only present for a server the renderer asked for */
  slots?: Record<string, PartView | null>;
  /** sim tick until which the power ring pulses cyan (Claude acted on it) */
  claudeUntil?: number;
}
export interface RackView {
  id: string; hall: HallId; slot: number; doorOpen: boolean; breaker: "closed" | "tripped";
  pduCapKw: number; rearDoor: boolean; kw: number; servers: (ServerView | null)[];
}
export interface HallView { id: HallId; owned: boolean; airC: number; heatKw: number; coolingKw: number }
export interface WorldView {
  tick: number; cash: number; incomePerHour: number; costPerHour: number; reputation: number;
  power: { usedKw: number; capKw: number }; cooling: { heatKw: number; capKw: number };
  time: { day: number; hour: number; minute: number }; speed: number; facilityName: string;
  halls: Record<HallId, HallView>; racks: RackView[]; alertCount: number;
}

export interface InvItem extends PartView { where: "shelf" | "cart" | "hand" | "crate" }
export interface Toast { text: string; kind: "info" | "warn" | "critical" | "claude"; target?: string }
export type CmdResult = { ok: true; data?: any } | { ok: false; reason: string; message: string };
export interface AlertView { id: string; severity: "info" | "warn" | "critical"; kind: string; target?: string; text: string; time?: { day: number; hour: number } }
