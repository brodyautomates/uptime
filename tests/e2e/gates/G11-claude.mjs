import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { launch, sleep, waitFor } from "../harness.mjs";
export const name = "Real Claude Code operates the facility through MCP";
export default async function () {
  const a = await launch({ preset: "showcase" }); const { page } = a;
  try {
    const which = spawnSync(process.env.SHELL || "/bin/zsh", ["-lic", "command -v claude"], { encoding: "utf8" });
    if (which.status !== 0 || !which.stdout.trim()) return { pass: false, detail: "claude is not installed on this machine, so this gate cannot run" };
    const ws = join(a.userData, "workspace"); const target = "A-R04-S05";
    const before = await page.evaluate((id) => window.game.findServer(window.game.client.world, id).power, target);
    const prompt = `Use the uptime tools. First call get_overview and tell me the cash figure. Then power off server ${target} with set_server_power. Reply with one line: CASH=<number> POWER=<off or on>.`;
    const r = spawnSync("claude", ["-p", prompt, "--mcp-config", join(ws, ".mcp.json"), "--strict-mcp-config", "--allowedTools", "mcp__uptime__get_overview,mcp__uptime__set_server_power", "--model", "haiku"], { cwd: ws, encoding: "utf8", timeout: 150000, env: { ...process.env } });
    const out = (r.stdout ?? "").trim();
    const after = await waitFor(() => page.evaluate((id) => { const p = window.game.findServer(window.game.client.world, id).power; return p === "off" ? p : null; }, target), 6000);
    await sleep(300);
    const feed = await page.evaluate(() => window.game.ui.getState().feed.filter((f) => f.kind === "claude").map((f) => f.text));
    const ring = await page.evaluate(() => window.game.props.ringsFired);
    const cash = /CASH=\$?([\d,]+)/.exec(out)?.[1];
    const pass = before === "on" && after === "off" && feed.some((f) => f.includes("set_server_power")) && !!cash && ring >= 1;
    return { pass, detail: `claude exit ${r.status}; said: ${out.slice(0, 140).replace(/\n/g, " ")}; ${target} ${before} -> ${after ?? "unchanged"}; feed: ${feed.slice(-2).join(" / ")}; cyan rings fired on the rack: ${ring}${r.stderr ? "; stderr " + r.stderr.slice(0, 160) : ""}` };
  } finally { await a.close(); }
}
