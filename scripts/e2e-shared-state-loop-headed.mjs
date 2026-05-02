import { spawn } from 'node:child_process';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';

const cwd = process.cwd();
const port = 5186;
const viteBin = path.join(cwd, 'node_modules', 'vite', 'bin', 'vite.js');
const defaultImagePath = path.join(cwd, 'scripts', 'fixtures', 'e2e-shared-loop.svg');
const timeoutMs = Number.parseInt(process.env.E2E_TIMEOUT_MS ?? '120000', 10);
const serverTimeoutMs = Number.parseInt(process.env.E2E_SERVER_TIMEOUT_MS ?? '60000', 10);
const enabledTimeoutMs = Number.parseInt(process.env.E2E_ENABLED_TIMEOUT_MS ?? '60000', 10);
const heartbeatMs = Number.parseInt(process.env.E2E_HEARTBEAT_MS ?? '10000', 10);
const imagePath = process.env.E2E_IMAGE_PATH
  ? path.resolve(cwd, process.env.E2E_IMAGE_PATH)
  : defaultImagePath;
const appUrl = `http://127.0.0.1:${port}/MyStringArt/`;

const REQUIRED_SINGLE_CALL_BUCKETS = [
  'shared best line search',
  'line application',
];

const IRRELEVANT_BUCKETS = [
  'mask rebuild',
  'next nail search',
  'active mask line application',
  'target preview refresh',
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBenignConsoleError(text) {
  return text === 'Failed to load resource: the server responded with a status of 404 (Not Found)';
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

async function waitWithHeartbeat(label, fn) {
  const stopHeartbeat = startHeartbeat(label);
  try {
    return await fn();
  } finally {
    stopHeartbeat();
  }
}

async function waitForServer() {
  const startedAt = performance.now();
  let nextHeartbeatAt = startedAt + heartbeatMs;
  while (performance.now() - startedAt < serverTimeoutMs) {
    try {
      const response = await fetch(appUrl);
      if (response.ok) {
        return;
      }
    } catch {
      // Wait for server startup.
    }
    if (heartbeatMs > 0 && performance.now() >= nextHeartbeatAt) {
      process.stdout.write(
        `[wait] Vite dev server ready check still pending after ${Math.round(
          performance.now() - startedAt,
        )}ms\n`,
      );
      nextHeartbeatAt += heartbeatMs;
    }
    await sleep(250);
  }
  throw new Error('Vite dev server did not become ready.');
}

async function waitForEnabled(locator) {
  const startedAt = performance.now();
  let nextHeartbeatAt = startedAt + heartbeatMs;
  while (performance.now() - startedAt < enabledTimeoutMs) {
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
    await sleep(100);
  }
  throw new Error('Timed out waiting for enabled control.');
}

function countBuckets(rows) {
  const counts = new Map();
  for (const row of rows ?? []) {
    counts.set(row.bucket, (counts.get(row.bucket) ?? 0) + 1);
  }
  return counts;
}

function assertProfileShape(profile, index) {
  const bucketCounts = countBuckets(profile.rows);
  for (const bucket of REQUIRED_SINGLE_CALL_BUCKETS) {
    const count = bucketCounts.get(bucket) ?? 0;
    if (count !== 1) {
      throw new Error(`Profile ${index} expected exactly one "${bucket}" bucket, found ${count}.`);
    }
  }

  for (const bucket of IRRELEVANT_BUCKETS) {
    const count = bucketCounts.get(bucket) ?? 0;
    if (count > 0) {
      throw new Error(`Profile ${index} should not include irrelevant bucket "${bucket}".`);
    }
  }
}

const viteServer = spawn(
  process.execPath,
  [viteBin, '--host', '127.0.0.1', '--port', String(port)],
  { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
);

viteServer.stdout.on('data', (chunk) => process.stdout.write(`[vite] ${chunk}`));
viteServer.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));

let browser;

try {
  await waitForServer();

  browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1024 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);
  let abortReason = null;
  const failFast = (reason) => {
    if (abortReason) {
      return;
    }
    abortReason = reason instanceof Error ? reason : new Error(String(reason));
    process.stderr.write(`[page-error] ${abortReason.message}\n`);
    void browser.close().catch(() => {});
  };
  page.on('console', (message) => {
    if (message.type() === 'error') {
      const text = message.text();
      if (!isBenignConsoleError(text)) {
        failFast(new Error(`Console error: ${text}`));
      }
    }
  });
  page.on('pageerror', (error) => {
    failFast(new Error(`Page error: ${error.message}`));
  });

  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  if (abortReason) {
    throw abortReason;
  }
  await page.locator('label.upload-field input[type="file"]').setInputFiles(imagePath);
  if (abortReason) {
    throw abortReason;
  }
  await page.locator('canvas.preview-image').waitFor({ state: 'visible' });
  if (abortReason) {
    throw abortReason;
  }
  await page.getByRole('slider', { name: /^Nails:/i }).evaluate((element) => {
    element.value = '80';
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
  if (abortReason) {
    throw abortReason;
  }

  await page.getByRole('button', { name: /switch to art/i }).click();
  if (abortReason) {
    throw abortReason;
  }
  await page.locator('.art-lines-layer').waitFor({ state: 'visible' });
  if (abortReason) {
    throw abortReason;
  }

  const logTimingsCheckbox = page.getByLabel('Log step timings');
  if (!(await logTimingsCheckbox.isChecked())) {
    await logTimingsCheckbox.check();
  }
  if (abortReason) {
    throw abortReason;
  }

  await page.evaluate(() => {
    window.__multicolorStepProfiles = [];
  });
  if (abortReason) {
    throw abortReason;
  }

  const initialPolygonCount = await page.locator('.art-lines-layer polygon').count();
  const loopButton = page.getByRole('button', { name: /Start shared-state loop/i });
  await waitForEnabled(loopButton);
  if (abortReason) {
    throw abortReason;
  }
  await loopButton.click();
  if (abortReason) {
    throw abortReason;
  }

  await waitWithHeartbeat('waiting for first shared-state profile', () =>
    page.waitForFunction(
      () => (window.__multicolorStepProfiles?.length ?? 0) >= 1,
      undefined,
      { timeout: timeoutMs },
    ),
  );

  await waitWithHeartbeat('waiting for art preview polygons', () =>
    page.waitForFunction(
      () => document.querySelectorAll('.art-lines-layer polygon').length > 0,
      undefined,
      { timeout: timeoutMs },
    ),
  );

  await waitWithHeartbeat('waiting for third shared-state profile', () =>
    page.waitForFunction(
      () => (window.__multicolorStepProfiles?.length ?? 0) >= 3,
      undefined,
      { timeout: timeoutMs },
    ),
  );

  const stopButton = page.getByRole('button', { name: /Stop shared-state loop/i });
  await waitForEnabled(stopButton);
  if (abortReason) {
    throw abortReason;
  }
  await stopButton.click();
  if (abortReason) {
    throw abortReason;
  }
  await waitWithHeartbeat('waiting for loop stop acknowledgement', () =>
    page.waitForFunction(
      () => {
        const statusText = document.body.innerText;
        return statusText.includes('Stopped: user requested stop.');
      },
      undefined,
      { timeout: timeoutMs },
    ),
  );

  const finalPolygonCount = await page.locator('.art-lines-layer polygon').count();
  if (finalPolygonCount <= initialPolygonCount) {
    throw new Error(
      `Expected art preview polygon count to grow. Initial=${initialPolygonCount}, final=${finalPolygonCount}.`,
    );
  }

  const profiles = await page.evaluate(() => window.__multicolorStepProfiles ?? []);
  if (profiles.length < 3) {
    throw new Error(`Expected at least 3 shared-state profiles, received ${profiles.length}.`);
  }

  profiles.slice(0, 3).forEach((profile, index) => assertProfileShape(profile, index));

  const summary = {
    appUrl,
    initialPolygonCount,
    finalPolygonCount,
    profilesChecked: 3,
    sampleProfiles: profiles.slice(0, 3).map((profile, index) => ({
      index,
      handlerMs: profile.handlerMs,
      totalUntilCommitMs: profile.totalUntilCommitMs,
      buckets: profile.rows.map((row) => row.bucket),
    })),
  };

  console.log('E2E_SHARED_STATE_LOOP_JSON_START');
  console.log(JSON.stringify(summary, null, 2));
  console.log('E2E_SHARED_STATE_LOOP_JSON_END');

  await context.close();
} finally {
  if (browser) {
    await browser.close().catch(() => {});
  }
  viteServer.kill();
}
