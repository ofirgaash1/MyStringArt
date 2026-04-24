import { spawn } from 'node:child_process';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';

const cwd = process.cwd();
const port = 5184;
const viteBin = path.join(cwd, 'node_modules', 'vite', 'bin', 'vite.js');
const imagePath = path.join(cwd, 'mona_lisa.PNG');
const appUrl = `http://127.0.0.1:${port}/MyStringArt/`;

function average(values) {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value) {
  return Number(value.toFixed(2));
}

function sumBuckets(rows) {
  const totals = new Map();
  for (const row of rows) {
    totals.set(row.bucket, (totals.get(row.bucket) ?? 0) + row.ms);
  }

  return [...totals.entries()]
    .map(([bucket, totalMs]) => ({
      bucket,
      totalMs: round(totalMs),
    }))
    .sort((first, second) => second.totalMs - first.totalMs);
}

function summarizeTraceEvents(traceEvents) {
  const eventTotals = new Map();
  for (const event of traceEvents) {
    if (event.ph !== 'X' || typeof event.dur !== 'number') {
      continue;
    }

    eventTotals.set(event.name, (eventTotals.get(event.name) ?? 0) + event.dur / 1000);
  }

  const sumByName = (names) =>
    round(
      names.reduce((sum, name) => sum + (eventTotals.get(name) ?? 0), 0),
    );

  return {
    buckets: {
      styleAndLayoutMs: sumByName([
        'ScheduleStyleRecalculation',
        'UpdateLayoutTree',
        'Layout',
      ]),
      paintAndCompositeMs: sumByName([
        'PrePaint',
        'Paint',
        'RasterTask',
        'CompositeLayers',
        'Commit',
        'UpdateLayer',
      ]),
      parseAndOtherRendererMs: sumByName([
        'ParseHTML',
        'ParseAuthorStyleSheet',
      ]),
      gcMs: sumByName([
        'MinorGC',
        'MajorGC',
        'GCEvent',
      ]),
    },
    topEvents: [...eventTotals.entries()]
      .map(([name, totalMs]) => ({
        name,
        totalMs: round(totalMs),
      }))
      .sort((first, second) => second.totalMs - first.totalMs)
      .slice(0, 15),
  };
}

async function waitForEnabled(locator) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < 60000) {
    if (await locator.isVisible().catch(() => false)) {
      const isDisabled = await locator.isDisabled().catch(() => true);
      if (!isDisabled) {
        return;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error('Timed out waiting for enabled control.');
}

async function waitForServer() {
  const startedAt = performance.now();
  while (performance.now() - startedAt < 60000) {
    try {
      const response = await fetch(appUrl);
      if (response.ok) {
        return;
      }
    } catch {
      // Server is not ready yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error('Vite dev server did not become ready.');
}

async function collectTrace(session, callback) {
  const traceEvents = [];
  const onDataCollected = ({ value }) => {
    traceEvents.push(...value);
  };
  const tracingComplete = new Promise((resolve) => {
    session.once('Tracing.tracingComplete', resolve);
  });

  session.on('Tracing.dataCollected', onDataCollected);
  await session.send('Tracing.start', {
    categories: [
      'devtools.timeline',
      'toplevel',
      'blink.user_timing',
      'disabled-by-default-devtools.timeline',
    ].join(','),
    options: 'sampling-frequency=10000',
  });

  await callback();
  await session.send('Tracing.end');
  await tracingComplete;
  session.off('Tracing.dataCollected', onDataCollected);
  return traceEvents;
}

const viteServer = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(port)], {
  cwd,
  stdio: ['ignore', 'pipe', 'pipe'],
});

viteServer.stdout.on('data', (chunk) => process.stdout.write(`[vite] ${chunk}`));
viteServer.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));

let browser;

try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(90000);

  const cdpSession = await context.newCDPSession(page);
  await cdpSession.send('Network.enable');

  let websocketFrameCount = 0;
  let isTracingClickWindow = false;
  cdpSession.on('Network.webSocketFrameSent', () => {
    if (isTracingClickWindow) {
      websocketFrameCount += 1;
    }
  });
  cdpSession.on('Network.webSocketFrameReceived', () => {
    if (isTracingClickWindow) {
      websocketFrameCount += 1;
    }
  });

  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('label.upload-field input[type="file"]').setInputFiles(imagePath);
  await page.locator('canvas.preview-image').waitFor({ state: 'visible' });

  await page.getByRole('radio', { name: 'isolate' }).click();
  await page.getByRole('radio', { name: 'dithered' }).click();
  await page.getByLabel('Target total lines').fill('40');
  await page.getByRole('radio', { name: 'round-robin' }).click();
  await page.getByLabel('Log step timings').check();
  await page.evaluate(() => {
    window.__multicolorStepProfiles = [];
  });

  const applyButton = page.getByRole('button', { name: 'Apply one round-robin line' });
  await waitForEnabled(applyButton);

  let clickDurationMs = 0;
  const traceEvents = await collectTrace(cdpSession, async () => {
    isTracingClickWindow = true;
    const startedAt = performance.now();
    await applyButton.click();
    clickDurationMs = performance.now() - startedAt;
    await page.waitForFunction(
      () => window.__multicolorStepProfiles?.length >= 1,
      undefined,
      { timeout: 120000 },
    );
    isTracingClickWindow = false;
  });

  const appProfile = await page.evaluate(() => window.__multicolorStepProfiles?.[0] ?? null);
  const traceSummary = summarizeTraceEvents(traceEvents);
  const exactAppBuckets = appProfile
    ? sumBuckets(
        appProfile.rows.filter((row) =>
          [
            'mask rebuild',
            'next nail search',
            'line application',
            'active mask line application',
            'target preview refresh',
            'react render App',
            'react layout commit',
            'paint/passive wait',
          ].includes(row.bucket),
        ),
      )
    : [];
  const combinedBuckets = appProfile
    ? {
        solverMathMs: round(
          (appProfile.rows.find((row) => row.bucket === 'next nail search')?.ms ?? 0) +
          (appProfile.rows.find((row) => row.bucket === 'line application')?.ms ?? 0) +
          (appProfile.rows.find((row) => row.bucket === 'active mask line application')?.ms ?? 0),
        ),
        quantizationAndDitheringMs: round(
          (appProfile.rows.find((row) => row.bucket === 'mask rebuild')?.ms ?? 0) +
          (appProfile.rows.find((row) => row.bucket === 'target preview refresh')?.ms ?? 0),
        ),
        reactRerenderAndCommitMs: round(
          (appProfile.rows.find((row) => row.bucket === 'react render App')?.ms ?? 0) +
          (appProfile.rows.find((row) => row.bucket === 'react layout commit')?.ms ?? 0),
        ),
        browserPostCommitWaitMs: round(
          appProfile.rows.find((row) => row.bucket === 'paint/passive wait')?.ms ?? 0,
        ),
        chromeStyleLayoutPaintCompositeMs: round(
          traceSummary.buckets.styleAndLayoutMs + traceSummary.buckets.paintAndCompositeMs,
        ),
      }
    : null;

  const summary = {
    scenario: {
      source: 'dithered',
      stepMode: 'round-robin',
      targetTotalLines: 40,
      url: appUrl,
    },
    clickDurationMs: round(clickDurationMs),
    websocketFrameCount,
    appProfile: appProfile
      ? {
          handlerMs: appProfile.handlerMs,
          reactCommitMs: appProfile.reactCommitMs,
          totalUntilCommitMs: appProfile.totalUntilCommitMs,
          selectedBuckets: exactAppBuckets,
        }
      : null,
    combinedBuckets,
    traceSummary,
    interpretationHints: {
      viteDevNetworkLikelySmall: websocketFrameCount === 0,
      note:
        'Trace buckets are Chrome trace durations for one click. App profile buckets come from the in-app instrumentation and are exact for the named phases.',
    },
  };

  console.log('TRACE_PROFILE_JSON_START');
  console.log(JSON.stringify(summary, null, 2));
  console.log('TRACE_PROFILE_JSON_END');

  await context.close();
} finally {
  if (browser) {
    await browser.close().catch(() => {});
  }

  viteServer.kill();
}
