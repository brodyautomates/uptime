import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyCommand, parseBalance, tick } from "@sim/index";
import type { Balance, Command, Result, SimEvent, State } from "@sim/index";

export const loadBalance = (): Balance => parseBalance(JSON.parse(readFileSync(resolve(__dirname, "../../balance/balance.json"), "utf8")));
export function run(state: State, bal: Balance, ticks: number): SimEvent[] {
  const all: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) { const ev = tick(state, bal); for (const e of ev) all.push(e); }
  return all;
}
export const cmd = (state: State, bal: Balance, c: Command): Result => applyCommand(state, bal, c);
export function must(state: State, bal: Balance, c: Command): unknown {
  const r = applyCommand(state, bal, c);
  if (!r.ok) throw new Error(`${c.type} refused: ${r.reason} ${r.message}`);
  return r.data;
}
export function reason(r: Result): string { return r.ok ? "ok" : r.reason; }
/** Places an express order, waits for it and opens the crate. Returns the new part ids in order. */
export function buy(state: State, bal: Balance, lines: { sku: string; qty: number }[]): string[] {
  const before = new Set(Object.keys(state.parts));
  const d = must(state, bal, { by: "player", type: "placeOrder", lines, express: true }) as { order: string };
  run(state, bal, bal.shop.expressTicks + 1);
  must(state, bal, { by: "player", type: "openCrate", order: d.order });
  return Object.keys(state.parts).filter((id) => !before.has(id)).sort();
}
