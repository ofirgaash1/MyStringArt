import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';

const cwd = process.cwd();
const mode = process.env.GOLDEN_MODE ?? process.argv[2] ?? 'compare';
const lineCount = Number.parseInt(process.env.GOLDEN_LINE_COUNT ?? process.argv[3] ?? '100', 10);
const port = Number.parseInt(process.env.GOLDEN_PORT ?? '4173', 10);
const nailsCount = Number.parseInt(process.env.GOLDEN_NAILS ?? '180', 10);
const finderColorCount = Number.parseInt(process.env.GOLDEN_FIND_COLORS ?? '2', 10);
const sourceMode = process.env.GOLDEN_SOURCE ?? 'nearest';
const currentOverlapMode = process.env.GOLDEN_CURRENT_OVERLAP_MODE ?? 'global-union';
const referenceOverlapMode = process.env.GOLDEN_REFERENCE_OVERLAP_MODE ?? 'global-union';
const headless = process.env.GOLDEN_HEADLESS !== 'false';
const timeoutMs = Number.parseInt(process.env.GOLDEN_TIMEOUT_MS ?? '240000', 10);
const viteBin = path.join(cwd, 'node_modules', 'vite', 'bin', 'vite.js');
const appUrl = `http://127.0.0.1:${port}/MyStringArt/`;
const goldenDir = path.join(cwd, 'diagnostics', 'goldens');
const getOverlapModeSuffix = (overlapMode) =>
  overlapMode === 'global-union' ? '' : `-${overlapMode}`;
const referenceGoldenName =
  `mona-2color-${sourceMode}-nails${nailsCount}-lines${lineCount}${getOverlapModeSuffix(referenceOverlapMode)}.json`;
const actualGoldenName =
  `mona-2color-${sourceMode}-nails${nailsCount}-lines${lineCount}${getOverlapModeSuffix(currentOverlapMode)}.json`;
const goldenPath = path.join(goldenDir, mode === 'capture' ? actualGoldenName : referenceGoldenName);
const latestPath = path.join(goldenDir, `latest-${actualGoldenName}`);
const comparePath = path.join(goldenDir, `compare-${actualGoldenName}`);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isServerReady() {
  try {
    const response = await fetch(appUrl);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForServer() {
  const startedAt = performance.now();
  while (performance.now() - startedAt < 60000) {
    if (await isServerReady()) {
      return;
    }
    await sleep(250);
  }
  throw new Error('Preview server did not become ready.');
}

async function waitForEnabled(locator) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < 90000) {
    if (await locator.isVisible().catch(() => false)) {
      const isDisabled = await locator.isDisabled().catch(() => true);
      if (!isDisabled) {
        return;
      }
    }
    await sleep(100);
  }
  throw new Error('Timed out waiting for enabled control.');
}

function firstDifference(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (JSON.stringify(left[index]) !== JSON.stringify(right[index])) {
      return {
        index,
        expected: left[index] ?? null,
        actual: right[index] ?? null,
      };
    }
  }
  return null;
}

function summarizeBuckets(linesByColor) {
  return linesByColor.map((bucket) => ({
    colorId: bucket.colorId,
    label: bucket.label,
    hex: bucket.hex,
    lineCount: bucket.lineCount,
  }));
}

async function runFlow() {
  let server = null;
  let browser = null;

  try {
    if (!(await isServerReady())) {
      server = spawn(
        process.execPath,
        [viteBin, 'preview', '--host', '127.0.0.1', '--port', String(port)],
        { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      server.stdout.on('data', (chunk) => process.stdout.write(`[preview] ${chunk}`));
      server.stderr.on('data', (chunk) => process.stderr.write(`[preview-err] ${chunk}`));
    }

    await waitForServer();
    browser = await chromium.launch({ headless });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1024 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    const errors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        errors.push(message.text());
      }
    });
    page.on('pageerror', (error) => {
      errors.push(error.message);
    });

    await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
    await page.evaluate((mode) => {
      window.__sharedLoopCurrentOverlapMode = mode;
    }, currentOverlapMode);
    await page.locator('canvas.preview-image').waitFor({ state: 'visible' });
    await sleep(1000);

    const modeButton = page.getByRole('button', { name: /switch to algorithm|switch to art/i });
    if ((await modeButton.innerText()).toLowerCase().includes('algorithm')) {
      await modeButton.click();
    }

    await page.getByRole('slider', { name: /^Nails:/i }).evaluate((element, value) => {
      element.value = String(value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, nailsCount);

    await page
      .locator('label.multicolor-histogram-input')
      .filter({ hasText: 'Find colors' })
      .locator('input')
      .fill(String(finderColorCount));
    await page.getByRole('button', { name: /find best palette/i }).click();
    await page.getByRole('radio', { name: new RegExp(`^${sourceMode}$`, 'i') }).click();
    await sleep(500);

    await page.evaluate(() => {
      window.__sharedLoopWallStepEvents = [];
      window.__totalLineCountCommitEvents = [];
      window.__multicolorStepProfiles = [];
    });

    const loopButton = page.getByRole('button', { name: /Start shared-state loop/i });
    await waitForEnabled(loopButton);
    const startedAt = Date.now();
    await loopButton.click();
    await page.waitForFunction(
      (targetLineCount) => (window.__sharedLoopWallStepEvents ?? []).length >= targetLineCount,
      lineCount,
      { timeout: timeoutMs },
    );
    const elapsedMs = Date.now() - startedAt;
    await page.getByRole('button', { name: /Stop shared-state loop/i }).click({ force: true });
    await sleep(1000);

    const result = await page.evaluate((targetLineCount) => {
      const buckets = window.__debugGetMulticolorLineBuckets();
      const linesByColor = buckets.map((bucket) => ({
        colorId: bucket.colorId,
        label: bucket.label,
        hex: bucket.hex,
        lineCount: bucket.lineCount,
        lines: bucket.lines.slice(0, targetLineCount),
      }));
      const orderedLines = linesByColor
        .flatMap((bucket) =>
          bucket.lines.map((line) => ({
            ...line,
            colorId: bucket.colorId,
            label: bucket.label,
            hex: bucket.hex,
          })),
        )
        .sort((firstLine, secondLine) => firstLine.stepOrder - secondLine.stepOrder)
        .slice(0, targetLineCount);

      return {
        orderedLines,
        linesByColor,
        stepEvents: (window.__sharedLoopWallStepEvents ?? []).slice(0, targetLineCount),
      };
    }, lineCount);

    await context.close();
    return {
      flow: {
        image: 'mona_lisa.PNG',
        nailsCount,
        finderColorCount,
        sourceMode,
        currentOverlapMode,
        lineCount,
      },
      capturedAt: new Date().toISOString(),
      elapsedMs,
      errors,
      ...result,
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (server) {
      server.kill();
    }
  }
}

await fs.mkdir(goldenDir, { recursive: true });

const actual = await runFlow();
await fs.writeFile(latestPath, JSON.stringify(actual, null, 2));

if (mode === 'capture') {
  await fs.writeFile(goldenPath, JSON.stringify(actual, null, 2));
  console.log(JSON.stringify({
    mode,
    goldenPath,
    elapsedMs: actual.elapsedMs,
    errors: actual.errors,
    orderedLineCount: actual.orderedLines.length,
    byColor: summarizeBuckets(actual.linesByColor),
  }, null, 2));
  process.exit(actual.errors.length > 0 ? 1 : 0);
}

if (mode !== 'compare') {
  throw new Error(`Unknown GOLDEN_MODE "${mode}". Use "capture" or "compare".`);
}

let expected;
try {
  expected = JSON.parse(await fs.readFile(goldenPath, 'utf8'));
} catch (error) {
  throw new Error(
    `Golden file does not exist at ${goldenPath}. Run with GOLDEN_MODE=capture first. ${error.message}`,
  );
}

const orderedLinesMatch = JSON.stringify(expected.orderedLines) === JSON.stringify(actual.orderedLines);
const linesByColorMatch = JSON.stringify(expected.linesByColor) === JSON.stringify(actual.linesByColor);
const summary = {
  mode,
  goldenPath,
  latestPath,
  elapsedMs: actual.elapsedMs,
  errors: actual.errors,
  orderedLinesMatch,
  linesByColorMatch,
  expectedLineCount: expected.orderedLines.length,
  actualLineCount: actual.orderedLines.length,
  expectedByColor: summarizeBuckets(expected.linesByColor),
  actualByColor: summarizeBuckets(actual.linesByColor),
  firstOrderedLineDifference: orderedLinesMatch
    ? null
    : firstDifference(expected.orderedLines, actual.orderedLines),
};

await fs.writeFile(comparePath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));

if (!orderedLinesMatch || !linesByColorMatch || actual.errors.length > 0) {
  process.exitCode = 1;
}
