#!/usr/bin/env node
// explore.mjs — black-box exploration driver for the test-designer skill (phase 1).
//
// Drives ANY public URL with headless Chromium and emits the evidence an
// agent needs to author test cases: a screenshot, console errors/warnings,
// the network request log (failures flagged), and an outline of the
// interactive elements (inputs, buttons, links) on the page.
//
// Usage:  node explore.mjs <url> [--steps steps.json]
//
// Output: artifacts/<host>/exploration.md   (the report an agent reads)
//         artifacts/<host>/screenshot.png   (full-page screenshot)
//         artifacts/<host>/console.json, network.json  (raw data)
//
// --steps lets you replay simple actions before capturing (to reach a page
// behind a click/fill), e.g. a JSON array:
//   [{"fill":"input[name=email]","value":"a@b.com"},{"click":"button:has-text('Sign in')"}]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { bundleDir, hostOf } from './lib/bundle.mjs';
import { navigate, observe, renderExploration, snapshot, summarize } from './lib/capture.mjs';
import { launchOptions, playwrightOrExit } from './lib/playwright.mjs';

const url = process.argv[2];
if (!url) {
  console.error('Usage: node explore.mjs <url> [--steps steps.json]');
  process.exit(1);
}
const { chromium } = playwrightOrExit();
const stepsFlag = process.argv.indexOf('--steps');
const steps = stepsFlag !== -1
  ? JSON.parse(readFileSync(process.argv[stepsFlag + 1], 'utf8'))
  : [];

const host = hostOf(url);
const outDir = bundleDir(url);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch(launchOptions());
const page = await browser.newPage();
const { consoleMsgs, network } = observe(page);
const { status } = await navigate(page, url, { consoleMsgs });

// Optional pre-capture actions to reach a deeper page.
for (const step of steps) {
  try {
    if (step.fill) await page.fill(step.fill, step.value ?? '');
    if (step.click) await page.click(step.click);
    if (step.waitFor) await page.waitForSelector(step.waitFor, { timeout: 10000 });
    if (step.goto) await page.goto(step.goto, { waitUntil: 'networkidle' });
  } catch (e) {
    consoleMsgs.push({ type: 'step-error', text: `${JSON.stringify(step)} -> ${e}` });
  }
}

const result = {
  url,
  status,
  consoleMsgs,
  network,
  ...(await snapshot(page, { screenshotPath: `${outDir}/screenshot.png` })),
};
await browser.close();

writeFileSync(`${outDir}/exploration.md`, renderExploration(result, host));
writeFileSync(`${outDir}/console.json`, JSON.stringify(consoleMsgs, null, 2));
writeFileSync(`${outDir}/network.json`, JSON.stringify(network, null, 2));

const { errors, failedReqs, fields, buttons, links } = summarize(result);
console.log(`Explored ${url}`);
console.log(`  final: ${result.finalUrl} [${status}] "${result.title}"`);
console.log(`  errors: ${errors.length}  failedReqs: ${failedReqs.length}`);
console.log(`  fields: ${fields.length}  buttons: ${buttons.length}  links: ${links.length}`);
console.log(`  report -> ${outDir}/exploration.md`);
