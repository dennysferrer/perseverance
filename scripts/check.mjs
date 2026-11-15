import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const URL = process.env.URL || 'http://localhost:5173/';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

mkdirSync('check', { recursive: true });
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => {
  if (!['error', 'warning'].includes(m.type())) return;
  if (m.text().includes('GL Driver Message')) return; // ruido de SwiftShader
  errors.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(6000);
await page.screenshot({ path: 'check/screenshot.png' });

// Interacción: caminar con W y girar 180° arrastrando el ratón
await page.keyboard.down('KeyW');
await page.waitForTimeout(2000);
await page.keyboard.up('KeyW');
await page.mouse.move(190, 360);
await page.mouse.down();
await page.mouse.move(1088, 360, { steps: 30 });
await page.mouse.up();
await page.waitForTimeout(2500);
await page.screenshot({ path: 'check/screenshot-back.png' });
await browser.close();

console.log('Capturas: check/screenshot.png, check/screenshot-back.png (tras caminar y girar 180°)');
if (errors.length) {
  console.log(`Errores de consola (${errors.length}):`);
  errors.forEach((e) => console.log(' ', e));
  process.exit(1);
}
console.log('Sin errores de consola.');
