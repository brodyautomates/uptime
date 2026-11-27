import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type CmdResult = { ok: true; data?: any } | { ok: false; reason: string; message: string };
/** What the MCP layer needs from the simulation host. */
export interface SimApi {
  view(name: string, ...args: any[]): any;
  command(cmd: Record<string, any>): Promise<CmdResult>;
  waitForEvent(kinds: string[] | undefined, timeoutMs: number): Promise<any | null>;
  activity(tool: string, target: string | undefined, ok: boolean): void;
}

const ok = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 1) }] });
const err = (reason: string, message: string) => ({ isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: reason, message }) }] });

export const TOOL_NAMES = ["get_overview", "list_alerts", "list_racks", "get_rack", "get_server", "list_inventory", "shop_catalog", "shop_order", "list_orders", "install_part", "remove_part", "set_server_power", "reset_breaker", "list_contracts", "accept_contract", "cancel_contract", "buy_upgrade", "wait_for_event", "get_finance_report"] as const;

export function registerTools(mcp: McpServer, sim: SimApi, rateLimited: () => boolean): void {
  const read = (name: string, description: string, shape: Record<string, z.ZodTypeAny>, fn: (a: any) => any) =>
    mcp.registerTool(name, { description, inputSchema: shape, annotations: { readOnlyHint: true } }, async (a: any) => {
      if (rateLimited()) return err("rate_limited", "Too many calls. Slow down to under 20 a second.");
      try { const v = fn(a ?? {}); sim.activity(name, undefined, true); return v === null ? err("not_found", "No such id.") : ok(v); } catch (e) { return err("internal", String(e)); }
    });
  const write = (name: string, description: string, shape: Record<string, z.ZodTypeAny>, target: (a: any) => string | undefined, toCmd: (a: any) => Record<string, any>, out: (a: any, data: any) => any = (_a, d) => d ?? { ok: true }) =>
    mcp.registerTool(name, { description, inputSchema: shape }, async (a: any) => {
      if (rateLimited()) return err("rate_limited", "Too many calls. Slow down to under 20 a second.");
      const r = await sim.command({ ...toCmd(a ?? {}), by: "claude" });
      sim.activity(name, target(a ?? {}), r.ok);
      return r.ok ? ok(out(a, r.data)) : err(r.reason, r.message);
    });

  const hall = z.enum(["A", "B", "C"]);
  read("get_overview", "Cash, income and cost per hour, power, cooling, hall temperatures, reputation, capacity and time.", {}, () => sim.view("overview"));
  read("list_alerts", "Open alerts: degraded and failed parts, thermal and power warnings, SLA risks.", { includeCleared: z.boolean().optional() }, (a) => sim.view("alerts", a.includeCleared));
  read("list_racks", "Every rack with load, heat, PDU use and worst status.", { hall: hall.optional() }, (a) => sim.view("racks", a.hall));
  read("get_rack", "One rack with its servers.", { rack: z.string() }, (a) => sim.view("rack", a.rack));
  read("get_server", "One server: every slot, part, health, temperature and bottleneck.", { server: z.string() }, (a) => sim.view("server", a.server));
  read("list_inventory", "Parts in stock (shelf, cart, open deliveries).", {}, () => sim.view("inventory"));
  read("shop_catalog", "Items for sale with prices and delivery times.", { family: z.string().optional() }, (a) => sim.view("catalog", a.family));
  read("list_orders", "Orders in transit and queued gantry jobs.", {}, () => sim.view("orders"));
  read("list_contracts", "Contract offers and active contracts.", { state: z.enum(["offer", "active"]).optional() }, (a) => sim.view("contracts", a.state));
  read("get_finance_report", "Income and cost breakdown over a period.", { days: z.number().int().min(1).max(30).optional() }, (a) => sim.view("finance", a.days));

  write("shop_order", "Place a shop order. Express costs 25% more and arrives in seconds.", { lines: z.array(z.object({ sku: z.string(), qty: z.number().int().min(1).max(200) })).min(1), express: z.boolean().optional() }, () => "shop", (a) => ({ type: "placeOrder", lines: a.lines, express: !!a.express }));
  write("install_part", "Queue a gantry job that installs a part into a server slot. Give a part id, or a sku to use the oldest matching part in stock. If the slot already holds a part, this is a swap: the old part is taken to the shelf first, so no separate remove_part call is needed.", { server: z.string(), slot: z.string(), part: z.string().optional(), sku: z.string().optional() }, (a) => a.server, (a) => ({ type: "queueJob", kind: "install", server: a.server, slot: a.slot, part: a.part, sku: a.sku }));
  write("remove_part", "Queue a gantry job that removes the part in a slot to the shelf.", { server: z.string(), slot: z.string() }, (a) => a.server, (a) => ({ type: "queueJob", kind: "remove", server: a.server, slot: a.slot }));
  write("set_server_power", "Power a server on or off.", { server: z.string(), on: z.boolean() }, (a) => a.server, (a) => ({ type: "setServerPower", server: a.server, on: a.on }), (a) => ({ power: a.on ? "booting" : "off" }));
  write("reset_breaker", "Close a tripped rack breaker.", { rack: z.string() }, (a) => a.rack, (a) => ({ type: "resetBreaker", rack: a.rack }), () => ({ breaker: "closed" }));
  write("accept_contract", "Accept a contract offer.", { contract: z.string() }, () => "contracts", (a) => ({ type: "acceptContract", contract: a.contract }), () => ({ state: "active" }));
  write("cancel_contract", "Cancel an active contract (costs one day's value and reputation).", { contract: z.string() }, () => "contracts", (a) => ({ type: "cancelContract", contract: a.contract }), () => ({ state: "cancelled" }));
  write("buy_upgrade", "Buy a facility upgrade: power, cooling, a rack's PDU or rear-door cooler (target = rack id), or a hall (target = B or C).", { kind: z.enum(["power", "cooling", "pdu", "rear_door", "hall"]), target: z.string().optional() }, (a) => a.target ?? "facility", (a) => ({ type: "buyUpgrade", kind: a.kind, target: a.target }));

  mcp.registerTool("wait_for_event", { description: "Block until the next alert, delivery or finished job (up to 60 s). Use this instead of polling.", inputSchema: { timeoutSeconds: z.number().min(1).max(60).optional(), kinds: z.array(z.string()).optional() }, annotations: { readOnlyHint: true } }, async (a: any) => {
    const ev = await sim.waitForEvent(a?.kinds, Math.min(60, a?.timeoutSeconds ?? 30) * 1000);
    sim.activity("wait_for_event", undefined, true);
    return ok(ev ?? { timeout: true });
  });
}
