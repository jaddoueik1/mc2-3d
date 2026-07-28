import * as THREE from "three";
import {
  PW, PH, wx, wz, BUILDINGS, MASTERPLAN,
} from "../data/buildings";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * Builds the whole WebGL scene onto `canvas` and returns a controller.
 *
 * The Three.js side stays imperative — React owns only the DOM chrome and
 * talks to the scene through the returned handle (selectBuilding /
 * backToOverview / togglePlan), while the scene reports hover + selection
 * back through the `on*` callbacks.
 */
export function createScene(canvas, callbacks = {}) {
  const {
    onHover = () => {},
    onSelect = () => {},
    onBackToOverview = () => {},
    onReady = () => {},
  } = callbacks;

  const reduce =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, alpha: true, powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x2b3550, 0.00085);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.5, 5000);
  const clock = new THREE.Clock();

  // ---------------------------------------------------------------- lighting
  scene.add(new THREE.HemisphereLight(0x5f7ba8, 0x3a2f22, 1.05));
  const key = new THREE.DirectionalLight(0xffc08a, 2.2);
  key.position.set(-130, 120, 90);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  const sc = key.shadow.camera;
  sc.left = -230; sc.right = 230; sc.top = 230; sc.bottom = -230;
  sc.near = 10; sc.far = 700;
  key.shadow.bias = -0.0005;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x6f93c8, 0.6);
  fill.position.set(150, 70, -100);
  scene.add(fill);

  // ------------------------------------------------------- dusk sky + sun
  const skyCv = document.createElement("canvas");
  skyCv.width = 8; skyCv.height = 256;
  const sxg = skyCv.getContext("2d");
  const grd = sxg.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0.0, "#080e28");
  grd.addColorStop(0.34, "#1d3060");
  grd.addColorStop(0.47, "#4a5578");
  grd.addColorStop(0.52, "#b9834f");
  grd.addColorStop(0.58, "#d79a58");
  grd.addColorStop(0.66, "#7b5e56");
  grd.addColorStop(1.0, "#201c2c");
  sxg.fillStyle = grd;
  sxg.fillRect(0, 0, 8, 256);
  const skyTex = new THREE.CanvasTexture(skyCv);
  skyTex.colorSpace = THREE.SRGBColorSpace;
  scene.add(new THREE.Mesh(
    new THREE.SphereGeometry(2600, 32, 16),
    new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false, depthWrite: false })
  ));

  const sunDir = new THREE.Vector3(-1500, 300, 1080);
  const sun = new THREE.Mesh(
    new THREE.SphereGeometry(90, 24, 16),
    new THREE.MeshBasicMaterial({ color: 0xfff1d2, fog: false })
  );
  sun.position.copy(sunDir);
  scene.add(sun);

  const gCv = document.createElement("canvas");
  gCv.width = gCv.height = 256;
  const gxx = gCv.getContext("2d");
  const rg = gxx.createRadialGradient(128, 128, 8, 128, 128, 128);
  rg.addColorStop(0, "rgba(255,228,176,0.95)");
  rg.addColorStop(0.22, "rgba(255,193,120,0.55)");
  rg.addColorStop(0.55, "rgba(240,150,90,0.18)");
  rg.addColorStop(1, "rgba(240,150,90,0)");
  gxx.fillStyle = rg;
  gxx.fillRect(0, 0, 256, 256);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(gCv),
    blending: THREE.AdditiveBlending,
    transparent: true, depthWrite: false, fog: false,
  }));
  glow.scale.set(1250, 1250, 1);
  glow.position.copy(sunDir);
  scene.add(glow);

  // -------------------------------------------------------- ground + plate
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(7000, 7000),
    new THREE.MeshStandardMaterial({ color: 0x0b1526, roughness: 0.98 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // The real masterplan drawing, textured onto the site plate.
  const planTex = new THREE.TextureLoader().load(MASTERPLAN);
  planTex.colorSpace = THREE.SRGBColorSpace;
  try {
    planTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  } catch {
    /* anisotropy unsupported — fine, the plate just reads slightly softer */
  }
  const planMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(PW, PH),
    new THREE.MeshStandardMaterial({
      map: planTex, roughness: 0.94, metalness: 0.0,
      emissiveMap: planTex, emissive: 0x8a8f9a, emissiveIntensity: 0.42,
    })
  );
  planMesh.rotation.x = -Math.PI / 2;
  planMesh.position.y = 0.15;
  planMesh.receiveShadow = true;
  scene.add(planMesh);

  const boxGeo = new THREE.BoxGeometry(1, 1, 1);

  // ------------------------------------------------------------- geometry
  function wavyGeo(w, d, amp, waves, h) {
    const s = new THREE.Shape();
    const hw = w / 2, hd = d / 2, N = 22;
    s.moveTo(-hw, -hd);
    s.lineTo(hw, -hd);
    for (let i = 1; i <= N; i++) {
      const tt = i / N;
      s.lineTo(hw + amp * Math.sin(tt * Math.PI * waves), -hd + d * tt);
    }
    s.lineTo(-hw, hd);
    for (let i = 1; i <= N; i++) {
      const tt = i / N;
      s.lineTo(-hw - amp * Math.sin(tt * Math.PI * waves), hd - d * tt);
    }
    s.closePath();
    const geo = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: false, steps: 1 });
    geo.rotateX(-Math.PI / 2);
    return geo;
  }

  function ovalGeo(ra, rb, hole, h) {
    const s = new THREE.Shape();
    s.absellipse(0, 0, ra, rb, 0, Math.PI * 2, false, 0);
    const hp = new THREE.Path();
    hp.absellipse(0, 0, ra * hole, rb * hole, 0, Math.PI * 2, true, 0);
    s.holes.push(hp);
    const geo = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: false, steps: 1 });
    geo.rotateX(-Math.PI / 2);
    return geo;
  }

  const solarMat = () => new THREE.MeshStandardMaterial({
    color: 0x30456a, roughness: 0.32, metalness: 0.72,
    emissive: 0x0a1830, emissiveIntensity: 0.28,
  });
  const mepMat = new THREE.MeshStandardMaterial({ color: 0x3b4250, roughness: 0.7, metalness: 0.3 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x646a73, roughness: 0.86, metalness: 0.12 });

  // Procedural window / lit-floor textures, shared across every facade.
  function makeTex(draw) {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 256;
    draw(cv.getContext("2d"), 256);
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  const GC = 6, CEL = 256 / GC;
  const winMap = makeTex((x, S) => {
    x.fillStyle = "#cbc8c1";
    x.fillRect(0, 0, S, S);
    for (let r = 0; r < GC; r++) {
      for (let c = 0; c < GC; c++) {
        x.fillStyle = "#949dab";
        x.fillRect(c * CEL + CEL * 0.15, r * CEL + CEL * 0.2, CEL * 0.7, CEL * 0.58);
      }
    }
    x.fillStyle = "rgba(60,58,54,0.5)";
    for (let r = 0; r <= GC; r++) x.fillRect(0, r * CEL - 1, S, 2);
  });
  const winEmis = makeTex((x, S) => {
    x.fillStyle = "#000";
    x.fillRect(0, 0, S, S);
    for (let r = 0; r < GC; r++) {
      for (let c = 0; c < GC; c++) {
        if (Math.random() < 0.36) {
          x.fillStyle = Math.random() < 0.72 ? "#ffca82" : "#bcd6f0";
          x.fillRect(c * CEL + CEL * 0.15, r * CEL + CEL * 0.2, CEL * 0.7, CEL * 0.58);
        }
      }
    }
  });
  winMap.repeat.set(1 / (GC * 4.0), 1 / (GC * 4.7));
  winEmis.repeat.set(1 / (GC * 4.0), 1 / (GC * 4.7));

  // ------------------------------------------------------------ buildings
  const buildings = [];
  const pick = [];

  BUILDINGS.forEach((b, idx) => {
    const h = b.floors * 4.4 + 3;
    const px = wx(b.u), pz = wz(b.v);
    const bw = b.w * PW, bd = b.d * PH;
    const g = new THREE.Group();
    g.position.set(px, 0, pz);

    const base = new THREE.Color(b.color !== undefined ? b.color : 0xbdb4a4);
    const facMat = new THREE.MeshStandardMaterial({
      color: base.clone(), map: winMap, emissiveMap: winEmis,
      emissive: 0xffc284, emissiveIntensity: 0.5, roughness: 0.72, metalness: 0.06,
    });
    const tint = [{ mat: facMat, base: base.clone() }];

    let fac;
    if (b.shape === "oval") {
      const ra = bw / 2, rb = bd / 2;
      fac = new THREE.Mesh(ovalGeo(ra, rb, 0.5, h), [roofMat, facMat]);
      const shM = solarMat();
      tint.push({ mat: shM, base: new THREE.Color(0x30456a) });
      const shell = new THREE.Mesh(ovalGeo(ra * 1.05, rb * 1.05, 0.52, 3.2), shM);
      shell.position.y = h;
      shell.castShadow = true;
      g.add(shell);
    } else if (b.shape === "folded") {
      fac = new THREE.Mesh(wavyGeo(bw, bd, bw * 0.03, 2, h), [roofMat, facMat]);
      const rM = solarMat();
      tint.push({ mat: rM, base: new THREE.Color(0x30456a) });
      for (let fi = 0; fi < 3; fi++) {
        const slab = new THREE.Mesh(boxGeo, rM);
        slab.scale.set(bw * 0.33, 1.4, bd * 0.92);
        slab.position.set(-bw * 0.33 + fi * bw * 0.33, h + (fi === 1 ? 5 : 2.5), 0);
        slab.rotation.z = (fi - 1) * 0.3;
        slab.castShadow = true;
        g.add(slab);
      }
    } else {
      fac = new THREE.Mesh(wavyGeo(bw, bd, bw * 0.055, 3, h), [roofMat, facMat]);
      for (let mi = 0; mi < 3; mi++) {
        const mep = new THREE.Mesh(boxGeo, mepMat);
        mep.scale.set(bw * 0.17, 3.4, bd * 0.17);
        mep.position.set((mi - 1) * bw * 0.26, h + 1.7, ((mi % 2) * 2 - 1) * bd * 0.16);
        mep.castShadow = true;
        g.add(mep);
      }
    }
    fac.castShadow = true;
    fac.receiveShadow = true;
    g.add(fac);
    scene.add(g);
    g.scale.y = reduce ? 1 : 0.001;

    const bo = {
      g, facMat, tint, data: b, h,
      center: new THREE.Vector3(px, h * 0.5 + 3, pz),
      focusR: Math.max(bw, bd, h) * 2.0 + 58,
      dim: 1, hov: 0, delay: 0.12 + idx * 0.06,
    };
    g.children.forEach((ch) => {
      ch.userData.bo = bo;
      pick.push(ch);
    });
    buildings.push(bo);
  });

  // ------------------------------------------------------------- context
  // Surface parking — rows of PV canopies behind the blocks.
  const canMat = new THREE.MeshStandardMaterial({ color: 0x2b3444, roughness: 0.6, metalness: 0.4 });
  for (let pr = 0; pr < 7; pr++) {
    const can = new THREE.Mesh(boxGeo, canMat);
    can.scale.set(PW * 0.27, 1.2, PH * 0.018);
    can.position.set(wx(0.35), 4.6, wz(0.16) + pr * PH * 0.022);
    can.castShadow = true;
    can.receiveShadow = true;
    scene.add(can);
  }

  // Water canal strip along the far edge.
  const water = new THREE.Mesh(
    new THREE.BoxGeometry(PW * 0.028, 0.6, PH * 0.34),
    new THREE.MeshStandardMaterial({
      color: 0x33618c, roughness: 0.12, metalness: 0.5,
      emissive: 0x0a2540, emissiveIntensity: 0.4,
    })
  );
  water.position.set(wx(0.965), 0.5, wz(0.36));
  scene.add(water);

  // Low context buildings ringing the site.
  const ctxMat = new THREE.MeshStandardMaterial({ color: 0x1a2740, roughness: 0.95 });
  for (let q = 0; q < 44; q++) {
    const ang = q * 2.399963, rr = 150 + ((q * 37) % 150);
    const cx = Math.cos(ang) * rr, cz = Math.sin(ang) * rr * 0.82;
    if (Math.abs(cx) < PW * 0.56 && Math.abs(cz) < PH * 0.56) continue;
    const cw = 16 + ((q * 13) % 30), cd = 16 + ((q * 7) % 24), ch = 9 + ((q * 17) % 36);
    const cm = new THREE.Mesh(boxGeo, ctxMat);
    cm.scale.set(cw, ch, cd);
    cm.position.set(cx, ch / 2, cz);
    cm.castShadow = true;
    cm.receiveShadow = true;
    scene.add(cm);
  }

  // Distant skyline — tall lit towers fading into the horizon haze.
  function towerEmisTex(cols, rows, frac) {
    return makeTex((x, S) => {
      x.fillStyle = "#05070f";
      x.fillRect(0, 0, S, S);
      const cw = S / cols, ch = S / rows;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (Math.random() < frac) {
            x.fillStyle = Math.random() < 0.68 ? "#ffd08a" : "#a8c6ec";
            x.fillRect(c * cw + cw * 0.22, r * ch + ch * 0.18, cw * 0.56, ch * 0.52);
          }
        }
      }
    });
  }
  const towerMats = [];
  const tPat = [[6, 20, 0.5], [8, 26, 0.42], [5, 16, 0.58]];
  for (let ti = 0; ti < 3; ti++) {
    const em = towerEmisTex(tPat[ti][0], tPat[ti][1], tPat[ti][2]);
    em.repeat.set(1, 1);
    towerMats.push(new THREE.MeshStandardMaterial({
      color: 0x1c2740, roughness: 0.72, metalness: 0.28,
      emissive: 0xffffff, emissiveMap: em, emissiveIntensity: 0.9,
    }));
  }
  for (let s = 0; s < 66; s++) {
    const a = s * 0.317 + (s % 4) * 0.06, rad = 600 + ((s * 53) % 560);
    const tw = 16 + ((s * 17) % 34), th = 90 + ((s * 79) % 330), td = 16 + ((s * 29) % 30);
    const tm = new THREE.Mesh(boxGeo, towerMats[s % 3]);
    tm.scale.set(tw, th, td);
    tm.position.set(Math.cos(a) * rad, th / 2, Math.sin(a) * rad);
    scene.add(tm);
  }
  const tall = [[-820, 60, 720, 460], [760, -680, 40, 520], [-160, 980, 55, 400], [980, 240, 45, 430]];
  tall.forEach((p, pi) => {
    const t = new THREE.Mesh(boxGeo, towerMats[pi % 3]);
    t.scale.set(p[2], p[3], p[2] * 0.8);
    t.position.set(p[0], p[3] / 2, p[1]);
    scene.add(t);
  });

  // Street trees.
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x3a2c1e, roughness: 1 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x4e7c59, roughness: 0.9 });
  const treeSpots = [
    [0.10, 0.55], [0.10, 0.70], [0.10, 0.85], [0.72, 0.58], [0.72, 0.74],
    [0.5, 0.95], [0.35, 0.95], [0.66, 0.44], [0.9, 0.62], [0.9, 0.78],
  ];
  treeSpots.forEach((s) => {
    for (let t = 0; t < 2; t++) {
      const tx = wx(s[0]) + (t * 6 - 3);
      const tz = wz(s[1]) + ((t % 2) * 6 - 3);
      const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.7, 4, 6), trunkMat);
      tr.position.set(tx, 2, tz);
      const lf = new THREE.Mesh(new THREE.SphereGeometry(2.8, 10, 8), leafMat);
      lf.position.set(tx, 6, tz);
      lf.castShadow = true;
      scene.add(tr, lf);
    }
  });

  // ------------------------------------------------------- camera + state
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const scratch = new THREE.Color();

  let hovered = null, focused = null;
  let theta = 0.86, phi = 0.7, radiusCur = 580, radiusDes = 305;
  const target = new THREE.Vector3(0, 8, 0);
  const targetDes = new THREE.Vector3(0, 8, 0);
  const HOME_T = new THREE.Vector3(0, 8, 0);
  const HOME_R = 305;
  let down = false, moved = 0, lx = 0, ly = 0, vT = 0, vP = 0;
  let autoRot = !reduce, ready = false, inView = true, planVisible = true;
  let rafId = null, disposed = false;

  function resize() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function frame() {
    rafId = requestAnimationFrame(frame);
    if (!inView) return;
    const t = clock.getElapsedTime();

    // Buildings grow in on load.
    if (!ready) {
      let all = true;
      for (const bo of buildings) {
        let f = reduce ? 1 : clamp((t - bo.delay) / 0.9, 0, 1);
        f = 1 - Math.pow(1 - f, 3);
        bo.g.scale.y = Math.max(0.001, f);
        if (f < 1) all = false;
      }
      if (all) {
        ready = true;
        onReady();
      }
    }

    target.lerp(targetDes, 0.075);
    radiusCur += (radiusDes - radiusCur) * 0.07;
    if (autoRot && !down && !focused && !hovered) theta += 0.0009;
    if (!down) {
      theta += vT;
      phi = clamp(phi + vP, 0.28, 1.35);
      vT *= 0.9;
      vP *= 0.9;
    }

    const sp = Math.sin(phi), cp = Math.cos(phi);
    camera.position.set(
      target.x + radiusCur * sp * Math.cos(theta),
      target.y + radiusCur * cp,
      target.z + radiusCur * sp * Math.sin(theta)
    );
    camera.lookAt(target);

    // Dim the unfocused buildings, brighten the hovered/focused one.
    for (const b of buildings) {
      const wantDim = focused ? (b === focused ? 1 : 0.34) : 1;
      b.dim += (wantDim - b.dim) * 0.1;
      const wantHov = hovered === b || focused === b ? 1 : 0;
      b.hov += (wantHov - b.hov) * 0.18;
      for (const tm of b.tint) {
        scratch.copy(tm.base).multiplyScalar(0.42 + 0.58 * b.dim);
        tm.mat.color.copy(scratch);
      }
      b.facMat.emissiveIntensity = 0.5 + b.hov * 0.5;
    }

    renderer.render(scene, camera);
  }

  // ---------------------------------------------------------- interaction
  function setP(e) {
    const r = canvas.getBoundingClientRect();
    pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  }
  function rayPick(e) {
    setP(e);
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(pick, false);
    return hits.length ? hits[0].object.userData.bo : null;
  }

  function selectBuildingById(id) {
    const bo = buildings.find((b) => b.data.id === id);
    if (bo) select(bo);
  }

  function select(bo) {
    focused = bo;
    targetDes.copy(bo.center);
    radiusDes = bo.focusR;
    autoRot = false;
    phi = 0.7;
    onHover(null);
    onSelect(bo.data);
  }

  function backToOverview() {
    focused = null;
    targetDes.copy(HOME_T);
    radiusDes = HOME_R;
    autoRot = !reduce;
    onBackToOverview();
  }

  function onPointerDown(e) {
    down = true;
    moved = 0;
    lx = e.clientX;
    ly = e.clientY;
  }
  function onPointerMove(e) {
    if (down) {
      const dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      vT = -dx * 0.005;
      vP = -dy * 0.004;
      theta += vT;
      phi = clamp(phi + vP, 0.28, 1.35);
    } else {
      const bo = rayPick(e);
      if (bo !== hovered) {
        hovered = bo;
        canvas.style.cursor = bo ? "pointer" : "grab";
      }
      if (!focused) {
        onHover(bo ? { data: bo.data, x: e.clientX, y: e.clientY } : null);
      }
    }
  }
  function onPointerUp() { down = false; }
  function onClick(e) {
    if (moved >= 12) return;
    const bo = rayPick(e) || hovered;
    if (bo) select(bo);
    else if (focused) backToOverview();
  }
  function onPointerLeave() {
    if (!focused) {
      hovered = null;
      onHover(null);
    }
  }

  canvas.addEventListener("pointerdown", onPointerDown, { passive: true });
  canvas.addEventListener("pointermove", onPointerMove, { passive: true });
  canvas.addEventListener("click", onClick);
  canvas.addEventListener("pointerleave", onPointerLeave);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("blur", onPointerUp);
  window.addEventListener("resize", resize);

  const io = new IntersectionObserver((entries) => {
    inView = entries[0].isIntersecting;
  }, { threshold: 0.01 });
  io.observe(canvas);

  resize();
  clock.start();
  frame();

  return {
    selectBuildingById,
    backToOverview,
    togglePlan() {
      planVisible = !planVisible;
      planMesh.visible = planVisible;
      return planVisible;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      io.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("blur", onPointerUp);
      window.removeEventListener("resize", resize);
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        const m = o.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else if (m) m.dispose();
      });
      renderer.dispose();
    },
  };
}
