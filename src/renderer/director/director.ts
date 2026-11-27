// Demo director (SPEC section 13). Hotkeys that force events. Never drawn in the clean frame.
import type { Game } from "../game";
import type { Client } from "../client";
import { ui } from "../ui/store";
import { BOOKMARKS } from "../bookmarks";

const PRESETS = ["fresh", "demo", "showcase", "mega"];
export class Director {
  private bm = -1; private preset = 0; private logging = false;
  debug = false; private cycled = false;
  constructor(private game: Game, private client: Client, private enabled: () => boolean, private gotoBookmark: (n: string) => void) {
    window.addEventListener("keydown", (e) => { if (/^F([1-9]|10)$/.test(e.key)) { e.preventDefault(); void this.key(e.key, e.shiftKey); } }, true);
  }
  private say(t: string) { ui.getState().pushFeed(`Director · ${t}`, "info"); }
  async key(k: string, shift = false): Promise<void> {
    const api = (window as any).uptime;
    if (k === "F10") { if (this.enabled() || (import.meta as any).env?.DEV) { this.debug = !this.debug; ui.getState().set({ debug: this.debug } as any); } return; }
    if (!this.enabled()) return;
    const rack = this.game.lookRack();
    const send = (cmd: any) => this.client.send({ ...cmd, by: "director" });
    switch (k) {
      case "F1": if (rack) { const r = await send({ type: "director.overheatRack", rack }); this.say(r.ok ? `overheat ${rack}` : r.message); } break;
      case "F2": if (rack) { const r = await send(shift ? { type: "director.failPart", rack, family: "fan" } : { type: "director.failPart", rack }); this.say(r.ok ? `fail ${shift ? "a fan" : "a random part"} in ${rack}` : r.message); } break;       // Shift+F2 picks a fan: hot-swappable, so the fix is quick to show
      case "F3": await send({ type: "director.deliverAll" }); this.say("deliver all orders"); break;
      case "F4": await send({ type: "director.addCash", amount: 50000 }); this.say("+$50,000"); break;
      case "F5": await send({ type: "director.skipDay" }); this.say("skipped one day"); break;
      case "F6": { const n = this.client.world.racks.length; if (!this.cycled) { this.preset = n <= 2 ? 0 : n <= 12 ? 1 : n <= 18 ? 2 : 3; this.cycled = true; } } this.preset = (this.preset + 1) % PRESETS.length; await api?.invoke("game.new", { name: this.client.world.facilityName, preset: PRESETS[this.preset] }); await this.client.send({ type: "setDemoMode", on: true, by: "player" }); this.say(`loaded ${PRESETS[this.preset]}`); break;
      case "F7": ui.getState().set({ hudHidden: !ui.getState().hudHidden }); break;
      case "F8": this.logging = !this.logging; if (this.logging) { await (window as any).game.capture.setLogging(true); await api?.invoke("replay.marker", "start"); this.say("replay logging on"); } else { await api?.invoke("replay.marker", "stop"); const d = await (window as any).game.capture.setLogging(false); this.say(`replay saved: ${String(d ?? "").split("/").pop()}`); } break;
      case "F9": this.bm = (this.bm + 1) % BOOKMARKS.length; this.gotoBookmark(BOOKMARKS[this.bm].name); this.say(BOOKMARKS[this.bm].name); break;
    }
  }
  update(): void {}
}
