import fs from 'node:fs/promises';
import path from 'node:path';

import { chromium } from 'playwright';

const targetUrl = process.argv[2] ?? 'https://www.cheapoair.com/';
const maxPages = Number.parseInt(process.argv[3] ?? '5', 10);
const artifactsDir = path.resolve('data', 'playwright-smoke');

const errors = [];
const results = [];

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/https?:\/\//g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function record(kind, payload) {
  errors.push({ kind, ...payload });
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function waitForPageSettled(page) {
  await page.waitForLoadState('domcontentloaded');
  try {
    await page.waitForLoadState('networkidle', { timeout: 7000 });
  } catch {}
  await page.waitForTimeout(1200);
}

async function dismissCommonBanners(page) {
  const selectors = [
    page.getByRole('button', { name: /accept|agree|allow all|continue|close/i }).first(),
    page.getByRole('link', { name: /accept|agree|allow all|continue|close/i }).first(),
  ];

  for (const locator of selectors) {
    try {
      if (await locator.isVisible({ timeout: 1500 })) {
        await locator.click({ timeout: 1500 });
        await page.waitForTimeout(500);
      }
    } catch {}
  }
}

function attachPageObservers(page) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      record('console-error', { page: page.url(), message: msg.text() });
    }
  });

  page.on('pageerror', (error) => {
    record('page-error', { page: page.url(), message: error.message });
  });

  page.on('requestfailed', (request) => {
    const failure = request.failure();
    record('request-failed', {
      page: page.url(),
      url: request.url(),
      resourceType: request.resourceType(),
      message: failure?.errorText ?? 'unknown request failure',
    });
  });

  page.on('response', (response) => {
    if (response.status() >= 400 && response.request().resourceType() === 'document') {
      record('bad-response', {
        page: page.url(),
        url: response.url(),
        status: response.status(),
      });
    }
  });
}

async function collectCandidateLinks(page) {
  const current = new URL(page.url());

  return page.evaluate(({ origin, pathname }) => {
    const seen = new Set();
    const anchors = [...document.querySelectorAll('header a, nav a, main a, footer a, a')];

    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    const candidates = [];

    for (const anchor of anchors) {
      const href = anchor.href?.trim();
      const text = anchor.textContent?.replace(/\s+/g, ' ').trim() ?? '';

      if (!href || !isVisible(anchor)) continue;
      if (!href.startsWith(origin)) continue;
      if (href.includes('#')) continue;
      if (href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
      if (text.length < 2 || text.length > 50) continue;
      if (href.endsWith(pathname) || href === `${origin}${pathname}`) continue;
      if (/(sign in|log in|login|account|cart|checkout)/i.test(text)) continue;
      if (seen.has(href)) continue;

      seen.add(href);
      candidates.push({ text, href });
    }

    return candidates.slice(0, 12);
  }, { origin: current.origin, pathname: current.pathname });
}

async function inspectPage(page, label) {
  await waitForPageSettled(page);
  await dismissCommonBanners(page);

  const brokenImages = await page.evaluate(() =>
    [...document.images]
      .filter((image) => image.complete && image.naturalWidth === 0)
      .slice(0, 10)
      .map((image) => image.currentSrc || image.src)
  );

  const fileName = `${results.length.toString().padStart(2, '0')}-${slugify(label || page.url())}.png`;
  const screenshotPath = path.join(artifactsDir, fileName);

  await page.screenshot({ path: screenshotPath, fullPage: true });

  const title = await page.title();
  results.push({
    label,
    url: page.url(),
    title,
    screenshotPath,
    brokenImages,
  });
}

async function launchBrowser() {
  const attempts = [
    { channel: 'msedge', headless: true },
    { channel: 'chrome', headless: true },
    { headless: true },
  ];

  for (const options of attempts) {
    try {
      return await chromium.launch(options);
    } catch {}
  }

  throw new Error('Unable to launch a Chromium-based browser.');
}

async function main() {
  await ensureDir(artifactsDir);

  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  attachPageObservers(page);

  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await inspectPage(page, 'home');

    const candidates = await collectCandidateLinks(page);

    for (const candidate of candidates.slice(0, Math.max(0, maxPages - 1))) {
      try {
        await page.goto(candidate.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await inspectPage(page, candidate.text);
      } catch (error) {
        record('navigation-error', {
          page: page.url(),
          url: candidate.href,
          message: error.message,
        });
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  const summary = {
    targetUrl,
    checkedAt: new Date().toISOString(),
    pageCount: results.length,
    pages: results,
    errorCount: errors.length,
    errors,
  };

  const summaryPath = path.join(artifactsDir, 'summary.json');
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ summaryPath, ...summary }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
