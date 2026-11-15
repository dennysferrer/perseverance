# Paisaje de Marte cinematográfico (Vite + Three.js)

## Context
Carpeta vacía. Se quiere un paisaje marciano de película (dunas, rocas, cielo caramelo con polvo, sol de tarde cálido con sombras suaves, las dos lunas) visible en <2 min tras aprobar, luego mejorado. Verificación automática con `npm run check`.

## Fase 1 — Algo visible rápido (<2 min)
1. `npm create vite@latest . -- --template vanilla` (no interactivo) + `npm i three`.
2. `npm run dev -- --host` en segundo plano; reportar URL (http://localhost:5173).
3. `src/main.js` mínimo: escena con terreno de dunas (PlaneGeometry con ruido sinusoidal), cielo con gradiente caramelo (fondo/shader), DirectionalLight cálida baja, niebla color arena, dos esferas (Fobos y Deimos) en el cielo.

## Fase 2 — `npm run check`
- `npm i -D playwright-core` (sin descargar navegadores).
- `scripts/check.mjs`: lanza `chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })`, abre la URL del dev server, espera ~3 s, guarda `check/screenshot.png`, imprime errores de consola/pageerror y sale con código ≠0 si hay errores. WebGL en headless: flags `--use-angle=swiftshader`/`--enable-unsafe-swiftshader` si hace falta.
- Script en package.json: `"check": "node scripts/check.mjs"`.

## Fase 3 — Mejoras (máx. 3 rondas, `check` + revisar captura tras cada una)
- Ronda 1: terreno con ruido fBm, dunas con crestas, color por pendiente/altura; rocas (IcosahedronGeometry deformada, instanciadas, material rugoso rojizo).
- Ronda 2: cielo shader (gradiente caramelo + halo del sol + polvo), sol de tarde bajo con sombras suaves (PCFSoft/VSM), niebla de polvo, partículas de polvo; Fobos (grande, irregular) y Deimos (pequeña) con fases/iluminación.
- Ronda 3: post-proceso ligero (tone mapping ACES, bloom suave/viñeta), cámara con leve movimiento, ajuste de color cinematográfico según la captura.

## Criterio de terminado
`npm run check` sin errores de consola y la captura muestra dunas, rocas, cielo caramelo con polvo, sol cálido con sombras suaves y las dos lunas.

## Verificación
Ejecutar `npm run check`, abrir `check/screenshot.png`, corregir; confirmar que el dev server responde en la URL.
