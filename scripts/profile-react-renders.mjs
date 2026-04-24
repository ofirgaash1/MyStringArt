import { spawn } from 'node:child_process';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';

const cwd = process.cwd();
const port = 5185;
const viteBin = path.join(cwd, 'node_modules', 'vite', 'bin', 'vite.js');
const imagePath = path.join(cwd, 'mona_lisa.PNG');
const appUrl = `http://127.0.0.1:${port}/MyStringArt/`;

async function waitForServer() {
  const startedAt = performance.now();
  while (performance.now() - startedAt < 60000) {
    try {
      const response = await fetch(appUrl);
      if (response.ok) {
        return;
      }
    } catch {
      // Wait for server startup.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error('Vite dev server did not become ready.');
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
  await applyButton.click();
  await page.waitForFunction(
    () => window.__multicolorStepProfiles?.length >= 1,
    undefined,
    { timeout: 120000 },
  );

  const profile = await page.evaluate(() => window.__multicolorStepProfiles?.[0] ?? null);
  const summary = profile
    ? {
        handlerMs: profile.handlerMs,
        reactCommitMs: profile.reactCommitMs,
        totalUntilCommitMs: profile.totalUntilCommitMs,
        rerenderRows: profile.rows.filter((row) =>
          row.bucket.startsWith('render why ') || row.bucket.startsWith('react render '),
        ),
      }
    : null;

  console.log('REACT_RENDER_PROFILE_JSON_START');
  console.log(JSON.stringify(summary, null, 2));
  console.log('REACT_RENDER_PROFILE_JSON_END');

  await context.close();
} finally {
  if (browser) {
    await browser.close().catch(() => {});
  }

  viteServer.kill();
}
