// The game's MCP server (SPEC section 10, appendix F). Loopback only, bearer token, origin check.
import http from "node:http";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools, type SimApi } from "./tools";

export class McpHost {
  port = 0;
  token = "";
  up = false;
  private server: http.Server | null = null;
  private lastAuthLog = 0;
  private calls: number[] = [];
  constructor(private sim: SimApi, private log: (s: string) => void) {}

  async start(): Promise<boolean> {
    this.token = randomBytes(32).toString("hex");
    for (let attempt = 0; attempt < 5; attempt++) {
      try { await this.listen(); this.up = true; return true; } catch (e) { this.log(`mcp: listen failed (${attempt + 1}/5): ${e}`); }
    }
    this.up = false; return false;
  }

  private listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => void this.handle(req, res));
      srv.once("error", reject);
      // forceFail lets a test exercise the retry path
      srv.listen(process.env.UPTIME_MCP_FORCE_FAIL ? { port: 1, host: "127.0.0.1" } : { port: 0, host: "127.0.0.1" }, () => {
        const a = srv.address(); this.port = typeof a === "object" && a ? a.port : 0; this.server = srv; srv.off("error", reject); resolve();
      });
    });
  }

  private rateLimited(): boolean {
    const now = Date.now(); this.calls = this.calls.filter((t) => now - t < 1000);
    if (this.calls.length >= 20) return true;
    this.calls.push(now); return false;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const deny = (code: number, msg: string) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: msg }, id: null })); };
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return deny(403, "forbidden origin");
    const host = (req.headers.host ?? "").split(":")[0];
    if (host !== "127.0.0.1" && host !== "localhost") return deny(403, "forbidden host");
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      if (Date.now() - this.lastAuthLog > 60000) { this.lastAuthLog = Date.now(); this.log("mcp: request without a valid token refused"); }
      return deny(401, "unauthorized");
    }
    if (!req.url?.startsWith("/mcp")) return deny(404, "not found");
    if (req.method !== "POST") return deny(405, "method not allowed");
    try {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      // stateless: a fresh server + transport per request
      const mcp = new McpServer({ name: "uptime", version: "1.0.0" });
      registerTools(mcp, this.sim, () => this.rateLimited());
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { void transport.close(); void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) { this.log(`mcp: ${e}`); if (!res.headersSent) deny(500, "internal error"); }
  }

  /** Write workspace/.mcp.json and CLAUDE.md (regenerated every launch). */
  writeWorkspace(dir: string, facilityName: string, rules: string): string {
    mkdirSync(dir, { recursive: true });
    const cfg = join(dir, ".mcp.json");
    writeFileSync(cfg, JSON.stringify({ mcpServers: { uptime: { type: "http", url: `http://127.0.0.1:${this.port}/mcp`, headers: { Authorization: `Bearer ${this.token}` } } } }, null, 2));
    chmodSync(cfg, 0o600);
    writeFileSync(join(dir, "CLAUDE.md"), claudeMd(facilityName, rules));
    return cfg;
  }
  stop(): void { this.server?.close(); this.server = null; this.up = false; }
}

function claudeMd(name: string, rules: string): string {
  return `# ${name}: operator notes

You are the operator AI for **${name}**, a simulated data center inside the game UPTIME. Everything here is in-game: the money, the hardware and the contracts are not real.

## How to work
- Use the \`uptime\` MCP tools. They are the only way to see or change the facility.
- Start with \`list_alerts\`, then \`get_overview\`.
- Physical work (installing or removing parts) is done by the overhead gantry. Queue it with \`install_part\` / \`remove_part\`; \`install_part\` on an occupied slot swaps the part, so a failed part needs just one call; each job takes a few seconds and costs a small fee. Parts must be in stock: check \`list_inventory\`, and order with \`shop_order\` if not.
- CPUs, memory, GPUs and network cards need the server powered off first (\`set_server_power\`). Drives, fans and power supplies are hot-swappable.
- Use \`wait_for_event\` to wait for a delivery or a finished job instead of polling.
- A refused call returns a reason. Tell the player what it was; do not retry the same call unchanged.
- When you finish, say what you did in two lines.

## Ids
- Rack \`A-R03\`, server \`A-R03-S02\` (bay 01 is the bottom), slots \`CPU1-2\`, \`RAM1-8\`, \`GPU1-4\`, \`DRV1-4\`, \`PSU1-2\`, \`FAN1-4\`, \`NIC1\`.
- Part skus look like \`gpu.v2\`, \`cpu.k3\`, \`fan.z1\`. \`shop_catalog\` lists them all.

## Rules of the simulation
${rules}
`;
}
