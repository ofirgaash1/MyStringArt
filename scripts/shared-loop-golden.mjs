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
const solverMode = process.env.GOLDEN_SOLVER_MODE ?? 'exact-global-union';
const bitsetGridSize = Number.parseInt(process.env.GOLDEN_BITSET_GRID_SIZE ?? '1024', 10);
const headless = process.env.GOLDEN_HEADLESS !== 'false';
const timeoutMs = Number.parseInt(process.env.GOLDEN_TIMEOUT_MS ?? '240000', 10);
const serverTimeoutMs = Number.parseInt(process.env.GOLDEN_SERVER_TIMEOUT_MS ?? '60000', 10);
const heartbeatMs = Number.parseInt(process.env.GOLDEN_HEARTBEAT_MS ?? '10000', 10);
const progressPollMs = Number.parseInt(process.env.GOLDEN_PROGRESS_POLL_MS ?? '1000', 10);
const stallTimeoutMs = Number.parseInt(process.env.GOLDEN_STALL_TIMEOUT_MS ?? '60000', 10);
const zeroLineTimeoutMs = Number.parseInt(process.env.GOLDEN_ZERO_LINE_TIMEOUT_MS ?? '5000', 10);
const measureStopLatency = process.env.GOLDEN_MEASURE_STOP_LATENCY === '1';
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
let runAbortSignal = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBenignConsoleError(text) {
  return text === 'Failed to load resource: the server responded with a status of 404 (Not Found)';
}

async function sleepOrAbort(ms) {
  if (!runAbortSignal) {
    return sleep(ms);
  }
  if (runAbortSignal.aborted) {
    throw runAbortSignal.reason ?? new Error('Run aborted.');
  }

  return await new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(runAbortSignal.reason ?? new Error('Run aborted.'));
    };

    const cleanup = () => {
      clearTimeout(timeoutId);
      runAbortSignal?.removeEventListener('abort', onAbort);
    };

    runAbortSignal.addEventListener('abort', onAbort, { once: true });
  });
}

function startHeartbeat(label) {
  if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0) {
    return () => {};
  }

  const startedAt = performance.now();
  const timer = setInterval(() => {
    const elapsedMs = Math.round(performance.now() - startedAt);
    process.stdout.write(`[wait] ${label} still waiting after ${elapsedMs}ms\n`);
  }, heartbeatMs);

  timer.unref?.();
  return () => clearInterval(timer);
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
  let nextHeartbeatAt = startedAt + heartbeatMs;
  while (performance.now() - startedAt < serverTimeoutMs) {
    if (await isServerReady()) {
      return;
    }
    if (heartbeatMs > 0 && performance.now() >= nextHeartbeatAt) {
      process.stdout.write(
        `[wait] Preview server ready check still pending after ${Math.round(
          performance.now() - startedAt,
        )}ms\n`,
      );
      nextHeartbeatAt += heartbeatMs;
    }
    await sleep(250);
  }
  throw new Error('Preview server did not become ready.');
}

async function waitForEnabled(locator) {
  const startedAt = performance.now();
  let nextHeartbeatAt = startedAt + heartbeatMs;
  while (performance.now() - startedAt < timeoutMs) {
    if (await locator.isVisible().catch(() => false)) {
      const isDisabled = await locator.isDisabled().catch(() => true);
      if (!isDisabled) {
        return;
      }
    }
    if (heartbeatMs > 0 && performance.now() >= nextHeartbeatAt) {
      process.stdout.write(
        `[wait] Control still disabled after ${Math.round(performance.now() - startedAt)}ms\n`,
      );
      nextHeartbeatAt += heartbeatMs;
    }
    await sleepOrAbort(100);
  }
  throw new Error('Timed out waiting for enabled control.');
}

async function waitForSharedLoopLines(page, targetLineCount) {
  const startedAt = performance.now();
  let lastProgressAt = startedAt;
  let lastCount = -1;
  let nextHeartbeatAt = startedAt + heartbeatMs;

  while (performance.now() - startedAt < timeoutMs) {
    const snapshot = await page.evaluate(() => {
      const wallStepCount = window.__sharedLoopWallStepEvents?.length ?? 0;
      const workerInitCount = window.__sharedLoopWorkerInitEvents?.length ?? 0;
      const noteText = Array.from(document.querySelectorAll('p.multicolor-mini-note'))
        .map((node) => node.textContent?.trim() ?? '')
        .find((text) => /Running\.|Stopped:|Not started:/.test(text)) ?? '';
      const totalStatText = Array.from(document.querySelectorAll('span.multicolor-inline-stat'))
        .map((node) => node.textContent?.trim() ?? '')
        .find((text) => /^Total \d+ lines$/.test(text)) ?? '';
      return {
        wallStepCount,
        workerInitCount,
        noteText,
        totalStatText,
      };
    });

    if (snapshot.wallStepCount !== lastCount) {
      lastCount = snapshot.wallStepCount;
      lastProgressAt = performance.now();
      process.stdout.write(
        `[golden] wall-step count=${snapshot.wallStepCount} worker-init=${snapshot.workerInitCount} ${snapshot.noteText}\n`,
      );
    } else if (heartbeatMs > 0 && performance.now() >= nextHeartbeatAt) {
      process.stdout.write(
        `[golden] still waiting: wall-step count=${snapshot.wallStepCount} worker-init=${snapshot.workerInitCount} elapsed=${Math.round(
          performance.now() - startedAt,
        )}ms\n`,
      );
      nextHeartbeatAt += heartbeatMs;
    }

    if (snapshot.wallStepCount >= targetLineCount) {
      return snapshot;
    }

    if (
      zeroLineTimeoutMs > 0 &&
      performance.now() - startedAt >= zeroLineTimeoutMs &&
      snapshot.wallStepCount === 0 &&
      /^Total 0 lines$/.test(snapshot.totalStatText)
    ) {
      throw new Error('Shared loop UI still shows Total 0 lines after 5000ms.');
    }

    if (performance.now() - lastProgressAt >= stallTimeoutMs) {
      throw new Error(
        `Shared loop stalled after ${Math.round(performance.now() - lastProgressAt)}ms without progress. ` +
          `Current wall-step count=${snapshot.wallStepCount}, worker-init=${snapshot.workerInitCount}.`,
      );
    }

    await sleepOrAbort(progressPollMs);
  }

  throw new Error(`Timed out waiting for ${targetLineCount} shared-loop lines.`);
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
  const abortController = new AbortController();
  runAbortSignal = abortController.signal;
  let abortReason = null;
  let shuttingDown = false;

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
    const failFast = (reason) => {
      if (abortReason || shuttingDown) {
        return;
      }
      abortReason = reason instanceof Error ? reason : new Error(String(reason));
      if (!abortController.signal.aborted) {
        abortController.abort(abortReason);
      }
      process.stderr.write(`[page-error] ${abortReason.message}\n`);
      void browser.close().catch(() => {});
    };
    browser.once('disconnected', () => {
      failFast(new Error('Browser disconnected.'));
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1024 },
    });
    const page = await context.newPage();
    page.once('close', () => {
      if (!abortReason && !shuttingDown) {
        failFast(new Error('Browser page was closed.'));
      }
    });
    page.setDefaultTimeout(timeoutMs);
    const errors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        const text = message.text();
        if (!isBenignConsoleError(text)) {
          errors.push(text);
          failFast(new Error(`Console error: ${text}`));
        }
      }
    });
    page.on('pageerror', (error) => {
      errors.push(error.message);
      const stack = error.stack ? `\n${error.stack}` : '';
      failFast(new Error(`Page error: ${error.message}${stack}`));
    });

    await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
    if (abortReason) throw abortReason;
    await page.evaluate((mode) => {
      window.__sharedLoopCurrentOverlapMode = mode;
    }, currentOverlapMode);
    if (abortReason) throw abortReason;
    await page.locator('canvas.preview-image').waitFor({ state: 'visible' });
    if (abortReason) throw abortReason;
    await sleep(1000);

    const modeButton = page.getByRole('button', { name: /switch to algorithm|switch to art/i });
    if ((await modeButton.innerText()).toLowerCase().includes('algorithm')) {
      await modeButton.click();
    }
    if (abortReason) throw abortReason;

    if (solverMode === 'bitset-prototype') {
      await page.getByRole('radio', { name: /^bitset$/i }).click();
      if (abortReason) throw abortReason;
      await page.getByLabel('Grid size').fill(String(bitsetGridSize));
      if (abortReason) throw abortReason;
    } else {
      await page.getByRole('radio', { name: /^exact$/i }).click();
      if (abortReason) throw abortReason;
    }

    await page.getByRole('radio', { name: /^shared best$/i }).click();
    if (abortReason) throw abortReason;

    await page.getByRole('slider', { name: /^Nails:/i }).evaluate((element, value) => {
      element.value = String(value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, nailsCount);
    if (abortReason) throw abortReason;

    await page
      .locator('label.multicolor-histogram-input')
      .filter({ hasText: 'Find colors' })
      .locator('input')
      .fill(String(finderColorCount));
    if (abortReason) throw abortReason;
    await page.getByRole('button', { name: /find best palette/i }).click();
    if (abortReason) throw abortReason;
    await page.getByRole('radio', { name: new RegExp(`^${sourceMode}$`, 'i') }).click();
    if (abortReason) throw abortReason;
    await sleep(500);

    await page.evaluate(() => {
      window.__sharedLoopWallStepEvents = [];
      window.__totalLineCountCommitEvents = [];
      window.__multicolorStepProfiles = [];
    });
    if (abortReason) throw abortReason;

    const loopButton = page.getByRole('button', { name: /Start shared-state loop/i });
    await waitForEnabled(loopButton);
    if (abortReason) throw abortReason;
    const startedAt = Date.now();
    await loopButton.click();
    if (abortReason) throw abortReason;
    const initialZeroDeadline = performance.now() + zeroLineTimeoutMs;
    await waitForSharedLoopLines(page, lineCount);
    const elapsedMs = Date.now() - startedAt;
    const stopButton = page.getByRole('button', { name: /Stop shared-state loop/i });
    const stopClickedAt = measureStopLatency ? performance.now() : null;
    await stopButton.click({ force: true });
    if (abortReason) throw abortReason;
    let stopLatencyMs = null;
    if (measureStopLatency) {
      await page.waitForFunction(
        () => {
          const notes = Array.from(document.querySelectorAll('p.multicolor-mini-note'))
            .map((node) => node.textContent?.trim() ?? '');
          return notes.some((text) => /^Stopped:/.test(text)) &&
            !notes.some((text) => /^Running\.$/.test(text));
        },
        undefined,
        { timeout: 10000 },
      );
      stopLatencyMs = Math.round(performance.now() - stopClickedAt);
    } else {
      await sleep(1000);
    }

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

    shuttingDown = true;
    await context.close();
    return {
      flow: {
        image: 'mona_lisa.PNG',
        nailsCount,
        finderColorCount,
        sourceMode,
        currentOverlapMode,
        solverMode,
        bitsetGridSize,
        lineCount,
      },
      capturedAt: new Date().toISOString(),
      elapsedMs,
      stopLatencyMs,
      errors,
      ...result,
    };
  } finally {
    shuttingDown = true;
    if (runAbortSignal === abortController.signal) {
      runAbortSignal = null;
    }
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
    stopLatencyMs: actual.stopLatencyMs,
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
