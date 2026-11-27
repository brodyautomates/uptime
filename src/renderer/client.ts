// The renderer's link to the simulation. IpcClient talks to the main process; MockClient is a local stand-in for visual tests.
import type { WorldView, ServerView, InvItem, CmdResult, Toast, AlertView, PartView } from "@shared/view";
import { mockWorld } from "./mock";

export interface Client {
  world: WorldView;
  inventory: InvItem[];
  stock: { racks: number; chassis: number; cart: boolean };
  send(cmd: Record<string, any>): Promise<CmdResult>;
  /** Ask for full part detail for one server (kept fresh while watched). */
  watchServer(id: string | null): void;
  query<T = any>(view: string, ...args: any[]): Promise<T>;
  onChange(fn: () => void): () => void;
  onToast(fn: (t: Toast) => void): () => void;
  onEvent(fn: (e: { kind: string; target?: string; text?: string; data?: any }) => void): () => void;
}

export function findServer(w: WorldView, id: string): ServerView | null {
  for (const r of w.racks) for (const s of r.servers) if (s && s.id === id) return s;
  return null;
}
export const findRack = (w: WorldView, id: string) => w.racks.find((r) => r.id === id) ?? null;

class Emitter<T> { private fns = new Set<(v: T) => void>(); on(fn: (v: T) => void) { this.fns.add(fn); return () => this.fns.delete(fn); } emit(v: T) { for (const f of this.fns) f(v); } }

export class MockClient implements Client {
  world: WorldView; inventory: InvItem[] = []; stock = { racks: 0, chassis: 0, cart: true };
  private ch = new Emitter<void>(); private toast = new Emitter<Toast>(); private ev = new Emitter<any>();
  constructor(preset: "fresh" | "showcase" | "mega") {
    this.world = mockWorld(preset);
    const mk = (family: string, tier: number, n: number): InvItem => ({ id: `inv_${family}${tier}_${n}`, sku: `${family}.${tier}`, name: `${family.toUpperCase()} T${tier}`, family, tier, health: 100, status: "ok", tempC: 22, watts: 100, where: "shelf" });
    this.inventory = [mk("gpu", 2, 1), mk("gpu", 3, 2), mk("fan", 2, 1), mk("cpu", 3, 1), mk("ram", 2, 1), mk("drv", 2, 1), mk("psu", 3, 1)];
  }
  async send(cmd: Record<string, any>): Promise<CmdResult> {
    const w = this.world;
    const rack = cmd.rack ? findRack(w, cmd.rack) : null, srv = cmd.server ? findServer(w, cmd.server) : null;
    switch (cmd.type) {
      case "setRackDoor": if (rack) rack.doorOpen = cmd.open; break;
      case "pullServer": if (srv) srv.pulledOut = true; break;
      case "pushServer": if (srv) srv.pulledOut = false; break;
      case "setServerPower": if (srv) srv.power = cmd.on ? "on" : "off"; break;
      case "removePart": {
        const p = srv?.slots?.[cmd.slot]; if (!srv || !p) return { ok: false, reason: "empty_slot", message: "That slot is empty." };
        if (this.inventory.some((i) => i.where === "hand")) return { ok: false, reason: "hands_full", message: "Your hands are full." };
        const hot = ["DRV", "PSU", "FAN"].includes(cmd.slot.slice(0, 3));
        if (!hot && srv.power !== "off") return { ok: false, reason: "needs_power_off", message: "Power the server off before removing this part." };
        srv.slots![cmd.slot] = null; this.inventory.push({ ...p, where: "hand" }); break;
      }
      case "installPart": {
        const i = this.inventory.findIndex((x) => x.id === cmd.part); if (!srv || i < 0) return { ok: false, reason: "part_not_available", message: "That part is not available." };
        if (srv.slots![cmd.slot]) return { ok: false, reason: "slot_full", message: "That slot is already filled." };
        const it = this.inventory[i];
        if (it.family !== cmd.slot.slice(0, 3).toLowerCase()) return { ok: false, reason: "wrong_type", message: "That part does not fit this slot." };
        const hot = ["DRV", "PSU", "FAN"].includes(cmd.slot.slice(0, 3));
        if (!hot && srv.power !== "off") return { ok: false, reason: "needs_power_off", message: "Power the server off before installing this part." };
        this.inventory.splice(i, 1); const { where: _w, ...part } = it; srv.slots![cmd.slot] = part as PartView; break;
      }
      default: return { ok: false, reason: "unknown", message: `Mock client does not handle ${cmd.type}.` };
    }
    this.ch.emit(); return { ok: true };
  }
  watchServer(): void {}
  async query<T>(): Promise<T> { return [] as any; }
  onChange(fn: () => void) { return this.ch.on(fn); }
  onToast(fn: (t: Toast) => void) { return this.toast.on(fn); }
  onEvent(fn: (e: any) => void) { return this.ev.on(fn); }
}

/** The real client: mirrors the sim through IPC deltas. */
export class IpcClient implements Client {
  world!: WorldView; inventory: InvItem[] = []; stock = { racks: 0, chassis: 0, cart: false };
  extra: { orders: any[]; jobs: any[]; milestones: string[] } = { orders: [], jobs: [], milestones: [] };
  private ch = new Emitter<void>(); private toast = new Emitter<Toast>(); private ev = new Emitter<any>();
  private byId = new Map<string, number>();
  private api = (window as any).uptime;
  resetCount = 0;
  async init(): Promise<void> {
    this.adopt(await this.api.invoke("sim.snapshot"));
    this.api.on("sim.reset", (full: any) => { this.adopt(full); this.resetCount++; this.ch.emit(); });
    this.api.on("sim.delta", (d: any) => this.merge(d));
    this.api.on("sim.events", (evs: any[]) => { for (const e of evs) this.ev.emit(e); });
  }
  /** Replay playback: apply messages the main process returned instead of pushed. */
  ingest(msgs: { ch: string; a: any[] }[], onOther: (ch: string, a: any[]) => void): void {
    for (const m of msgs) { if (m.ch === "sim.delta") this.merge(m.a[0]); else if (m.ch === "sim.events") { for (const e of m.a[0]) this.ev.emit(e); } else onOther(m.ch, m.a); }
  }
  private adopt(full: any) { this.world = full.world; this.inventory = full.inventory; this.extra = full.extra; this.stock = full.extra.stock ?? this.stock; this.byId.clear(); this.world.racks.forEach((r, i) => this.byId.set(r.id, i)); }
  private merge(d: any) {
    if (!this.world) return;
    const racks = this.world.racks;
    let structural = false;
    if (d.removed) { this.world.racks = racks.filter((r) => !d.removed.includes(r.id)); structural = true; }
    if (d.racks) for (const r of d.racks as any[]) {
      const i = this.byId.get(r.id);
      if (i === undefined || !this.world.racks[i] || this.world.racks[i].id !== r.id) { this.world.racks.push(r); structural = true; }
      else { const old = this.world.racks[i]; for (let b = 0; b < r.servers.length; b++) { const o = old.servers[b], n = r.servers[b]; if (o && n && o.id === n.id && o.slots) n.slots = o.slots; } this.world.racks[i] = r; }
    }
    if (structural) { this.world.racks.sort((a, b) => (a.id < b.id ? -1 : 1)); this.byId.clear(); this.world.racks.forEach((r, i) => this.byId.set(r.id, i)); }
    Object.assign(this.world, d.header);
    if (d.detail) { const s = findServer(this.world, d.detail.id); if (s) s.slots = d.detail.slots; }
    if (d.inventory) this.inventory = d.inventory;
    if (d.extra) { this.extra = d.extra; this.stock = d.extra.stock ?? this.stock; }
    this.ch.emit();
  }
  send(cmd: Record<string, any>): Promise<CmdResult> { return this.api.invoke("sim.command", cmd); }
  watchServer(id: string | null): void { void this.api.invoke("sim.watch", id); }
  query<T>(view: string, ...args: any[]): Promise<T> { return this.api.invoke("sim.query", view, ...args); }
  onChange(fn: () => void) { return this.ch.on(fn); }
  onToast(fn: (t: Toast) => void) { return this.toast.on(fn); }
  onEvent(fn: (e: any) => void) { return this.ev.on(fn); }
}
export type { AlertView };
