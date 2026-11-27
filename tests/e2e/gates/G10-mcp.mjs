import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { launch, sleep } from "../harness.mjs";
export const name = "MCP: every tool answers, no token is refused";
const EXPECT = ["get_overview", "list_alerts", "list_racks", "get_rack", "get_server", "list_inventory", "shop_catalog", "shop_order", "list_orders", "install_part", "remove_part", "set_server_power", "reset_breaker", "list_contracts", "accept_contract", "cancel_contract", "buy_upgrade", "wait_for_event", "get_finance_report"];
export async function connect(userData) {
  const cfg = JSON.parse(readFileSync(join(userData, "workspace/.mcp.json"), "utf8")).mcpServers.uptime;
  const client = new Client({ name: "gate", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }));
  return { client, cfg };
}
export const call = async (client, name, args = {}) => { const r = await client.callTool({ name, arguments: args }); let v; try { v = JSON.parse(r.content[0].text); } catch { v = r.content?.[0]?.text; } return { isError: !!r.isError, v }; };
export default async function () {
  const a = await launch({ preset: "showcase" }); const notes = []; let bad = 0;
  try {
    const { client, cfg } = await connect(a.userData);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    const missing = EXPECT.filter((t) => !tools.includes(t)); if (missing.length) { bad++; notes.push("missing " + missing.join(",")); }
    const c = (n, args) => call(client, n, args);
    const chk = (label, r, okIf = (x) => !x.isError) => { if (!okIf(r)) { bad++; notes.push(`${label}: ${JSON.stringify(r.v).slice(0, 120)}`); } };
    const ov = await c("get_overview"); chk("get_overview", ov, (r) => !r.isError && typeof r.v.cash === "number");
    chk("list_alerts", await c("list_alerts"));
    const racks = await c("list_racks", { hall: "A" }); chk("list_racks", racks, (r) => Array.isArray(r.v) && r.v.length === 12);
    chk("get_rack", await c("get_rack", { rack: "A-R02" }), (r) => !r.isError && r.v.servers?.length > 0);
    const sv = await c("get_server", { server: "A-R02-S02" }); chk("get_server", sv, (r) => !r.isError && r.v.slots?.length === 25);
    chk("get_server bad id", await c("get_server", { server: "Z-R99-S01" }), (r) => r.isError);
    chk("list_inventory", await c("list_inventory"));
    const cat = await c("shop_catalog", { family: "fan" }); chk("shop_catalog", cat, (r) => Array.isArray(r.v) && r.v.length === 3);
    chk("list_contracts", await c("list_contracts", { state: "offer" }));
    chk("get_finance_report", await c("get_finance_report", { days: 3 }));
    const order = await c("shop_order", { lines: [{ sku: "fan.z2", qty: 2 }], express: true }); chk("shop_order", order);
    chk("list_orders", await c("list_orders"), (r) => !r.isError && r.v.orders?.length >= 1);
    const ev = await c("wait_for_event", { timeoutSeconds: 40, kinds: ["delivery"] }); chk("wait_for_event delivery", ev, (r) => !r.isError && !r.v.timeout);
    chk("remove_part", await c("remove_part", { server: "A-R02-S02", slot: "FAN2" }));
    await c("wait_for_event", { timeoutSeconds: 20, kinds: ["job_done", "job_failed"] });
    chk("install_part", await c("install_part", { server: "A-R02-S02", slot: "FAN2", sku: "fan.z2" }));
    const done = await c("wait_for_event", { timeoutSeconds: 20, kinds: ["job_done", "job_failed"] });
    const after = await c("get_server", { server: "A-R02-S02" });
    const fan2 = after.v.slots.find((s) => s.slot === "FAN2").part?.sku; if (fan2 !== "fan.z2") { bad++; notes.push(`FAN2 is ${fan2} after gantry job (${JSON.stringify(done.v).slice(0, 80)})`); }
    chk("set_server_power off", await c("set_server_power", { server: "A-R02-S03", on: false }));
    chk("set_server_power on", await c("set_server_power", { server: "A-R02-S03", on: true }));
    chk("reset_breaker (not tripped -> refusal)", await c("reset_breaker", { rack: "A-R02" }), (r) => r.isError && r.v.error === "not_tripped");
    const offers = await c("list_contracts", { state: "offer" });
    if (offers.v.length) { const acc = await c("accept_contract", { contract: offers.v[0].id }); chk("accept_contract", acc, (r) => !r.isError || ["too_many_active", "reputation_too_low"].includes(r.v.error)); if (!acc.isError) chk("cancel_contract", await c("cancel_contract", { contract: offers.v[0].id })); else chk("cancel_contract (refusal)", await c("cancel_contract", { contract: "nope" }), (r) => r.isError); }
    else { chk("accept_contract (refusal)", await c("accept_contract", { contract: "nope" }), (r) => r.isError); chk("cancel_contract (refusal)", await c("cancel_contract", { contract: "nope" }), (r) => r.isError); }
    chk("buy_upgrade pdu", await c("buy_upgrade", { kind: "pdu", target: "A-R03" }), (r) => !r.isError || r.v.error === "already_max");
    await client.close();
    // no token -> 401 ; wrong origin -> 403
    const noTok = await fetch(cfg.url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const badOrigin = await fetch(cfg.url, { method: "POST", headers: { ...cfg.headers, origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
    if (noTok.status !== 401) { bad++; notes.push(`no-token status ${noTok.status}`); }
    if (badOrigin.status !== 403) { bad++; notes.push(`foreign-origin status ${badOrigin.status}`); }
    await sleep(300);
    const feed = await a.page.evaluate(() => window.game.ui.getState().feed.filter((f) => f.kind === "claude").length);
    if (feed < 1) { bad++; notes.push("no Claude line reached the activity feed"); }
    return { pass: bad === 0, detail: `${tools.length} tools listed, ${EXPECT.length} exercised, ${bad} problems; no-token ${noTok.status}, foreign origin ${badOrigin.status}; claude feed lines ${feed}${notes.length ? "\n" + notes.join("\n") : ""}` };
  } finally { await a.close(); }
}
