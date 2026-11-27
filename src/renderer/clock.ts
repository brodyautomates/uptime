// One virtual clock for everything visual, so an offline replay render is frame-for-frame repeatable (gate G12).
import { uniform } from "three/tsl";
export const timeU = uniform(0);          // seconds, drives LED blink and grain
let ms = 0;
export const clock = {
  /** Virtual milliseconds since boot. */
  now: () => ms,
  advance(dt: number) { ms += dt * 1000; timeU.value = ms / 1000; },
  set(seconds: number) { ms = seconds * 1000; timeU.value = seconds; },
};
