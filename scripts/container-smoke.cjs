// docker run --rm --entrypoint node -v "$PWD/scripts:/checks:ro" IMAGE /checks/container-smoke.cjs
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { test } = require('node:test');

const appRequire = createRequire('/usr/share/nginx/backend/package.json');

test('nginx configuration is valid', () => {
  execFileSync('nginx', ['-t'], { stdio: 'pipe' });
});

test('runtime packages include the reported critical security fixes', () => {
  for (const [name, minimum] of [
    ['chromium', '155.0.8059.39'],
    ['chromium-common', '155.0.8059.39'],
    ['libglib2.0-0', '2.74.6-2+deb12u8'],
    ['libbrotli1', '1.0.9-2+deb12u1'],
  ]) {
    const version = execFileSync('dpkg-query', ['-W', '-f=${Version}', name], { encoding: 'utf8' });
    execFileSync('dpkg', ['--compare-versions', version, 'ge', minimum]);
    console.log(`${name}: ${version}`);
  }
});

test('Puppeteer renders an invoice PDF with the system Chromium', async () => {
  const puppeteer = appRequire('puppeteer');
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><meta charset="utf-8"><h1>Invoice</h1><p>Service: 42.00</p>',
      { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({ format: 'A4', printBackground: true });
    assert.equal(Buffer.from(pdf).subarray(0, 5).toString(), '%PDF-');
    assert.ok(pdf.length > 1000);
  } finally {
    await browser.close();
  }
});
