// Cámaras de Percy que toman fotos reales de Marte (NASA Mars 2020 raw images API).
// Las fotos de src/photos.json se escogieron a mano entre las más recientes de cada cámara.
import * as THREE from 'three';
import PHOTOS from './photos.json';

const CAMS = [
  { part: 'Mastcam_Z_cams', name: 'Mastcam-Z', api: 'MCZ_LEFT', desc: 'Cámaras con zoom del mástil' },
  { part: 'NavCams', name: 'Navcam', api: 'NAVCAM_LEFT', desc: 'Cámaras de navegación' },
  { part: 'hazcams_front', name: 'Hazcam delantera', api: 'FRONT_HAZCAM_LEFT_A', desc: 'Evita obstáculos' },
  { part: 'WATSON', name: 'WATSON', api: 'SHERLOC_WATSON', desc: 'Primer plano, en el brazo' },
];

const css = `
.cam-spot{position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;border:0;padding:0;cursor:pointer;z-index:5;
  background:radial-gradient(circle,#fff 0 25%,#7fe3ff 40%,rgba(80,200,255,.35) 62%,transparent 70%);
  box-shadow:0 0 12px 4px rgba(110,220,255,.55);animation:camPulse 1.8s ease-in-out infinite}
.cam-spot:hover,.cam-spot:focus-visible{animation:none;transform:scale(1.35);outline:none;box-shadow:0 0 18px 7px rgba(140,230,255,.8)}
.cam-spot span{position:absolute;left:50%;bottom:150%;transform:translateX(-50%);white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .15s;
  background:rgba(10,8,6,.85);color:#f3dcc4;font:12px/1.3 system-ui,sans-serif;padding:5px 9px;border-radius:6px;text-align:center}
.cam-spot span small{display:block;opacity:.65;font-size:10.5px}
.cam-spot:hover span,.cam-spot:focus-visible span{opacity:1}
@keyframes camPulse{0%,100%{transform:scale(.85);opacity:.75}50%{transform:scale(1.15);opacity:1}}

#cam-view{position:fixed;inset:0;z-index:20;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,0);transition:background .4s}
#cam-view.open{display:flex;background:rgba(0,0,0,.55)}
#cam-view.zoom{background:rgba(0,0,0,.94)}
#cam-shutter{position:absolute;inset:0;pointer-events:none}
#cam-shutter::before,#cam-shutter::after{content:'';position:absolute;left:0;right:0;height:50%;background:#000;transform:scaleY(0)}
#cam-shutter::before{top:0;transform-origin:top}#cam-shutter::after{bottom:0;transform-origin:bottom}
#cam-view.snap #cam-shutter::before,#cam-view.snap #cam-shutter::after{animation:shut .32s ease-in-out}
@keyframes shut{0%,100%{transform:scaleY(0)}45%,55%{transform:scaleY(1)}}
#cam-flash{position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none}
#cam-view.snap #cam-flash{animation:flash .9s ease-out .16s}
@keyframes flash{0%{opacity:.95}100%{opacity:0}}
#cam-card{position:relative;max-width:min(88vw,1100px);background:#0d0a08;padding:10px 10px 12px;border-radius:6px;box-shadow:0 20px 60px rgba(0,0,0,.7);cursor:zoom-in;
  transition:max-width .35s,padding .35s;color:#f3dcc4;font:13px/1.4 system-ui,sans-serif}
#cam-view.zoom #cam-card{max-width:100vw;padding:0;background:transparent;box-shadow:none;cursor:zoom-out}
#cam-img{display:block;max-width:100%;max-height:72vh;min-width:min(60vw,640px);min-height:200px;object-fit:contain;background:#000;
  filter:brightness(0) blur(18px) sepia(1);transition:filter 2.6s ease-out}
#cam-view.zoom #cam-img{max-height:92vh;min-width:0}
#cam-img.dev{filter:none}
#cam-meta{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:8px 2px 0}
#cam-meta b{font-size:14px}#cam-meta .r{opacity:.7}
#cam-view.zoom #cam-meta{position:absolute;left:12px;right:12px;bottom:10px;background:rgba(0,0,0,.6);padding:6px 10px;border-radius:6px}
#cam-msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;opacity:.7;pointer-events:none}
#cam-help{position:fixed;bottom:14px;left:50%;transform:translateX(-50%);color:#f3dcc4;opacity:.75;font:12px system-ui,sans-serif;white-space:nowrap}
#cam-view .nav{position:fixed;top:50%;transform:translateY(-50%);background:rgba(0,0,0,.45);color:#fff;border:0;font-size:28px;width:44px;height:64px;border-radius:8px;cursor:pointer}
#cam-view .nav.l{left:12px}#cam-view .nav.r{right:12px}
@media (max-width:600px){#cam-help{font-size:10.5px}#cam-img{min-width:0}}`;

const daysAgo = (utc) => Math.max(0, Math.floor((Date.now() - Date.parse(utc)) / 86400000));
const agoText = (d) => (d === 0 ? 'hoy' : d === 1 ? 'hace 1 día' : `hace ${d} días`);

let audio;
function shutterSound() {
  try {
    audio ||= new AudioContext();
    const n = audio.sampleRate * 0.09, buf = audio.createBuffer(1, n, audio.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (n * 0.12)) * (i < n * 0.5 || i > n * 0.55 ? 1 : 0);
    const s = audio.createBufferSource(), g = audio.createGain();
    s.buffer = buf; g.gain.value = 0.35; s.connect(g).connect(audio.destination); s.start();
  } catch { /* sin audio */ }
}

export function setupCameras({ rover, camera, renderer, onOpenChange }) {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ---- visor de fotos ----
  const view = document.createElement('div');
  view.id = 'cam-view';
  view.innerHTML = `<div id="cam-shutter"></div><div id="cam-flash"></div>
    <button class="nav l" aria-label="Foto anterior">‹</button>
    <figure id="cam-card" style="margin:0"><img id="cam-img" alt=""><div id="cam-msg"></div>
      <figcaption id="cam-meta"></figcaption></figure>
    <button class="nav r" aria-label="Foto siguiente">›</button>
    <div id="cam-help">Clic: ampliar · ← →: más fotos de esta cámara · Esc: volver al juego</div>`;
  document.body.appendChild(view);
  const img = view.querySelector('#cam-img'), meta = view.querySelector('#cam-meta'), msg = view.querySelector('#cam-msg');
  let cur = null, idx = 0;

  function show(i, snap) {
    const list = PHOTOS[cur.api];
    idx = (i + list.length) % list.length;
    const p = list[idx];
    img.classList.remove('dev');
    img.alt = `${cur.name}, sol ${p.sol}`;
    msg.textContent = 'Revelando…';
    meta.innerHTML = `<span><b>${cur.name}</b> · Sol ${p.sol} · ${agoText(daysAgo(p.utc))}</span>
      <span class="r">${idx + 1}/${list.length} · <a href="${p.link}" target="_blank" rel="noopener" style="color:inherit">NASA/JPL-Caltech</a></span>`;
    if (snap) { view.classList.remove('snap'); void view.offsetWidth; view.classList.add('snap'); shutterSound(); }
    img.onload = () => { msg.textContent = ''; requestAnimationFrame(() => requestAnimationFrame(() => img.classList.add('dev'))); };
    img.onerror = () => { msg.textContent = 'No se pudo descargar la foto (¿sin conexión?)'; };
    img.src = p.src;
  }
  function open(cam) {
    cur = cam;
    view.classList.remove('zoom');
    view.classList.add('open');
    onOpenChange?.(true);
    show(0, true);
  }
  function close() {
    view.classList.remove('open', 'zoom', 'snap');
    cur = null;
    onOpenChange?.(false);
  }
  view.querySelector('#cam-card').addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    view.classList.toggle('zoom');
  });
  view.querySelector('.nav.l').addEventListener('click', () => show(idx - 1, true));
  view.querySelector('.nav.r').addEventListener('click', () => show(idx + 1, true));
  view.addEventListener('click', (e) => { if (e.target === view) close(); });
  // captura: mientras el visor está abierto, las teclas no conducen el rover
  addEventListener('keydown', (e) => {
    if (!cur) return;
    if (e.code === 'Escape') close();
    else if (e.code === 'ArrowLeft') show(idx - 1, true);
    else if (e.code === 'ArrowRight') show(idx + 1, true);
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  // ---- puntos brillantes sobre las piezas del modelo ----
  const spots = CAMS.map((cam) => {
    const b = document.createElement('button');
    b.className = 'cam-spot';
    b.dataset.cam = cam.part;
    b.style.display = 'none';
    b.setAttribute('aria-label', `Tomar foto con ${cam.name}`);
    b.innerHTML = `<span>${cam.name}<small>${cam.desc} · clic para tomar foto</small></span>`;
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('click', () => open(cam));
    document.body.appendChild(b);
    return { cam, b, local: null, obj: null };
  });

  const v = new THREE.Vector3(), box = new THREE.Box3();
  return function update() {
    for (const s of spots) {
      if (!s.obj) {
        s.obj = rover.cameras[s.cam.part];
        if (!s.obj) continue;
        // centro de la pieza en coordenadas del rover (se calcula una vez)
        rover.pivot.updateMatrixWorld(true);
        box.setFromObject(s.obj, true).getCenter(v);
        s.local = rover.pivot.worldToLocal(v.clone());
      }
      v.copy(s.local);
      rover.pivot.localToWorld(v);
      v.project(camera);
      s.vis = !cur && v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
      const r = renderer.domElement.getBoundingClientRect();
      s.sx = r.left + (v.x * 0.5 + 0.5) * r.width;
      s.sy = r.top + (-v.y * 0.5 + 0.5) * r.height;
    }
    // Mastcam-Z y Navcam están casi juntas: si dos puntos se tapan, se separan en pantalla
    const MIN = 26;
    for (let i = 0; i < spots.length; i++) for (let j = i + 1; j < spots.length; j++) {
      const a = spots[i], c = spots[j];
      if (!a.vis || !c.vis) continue;
      let dx = c.sx - a.sx, dy = c.sy - a.sy, d = Math.hypot(dx, dy);
      if (d >= MIN) continue;
      if (d < 0.01) { dx = 1; dy = 0; d = 1; }
      const push = (MIN - d) / 2;
      a.sx -= (dx / d) * push; a.sy -= (dy / d) * push;
      c.sx += (dx / d) * push; c.sy += (dy / d) * push;
    }
    for (const s of spots) {
      s.b.style.display = s.vis ? 'block' : 'none';
      if (s.vis) { s.b.style.left = `${s.sx}px`; s.b.style.top = `${s.sy}px`; }
    }
  };
}
