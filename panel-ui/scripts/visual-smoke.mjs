#!/usr/bin/env node
/**
 * Browser smoke for the workbench.
 *
 * Requires the panel server on 4399 (with --annotations) and Vite on 5173.
 * Uses a Playwright browser installed under the repo's .tmp-build cache.
 */
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("../../node_modules/playwright-core");

const here = dirname(fileURLToPath(import.meta.url));
const artifactDir = resolve(here, "..", "..", ".tmp-build");
await mkdir(artifactDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(String(error)));
page.on("response", (response) => {
  if (response.status() >= 400)
    failedResponses.push(`${String(response.status())} ${response.url()}`);
});

await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await page.waitForSelector(".topoNode", { timeout: 15000 });

const computed = await page.evaluate(() => {
  const body = getComputedStyle(document.body);
  const stage = document.querySelector("[data-testid='topology-stage']");
  const rail = document.querySelector(".railPanel");
  return {
    bodyBackground: body.backgroundColor,
    bodyFont: body.fontFamily,
    stageHeight: stage === null ? null : stage.getBoundingClientRect().height,
    stageWidth: stage === null ? null : stage.getBoundingClientRect().width,
    railBorderWidth: rail === null ? null : getComputedStyle(rail).borderWidth,
    railBackground:
      rail === null ? null : getComputedStyle(rail).backgroundColor,
    nodeCount: document.querySelectorAll(".topoNode").length,
    dataFont: getComputedStyle(
      document.querySelector(".metricValue") ?? document.body,
    ).fontFamily,
    themeColor: getComputedStyle(document.documentElement)
      .getPropertyValue("--emerald")
      .trim(),
  };
});

const transformBefore = await page.evaluate(
  () => document.querySelector(".topoSvg > g")?.getAttribute("transform") ?? "",
);
await page.getByRole("button", { name: "Zoom in" }).click();
await page.waitForTimeout(200);
const transformAfter = await page.evaluate(
  () => document.querySelector(".topoSvg > g")?.getAttribute("transform") ?? "",
);
const zoomChanged = transformBefore !== transformAfter;
await page.getByRole("button", { name: "Fit" }).click();

await page.screenshot({
  path: resolve(artifactDir, "panel-workbench.png"),
  fullPage: true,
});

await page.locator(".topoNode").first().click({ force: true });
await page.waitForSelector("[data-testid='drawer']", { timeout: 5000 });
await page.waitForTimeout(350);
const drawerBox = await page.locator("[data-testid='drawer']").boundingBox();

const tabTrail = [];
for (let index = 0; index < 6; index += 1) {
  await page.keyboard.press("Tab");
  tabTrail.push(
    await page.evaluate(() => {
      const active = document.activeElement;
      return {
        tag: active?.tagName ?? null,
        inDrawer:
          active instanceof Element &&
          active.closest("[data-testid='drawer']") !== null,
      };
    }),
  );
}
await page.keyboard.press("Escape");
await page.waitForSelector("[data-testid='drawer']", { state: "detached" });
const focusAfterEscape = await page.evaluate(() => ({
  nodeId: document.activeElement?.dataset?.nodeId ?? null,
  tag: document.activeElement?.tagName ?? null,
}));

await page.locator(".topoNode").first().click({ force: true });
await page.waitForSelector("[data-testid='drawer']", { timeout: 5000 });
const tabs = page.locator("[data-testid='drawer'] [role='tab']");
await tabs.nth(3).click({ force: true });

const note = `smoke-${Date.now()}`;
await page.locator(".noteComposer textarea").fill(note);
await page
  .locator(".noteComposer button[type='submit']")
  .click({ force: true });
await page.waitForFunction(
  (value) => document.body.textContent?.includes(value) === true,
  note,
  { timeout: 8000 },
);
const noteOccurrences = await page.evaluate(
  (value) => (document.body.textContent?.split(value).length ?? 1) - 1,
  note,
);

await page.screenshot({
  path: resolve(artifactDir, "panel-drawer.png"),
  fullPage: false,
});

const result = {
  computed,
  drawerLeft: drawerBox?.x ?? null,
  drawerWidth: drawerBox?.width ?? null,
  tabTrail,
  focusAfterEscape,
  zoomChanged,
  noteSaved: true,
  noteOccurrences,
  failedResponses: [...new Set(failedResponses)],
  consoleErrors,
  screenshots: [
    resolve(artifactDir, "panel-workbench.png"),
    resolve(artifactDir, "panel-drawer.png"),
  ],
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
await browser.close();
