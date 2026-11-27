import { expect, test } from "vitest";
import { runIdle, runSensiblePlayer } from "../../scripts/balance-report";
import { loadBalance } from "./helpers";

// G3: the three balance gates of SPEC section 9.
test("G3 balance gates with a scripted sensible player", () => {
  const bal = loadBalance();
  const bot = runSensiblePlayer(bal, 75);
  console.log("G3 bot:", JSON.stringify({ ...bot, refusals: [...new Set(bot.refusals)], timeline: bot.timeline.map((t) => `${t.realMinute}m $${t.cash} +${t.incomePerHour}/h ${t.servers}srv`) }, null, 1));
  expect(bot.firstUpgrade).not.toBeNull();
  expect(bot.firstUpgrade!.paybackRealMinutes).toBeGreaterThanOrEqual(5);
  expect(bot.firstUpgrade!.paybackRealMinutes).toBeLessThanOrEqual(20);
  expect(bot.hallBAffordableRealMinutes).not.toBeNull();
  expect(bot.hallBAffordableRealMinutes!).toBeGreaterThanOrEqual(30);
  expect(bot.hallBAffordableRealMinutes!).toBeLessThanOrEqual(60);
});

test("G3 a facility left alone for 3 game days neither goes bankrupt nor runs failure-free", () => {
  const bal = loadBalance();
  const idle = runIdle(bal, 3);
  console.log("G3 idle:", { startCash: idle.startCash, endCash: Math.round(idle.endCash), minCash: Math.round(idle.minCash), degraded: idle.degraded, failed: idle.failed });
  expect(idle.minCash).toBeGreaterThan(0);
  expect(idle.endCash).toBeGreaterThan(idle.startCash);
  expect(idle.degraded).toBeGreaterThan(0);
});
