// Dashboard de telemetría de Percy, al estilo Open MCT (nasa/openmct @ e09bfaf).
// Misma forma que Open MCT: cada sensor es un "objeto de telemetría" con metadatos
// (utc = eje X, value = eje Y) y un proveedor con request (historia) y subscribe (en vivo).
// Ref: src/api/telemetry/TelemetryAPI.js:167 (addProvider), :470 (request), :529 (subscribe).

export const SENSORS = [
  { key: 'percy.velocidad', name: 'Velocidad', unit: 'm/s', digits: 2, color: '#ff8a4c' },
  { key: 'percy.rumbo', name: 'Rumbo', unit: '°', digits: 0, color: '#6fb3d6' },
  { key: 'percy.cabeceo', name: 'Cabeceo', unit: '°', digits: 1, color: '#e6c35c' },
  { key: 'percy.alabeo', name: 'Alabeo', unit: '°', digits: 1, color: '#9ad17a' },
  { key: 'percy.altitud', name: 'Altitud', unit: 'm', digits: 2, color: '#c79bf0' },
  { key: 'percy.odometro', name: 'Odómetro', unit: 'm', digits: 1, color: '#f0f0f0' },
];

// Metadatos por sensor, como GeneratorMetadataProvider.js:73
export const metadataFor = (s) => ({
  values: [
    { key: 'utc', name: 'Hora', format: 'utc', hints: { domain: 1 } },
    { key: 'value', name: s.name, unit: s.unit, hints: { range: 1 } },
  ],
});

// Proveedor de telemetría (forma compatible con openmct.telemetry.addProvider)
const HISTORY_MS = 60_000;
const store = new Map(SENSORS.map((s) => [s.key, []]));
const subs = new Map(SENSORS.map((s) => [s.key, new Set()]));

export const percyProvider = {
  supportsRequest: (o) => store.has(o.key),
  request: (o, { start = 0, end = Infinity } = {}) =>
    Promise.resolve(store.get(o.key).filter((d) => d.utc >= start && d.utc <= end)),
  supportsSubscribe: (o) => store.has(o.key),
  subscribe: (o, cb) => { subs.get(o.key).add(cb); return () => subs.get(o.key).delete(cb); },
};

function publish(key, utc, value) {
  const datum = { id: key, utc, value };
  const arr = store.get(key);
  arr.push(datum);
  while (arr.length && arr[0].utc < utc - HISTORY_MS) arr.shift();
  for (const cb of subs.get(key)) cb(datum);
}

// ---------- UI: tabla de último valor (LAD) + gráficas ----------
const css = `
#percy-dash{position:fixed;top:16px;right:16px;width:340px;max-width:calc(100% - 32px);max-height:calc(100% - 32px);overflow:auto;
  background:rgba(14,10,8,.72);backdrop-filter:blur(6px);color:#f3dcc4;border:1px solid rgba(243,220,196,.18);border-radius:10px;
  font:12px/1.35 system-ui,sans-serif;z-index:10}
#percy-dash.hide{display:none}
#percy-dash header{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-bottom:1px solid rgba(243,220,196,.15)}
#percy-dash header b{font-size:13px;letter-spacing:.04em}
#percy-dash header span{opacity:.6;font-size:11px}
#percy-dash table{width:100%;border-collapse:collapse}
#percy-dash td{padding:3px 12px}
#percy-dash td.v{text-align:right;font-variant-numeric:tabular-nums}
#percy-dash .plot{padding:6px 12px 2px}
#percy-dash .plot div{display:flex;justify-content:space-between;opacity:.8}
#percy-dash canvas{width:100%;height:46px;display:block}
#percy-dash footer{padding:6px 12px 10px;opacity:.55;font-size:10.5px}
#percy-dash .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}`;

export function createDashboard(sample) {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'percy-dash';
  root.innerHTML = `
    <header><b>PERSEVERANCE · TELEMETRÍA</b><span id="pd-clock"></span></header>
    <table>${SENSORS.map((s) => `<tr><td><i class="dot" style="background:${s.color}"></i>${s.name}</td><td class="v" id="lad-${s.key}">—</td></tr>`).join('')}</table>
    ${SENSORS.map((s) => `<div class="plot"><div><span>${s.name}</span><span id="rng-${s.key}"></span></div><canvas id="plot-${s.key}"></canvas></div>`).join('')}
    <footer>Últimos 60 s · modelo de datos de Open MCT (utc/value, request + subscribe) · tecla T: ocultar/mostrar</footer>`;
  document.body.appendChild(root);
  addEventListener('keydown', (e) => { if (e.code === 'KeyT') root.classList.toggle('hide'); });

  // cada widget se suscribe como lo hace PlotSeries.js:214
  for (const s of SENSORS) {
    const cell = root.querySelector(`#lad-${CSS.escape(s.key)}`);
    percyProvider.subscribe(s, (d) => { cell.textContent = `${d.value.toFixed(s.digits)} ${s.unit}`; });
  }

  const startUtc = Date.now();
  let lastPub = 0, lastDraw = 0;
  return function tick() {
    const now = Date.now();
    if (now - lastPub >= 100) { // 10 Hz
      lastPub = now;
      const v = sample();
      for (const s of SENSORS) publish(s.key, now, v[s.key]);
    }
    if (root.classList.contains('hide') || now - lastDraw < 200) return;
    lastDraw = now;
    const secs = Math.floor((now - startUtc) / 1000);
    root.querySelector('#pd-clock').textContent = `T+${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
    for (const s of SENSORS) drawPlot(root.querySelector(`#plot-${CSS.escape(s.key)}`), root.querySelector(`#rng-${CSS.escape(s.key)}`), s, now);
  };
}

function drawPlot(cv, rng, s, now) {
  const dpr = devicePixelRatio || 1;
  const w = cv.clientWidth * dpr, h = cv.clientHeight * dpr;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const g = cv.getContext('2d');
  g.clearRect(0, 0, w, h);
  const data = store.get(s.key);
  if (data.length < 2) return;
  let lo = Infinity, hi = -Infinity;
  for (const d of data) { lo = Math.min(lo, d.value); hi = Math.max(hi, d.value); }
  if (hi - lo < 1e-6) { hi += 0.5; lo -= 0.5; }
  rng.textContent = `${lo.toFixed(s.digits)} – ${hi.toFixed(s.digits)} ${s.unit}`;
  g.strokeStyle = 'rgba(243,220,196,.12)';
  g.beginPath(); g.moveTo(0, h - 0.5); g.lineTo(w, h - 0.5); g.stroke();
  g.strokeStyle = s.color; g.lineWidth = 1.5 * dpr;
  g.beginPath();
  data.forEach((d, i) => {
    const x = (1 - (now - d.utc) / HISTORY_MS) * w;
    const y = h - 3 * dpr - ((d.value - lo) / (hi - lo)) * (h - 6 * dpr);
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  });
  g.stroke();
}
