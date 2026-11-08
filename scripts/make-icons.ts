// Draws the app icon (a fridge with a ticked sticky note, on cream): node scripts/make-icons.ts
// It comes in two sizes of fridge on the same full cream square. Plain icons (the iPhone home screen, the tab) only
// get their corners rounded, so the fridge is drawn large. Maskable ones are cropped by Android launchers to their
// own shape, so the fridge is drawn smaller to sit like the icons beside it.
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const TOP = "#f7943a"; // the fridge runs from orange at the top to red at the bottom
const BOTTOM = "#e53935";
const CREAM = "#f8f5f0";
const YELLOW = "#f7c948";
const INK = "#a8231f"; // a deep red, so the tick holds on the yellow
const SHADOW = "#2b2521";

const icon = (scale: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
  `<defs><linearGradient id="fridge" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${TOP}"/><stop offset="1" stop-color="${BOTTOM}"/></linearGradient></defs>` +
  `<rect width="100" height="100" fill="${CREAM}"/>` +
  `<g transform="translate(50 50) scale(${scale}) translate(-50 -50)">` +
  `<rect x="29" y="13" width="42" height="74" rx="8" fill="url(#fridge)"/>` +
  `<path d="M29 37 H71" stroke="${CREAM}" stroke-width="3"/>` +
  `<path d="M36 21 V29 M36 45 V57" stroke="${CREAM}" stroke-width="4" stroke-linecap="round"/>` +
  `<g transform="translate(68 60) rotate(7) translate(-14 -14)">` +
  `<rect x="1.5" y="2" width="28" height="28" fill="${SHADOW}" fill-opacity=".16"/>` +
  `<rect width="28" height="28" fill="${YELLOW}"/>` +
  `<path d="M6.2 14.6 L11.8 19.6 L21.8 8.4" fill="none" stroke="${INK}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>` +
  `</g></g></svg>\n`;

const plain = icon(0.92);
const maskable = icon(0.75);
const out = (name: string) => new URL(`../web/public/${name}`, import.meta.url).pathname;

writeFileSync(out("icon.svg"), plain);

const browser = await chromium.launch();
for (const [svg, prefix] of [[plain, "icon"], [maskable, "icon-maskable"]]) {
  for (const size of [192, 512]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<!doctype html><style>html,body{margin:0}svg{display:block;width:100vw;height:100vh}</style>${svg}`);
    await page.screenshot({ path: out(`${prefix}-${size}.png`) });
    await page.close();
  }
}
await browser.close();
