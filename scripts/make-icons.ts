// Draws the app icon (a fridge with a ticked sticky note, on cream): node scripts/make-icons.ts
// The art fills the whole square and keeps the mark inside the middle circle (80% across), so it works as a maskable icon too.
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const ORANGE = "#f0712c";
const CREAM = "#f8f5f0";
const YELLOW = "#f7c948";
const INK = "#bd4d0a"; // --accent-ink in the app: the tick has to hold on the yellow
const SHADOW = "#2b2521";

const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="${CREAM}"/>` +
  `<rect x="29" y="13" width="42" height="74" rx="8" fill="${ORANGE}"/>` +
  `<path d="M29 37 H71" stroke="${CREAM}" stroke-width="3"/>` +
  `<path d="M36 21 V29 M36 45 V57" stroke="${CREAM}" stroke-width="4" stroke-linecap="round"/>` +
  `<g transform="translate(68 60) rotate(7) translate(-14 -14)">` +
  `<rect x="1.5" y="2" width="28" height="28" fill="${SHADOW}" fill-opacity=".16"/>` +
  `<rect width="28" height="28" fill="${YELLOW}"/>` +
  `<path d="M6.2 14.6 L11.8 19.6 L21.8 8.4" fill="none" stroke="${INK}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>` +
  `</g></svg>\n`;

writeFileSync(new URL("../web/public/icon.svg", import.meta.url), svg);

const browser = await chromium.launch();
for (const size of [192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<!doctype html><style>html,body{margin:0}svg{display:block;width:100vw;height:100vh}</style>${svg}`);
  await page.screenshot({ path: new URL(`../web/public/icon-${size}.png`, import.meta.url).pathname });
  await page.close();
}
await browser.close();
