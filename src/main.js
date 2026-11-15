import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { mergeVertices, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';

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
{
  const SEG = 420, EXT = 2000, EXP = 1.7;
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

function scatter(geo, count, { rMin, rMax, sizeMin, sizeMax, sizePow, cast, farProb }) {
  const mesh = new THREE.InstancedMesh(geo, rockMat, count);
  let n = 0;
  while (n < count) {
    const r = rMin + Math.pow(rand(), 1.5) * (rMax - rMin);
    const a = rand() * Math.PI * 2; // 360°: rocas alrededor de toda la cámara
    const x = CAM.x + Math.sin(a) * r, z = CAM.z - Math.cos(a) * r;
    const tr = terrain(x, z);
    if (rand() < tr.mask * tr.crest * farProb) continue; // no sobre la arena suelta de las dunas
    const s = sizeMin + Math.pow(rand(), sizePow) * (sizeMax - sizeMin);
    sc.set(s * (0.8 + rand() * 0.6), s * (0.6 + rand() * 0.6), s * (0.8 + rand() * 0.6));
    q.setFromEuler(eu.set((rand() - 0.5) * 0.5, rand() * Math.PI * 2, (rand() - 0.5) * 0.5));
    pv.set(x, tr.h - sc.y * 0.2, z);
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
// Controles: arrastrar = mirar 360°, clic derecho / rueda / WASD = caminar
// ============================================================
const el = renderer.domElement;
el.style.cursor = 'grab';
el.style.touchAction = 'none';
camera.rotation.order = 'YXZ';
const view = { yaw: 0.06, pitch: 0.06 };
const player = { x: CAM.x, z: CAM.z, y: heightAt(CAM.x, CAM.z) + CAM.eye, bob: 0 };
const vel = new THREE.Vector3(), wish = new THREE.Vector3();
const fwd = new THREE.Vector3(), right = new THREE.Vector3();
const keys = new Set();
const pointers = new Map();
let walkHeld = false, wheel = 0;
const hint = document.getElementById('hint');
let hintTimer = setTimeout(() => hint?.classList.add('hide'), 12000);
const hideHint = () => { clearTimeout(hintTimer); hintTimer = setTimeout(() => hint?.classList.add('hide'), 2500); };

el.addEventListener('contextmenu', (e) => e.preventDefault());
el.addEventListener('pointerdown', (e) => {
  el.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (e.button === 2) walkHeld = true;
  else el.style.cursor = 'grabbing';
  hideHint();
});
el.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (e.pointerType === 'mouse' && !(e.buttons & 1)) return; // solo el botón izquierdo gira
  if (pointers.size > 1) return;
  view.yaw -= dx * 0.0035;
  view.pitch = THREE.MathUtils.clamp(view.pitch - dy * 0.0035, -1.35, 1.35);
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  if (e.button === 2) walkHeld = false;
  if (!pointers.size) { walkHeld = false; el.style.cursor = 'grab'; }
};
el.addEventListener('pointerup', endPointer);
el.addEventListener('pointercancel', endPointer);
el.addEventListener('wheel', (e) => { e.preventDefault(); wheel += -e.deltaY * 0.03; hideHint(); }, { passive: false });
addEventListener('keydown', (e) => { keys.add(e.code); hideHint(); });
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => { keys.clear(); walkHeld = false; });

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

const WALK_RADIUS = 230;
let last = performance.now();
renderer.setAnimationLoop((ms) => {
  const t = ms * 0.001;
  const dt = Math.min(0.05, (ms - last) / 1000 || 0);
  last = ms;

  // movimiento en el plano según hacia dónde se mira
  fwd.set(-Math.sin(view.yaw), 0, -Math.cos(view.yaw));
  right.set(Math.cos(view.yaw), 0, -Math.sin(view.yaw));
  const k = (c) => (keys.has(c) ? 1 : 0);
  const f = k('KeyW') + k('ArrowUp') - k('KeyS') - k('ArrowDown') + (walkHeld || pointers.size > 1 ? 1 : 0);
  const s = k('KeyD') + k('ArrowRight') - k('KeyA') - k('ArrowLeft');
  wish.set(0, 0, 0).addScaledVector(fwd, f).addScaledVector(right, s);
  if (wish.lengthSq() > 1) wish.normalize();
  wish.multiplyScalar(keys.has('ShiftLeft') || keys.has('ShiftRight') ? 14 : 5);
  vel.lerp(wish, 1 - Math.exp(-dt * 6));
  player.x += (vel.x + fwd.x * wheel) * dt;
  player.z += (vel.z + fwd.z * wheel) * dt;
  wheel *= Math.exp(-dt * 3);
  const ox = player.x - CAM.x, oz = player.z - CAM.z, r = Math.hypot(ox, oz);
  if (r > WALK_RADIUS) { player.x = CAM.x + (ox / r) * WALK_RADIUS; player.z = CAM.z + (oz / r) * WALK_RADIUS; }
  const speed = Math.hypot(vel.x + fwd.x * wheel, vel.z + fwd.z * wheel);
  player.bob += speed * dt * 1.6;
  const groundY = heightAt(player.x, player.z) + CAM.eye;
  player.y += (groundY - player.y) * (1 - Math.exp(-dt * 10));
  camera.position.set(player.x, player.y + Math.sin(player.bob * 2) * 0.04 * Math.min(1, speed / 5), player.z);
  camera.rotation.set(view.pitch, view.yaw, 0);

  // cielo, sol y lunas viajan con la cámara (están "en el infinito")
  celestial.position.copy(camera.position);

  // la caja de sombras sigue al jugador (ajustada a la rejilla para evitar parpadeo)
  shadowTarget.set(Math.round((player.x + fwd.x * 90) / 4) * 4, 0, Math.round((player.z + fwd.z * 90) / 4) * 4);
  sun.target.position.copy(shadowTarget);
  sun.position.copy(shadowTarget).addScaledVector(sunDir, 700);

  phobos.rotation.y += 0.0002;
  const a = dustGeo.attributes.position;
  for (let i = 0; i < DUST; i++) {
    let x = a.getX(i) + 0.035, z = a.getZ(i);
    if (x - player.x > 130) x -= 260; else if (x - player.x < -130) x += 260;
    if (z - player.z > 130) z -= 260; else if (z - player.z < -130) z += 260;
    a.setXYZ(i, x, a.getY(i) + Math.sin(t * 0.6 + i) * 0.004, z);
  }
  a.needsUpdate = true;

  grade.uniforms.time.value = t;
  composer.render();
});
