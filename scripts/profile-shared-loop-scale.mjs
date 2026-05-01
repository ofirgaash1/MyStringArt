import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';

const cwd = process.cwd();
const lineCount = Number.parseInt(process.env.PROFILE_LINE_COUNT ?? process.argv[2] ?? '100', 10);
const port = Number.parseInt(process.env.PROFILE_PORT ?? '4173', 10);
const nailsCount = Number.parseInt(process.env.PROFILE_NAILS ?? '180', 10);
const finderColorCount = Number.parseInt(process.env.PROFILE_FIND_COLORS ?? '2', 10);
const sourceMode = process.env.PROFILE_SOURCE ?? 'nearest';
const currentOverlapMode = process.env.PROFILE_CURRENT_OVERLAP_MODE ?? 'global-union';
const headless = process.env.PROFILE_HEADLESS !== 'false';
const timeoutMs = Number.parseInt(process.env.PROFILE_TIMEOUT_MS ?? '300000', 10);
const viteBin = path.join(cwd, 'node_modules', 'vite', 'bin', 'vite.js');
const appUrl = `http://127.0.0.1:${port}/MyStringArt/`;
const profileDir = path.join(cwd, 'diagnostics', 'profiles');
const overlapModeSuffix =
  currentOverlapMode === 'global-union' ? '' : `-${currentOverlapMode}`;
const profileName =
  `shared-loop-mona-2color-${sourceMode}-nails${nailsCount}-lines${lineCount}${overlapModeSuffix}.json`;
const profilePath = path.join(profileDir, profileName);

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

function getAverage(values) {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function getPercentile(values, percentile) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

function roundMs(value) {
  return Number(value.toFixed(2));
}

function summarizeEvents(events, rangeSize = 100) {
  const summaries = [];
  for (let start = 1; start <= events.length; start += rangeSize) {
    const end = Math.min(events.length, start + rangeSize - 1);
    const rangeEvents = events.slice(start - 1, end);
    const workerSolveValues = rangeEvents
      .map((event) => event.workerSolveMs)
      .filter(Number.isFinite);
    const mainApplyValues = rangeEvents
      .map((event) => event.applyMs)
      .filter(Number.isFinite);
    const totalValues = rangeEvents.map((event) =>
      (Number.isFinite(event.workerSolveMs) ? event.workerSolveMs : 0) +
      (Number.isFinite(event.applyMs) ? event.applyMs : 0),
    );
    const workerProfile = summarizeWorkerProfiles(rangeEvents);
    summaries.push({
      range: `${start}-${end}`,
      count: rangeEvents.length,
      workerSolveAvgMs: roundMs(getAverage(workerSolveValues)),
      workerSolveP95Ms: roundMs(getPercentile(workerSolveValues, 95)),
      workerSolveMaxMs: roundMs(Math.max(...workerSolveValues, 0)),
      mainApplyAvgMs: roundMs(getAverage(mainApplyValues)),
      mainApplyP95Ms: roundMs(getPercentile(mainApplyValues, 95)),
      mainApplyMaxMs: roundMs(Math.max(...mainApplyValues, 0)),
      workerPlusApplyAvgMs: roundMs(getAverage(totalValues)),
      workerPlusApplyP95Ms: roundMs(getPercentile(totalValues, 95)),
      workerPlusApplyMaxMs: roundMs(Math.max(...totalValues, 0)),
      workerProfile,
    });
  }
  return summaries;
}

function summarizeWorkerProfiles(events) {
  const profileKeys = [
    'getEligibleBucketsMs',
    'bestLineSearchMs',
    'staticMetricMs',
    'currentOverlapMs',
    'stateBuildLineGeometryMs',
    'stateIntersectionMs',
    'stateUnionMs',
    'stateReindexMs',
    'stateAcceptedStripIndexMs',
    'stateFragmentDifferenceMs',
    'localCurrentIntersectionMs',
    'localCurrentUnionMs',
    'localCurrentAreaMs',
    'fragmentCurrentClipMs',
  ];
  const countKeys = [
    'eligibleBucketCount',
    'candidateCount',
    'usedLineSkipCount',
    'distanceSkipCount',
    'noTargetOverlapSkipCount',
    'currentOverlapCandidateCount',
    'fullyPaintedSkipCount',
    'acceptedStripQueryCandidateCount',
    'acceptedStripQueryHitCount',
    'localCurrentIntersectionHitCount',
  ];
  const summary = {};

  for (const key of profileKeys) {
    const values = events
      .map((event) => event.workerProfile?.[key])
      .filter(Number.isFinite);
    summary[key] = {
      avgMs: roundMs(getAverage(values)),
      p95Ms: roundMs(getPercentile(values, 95)),
      maxMs: roundMs(Math.max(...values, 0)),
    };
  }

  for (const key of countKeys) {
    const values = events
      .map((event) => event.workerProfile?.[key])
      .filter(Number.isFinite);
    summary[key] = {
      avg: roundMs(getAverage(values)),
      max: Math.max(...values, 0),
    };
  }

  return summary;
}

function summarizeBuckets(linesByColor) {
  return linesByColor.map((bucket) => ({
    colorId: bucket.colorId,
    label: bucket.label,
    hex: bucket.hex,
    lineCount: bucket.lineCount,
  }));
}

async function runProfile() {
  let server = null;
  let browser = null;
  let context = null;

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
    context = await browser.newContext({
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
    const timeoutErrors = [];
    let completed = true;
    try {
      await page.waitForFunction(
        (targetLineCount) => (window.__sharedLoopWallStepEvents ?? []).length >= targetLineCount,
        lineCount,
        { timeout: timeoutMs },
      );
    } catch (error) {
      completed = false;
      timeoutErrors.push(error.message);
    }
    const elapsedMs = Date.now() - startedAt;
    await page.getByRole('button', { name: /Stop shared-state loop/i }).click({ force: true }).catch(() => {});
    await sleep(1000);

    const result = await page.evaluate((targetLineCount) => {
      const buckets = window.__debugGetMulticolorLineBuckets();
      return {
        events: (window.__sharedLoopWallStepEvents ?? []).slice(0, targetLineCount),
        countEvents: (window.__totalLineCountCommitEvents ?? []).slice(0, targetLineCount),
        linesByColor: buckets.map((bucket) => ({
          colorId: bucket.colorId,
          label: bucket.label,
          hex: bucket.hex,
          lineCount: bucket.lineCount,
          lines: bucket.lines.slice(0, targetLineCount),
        })),
      };
    }, lineCount);

    await context.close();
    context = null;
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
      completed,
      elapsedMs,
      errors: [...errors, ...timeoutErrors],
      byColor: summarizeBuckets(result.linesByColor),
      ranges: summarizeEvents(result.events),
      events: result.events,
      countEvents: result.countEvents,
    };
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (server) {
      server.kill();
    }
  }
}

await fs.mkdir(profileDir, { recursive: true });
const profile = await runProfile();
await fs.writeFile(profilePath, JSON.stringify(profile, null, 2));

console.log(JSON.stringify({
  profilePath,
  completed: profile.completed,
  elapsedMs: profile.elapsedMs,
  errors: profile.errors,
  byColor: profile.byColor,
  ranges: profile.ranges,
}, null, 2));

if (profile.errors.length > 0) {
  process.exitCode = 1;
}
