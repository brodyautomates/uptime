// Rebindable controls (SPEC appendix K: every control in section 7 except the Cmd chords used while seated).
export type Action = "forward" | "back" | "left" | "right" | "run" | "use" | "putBack" | "explode" | "flashlight" | "hud" | "tablet" | "pause";
export const ACTIONS: [Action, string][] = [["forward", "Walk forward"], ["back", "Walk back"], ["left", "Strafe left"], ["right", "Strafe right"], ["run", "Move faster"], ["use", "Use"], ["putBack", "Put back / close"], ["explode", "Exploded view"], ["flashlight", "Flashlight"], ["hud", "Hide the HUD"], ["tablet", "Tablet"], ["pause", "Pause"]];
export const DEFAULT_KEYS: Record<Action, string> = { forward: "KeyW", back: "KeyS", left: "KeyA", right: "KeyD", run: "ShiftLeft", use: "KeyE", putBack: "KeyQ", explode: "KeyX", flashlight: "KeyF", hud: "KeyH", tablet: "Tab", pause: "KeyP" };
export const keys: Record<Action, string> = { ...DEFAULT_KEYS };
export function loadKeys(saved: unknown): void { if (saved && typeof saved === "object") for (const [a] of ACTIONS) { const v = (saved as any)[a]; if (typeof v === "string" && v) keys[a] = v; } }
/** Bind an action to a key. A key already used by another action is swapped with it, so nothing is ever unbound. */
export function bind(action: Action, code: string): Record<Action, string> {
  if (/^(Meta|F\d+|Escape)/.test(code)) return { ...keys };       // reserved: Cmd chords, director keys, Esc
  const other = ACTIONS.map(([a]) => a).find((a) => a !== action && keys[a] === code);
  if (other) keys[other] = keys[action];
  keys[action] = code; return { ...keys };
}
export const is = (e: KeyboardEvent, a: Action) => e.code === keys[a];
export const label = (code: string) => code.replace(/^Key/, "").replace(/^Digit/, "").replace("ShiftLeft", "Shift").replace("ShiftRight", "Right Shift").replace("ControlLeft", "Ctrl").replace("AltLeft", "Option").replace("Space", "Space");
