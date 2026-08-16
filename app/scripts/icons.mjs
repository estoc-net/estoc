/**
 * Render public/icon.svg to the PNG sizes the manifest and iOS want, using
 * the system chromium through playwright-core (already here for e2e). Run
 * `npm run icons` after changing the SVG; the PNGs are committed.
 */
import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const svg = await readFile(new URL("../public/icon.svg", import.meta.url), "utf8");
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium" });
try {
  for (const [name, size] of [
    ["icon-192.png", 192],
    ["icon-512.png", 512],
    ["apple-touch-icon.png", 180],
  ]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(
      `<body style="margin:0;background:#1d2528">${svg.replace("<svg ", `<svg width="${size}" height="${size}" style="display:block" `)}</body>`
    );
    const png = await page.screenshot({ clip: { x: 0, y: 0, width: size, height: size } });
    await writeFile(new URL(`../public/${name}`, import.meta.url), png);
    await page.close();
    console.log(`${name} ${png.length} bytes`);
  }
} finally {
  await browser.close();
}
