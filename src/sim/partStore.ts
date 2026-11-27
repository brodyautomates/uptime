// Part storage (SPEC appendix C): parts live in typed arrays (sku index, health, temperature, status, location).
// The rest of the code sees each part through a PartRec, which reads and writes those arrays.
import { SLOTS } from "./state";
import type { Part, PartId, PartWhere, Sku, SlotId } from "./state";

const STATUS: Part["status"][] = ["ok", "degraded", "failed"];
const KIND: PartWhere["kind"][] = ["slot", "shelf", "cart", "hand", "crate", "gantry"];
const SLOT_INDEX = new Map<string, number>(SLOTS.map((s, i) => [s, i]));

export class PartStore {
  n = 0; private cap = 256;
  id: PartId[] = [];
  sku = new Uint16Array(this.cap);        // index into skuList
  health = new Float64Array(this.cap);
  temp = new Float64Array(this.cap);
  status = new Uint8Array(this.cap);      // 0 ok, 1 degraded, 2 failed
  fails = new Float64Array(this.cap);     // tick at which a degraded part fails; NaN = none
  kind = new Uint8Array(this.cap);        // index into KIND
  slot = new Uint8Array(this.cap);        // index into SLOTS when kind is "slot"
  ref = new Int32Array(this.cap);         // interned id of the server, order or job; -1 = none
  skuList: Sku[] = []; private skuIdx = new Map<Sku, number>();
  private strs: string[] = []; private strIdx = new Map<string, number>();

  private grow(): void {
    const cap = this.cap * 2; const g = <T extends Uint16Array | Float64Array | Uint8Array | Int32Array>(a: T): T => { const b = new (a.constructor as any)(cap) as T; b.set(a as any); return b; };
    this.sku = g(this.sku); this.health = g(this.health); this.temp = g(this.temp); this.status = g(this.status); this.fails = g(this.fails); this.kind = g(this.kind); this.slot = g(this.slot); this.ref = g(this.ref); this.cap = cap;
  }
  skuOf(i: number): Sku { return this.skuList[this.sku[i]]; }
  setSku(i: number, sku: Sku): void { let k = this.skuIdx.get(sku); if (k === undefined) { k = this.skuList.length; this.skuList.push(sku); this.skuIdx.set(sku, k); } this.sku[i] = k; }
  private intern(s: string): number { let k = this.strIdx.get(s); if (k === undefined) { k = this.strs.length; this.strs.push(s); this.strIdx.set(s, k); } return k; }
  whereOf(i: number): PartWhere {
    const kind = KIND[this.kind[i]];
    if (kind === "slot") return { kind, server: this.strs[this.ref[i]], slot: SLOTS[this.slot[i]] as SlotId };
    if (kind === "crate") return { kind, order: this.strs[this.ref[i]] };
    if (kind === "gantry") return { kind, job: this.strs[this.ref[i]] };
    return { kind } as PartWhere;
  }
  setWhere(i: number, w: PartWhere): void {
    this.kind[i] = KIND.indexOf(w.kind); this.slot[i] = 0; this.ref[i] = -1;
    if (w.kind === "slot") { this.ref[i] = this.intern(w.server); this.slot[i] = SLOT_INDEX.get(w.slot) ?? 0; }
    else if (w.kind === "crate") this.ref[i] = this.intern(w.order);
    else if (w.kind === "gantry") this.ref[i] = this.intern(w.job);
  }
  add(p: Part): PartRec {
    if (this.n === this.cap) this.grow();
    const i = this.n++; this.id[i] = p.id; this.setSku(i, p.sku); this.health[i] = p.health; this.temp[i] = p.tempC;
    this.status[i] = STATUS.indexOf(p.status); this.fails[i] = p.failsAtTick === undefined ? NaN : p.failsAtTick; this.setWhere(i, p.where);
    return new PartRec(this, i);
  }
}

/** One part, as the rest of the sim sees it. Every field reads and writes the store's typed arrays. */
export class PartRec implements Part {
  #s: PartStore; #i: number;
  constructor(store: PartStore, index: number) { this.#s = store; this.#i = index; }
  get id(): PartId { return this.#s.id[this.#i]; }
  get sku(): Sku { return this.#s.skuOf(this.#i); } set sku(v: Sku) { this.#s.setSku(this.#i, v); }
  get health(): number { return this.#s.health[this.#i]; } set health(v: number) { this.#s.health[this.#i] = v; }
  get tempC(): number { return this.#s.temp[this.#i]; } set tempC(v: number) { this.#s.temp[this.#i] = v; }
  get status(): Part["status"] { return STATUS[this.#s.status[this.#i]]; } set status(v: Part["status"]) { this.#s.status[this.#i] = STATUS.indexOf(v); }
  get failsAtTick(): number | undefined { const f = this.#s.fails[this.#i]; return f !== f ? undefined : f; } set failsAtTick(v: number | undefined) { this.#s.fails[this.#i] = v === undefined ? NaN : v; }
  get where(): PartWhere { return this.#s.whereOf(this.#i); } set where(w: PartWhere) { this.#s.setWhere(this.#i, w); }
  /** Plain-object form: used by JSON.stringify (saves) and by the state hash. */
  toJSON(): Part { const o: Part = { id: this.id, sku: this.sku, health: this.health, status: this.status, tempC: this.tempC, where: this.where }; const f = this.failsAtTick; if (f !== undefined) o.failsAtTick = f; return o; }
}

const stores = new WeakMap<object, PartStore>();
/** The typed-array store behind a state's parts. Any plain part objects found (a freshly parsed save) are moved into it. */
export function storeOf(state: { parts: Record<PartId, Part> }): PartStore {
  let st = stores.get(state.parts);
  if (!st) {
    st = new PartStore(); stores.set(state.parts, st);
    for (const id of Object.keys(state.parts)) { const p = state.parts[id]; if (!(p instanceof PartRec)) state.parts[id] = st.add(p); }
  }
  return st;
}
