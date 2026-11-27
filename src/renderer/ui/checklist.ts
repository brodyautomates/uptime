// First-shift checklist (SPEC appendix A). Seven steps, each ticks itself; one hint per step after 60 s idle.
import type { Client } from "../client";
import type { Player } from "../player/controller";
import type { Game } from "../game";
import { ui } from "./store";
import { clock } from "../clock";

export const STEPS = ["Walk to rack A-R01", "Open the door and pull out a server", "Toggle the exploded view", "Sit at the master computer", "Order one tier-1 GPU with express delivery", "Collect it from the loading bay and install it by hand", "Run claude in the terminal and ask for a status report"];
const HINTS = ["Use W A S D to walk. Rack A-R01 is the first rack on the right-hand row.", "Look at the rack door and press E. Then look at a server and press E again.", "With a server open, press X.", "Walk into the glass control room, look at the chair and press E.", "On the left monitor (Cmd+1) open Shop, add a tier-1 GPU, tick Express and place the order.", "Open the crate in the loading bay with E. Then pull a server, power it off, click an empty GPU slot and install the GPU.", "Focus the centre monitor (Cmd+2), type claude and ask: give me a status report."];

export class Checklist {
  claudeMissing = false;
  private stepStart = clock.now(); private hinted = new Set<number>();
  hintCount: number[] = [0, 0, 0, 0, 0, 0, 0];
  constructor(private client: Client, private api: any) {}
  private get s() { return ui.getState().checklist; }
  reset(fresh: boolean): void { ui.getState().set({ checklist: { step: 0, done: [false, false, false, false, false, false, false], hint: "", dismissed: !fresh } }); this.stepStart = clock.now(); this.hinted.clear(); this.hintCount = [0, 0, 0, 0, 0, 0, 0]; }
  show(): void { ui.getState().set({ checklist: { ...this.s, dismissed: false } }); }
  dismiss(): void { ui.getState().set({ checklist: { ...this.s, dismissed: true } }); }
  skip(): void { this.mark(this.s.step); }
  mark(i: number): void {
    const c = this.s; if (c.done[i] || i !== c.step) return;       // steps complete in order
    const done = [...c.done]; done[i] = true;
    ui.getState().set({ checklist: { ...c, done, step: i + 1, hint: "" } }); this.stepStart = clock.now();
    if (i === 6) ui.getState().pushFeed("First shift complete. The facility is yours.", "info");
  }
  onEvent(e: { kind: string; target?: string; data?: any; text?: string }): void {
    if (e.kind === "server_pull") this.mark(1);
    if (e.kind === "order_placed") { const d = e.data as any; const lines: any[] = d?.lines ?? []; if (!lines.length || (lines.some((l) => String(l.sku).startsWith("gpu.")) && d?.express !== false)) this.mark(4); }
    if (e.kind === "part_installed") { const d = e.data as any; if (d?.by !== "claude" && String(d?.sku ?? d?.slot ?? e.text ?? "").toLowerCase().includes("gpu")) this.mark(5); }
  }
  onMcp(a: { write: boolean }): void { if (!a.write) this.mark(6); }
  update(player: Player, game: Game): void {
    const c = this.s; if (c.step > 6) return;
    if (c.step === 0) { const m = game.racks.rackMatrix.get("A-R01"); if (m && Math.hypot(m.elements[12] - player.pos.x, m.elements[14] - player.pos.z) < 2.2) this.mark(0); }
    if (c.step === 1 && game.inspecting) this.mark(1);
    if (c.step === 2 && ui.getState().inspect?.exploded) this.mark(2);
    if (!c.hint && !this.hinted.has(c.step) && clock.now() - this.stepStart > 60000) { this.hinted.add(c.step); this.hintCount[c.step]++; ui.getState().set({ checklist: { ...c, hint: HINTS[c.step] } }); }
  }
}
