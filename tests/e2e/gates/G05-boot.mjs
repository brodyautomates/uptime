import { launch, world } from "../harness.mjs";
export const name = "Boot";
export default async function () {
  const a = await launch({ preset: "fresh" });
  try {
    const w = await world(a.page);
    const ok = a.bootMs < 6000 && a.errors.length === 0 && w.racks === 2;
    return { pass: ok, detail: `reached Hall A in ${a.bootMs} ms, ${a.errors.length} console errors, ${w.racks} racks${a.errors.length ? "\n" + a.errors.slice(0, 3).join("\n") : ""}` };
  } finally { await a.close(); }
}
