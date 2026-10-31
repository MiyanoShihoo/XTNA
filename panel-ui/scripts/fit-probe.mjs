#!/usr/bin/env node
/** Measure a graph's rendered bounds after Fit. Usage: node fit-probe.mjs [url] */
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("../../node_modules/playwright-core");

const url = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector(".topoNode", { timeout: 15000 });
const fit = page.getByRole("button", { name: "Fit" });
if (await fit.count()) await fit.first().click();
await page.waitForTimeout(300);
const result = await page.evaluate(() => {
  const stage = document
    .querySelector("[data-testid='topology-stage']")
    ?.getBoundingClientRect();
  const cores = [...document.querySelectorAll(".topoCore")].map((node) =>
    node.getBoundingClientRect(),
  );
  if (stage === undefined || cores.length === 0) return null;
  const minX = Math.min(...cores.map((box) => box.x));
  const minY = Math.min(...cores.map((box) => box.y));
  const maxX = Math.max(...cores.map((box) => box.x + box.width));
  const maxY = Math.max(...cores.map((box) => box.y + box.height));
  return {
    stage: { x: stage.x, y: stage.y, width: stage.width, height: stage.height },
    content: { minX, minY, maxX, maxY },
    inside:
      minX >= stage.x &&
      minY >= stage.y &&
      maxX <= stage.x + stage.width &&
      maxY <= stage.y + stage.height,
    nodes: cores.length,
  };
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
await browser.close();
