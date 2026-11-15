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
const roverLogs = [];
page.on('console', (m) => {
  if (m.text().startsWith('[rover]')) roverLogs.push(m.text());
  if (!['error', 'warning'].includes(m.type())) return;
  if (m.text().includes('GL Driver Message')) return; // ruido de SwiftShader
  errors.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.__roverReady, null, { timeout: 60000 }).catch(() => errors.push('[check] el rover no terminó de cargar'));
await page.waitForTimeout(3000);
await page.screenshot({ path: 'check/screenshot.png' });

// Interacción: conducir (W + giro con D) y orbitar 180° para ver las huellas
// (la simulación se avanza con window.__sim para no depender de los FPS del Chrome sin GPU)
const sim = (frames) => page.evaluate((n) => window.__sim?.(n), frames);
await page.keyboard.down('KeyW');
await sim(100);
await page.keyboard.down('KeyD');
await sim(70);
await page.keyboard.up('KeyD');
await sim(90);
await page.keyboard.up('KeyW');
await sim(45);
await page.mouse.move(190, 300);
await page.mouse.down();
await page.mouse.move(1088, 420, { steps: 30 });
await page.mouse.up();
await page.waitForTimeout(2500);
await page.screenshot({ path: 'check/screenshot-back.png' });

// Prueba de suspensión: una rueda pasa por encima de una roca pequeña
await page.keyboard.up('KeyW');
const climb = await page.evaluate(() => {
  const { rover, orbit, rockGrid, boulders } = window.__test;
  if (!rover.wheels[0]?.wrapper) return { error: 'ruedas no separadas' };
  const rocks = [...rockGrid.values()].flat()
    .filter((r) => r.top > 0.18 && r.top < 0.38)
    .filter((r) => !boulders.some((b) => Math.hypot(b.x - r.x, b.z - r.z) < b.r + 4))
    .sort((a, b) => Math.hypot(a.x - rover.x, a.z - rover.z) - Math.hypot(b.x - rover.x, b.z - rover.z));
  const rock = rocks[0];
  if (!rock) return { error: 'no hay rocas trepables' };
  rover.heading = 0; rover.speed = 0;
  rover.x = rock.x - rover.trackHalf; rover.z = rock.z + 2.6;
  return { rock: { top: rock.top, r: rock.r } };
});
let maxLift = 0;
if (!climb.error) {
  await page.keyboard.down('KeyW');
  for (let i = 0; i < 200; i++) {
    await page.evaluate(() => window.__sim(1));
    const lift = await page.evaluate(() => Math.max(...window.__test.rover.wheels.map((w) => w.off)));
    maxLift = Math.max(maxLift, lift);
    if (lift >= climb.rock.top * 0.7) break;
  }
  await page.keyboard.up('KeyW');
  await page.evaluate(() => {
    const { rover, orbit } = window.__test;
    rover.speed = 0;
    Object.assign(orbit, { yaw: Math.PI / 2 - 0.35, elev: 0.75, dist: 6.5, lastDrag: performance.now() + 1e7 });
    window.__sim(90);
  });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'check/screenshot-climb.png' });
  console.log(`[check] Suspensión: una rueda subió ${(maxLift * 100).toFixed(0)} cm sobre una roca de ${(climb.rock.top * 100).toFixed(0)} cm`);
  if (maxLift < 0.05) errors.push('[check] la rueda no subió al pisar la roca');
} else errors.push(`[check] prueba de suspensión: ${climb.error}`);
await browser.close();

roverLogs.forEach((l) => console.log(l));
console.log('Capturas: check/screenshot.png, check/screenshot-back.png (tras conducir y orbitar 180°), check/screenshot-climb.png (rueda sobre roca)');
if (errors.length) {
  console.log(`Errores de consola (${errors.length}):`);
  errors.forEach((e) => console.log(' ', e));
  process.exit(1);
}
console.log('Sin errores de consola.');
