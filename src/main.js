import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { mergeVertices, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { createDashboard } from './dashboard.js';

// Icosaedro indexado (vértices compartidos) para normales suaves
const smoothIco = (detail) => {
  const g = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  return mergeVertices(g);
};

// ============================================================
// Renderer / escena / cámara
// ============================================================
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 5000);
const CAM = { x: 0, z: 60, eye: 2.6 };
const ROVER_START = { x: CAM.x, z: CAM.z - 14 };

// ============================================================
// Ruido
// ============================================================
const hash = (x, y) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
const smooth = (t) => t * t * (3 - 2 * t);
const vnoise = (x, y) => {
  const xi = Math.floor(x), yi = Math.floor(y);
  const u = smooth(x - xi), v = smooth(y - yi);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
};
const fbm = (x, y, oct = 5) => {
  let a = 0.5, f = 1, s = 0, n = 0;
  for (let i = 0; i < oct; i++) { s += a * vnoise(x * f, y * f); n += a; f *= 2.03; a *= 0.5; }
  return s / n;
};
const ridged = (x, y) => {
  let a = 0.5, f = 1, s = 0, n = 0;
  for (let i = 0; i < 5; i++) {
    const r = 1 - Math.abs(2 * vnoise(x * f, y * f) - 1);
    s += a * r * r; n += a; f *= 2.1; a *= 0.5;
  }
  return s / n;
};
const sstep = (a, b, x) => smooth(Math.min(1, Math.max(0, (x - a) / (b - a))));
const fract = (x) => x - Math.floor(x);

// Ruido periódico (para texturas que se repiten sin costuras)
const pnoise = (x, y, P) => {
  const xi = Math.floor(x), yi = Math.floor(y);
  const u = smooth(x - xi), v = smooth(y - yi);
  const w = (i) => ((i % P) + P) % P;
  const a = hash(w(xi), w(yi)), b = hash(w(xi + 1), w(yi)), c = hash(w(xi), w(yi + 1)), d = hash(w(xi + 1), w(yi + 1));
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
};

// ============================================================
// Terreno: llanura pedregosa cerca, dunas transversales, montañas al fondo
// ============================================================
function terrain(x, z) {
  const r = Math.hypot(x - CAM.x, z - CAM.z);
  // dunas transversales con barlovento suave y sotavento abrupto (cresta afilada)
  const warp = (fbm(x * 0.003 + 10, z * 0.003) - 0.5) * 160;
  const f = fract((x * 0.8 + z * 0.6 + warp) / 130);
  const prof = f < 0.78 ? Math.pow(f / 0.78, 1.5) : 1 - sstep(0.78, 1.0, f);
  const amp = 5 + fbm(x * 0.004, z * 0.004 + 3) * 14;
  const mask = 0.12 + 0.88 * sstep(25, 160, r);
  const dunes = prof * amp * mask;
  const big = (fbm(x * 0.0018 + 4, z * 0.0018) - 0.5) * 34 * sstep(20, 220, r);
  const mountains = ridged(x * 0.0022 + 2, z * 0.0022) * 95 * sstep(500, 1050, r);
  const local = (fbm(x * 0.03, z * 0.03, 4) - 0.5) * 1.8;
  return { h: dunes + big + mountains + local, crest: prof, mask };
}
const heightAt = (x, z) => terrain(x, z).h;

// ============================================================
// Sol, cielo y atmósfera
// ============================================================
const dirFrom = (azDeg, elDeg) => {
  const az = THREE.MathUtils.degToRad(azDeg), el = THREE.MathUtils.degToRad(elDeg);
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
};
const sunDir = dirFrom(-24, 9);

const HORIZON = new THREE.Color(0xe2a46c);
scene.fog = new THREE.FogExp2(HORIZON, 0.00135);

const sky = new THREE.Mesh(
  new THREE.SphereGeometry(3000, 64, 32),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      sunDir: { value: sunDir },
      horizon: { value: HORIZON },
      mid: { value: new THREE.Color(0xc87a47) },
      zenith: { value: new THREE.Color(0x5e3020) },
      sunCol: { value: new THREE.Color(1.0, 0.72, 0.46) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vP;
      void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      varying vec3 vP;
      uniform vec3 sunDir, horizon, mid, zenith, sunCol;
      float h21(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5); }
      float n2(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
        return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }
      void main(){
        vec3 d = normalize(vP);
        float h = max(d.y, 0.0);
        vec3 c = mix(horizon, mid, smoothstep(0.0, 0.2, h));
        c = mix(c, zenith, smoothstep(0.15, 0.9, h));
        // velos de polvo en altura
        vec2 sp = d.xz / (d.y + 0.15) * 2.0;
        float veil = n2(sp * 0.6) * 0.6 + n2(sp * 1.7) * 0.4;
        c = mix(c, horizon * 1.05, veil * 0.18 * smoothstep(0.0, 0.5, h));
        // dispersión alrededor del sol (con el leve halo frío real de los atardeceres marcianos)
        float s = max(dot(d, normalize(sunDir)), 0.0);
        c += sunCol * (pow(s, 6.0) * 0.16 + pow(s, 40.0) * 0.32 + pow(s, 700.0) * 2.5);
        c = mix(c, c * vec3(0.92, 0.98, 1.12), pow(s, 90.0) * 0.6);
        // bruma densa pegada al horizonte
        c = mix(c, horizon, exp(-h * 18.0) * 0.6);
        if (d.y < 0.0) c = horizon;
        gl_FragColor = vec4(c, 1.0);
      }`,
  }),
);
sky.renderOrder = -1;
sky.frustumCulled = false;
const celestial = new THREE.Group();
scene.add(celestial);
celestial.add(sky);

// Disco solar HDR (alimenta el bloom)
const sunDisc = new THREE.Mesh(
  new THREE.CircleGeometry(22, 48),
  new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.88, 0.7).multiplyScalar(40), fog: false }),
);
sunDisc.position.copy(sunDir).multiplyScalar(2600);
sunDisc.lookAt(0, 0, 0);
celestial.add(sunDisc);

// Luces
scene.add(new THREE.HemisphereLight(0xf2b27c, 0x5a2a18, 0.65));
const sun = new THREE.DirectionalLight(0xffb06a, 3.6);
const shadowTarget = new THREE.Vector3(CAM.x - 20, 0, CAM.z - 140);
sun.target.position.copy(shadowTarget);
sun.position.copy(shadowTarget).addScaledVector(sunDir, 700);
scene.add(sun.target);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -200, right: 200, top: 200, bottom: -200, near: 1, far: 1600 });
sun.shadow.radius = 5;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.25;
scene.add(sun);

// ============================================================
// Textura de ondulaciones de arena (normal map procedural)
// ============================================================
function makeRippleNormalMap(size = 512) {
  const H = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = i / size, v = j / size;
      const w = pnoise(u * 4, v * 4, 4) * 1.6 + pnoise(u * 8, v * 8, 8) * 0.5;
      const f = fract(u * 22 + w * 1.7 + Math.sin(v * Math.PI * 2 * 3 + w * 3) * 0.35);
      const rip = f < 0.72 ? smooth(f / 0.72) : smooth((1 - f) / 0.28);
      const grain = pnoise(u * 160, v * 160, 160) * 0.18 + pnoise(u * 64, v * 64, 64) * 0.12;
      H[j * size + i] = rip * 0.65 + grain + pnoise(u * 16, v * 16, 16) * 0.25;
    }
  }
  const data = new Uint8Array(size * size * 4);
  const k = 3.2;
  const at = (i, j) => H[((j + size) % size) * size + ((i + size) % size)];
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const nx = (at(i - 1, j) - at(i + 1, j)) * k;
      const ny = (at(i, j - 1) - at(i, j + 1)) * k;
      const l = Math.hypot(nx, ny, 1);
      const o = (j * size + i) * 4;
      data[o] = ((nx / l) * 0.5 + 0.5) * 255;
      data[o + 1] = ((ny / l) * 0.5 + 0.5) * 255;
      data[o + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.needsUpdate = true;
  return tex;
}

// ============================================================
// Malla del terreno (más densa cerca de la cámara)
// ============================================================
const GRID = { SEG: 420, EXT: 2000, EXP: 1.7 };
let groundPos;
{
  const { SEG, EXT, EXP } = GRID;
  const geo = new THREE.PlaneGeometry(2, 2, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const colors = new Float32Array(pos.count * 3);
  const cSandLight = new THREE.Color(0xcf7a44), cSand = new THREE.Color(0xac5530);
  const cGravel = new THREE.Color(0x7c3c24), cDark = new THREE.Color(0x5a2a19);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i), v = pos.getZ(i);
    const x = CAM.x + Math.sign(u) * Math.pow(Math.abs(u), EXP) * EXT;
    const z = CAM.z + Math.sign(v) * Math.pow(Math.abs(v), EXP) * EXT;
    const t = terrain(x, z);
    pos.setXYZ(i, x, t.h, z);
    uv.setXY(i, x / 4, z / 4);
    const n1 = fbm(x * 0.012, z * 0.012, 4), n2 = fbm(x * 0.07 + 7, z * 0.07, 3);
    c.copy(cSand).lerp(cSandLight, Math.min(1, t.crest * 0.55 * t.mask + (n1 - 0.45) * 0.8));
    c.lerp(cGravel, Math.max(0, (1 - t.mask) * 0.7 * n2 + (1 - t.crest) * 0.15 * t.mask));
    c.lerp(cDark, Math.max(0, (n2 - 0.62) * 1.4) * (1 - t.mask * 0.7));
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const ground = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.93,
      metalness: 0,
      normalMap: makeRippleNormalMap(),
      normalScale: new THREE.Vector2(0.5, 0.5),
    }),
  );
  ground.receiveShadow = true;
  groundPos = geo.attributes.position;
  ground.castShadow = true;
  scene.add(ground);
}

// ============================================================
// Rocas fracturadas: caras talladas por planos de rotura + grietas
// ============================================================
function makeRockGeometry(seed, detail, planesN) {
  let st = Math.floor(seed * 9973) + 7;
  const rnd = () => ((st = (st * 16807) % 2147483647) / 2147483647);
  const g = smoothIco(detail);
  const p = g.attributes.position, v = new THREE.Vector3(), d = new THREE.Vector3();
  const planes = [];
  for (let i = 0; i < planesN; i++) {
    planes.push({ n: new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize(), d: 0.48 + rnd() * 0.34 });
  }
  planes.push({ n: new THREE.Vector3(0, -1, 0), d: 0.3 }); // base plana
  const cracks = [];
  for (let i = 0; i < 2; i++) {
    cracks.push({ n: new THREE.Vector3(rnd() * 2 - 1, rnd() * 0.8 - 0.4, rnd() * 2 - 1).normalize(), d: (rnd() - 0.5) * 0.5 });
  }
  const crack = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) {
    d.fromBufferAttribute(p, i).normalize();
    v.copy(d).multiplyScalar(0.95 + (fbm(d.x * 1.4 + seed, d.y * 1.4 + d.z, 3) - 0.5) * 0.4);
    for (let it = 0; it < 3; it++) {
      for (const pl of planes) {
        const e = v.dot(pl.n) - pl.d;
        if (e > 0) v.addScaledVector(pl.n, -e);
      }
    }
    v.addScaledVector(d, (fbm(d.x * 16 + seed, d.z * 16 + d.y * 9, 2) - 0.5) * 0.03); // rugosidad fina
    let ck = 0;
    for (const c of cracks) {
      const e = Math.abs(v.dot(c.n) - c.d);
      if (e < 0.055) ck = Math.max(ck, 1 - e / 0.055);
    }
    v.addScaledVector(d, -0.05 * ck);
    crack[i] = ck;
    p.setXYZ(i, v.x, v.y * 0.75, v.z);
  }
  g.setAttribute('crack', new THREE.BufferAttribute(crack, 1));
  // suave dentro de cada cara de rotura, aristas vivas entre caras (>32°)
  const f = toCreasedNormals(g, THREE.MathUtils.degToRad(32));
  const fp = f.attributes.position, nr = f.attributes.normal, ca = f.attributes.crack;
  const col = new Float32Array(fp.count * 3);
  const base = new THREE.Color(0x4a261a), alt = new THREE.Color(0x6c3a27), pale = new THREE.Color(0x8a5238);
  const dust = new THREE.Color(0xb86c3d), dark = new THREE.Color(0x1e0f0a), c = new THREE.Color();
  for (let i = 0; i < fp.count; i++) {
    const x = fp.getX(i), y = fp.getY(i), z = fp.getZ(i);
    c.copy(base).lerp(alt, fbm(x * 3 + seed, z * 3 + y * 2, 3));
    c.lerp(pale, Math.max(0, fbm(x * 9 - seed, y * 9 + z * 4, 2) - 0.6) * 1.5); // vetas
    c.lerp(dust, Math.max(0, nr.getY(i) - 0.5) * 1.6);
    c.lerp(dark, ca.getX(i) * 0.85);
    col.set([c.r, c.g, c.b], i * 3);
  }
  f.setAttribute('color', new THREE.BufferAttribute(col, 3));
  f.deleteAttribute('crack');
  return f;
}
const rockMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
const rand = (() => { let s = 12345; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), eu = new THREE.Euler(), sc = new THREE.Vector3(), pv = new THREE.Vector3();

const boulders = []; // rocas grandes con las que choca el rover
const ROCK_CELL = 2;
const rockGrid = new Map(); // rocas pequeñas que las ruedas pueden pisar
const addClimbable = (x, z, r, top) => {
  const key = Math.floor(x / ROCK_CELL) * 100003 + Math.floor(z / ROCK_CELL);
  if (!rockGrid.has(key)) rockGrid.set(key, []);
  rockGrid.get(key).push({ x, z, r, r2: r * r, top });
};
const CLIMB_MAX = 0.42; // m: una rueda de 52,5 cm sobrepasa rocas de hasta ~40 cm
function scatter(geo, count, { rMin, rMax, sizeMin, sizeMax, sizePow, cast, farProb }) {
  const mesh = new THREE.InstancedMesh(geo, rockMat, count);
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  let n = 0;
  while (n < count) {
    const r = rMin + Math.pow(rand(), 1.5) * (rMax - rMin);
    const a = rand() * Math.PI * 2; // 360°: rocas alrededor de toda la cámara
    const x = CAM.x + Math.sin(a) * r, z = CAM.z - Math.cos(a) * r;
    if (Math.hypot(x - ROVER_START.x, z - ROVER_START.z) < 7) continue; // despejar la salida del rover
    const tr = terrain(x, z);
    if (rand() < tr.mask * tr.crest * farProb) continue; // no sobre la arena suelta de las dunas
    const s = sizeMin + Math.pow(rand(), sizePow) * (sizeMax - sizeMin);
    sc.set(s * (0.8 + rand() * 0.6), s * (0.6 + rand() * 0.6), s * (0.8 + rand() * 0.6));
    q.setFromEuler(eu.set((rand() - 0.5) * 0.5, rand() * Math.PI * 2, (rand() - 0.5) * 0.5));
    pv.set(x, tr.h - sc.y * 0.2, z);
    const top = tr.h - groundHeight(x, z) + sc.y * (bb.max.y - 0.2);
    const rad = 0.5 * (sc.x * (bb.max.x - bb.min.x) + sc.z * (bb.max.z - bb.min.z)) / 2;
    if (top > CLIMB_MAX) boulders.push({ x, z, r: Math.max(sc.x, sc.z) * 0.75 });
    else if (top > 0.02) addClimbable(x, z, rad, top);
    mesh.setMatrixAt(n++, m4.compose(pv, q, sc));
  }
  mesh.castShadow = cast;
  mesh.receiveShadow = true;
  scene.add(mesh);
}
for (let k = 0; k < 5; k++) {
  scatter(makeRockGeometry(k * 17.3 + 1, 4, 7 + k), 70, {
    rMin: 6, rMax: 320, sizeMin: 0.35, sizeMax: 3.8, sizePow: 4, cast: true, farProb: 1.6,
  });
}
for (let k = 0; k < 2; k++) {
  scatter(makeRockGeometry(91 + k * 7, 2, 6), 2600, {
    rMin: 2, rMax: 150, sizeMin: 0.04, sizeMax: 0.45, sizePow: 3, cast: false, farProb: 1.2,
  });
}

// ============================================================
// Lunas: Fobos y Deimos (irregulares, atenuadas por la atmósfera)
// ============================================================
function makeMoon(radius, dir, seed, stretch) {
  const g = smoothIco(5);
  const p = g.attributes.position, v = new THREE.Vector3();
  const crater = new THREE.Vector3(0.3, 0.2, 1).normalize();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    let k = 1 + (fbm(v.x * 2.2 + seed, v.y * 2.2 + v.z * 1.3, 5) - 0.5) * 0.35;
    const cd = v.dot(crater);
    if (cd > 0.82) k -= Math.pow((cd - 0.82) / 0.18, 0.6) * 0.12; // gran cráter (Stickney)
    k -= Math.max(0, fbm(v.x * 9 + seed, v.z * 9 + v.y * 4, 3) - 0.62) * 0.25; // cráteres pequeños
    p.setXYZ(i, v.x * k * stretch.x, v.y * k * stretch.y, v.z * k * stretch.z);
  }
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(
    g,
    new THREE.MeshStandardMaterial({ color: 0xeadfd2, roughness: 1, fog: false, transparent: true, opacity: 0.72, emissive: 0xb09c8a, emissiveIntensity: 0.85 }),
  );
  mesh.scale.setScalar(radius);
  mesh.position.copy(dir).multiplyScalar(1800);
  mesh.rotation.set(seed, seed * 0.7, 0.3);
  celestial.add(mesh);
  return mesh;
}
const phobos = makeMoon(34, dirFrom(21, 14.5), 3.1, new THREE.Vector3(1.3, 0.95, 1.05));
makeMoon(12, dirFrom(5, 20), 11.7, new THREE.Vector3(1.15, 0.9, 1));

// ============================================================
// Polvo en suspensión
// ============================================================
const dustTex = (() => {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
})();
const DUST = 2200;
const dustPos = new Float32Array(DUST * 3);
for (let i = 0; i < DUST; i++) {
  const x = CAM.x + (rand() - 0.5) * 260, z = CAM.z + (rand() - 0.5) * 260;
  dustPos.set([x, heightAt(x, z) + Math.pow(rand(), 2) * 25, z], i * 3);
}
const dustGeo = new THREE.BufferGeometry();
dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
const dust = new THREE.Points(
  dustGeo,
  new THREE.PointsMaterial({ color: 0xffcf9c, size: 0.9, map: dustTex, transparent: true, opacity: 0.16, depthWrite: false }),
);
dust.frustumCulled = false;
scene.add(dust);

// ============================================================
// Post-proceso: bloom + gradación de película (grano, viñeta, aberración)
// ============================================================
const composer = new EffectComposer(renderer);
composer.setPixelRatio(renderer.getPixelRatio());
composer.setSize(innerWidth, innerHeight);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.32, 0.6, 1.5);
composer.addPass(bloom);
composer.addPass(new OutputPass());
const grade = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, time: { value: 0 }, res: { value: new THREE.Vector2(innerWidth, innerHeight) } },
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float time; uniform vec2 res; varying vec2 vUv;
    float rnd(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec2 cc = vUv - 0.5;
      float r2 = dot(cc, cc);
      vec2 off = cc * r2 * 0.012;
      vec3 col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
      col = mix(col, col * col * (3.0 - 2.0 * col), 0.22);              // contraste en S
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      col += vec3(0.025, 0.008, -0.012) * (1.0 - l);                    // sombras cálidas
      col = mix(vec3(l), col, 1.04);                                     // leve desaturación
      col *= 1.0 - smoothstep(0.3, 0.95, length(cc * vec2(1.0, 0.85)) * 1.25) * 0.5; // viñeta
      col += (rnd(vUv * res + fract(time)) - 0.5) * 0.03;               // grano
      gl_FragColor = vec4(col, 1.0);
    }`,
});
composer.addPass(grade);

// ============================================================
// Altura exacta de la malla renderizada (para apoyar rover y huellas)
// ============================================================
function groundHeight(x, z) {
  const { SEG, EXT, EXP } = GRID;
  const inv = (d) => Math.sign(d) * Math.pow(Math.min(1, Math.abs(d) / EXT), 1 / EXP);
  const fu = ((inv(x - CAM.x) + 1) / 2) * SEG, fv = ((inv(z - CAM.z) + 1) / 2) * SEG;
  const ix = Math.min(SEG - 1, Math.max(0, Math.floor(fu))), iy = Math.min(SEG - 1, Math.max(0, Math.floor(fv)));
  const W = SEG + 1, P = groundPos;
  const a = ix + W * iy, b = ix + W * (iy + 1), c = ix + 1 + W * (iy + 1), d = ix + 1 + W * iy;
  const fx = (x - P.getX(a)) / (P.getX(d) - P.getX(a)), fz = (z - P.getZ(a)) / (P.getZ(b) - P.getZ(a));
  const ha = P.getY(a), hb = P.getY(b), hc = P.getY(c), hd = P.getY(d);
  return fx + fz <= 1 ? ha + (hd - ha) * fx + (hb - ha) * fz : hc + (hb - hc) * (1 - fx) + (hd - hc) * (1 - fz);
}
const groundNormal = (x, z, out, e = 0.35) =>
  out.set(groundHeight(x - e, z) - groundHeight(x + e, z), 2 * e, groundHeight(x, z - e) - groundHeight(x, z + e)).normalize();

// ============================================================
// Rover Perseverance (modelo oficial NASA, tamaño real)
// ============================================================
const ROVER_HEIGHT = 2.2; // m (Perseverance: 3 m largo, 2.7 m ancho, 2.2 m alto)
const WHEEL_DIAMETER = 0.525; // m
const rover = {
  pivot: new THREE.Group(),
  x: ROVER_START.x, z: ROVER_START.z, heading: 0, speed: 0,
  trackHalf: 1.05, wheelW: 0.42, halfBase: 1.25,
  // ruedas por defecto (se reemplazan por las reales al cargar el modelo)
  wheels: [-1, 1].flatMap((side) => [1.1, 0, -1.1].map((f) => ({ wrapper: null, x: side * 1.05, f, side, off: 0, spin: 0, contact: 0 }))),
  susp: [], suspY: [0.3, 1],
  cameras: {},
};
rover.pivot.position.set(rover.x, groundHeight(rover.x, rover.z), rover.z);
scene.add(rover.pivot);

const CAMERA_PARTS = {
  Mastcam_Z_cams: 'Mastcam-Z: cámaras estéreo con zoom del mástil',
  NavCams: 'Navcams: cámaras de navegación del mástil',
  lens: 'lente del cabezal del mástil (probablemente SuperCam)',
  hazcams_front: 'Hazcams delanteras: evitan obstáculos',
  hazcams_rear: 'Hazcams traseras: evitan obstáculos',
  Up_Look_Camera: 'Up-Look Camera: cámara del descenso (EDL) mirando arriba',
  Down_Look_Camera: 'Down-Look Camera: cámara del descenso (EDL) mirando abajo',
  WATSON: 'WATSON: cámara de primer plano en la torreta del brazo (SHERLOC)',
};

const envTex = (() => {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), sky.material));
  const t = pmrem.fromScene(envScene, 0.04).texture;
  pmrem.dispose();
  return t;
})();

const draco = new DRACOLoader().setDecoderPath('/draco/');
new GLTFLoader().setDRACOLoader(draco).load(
  '/models/perseverance.glb',
  (gltf) => {
    const model = gltf.scene;
    model.rotation.y = Math.PI; // el frente del modelo mira a +Z; el rover avanza hacia -Z
    const holder = new THREE.Group();
    holder.add(model);
    const measure = (obj) => { holder.updateMatrixWorld(true); return new THREE.Box3().setFromObject(obj, true); };
    // escala real: por el diámetro de rueda (52,5 cm); si no hay ruedas, por la altura total (2,2 m)
    const wheels = model.getObjectByName('Wheels_objs');
    if (wheels) {
      const wb = measure(wheels);
      model.scale.setScalar(WHEEL_DIAMETER / (wb.max.y - wb.min.y));
    } else {
      const b = measure(model);
      model.scale.setScalar(ROVER_HEIGHT / (b.max.y - b.min.y));
    }
    let box = measure(model);
    const ctr = box.getCenter(new THREE.Vector3());
    model.position.set(-ctr.x, -box.min.y, -ctr.z);
    box = measure(model);
    const size = box.getSize(new THREE.Vector3());
    if (wheels) {
      const wb = measure(wheels);
      rover.trackHalf = (wb.max.x - wb.min.x) / 2 - rover.wheelW / 2;
      rover.halfBase = (wb.max.z - wb.min.z) / 2 - WHEEL_DIAMETER / 2;
    }

    model.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        for (const m of [].concat(o.material)) {
          if ('envMap' in m) { m.envMap = envTex; m.envMapIntensity = 0.7; m.needsUpdate = true; }
        }
      }
    });

    // piezas que son cámaras (las guardamos para usarlas más adelante)
    model.traverse((o) => {
      if (CAMERA_PARTS[o.name]) rover.cameras[o.name] = o;
    });
    window.roverCameras = rover.cameras;
    console.log(`[rover] Perseverance cargado: ${size.z.toFixed(2)} m largo × ${size.x.toFixed(2)} m ancho × ${size.y.toFixed(2)} m alto`);
    console.log(`[rover] Piezas que son cámaras (${Object.keys(rover.cameras).length}):`);
    for (const name of Object.keys(rover.cameras)) console.log(`[rover]   ${name} — ${CAMERA_PARTS[name]}`);

    setupRig(model, holder);
    rover.pivot.add(holder);
    window.__roverReady = true;
  },
  undefined,
  (err) => console.error('[rover] No se pudo cargar el modelo:', err),
);

// ============================================================
// Rocker-bogie: separa las 6 ruedas y deforma la suspensión
// ============================================================
function bakeToHolder(o, holder) {
  const g = o.geometry.clone();
  for (const name of Object.keys(g.attributes)) {
    const a = g.attributes[name];
    if (a.isInterleavedBufferAttribute || !(a.array instanceof Float32Array) || a.normalized) {
      const get = [a.getX, a.getY, a.getZ, a.getW];
      const arr = new Float32Array(a.count * a.itemSize);
      for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) arr[i * a.itemSize + c] = get[c].call(a, i);
      g.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize));
    }
  }
  g.applyMatrix4(new THREE.Matrix4().copy(holder.matrixWorld).invert().multiply(o.matrixWorld));
  return g;
}

function setupRig(model, holder) {
  holder.updateMatrixWorld(true);
  const R = WHEEL_DIAMETER / 2;
  const wheelsObj = model.getObjectByName('Wheels_objs');
  if (!wheelsObj) return;
  const parts = [];
  wheelsObj.traverse((o) => {
    if (!o.isMesh || o.isSkinnedMesh) return;
    let g = bakeToHolder(o, holder);
    if (g.index) g = g.toNonIndexed();
    parts.push({ g, mat: o.material });
    o.visible = false;
  });
  // centroide de cada triángulo
  for (const p of parts) {
    const a = p.g.attributes.position.array, n = a.length / 9;
    p.cent = new Float32Array(n * 2);
    for (let t = 0; t < n; t++) {
      const o = t * 9;
      p.cent[t * 2] = (a[o] + a[o + 3] + a[o + 6]) / 3;
      p.cent[t * 2 + 1] = (a[o + 2] + a[o + 5] + a[o + 8]) / 3;
    }
  }
  // k-means 1D (3 ruedas por lado a lo largo del eje Z)
  const centers = [];
  for (const side of [-1, 1]) {
    const zs = [];
    for (const p of parts) for (let i = 0; i < p.cent.length; i += 2) if ((p.cent[i] < 0 ? -1 : 1) === side) zs.push(p.cent[i + 1]);
    zs.sort((a, b) => a - b);
    let c = [zs[0], (zs[0] + zs[zs.length - 1]) / 2, zs[zs.length - 1]];
    for (let it = 0; it < 20; it++) {
      const s = [0, 0, 0], n = [0, 0, 0];
      for (const z of zs) {
        let k = 0;
        for (let j = 1; j < 3; j++) if (Math.abs(z - c[j]) < Math.abs(z - c[k])) k = j;
        s[k] += z; n[k]++;
      }
      c = c.map((v, j) => (n[j] ? s[j] / n[j] : v));
    }
    for (const z of c) centers.push({ side, z });
  }
  const wheelTris = centers.map(() => parts.map(() => []));
  parts.forEach((p, pi) => {
    for (let t = 0; t < p.cent.length / 2; t++) {
      const side = p.cent[t * 2] < 0 ? -1 : 1, z = p.cent[t * 2 + 1];
      let best = -1, bd = Infinity;
      centers.forEach((c, ci) => { if (c.side === side && Math.abs(z - c.z) < bd) { bd = Math.abs(z - c.z); best = ci; } });
      wheelTris[best][pi].push(t);
    }
  });
  rover.wheels = centers.map((c, ci) => {
    const box = new THREE.Box3();
    const geos = parts.map((p, pi) => {
      const tris = wheelTris[ci][pi];
      if (!tris.length) return null;
      const g = new THREE.BufferGeometry();
      for (const name of Object.keys(p.g.attributes)) {
        const a = p.g.attributes[name], is = a.itemSize, arr = new Float32Array(tris.length * 3 * is);
        let o = 0;
        for (const t of tris) for (let k = 0; k < 3 * is; k++) arr[o++] = a.array[t * 3 * is + k];
        g.setAttribute(name, new THREE.BufferAttribute(arr, is));
      }
      g.computeBoundingBox();
      box.union(g.boundingBox);
      return g;
    });
    // eje de la rueda: centro horizontal de la rueda, a un radio del suelo
    const axle = new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y + R, (box.min.z + box.max.z) / 2);
    // wrapper (sube/baja y gira la dirección en Y) → spinner (rueda sobre su eje X)
    const wrapper = new THREE.Group();
    const spinner = new THREE.Group();
    wrapper.add(spinner);
    geos.forEach((g, pi) => {
      if (!g) return;
      g.translate(-axle.x, -axle.y, -axle.z);
      const m = new THREE.Mesh(g, parts[pi].mat);
      m.castShadow = m.receiveShadow = true;
      spinner.add(m);
    });
    wrapper.position.copy(axle);
    holder.add(wrapper);
    return { wrapper, spinner, base: axle.clone(), x: axle.x, f: -axle.z, side: c.side, off: 0, spin: 0, steer: 0, contact: 0 };
  });
  rover.trackHalf = rover.wheels.reduce((s, w) => s + Math.abs(w.x), 0) / rover.wheels.length;

  // suspensión: se deforma siguiendo la altura de las ruedas de su lado
  const susp = model.getObjectByName('suspension');
  let yTop = 0;
  if (susp) susp.traverse((o) => {
    if (!o.isMesh || o.isSkinnedMesh) return;
    const g = bakeToHolder(o, holder);
    g.computeBoundingBox();
    yTop = Math.max(yTop, g.boundingBox.max.y);
    const m = new THREE.Mesh(g, o.material);
    m.castShadow = m.receiveShadow = true;
    m.frustumCulled = false;
    holder.add(m);
    o.visible = false;
    rover.susp.push({ g, orig: g.attributes.position.array.slice() });
  });
  rover.suspY = [R + 0.08, yTop];
}

let lastSuspOff = '';
function deformSuspension() {
  if (!rover.susp.length) return;
  const key = rover.wheels.map((w) => w.off.toFixed(3)).join();
  if (key === lastSuspOff) return;
  lastSuspOff = key;
  const L = rover.wheels.filter((w) => w.side < 0).sort((a, b) => a.f - b.f);
  const Rt = rover.wheels.filter((w) => w.side > 0).sort((a, b) => a.f - b.f);
  const interp = (arr, f) => {
    if (f <= arr[0].f) return arr[0].off;
    for (let i = 1; i < arr.length; i++) {
      if (f <= arr[i].f) return arr[i - 1].off + ((arr[i].off - arr[i - 1].off) * (f - arr[i - 1].f)) / (arr[i].f - arr[i - 1].f);
    }
    return arr[arr.length - 1].off;
  };
  const [y0, y1] = rover.suspY;
  for (const s of rover.susp) {
    const p = s.g.attributes.position.array, o = s.orig;
    for (let i = 0; i < o.length; i += 3) {
      const y = o[i + 1];
      const w = 1 - THREE.MathUtils.smoothstep(y, y0, y1);
      p[i + 1] = w > 0 ? y + interp(o[i] < 0 ? L : Rt, -o[i + 2]) * w : y;
    }
    s.g.attributes.position.needsUpdate = true;
  }
}

// cuánto sube una rueda (radio R) al pisar rocas pequeñas: perfil elipsoidal de cada roca
function rockLift(px, pz) {
  const R = WHEEL_DIAMETER / 2;
  const ci = Math.floor(px / ROCK_CELL), cj = Math.floor(pz / ROCK_CELL);
  const cand = [];
  for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) {
    const cell = rockGrid.get(i * 100003 + j);
    if (cell) for (const r of cell) if (Math.hypot(r.x - px, r.z - pz) < r.r + R + 0.3) cand.push(r);
  }
  if (!cand.length) return 0;
  let best = 0;
  for (const a of [-0.9, -0.6, -0.3, 0, 0.3, 0.6, 0.9]) {
    const drop = R - Math.sqrt(R * R - (a * R) ** 2);
    for (const l of [-0.16, 0, 0.16]) {
      const sx = px + fwd.x * a * R + right.x * l, sz = pz + fwd.z * a * R + right.z * l;
      for (const r of cand) {
        const d2 = (sx - r.x) ** 2 + (sz - r.z) ** 2;
        if (d2 < r.r2) {
          const h = r.top * Math.sqrt(1 - d2 / r.r2) - drop;
          if (h > best) best = h;
        }
      }
    }
  }
  return best;
}

// ============================================================
// Huellas de las ruedas (decals sobre el terreno)
// ============================================================
const treadTex = (() => {
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 128;
  const g = cv.getContext('2d');
  g.fillStyle = 'rgba(70,28,14,0.55)';
  g.fillRect(0, 0, 64, 128);
  for (let y = 0; y < 128; y += 16) {
    g.fillStyle = 'rgba(40,14,6,0.8)';
    g.beginPath(); // grousers en "V" suave como las ruedas de Perseverance
    g.moveTo(0, y + 2); g.lineTo(32, y + 7); g.lineTo(64, y + 2);
    g.lineTo(64, y + 7); g.lineTo(32, y + 12); g.lineTo(0, y + 7);
    g.fill();
    g.fillStyle = 'rgba(255,190,140,0.18)';
    g.fillRect(0, y + 12, 64, 2);
  }
  const fade = g.createLinearGradient(0, 0, 64, 0);
  fade.addColorStop(0, 'rgba(0,0,0,1)'); fade.addColorStop(0.12, 'rgba(0,0,0,0)');
  fade.addColorStop(0.88, 'rgba(0,0,0,0)'); fade.addColorStop(1, 'rgba(0,0,0,1)');
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = fade;
  g.fillRect(0, 0, 64, 128);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
})();
const MAX_TRACKS = 9000;
const trackGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
const tracks = new THREE.InstancedMesh(
  trackGeo,
  new THREE.MeshStandardMaterial({
    map: treadTex, transparent: true, depthWrite: false, roughness: 1,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  }),
  MAX_TRACKS,
);
tracks.count = 0;
tracks.frustumCulled = false;
tracks.receiveShadow = true;
scene.add(tracks);
let trackHead = 0;
const lastTrack = { [-1]: null, [1]: null };
const tA = new THREE.Vector3(), tB = new THREE.Vector3(), tF = new THREE.Vector3(), tU = new THREE.Vector3(), tR = new THREE.Vector3();
const tM = new THREE.Matrix4();
function addTrack(p0, p1) {
  tA.set(p0.x, groundHeight(p0.x, p0.z), p0.z);
  tB.set(p1.x, groundHeight(p1.x, p1.z), p1.z);
  const len = tA.distanceTo(tB);
  tF.subVectors(tB, tA).normalize();
  groundNormal((p0.x + p1.x) / 2, (p0.z + p1.z) / 2, tU);
  tR.crossVectors(tF, tU).normalize();
  tU.crossVectors(tR, tF);
  tM.makeBasis(tR, tU, tF.negate());
  tM.scale(new THREE.Vector3(rover.wheelW, 1, len * 1.04));
  tM.setPosition(tA.add(tB).multiplyScalar(0.5).addScaledVector(tU, 0.025));
  tracks.setMatrixAt(trackHead, tM);
  trackHead = (trackHead + 1) % MAX_TRACKS;
  tracks.count = Math.min(MAX_TRACKS, tracks.count + 1);
  tracks.instanceMatrix.needsUpdate = true;
}

// ============================================================
// Controles: WASD conduce · arrastrar orbita 360° · rueda = zoom
// ============================================================
const el = renderer.domElement;
el.style.cursor = 'grab';
el.style.touchAction = 'none';
const orbit = { yaw: 0, elev: 0.17, dist: 10, lastDrag: -1e9 };
const keys = new Set();
const pointers = new Map();
const hint = document.getElementById('hint');
let hintTimer = setTimeout(() => hint?.classList.add('hide'), 12000);
const hideHint = () => { clearTimeout(hintTimer); hintTimer = setTimeout(() => hint?.classList.add('hide'), 2500); };

el.addEventListener('contextmenu', (e) => e.preventDefault());
el.addEventListener('pointerdown', (e) => {
  el.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  el.style.cursor = 'grabbing';
  hideHint();
});
el.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (pointers.size > 1) return;
  orbit.yaw -= dx * 0.0035;
  orbit.elev = THREE.MathUtils.clamp(orbit.elev + dy * 0.003, 0.03, 1.35);
  orbit.lastDrag = performance.now();
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  if (!pointers.size) el.style.cursor = 'grab';
};
el.addEventListener('pointerup', endPointer);
el.addEventListener('pointercancel', endPointer);
el.addEventListener('wheel', (e) => {
  e.preventDefault();
  orbit.dist = THREE.MathUtils.clamp(orbit.dist * Math.exp(e.deltaY * 0.001), 4.5, 45);
  hideHint();
}, { passive: false });
addEventListener('keydown', (e) => {
  if (e.code.startsWith('Arrow')) e.preventDefault();
  keys.add(e.code);
  hideHint();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

// ============================================================
// Bucle
// ============================================================
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  grade.uniforms.res.value.set(innerWidth, innerHeight);
});

const DRIVE_RADIUS = 230;
const fwd = new THREE.Vector3(), right = new THREE.Vector3();
const rF = new THREE.Vector3(), rR = new THREE.Vector3(), rU = new THREE.Vector3(), rM = new THREE.Matrix4();
const rQ = new THREE.Quaternion();
const wp = new THREE.Vector3();
const camTarget = new THREE.Vector3(rover.x, rover.pivot.position.y + 1.4, rover.z);
const lookAt = new THREE.Vector3();
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
let last = performance.now();

function update(dt, t) {
  const k = (c) => (keys.has(c) ? 1 : 0);

  // --- conducción ---
  const throttle = k('KeyW') + k('ArrowUp') - k('KeyS') - k('ArrowDown');
  const steer = k('KeyA') + k('ArrowLeft') - k('KeyD') - k('ArrowRight');
  const vMax = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 7 : 3;
  const vTarget = throttle > 0 ? vMax : throttle < 0 ? -vMax * 0.6 : 0;
  rover.speed += (vTarget - rover.speed) * (1 - Math.exp(-dt * (throttle ? 1.8 : 3.5)));
  const yawRate = steer * 0.8 * (rover.speed < -0.05 ? -1 : 1); // puede girar sobre sí mismo
  rover.heading += yawRate * dt;
  fwd.set(-Math.sin(rover.heading), 0, -Math.cos(rover.heading));
  right.set(Math.cos(rover.heading), 0, -Math.sin(rover.heading));
  rover.x += fwd.x * rover.speed * dt;
  rover.z += fwd.z * rover.speed * dt;
  rover.odo = (rover.odo || 0) + Math.abs(rover.speed) * dt;
  // choque con rocas grandes: el rover se detiene y se desliza por el borde
  for (const b of boulders) {
    const dx = rover.x - b.x, dz = rover.z - b.z, minD = b.r + 1.35;
    const d2 = dx * dx + dz * dz;
    if (d2 < minD * minD && d2 > 1e-6) {
      const d = Math.sqrt(d2);
      rover.x = b.x + (dx / d) * minD;
      rover.z = b.z + (dz / d) * minD;
      rover.speed *= 0.6;
    }
  }
  const ox = rover.x - CAM.x, oz = rover.z - CAM.z, r = Math.hypot(ox, oz);
  if (r > DRIVE_RADIUS) { rover.x = CAM.x + (ox / r) * DRIVE_RADIUS; rover.z = CAM.z + (oz / r) * DRIVE_RADIUS; rover.speed *= 0.5; }

  // --- rocker-bogie: cada rueda apoya en terreno + rocas pequeñas; el chasis sigue el plano medio ---
  const W = rover.trackHalf;
  const wl = rover.wheels;
  let sx = 0, sf = 0, sc = 0;
  for (const w of wl) {
    const px = rover.x + right.x * w.x + fwd.x * w.f, pz = rover.z + right.z * w.x + fwd.z * w.f;
    w.contact = groundHeight(px, pz) + rockLift(px, pz);
    sx += w.x; sf += w.f; sc += w.contact;
  }
  const mx = sx / wl.length, mf = sf / wl.length, mc = sc / wl.length;
  let nX = 0, dX = 0, nF = 0, dF = 0;
  for (const w of wl) {
    nX += (w.x - mx) * (w.contact - mc); dX += (w.x - mx) ** 2;
    nF += (w.f - mf) * (w.contact - mc); dF += (w.f - mf) ** 2;
  }
  const slopeX = nX / dX, slopeF = nF / dF;
  const baseY = mc - slopeX * mx - slopeF * mf;
  rF.copy(fwd); rF.y = slopeF; rF.normalize();
  rR.copy(right); rR.y = slopeX; rR.normalize();
  rU.crossVectors(rR, rF).normalize();
  rR.crossVectors(rF, rU);
  rM.makeBasis(rR, rU, rF.clone().negate());
  rQ.setFromRotationMatrix(rM);
  rover.pivot.quaternion.slerp(rQ, 1 - Math.exp(-dt * 8));
  rover.pivot.position.set(rover.x, THREE.MathUtils.lerp(rover.pivot.position.y, baseY, 1 - Math.exp(-dt * 12)), rover.z);
  rover.pivot.updateMatrixWorld();

  // cada rueda sube/baja respecto al chasis real y gira según su velocidad (diferencial en curvas)
  for (const w of wl) {
    wp.set(w.x, 0, -w.f);
    rover.pivot.localToWorld(wp);
    const target = THREE.MathUtils.clamp(w.contact - wp.y, -0.25, 0.45);
    w.off += (target - w.off) * (1 - Math.exp(-dt * 25));
    // velocidad del suelo bajo la rueda (avance + giro del chasis): lateral y hacia delante
    const lat = -yawRate * w.f, fw = rover.speed + yawRate * w.x;
    let roll = fw;
    // las 4 ruedas de las esquinas tienen dirección (como Perseverance): se orientan
    // según la velocidad local; las del medio van fijas. Ángulo limitado a ±90°.
    if (Math.abs(w.f) > 0.3 && Math.hypot(lat, fw) > 0.02) {
      let phi = Math.atan2(-lat, fw);
      roll = Math.hypot(lat, fw);
      if (phi > Math.PI / 2) { phi -= Math.PI; roll = -roll; } else if (phi < -Math.PI / 2) { phi += Math.PI; roll = -roll; }
      w.steer += (phi - w.steer) * (1 - Math.exp(-dt * 6)); // el actuador tarda un poco
    } else if (Math.abs(w.f) > 0.3 && Math.abs(throttle) + Math.abs(steer) === 0) {
      w.steer *= Math.exp(-dt * 1.5); // en reposo vuelve poco a poco al centro
    }
    w.spin += (roll * dt) / (WHEEL_DIAMETER / 2);
    if (w.wrapper) {
      w.wrapper.position.y = w.base.y + w.off;
      w.wrapper.rotation.y = w.steer;
      w.spinner.rotation.x = -w.spin;
    }
  }
  deformSuspension();

  // --- huellas: una por lado (las 3 ruedas de cada lado pisan la misma rodada) ---
  for (const side of [-1, 1]) {
    const p = { x: rover.x + right.x * W * side, z: rover.z + right.z * W * side };
    const prev = lastTrack[side];
    if (!prev) { lastTrack[side] = p; continue; }
    const d = Math.hypot(p.x - prev.x, p.z - prev.z);
    if (d > 4) lastTrack[side] = p;
    else if (d >= 0.3) { addTrack(prev, p); lastTrack[side] = p; }
  }

  // --- cámara que sigue al rover (órbita libre con el ratón) ---
  if (performance.now() - orbit.lastDrag > 1500 && Math.abs(rover.speed) > 0.2) {
    orbit.yaw += wrapAngle(rover.heading - orbit.yaw) * (1 - Math.exp(-dt * 1.2));
  }
  camTarget.lerp(lookAt.set(rover.x, rover.pivot.position.y + 1.4, rover.z), 1 - Math.exp(-dt * 6));
  const ce = Math.cos(orbit.elev);
  camera.position.set(
    camTarget.x + Math.sin(orbit.yaw) * ce * orbit.dist,
    camTarget.y + Math.sin(orbit.elev) * orbit.dist,
    camTarget.z + Math.cos(orbit.yaw) * ce * orbit.dist,
  );
  camera.position.y = Math.max(camera.position.y, groundHeight(camera.position.x, camera.position.z) + 0.5);
  // con cámara baja mira más allá del rover hacia el horizonte; desde arriba, al rover
  const far = 1 - THREE.MathUtils.smoothstep(orbit.elev, 0.25, 0.8);
  lookAt.set(-Math.sin(orbit.yaw), 0, -Math.cos(orbit.yaw)).multiplyScalar(22 * far).add(camTarget);
  lookAt.y += 2.6 * far;
  camera.lookAt(lookAt);

  // cielo, sol y lunas viajan con la cámara (están "en el infinito")
  celestial.position.copy(camera.position);

  // la caja de sombras sigue al rover (ajustada a una rejilla para evitar parpadeo)
  shadowTarget.set(Math.round(rover.x / 4) * 4, 0, Math.round(rover.z / 4) * 4);
  sun.target.position.copy(shadowTarget);
  sun.position.copy(shadowTarget).addScaledVector(sunDir, 700);

  phobos.rotation.y += 0.0002;
  const a = dustGeo.attributes.position;
  for (let i = 0; i < DUST; i++) {
    let x = a.getX(i) + 0.035, z = a.getZ(i);
    if (x - rover.x > 130) x -= 260; else if (x - rover.x < -130) x += 260;
    if (z - rover.z > 130) z -= 260; else if (z - rover.z < -130) z += 260;
    a.setXYZ(i, x, a.getY(i) + Math.sin(t * 0.6 + i) * 0.004, z);
  }
  a.needsUpdate = true;

  grade.uniforms.time.value = t;
}
// --- dashboard de telemetría (modelo Open MCT) ---
const attEuler = new THREE.Euler();
const dashTick = createDashboard(() => {
  attEuler.setFromQuaternion(rover.pivot.quaternion, 'YXZ');
  const deg = THREE.MathUtils.radToDeg;
  return {
    'percy.velocidad': Math.abs(rover.speed),
    'percy.rumbo': (deg(-rover.heading) % 360 + 360) % 360,
    'percy.cabeceo': deg(attEuler.x),
    'percy.alabeo': deg(attEuler.z),
    'percy.altitud': rover.pivot.position.y,
    'percy.odometro': rover.odo || 0,
  };
});
renderer.setAnimationLoop((ms) => {
  const dt = THREE.MathUtils.clamp((ms - last) / 1000 || 0, 0, 0.05);
  last = ms;
  update(dt, ms * 0.001);
  composer.render();
  dashTick();
});
// gancho de pruebas: avanza la simulación sin depender de los FPS (lo usa npm run check)
let simT = 0;
window.__test = { rover, orbit, rockGrid, boulders };
window.__sim = (frames, dt = 1 / 30) => { for (let i = 0; i < frames; i++) update(dt, (simT += dt)); };
