import { launch, frames, waitFor, sleep } from "../harness.mjs";
export const name = "Terminal: real pty, readable on the in-world monitor";
export default async function () {
  const a = await launch({ preset: "fresh" }); const { page } = a;
  try {
    await waitFor(() => page.evaluate(() => window.game.term.status === "running"), 10000);
    await sleep(1500);
    const token = "UPTIME_G9_" + Math.floor(Math.random() * 1e6);
    await page.evaluate((t) => window.uptime.send("pty.input", `printf '%s\\n' ${t}\r`), token);
    const inBuf = await waitFor(() => page.evaluate((t) => window.game.term.text().split("\n").some((l) => l.trim() === t), token), 8000);
    await frames(page, 30);
    // the mirror canvas must contain painted glyph pixels on the row that holds the token
    const mirror = await page.evaluate((t) => {
      const term = window.game.term; term.dirty = true; term.paint();
      const lines = term.text().split("\n"); const row = lines.findIndex((l) => l.trim() === t);
      const c = term.canvas, g = c.getContext("2d"); const ch = (c.height - 24) / 32, cw = (c.width - 28) / 110;
      const img = g.getImageData(14, Math.round(12 + row * ch), Math.round(cw * t.length), Math.round(ch)).data;
      let lit = 0; for (let i = 0; i < img.length; i += 4) if (img[i] + img[i + 1] + img[i + 2] > 300) lit++;
      return { row, lit, glyphPx: ch * 0.82, cw };
    }, token);
    // legibility at 3 m: the monitor is 0.6 m wide, so 110 columns over 0.6 m; require the painted glyph height to resolve to >= 6 px on the texture
    const pass = !!inBuf && mirror.row >= 0 && mirror.lit > 150 && mirror.glyphPx >= 14;
    return { pass, detail: `token in xterm buffer: ${!!inBuf}; mirror row ${mirror.row}, ${mirror.lit} lit pixels, glyph height ${mirror.glyphPx.toFixed(1)} px on a 724 px texture` };
  } finally { await a.close(); }
}
