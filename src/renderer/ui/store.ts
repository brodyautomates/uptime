import { createStore } from "zustand/vanilla";
import type { PartView, ServerView, InvItem, Toast, WorldView } from "@shared/view";

export type Mode = "walk" | "carry" | "inspect" | "seated" | "menu";
/** Walk and carry are both free movement; carry means a part, the cart or the rack dolly is in hand (SPEC section 7, modes). */
export const isFree = (m: Mode) => m === "walk" || m === "carry";
export interface FeedLine { id: number; text: string; kind: Toast["kind"]; t: number }
export interface PartMenu { slot: string; part: PartView | null; x: number; y: number; options: InvItem[]; orderSku: string; orderName: string }
export interface Label { slot: string; x: number; y: number; /** screen position of the part the label points at (leader line start) */ ax: number; ay: number; text: string; sub: string; tier: number; status: string }

export interface UIState {
  mode: Mode;
  hudHidden: boolean;
  prompt: string;
  hint: string;
  card: { title: string; lines: string[] } | null;
  inspect: { server: ServerView; hover: { slot: string; part: PartView | null } | null; exploded: boolean } | null;
  partMenu: PartMenu | null;
  /** slot whose card is pinned by the Info action */
  pinned: string | null;
  labels: Label[];
  feed: FeedLine[];
  feedLog: FeedLine[];
  held: InvItem | null;
  cartCount: number;
  world: WorldView | null;
  focusMonitor: 0 | 1 | 2;
  paused: boolean;
  tablet: boolean;
  monitorRects: ({ x: number; y: number; w: number; h: number } | null)[];
  banner: string;
  menu: null | "notice1" | "notice2" | "main" | "new" | "load" | "pause" | "settings" | "demo";
  debug: boolean;
  checklist: { step: number; done: boolean[]; hint: string; dismissed: boolean };
  set: (p: Partial<UIState>) => void;
  pushFeed: (text: string, kind?: Toast["kind"]) => void;
}

let feedId = 1;
export const ui = createStore<UIState>((set, get) => ({
  mode: "walk", hudHidden: false, prompt: "", hint: "", card: null, inspect: null, partMenu: null, pinned: null, labels: [], feed: [], feedLog: [], held: null, cartCount: 0,
  world: null, focusMonitor: 1, paused: false, tablet: false, monitorRects: [null, null, null], banner: "", menu: null, debug: false,
  checklist: { step: 0, done: [false, false, false, false, false, false, false], hint: "", dismissed: false },
  set: (p) => set(p),
  pushFeed: (text, kind = "info") => { const line = { id: feedId++, text, kind, t: performance.now() }; set({ feed: [...get().feed.slice(-5), line], feedLog: [...get().feedLog.slice(-199), line] }); },
}));
