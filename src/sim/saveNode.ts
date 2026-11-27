// Node-only save helpers (gzip). Keep everything else in src/sim browser-safe.
import { gunzipSync, gzipSync } from "node:zlib";
import type { Balance } from "./balance";
import { deserialize } from "./save";
import type { State } from "./state";

/** The save file of SPEC Appendix H: gzip of `{ version, savedAt, state }`. The host passes the clock in. */
export function packSave(state: State, savedAt: string): Uint8Array {
  return gzipSync(JSON.stringify({ version: state.version, savedAt, state }));
}
/** Reads a save file (gzip or plain JSON), migrates and validates it. Throws when it is corrupt. */
export function unpackSave(file: Uint8Array, bal: Balance): { savedAt?: string; state: State } {
  const gz = file.length > 2 && file[0] === 0x1f && file[1] === 0x8b;
  const text = (gz ? gunzipSync(file) : Buffer.from(file)).toString("utf8");
  const state = deserialize(text, bal);
  let savedAt: string | undefined;
  try { const raw = JSON.parse(text); if (typeof raw.savedAt === "string") savedAt = raw.savedAt; } catch { /* deserialize already threw */ }
  return { savedAt, state };
}
