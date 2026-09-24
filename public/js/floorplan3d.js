// 3D "whitebox" view of the Grondplan floor plan, view-only (no editing
// here - the 2D canvas stays the one editing surface, see index.html's own
// tools). Talks to the main (non-module) script through exactly one global
// object, window.Floorplan3D, assigned at the bottom of this file:
//   mount(el)   - create renderer/scene/camera into `el`, start the render
//                 loop, auto-frame the camera once. Safe to call again
//                 after unmount().
//   unmount()   - stop the render loop, dispose the renderer/scene, detach
//                 from the DOM. Safe to call even if never mounted.
//   sync(data)  - data: { walls, openings, zones, resolvedCuts,
//                 wallHeightProfiles }, all in the SAME mm world-space
//                 coordinates index.html's own 2D state uses.
//                 wallHeightProfiles is { [wallId]: computeWallHeightProfile()
//                 result }, precomputed by the caller so this module never
//                 has to re-derive wall-height-vs-zone logic - see the
//                 index.html call site for why (keeps 2D/3D wall heights
//                 byte-for-byte identical by construction, not by
//                 coincidence).
//   isActive()  - whether the 3D view is the one currently visible, so the
//                 caller can skip building wallHeightProfiles/calling
//                 sync() at all while the user is only looking at 2D.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

function toM(mm) { return mm / 1000; }

var renderer = null, scene = null, camera = null, controls = null;
var wallsGroup, floorGroup, ceilingGroup, risersGroup;
var sunLight = null;
var mountEl = null;
var resizeObserver = null;
var rafId = null;
var syncRafScheduled = false;
var pendingSyncData = null;
var lastData = null;
var framedOnce = false;
var showCeiling = false;
var darkModeQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

// ---------------------------------------------------------------------
// Wall/riser box-segment geometry
// ---------------------------------------------------------------------

// One straight solid box between two 2D world points (mm), from bottomM to
// topM (already meters, Y-up). Shared by both wall column segments and
// bulkhead risers - a riser is geometrically just a thin, tall "wall"
// running along its resolvedCut's own chord.
function buildBoxSegment(p1x, p1y, p2x, p2y, thicknessMm, bottomM, topM) {
  var dx = p2x - p1x, dy = p2y - p1y;
  var lenMm = Math.hypot(dx, dy);
  if (lenMm < 1 || topM <= bottomM) return null;
  // 2D (x,y) -> 3D (x,z): a 2D direction (dx,dy) becomes a 3D direction
  // (dx,dz) with dz=dy (no sign flip - see the module doc comment on the
  // coordinate mapping). rotateY's convention maps local +X to
  // (cosT, 0, -sinT), so matching that to (dx,dy) requires
  // cosT=dx/len, -sinT=dy/len -> T = atan2(-dy, dx).
  var angle = Math.atan2(-dy, dx);
  var geo = new THREE.BoxGeometry(toM(lenMm), topM - bottomM, toM(thicknessMm));
  geo.translate(0, (topM + bottomM) / 2, 0);
  geo.rotateY(angle);
  geo.translate(toM((p1x + p2x) / 2), 0, toM((p1y + p2y) / 2));
  return geo;
}

// Splits one wall into vertical "columns" along its length wherever either
// its own required height changes (heightProfile, from
// computeWallHeightProfile) or a door/window's edge falls, then punches
// each column's own openings out of its own local height - see the plan's
// note on why this needs BOTH breakpoint sets merged into one timeline
// before looking up heights, and why overlapping opening ranges need
// merging (two openings straddling the same column) and punch ranges need
// clamping to [0, column height] (an opening sitting where the wall steps
// down to a shorter zone).
function computeWallColumns(wall, heightProfile, wallOpenings) {
  var wLen = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
  if (wLen < 1) return [];
  var profile = heightProfile && heightProfile.length ? heightProfile : [{ t0: 0, t1: 1, height: 2500 }];

  var breakpoints = [0, 1];
  profile.forEach(function (seg) { breakpoints.push(seg.t0, seg.t1); });
  var openingSpans = wallOpenings.map(function (o) {
    var halfT = (o.width / 2) / wLen;
    return { o: o, t0: Math.max(0, o.t - halfT), t1: Math.min(1, o.t + halfT) };
  });
  openingSpans.forEach(function (s) { breakpoints.push(s.t0, s.t1); });

  breakpoints.sort(function (a, b) { return a - b; });
  var dedup = [];
  breakpoints.forEach(function (t) {
    if (!dedup.length || t - dedup[dedup.length - 1] > 1e-4) dedup.push(t);
  });

  var columns = [];
  for (var i = 0; i < dedup.length - 1; i++) {
    var tA = dedup[i], tB = dedup[i + 1];
    var tMid = (tA + tB) / 2;
    var H = profile[0].height;
    for (var j = 0; j < profile.length; j++) {
      if (tMid >= profile[j].t0 - 1e-6 && tMid <= profile[j].t1 + 1e-6) { H = profile[j].height; break; }
    }

    var punches = [];
    openingSpans.forEach(function (s) {
      if (s.t1 <= tA + 1e-6 || s.t0 >= tB - 1e-6) return; // no overlap with this column
      var o = s.o;
      var bottom = o.type === "door" ? 0 : (o.sill || 0);
      var top = o.type === "door" ? o.height : (o.sill || 0) + o.height;
      bottom = Math.max(0, Math.min(bottom, H));
      top = Math.max(0, Math.min(top, H));
      if (top > bottom) punches.push([bottom, top]);
    });
    punches.sort(function (a, b) { return a[0] - b[0]; });
    var merged = [];
    punches.forEach(function (p) {
      if (merged.length && p[0] <= merged[merged.length - 1][1] + 1e-6) {
        merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], p[1]);
      } else {
        merged.push(p.slice());
      }
    });
    var solids = [];
    var cursor = 0;
    merged.forEach(function (p) {
      if (p[0] > cursor) solids.push([cursor, p[0]]);
      cursor = Math.max(cursor, p[1]);
    });
    if (cursor < H) solids.push([cursor, H]);

    columns.push({ tA: tA, tB: tB, solids: solids });
  }
  return columns;
}

function buildWallMesh(wall, heightProfile, wallOpenings, material) {
  var wLen = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
  if (wLen < 1) return null;
  var ux = (wall.x2 - wall.x1) / wLen, uy = (wall.y2 - wall.y1) / wLen;
  var columns = computeWallColumns(wall, heightProfile, wallOpenings);
  var geometries = [];
  columns.forEach(function (col) {
    var p1x = wall.x1 + ux * col.tA * wLen, p1y = wall.y1 + uy * col.tA * wLen;
    var p2x = wall.x1 + ux * col.tB * wLen, p2y = wall.y1 + uy * col.tB * wLen;
    col.solids.forEach(function (seg) {
      var geo = buildBoxSegment(p1x, p1y, p2x, p2y, wall.thickness, toM(seg[0]), toM(seg[1]));
      if (geo) geometries.push(geo);
    });
  });
  if (!geometries.length) return null;
  var merged = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false);
  var mesh = new THREE.Mesh(merged, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// ---------------------------------------------------------------------
// Floor / ceiling (flat, triangulated zone polygons)
// ---------------------------------------------------------------------

function buildFlatPolygonMesh(polygon, yM, material) {
  if (!polygon || polygon.length < 3) return null;
  var points2D = polygon.map(function (p) { return new THREE.Vector2(toM(p.x), toM(p.y)); });
  var triangles = THREE.ShapeUtils.triangulateShape(points2D, []);
  if (!triangles.length) return null;
  var positions = [];
  polygon.forEach(function (p) { positions.push(toM(p.x), yM, toM(p.y)); });
  var indices = [];
  triangles.forEach(function (t) { indices.push(t[0], t[1], t[2]); });
  var geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  var mesh = new THREE.Mesh(geo, material);
  return mesh;
}

// ---------------------------------------------------------------------
// Materials (created once, reused across rebuilds)
// ---------------------------------------------------------------------

// DoubleSide on the flat floor/ceiling planes: THREE.ShapeUtils.
// triangulateShape's winding, combined with this module's 2D(x,y)->3D(x,z)
// mapping, produced triangles whose front face pointed away from a camera
// looking down into the room - confirmed live (the floor was fully
// invisible, backface-culled, before this was added). Cheap here since
// each is a single flat plane, not extruded/thin geometry.
var wallMaterial = new THREE.MeshStandardMaterial({ color: 0xf5f5f2, roughness: 0.9, metalness: 0 });
var floorMaterial = new THREE.MeshStandardMaterial({ color: 0xf0efe9, roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
var ceilingMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
var riserMaterial = new THREE.MeshStandardMaterial({ color: 0xe9e5f5, roughness: 0.85, metalness: 0 });

// ---------------------------------------------------------------------
// Scene lifecycle
// ---------------------------------------------------------------------

function disposeGroupChildren(group) {
  group.children.slice().forEach(function (child) {
    if (child.geometry) child.geometry.dispose();
    group.remove(child);
  });
}

function setupLights(roomSpanM) {
  var hemi = new THREE.HemisphereLight(0xffffff, 0xe8ecf1, 0.9);
  scene.add(hemi);

  sunLight = new THREE.DirectionalLight(0xfff6e8, 2.2);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.bias = -0.0015;
  sunLight.shadow.normalBias = 0.02;
  sunLight.shadow.radius = 4; // VSMShadowMap blur amount - soft shadow edges
  scene.add(sunLight);
  scene.add(sunLight.target);

  var fill = new THREE.DirectionalLight(0xdce6f5, 0.5);
  fill.position.set(-1, 1.6, -1.2);
  scene.add(fill);

  fitSunToRoom(roomSpanM || 5);
}

function fitSunToRoom(roomSpanM) {
  if (!sunLight) return;
  sunLight.position.set(roomSpanM * 0.6, roomSpanM * 1.2, roomSpanM * 0.4);
  sunLight.target.position.set(0, 0, 0);
  var cam = sunLight.shadow.camera;
  cam.near = 0.1;
  cam.far = Math.max(roomSpanM * 4, 10);
  cam.left = -roomSpanM; cam.right = roomSpanM;
  cam.top = roomSpanM; cam.bottom = -roomSpanM;
  cam.updateProjectionMatrix();
}

function applyBackground() {
  if (!scene) return;
  var dark = !!(darkModeQuery && darkModeQuery.matches);
  scene.background = new THREE.Color(dark ? 0x11151c : 0xf7f8fa);
}

function ensureScene() {
  if (scene) return;
  scene = new THREE.Scene();
  wallsGroup = new THREE.Group(); scene.add(wallsGroup);
  floorGroup = new THREE.Group(); scene.add(floorGroup);
  ceilingGroup = new THREE.Group(); ceilingGroup.visible = showCeiling; scene.add(ceilingGroup);
  risersGroup = new THREE.Group(); scene.add(risersGroup);
  applyBackground();
  setupLights(5);
}

function polygonBoundsM(zones) {
  var minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  (zones || []).forEach(function (z) {
    (z.polygon || []).forEach(function (p) {
      var x = toM(p.x), zc = toM(p.y);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (zc < minZ) minZ = zc; if (zc > maxZ) maxZ = zc;
    });
  });
  if (!isFinite(minX)) return { cx: 0, cz: 0, span: 5 };
  return {
    cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2,
    span: Math.max(1, Math.hypot(maxX - minX, maxZ - minZ))
  };
}

function rebuildScene(data) {
  ensureScene();
  disposeGroupChildren(wallsGroup);
  disposeGroupChildren(floorGroup);
  disposeGroupChildren(ceilingGroup);
  disposeGroupChildren(risersGroup);

  var zones = data.zones || [];
  var resolvedCuts = data.resolvedCuts || [];
  var walls = data.walls || [];
  var openings = data.openings || [];
  var profiles = data.wallHeightProfiles || {};

  zones.forEach(function (z) {
    var floorMesh = buildFlatPolygonMesh(z.polygon, 0, floorMaterial);
    if (floorMesh) { floorMesh.receiveShadow = true; floorGroup.add(floorMesh); }
    var ceilMesh = buildFlatPolygonMesh(z.polygon, toM(z.height), ceilingMaterial);
    if (ceilMesh) ceilingGroup.add(ceilMesh);
  });

  walls.forEach(function (w) {
    var wallOpenings = openings.filter(function (o) { return o.wallId === w.id; });
    var mesh = buildWallMesh(w, profiles[w.id], wallOpenings, wallMaterial);
    if (mesh) wallsGroup.add(mesh);
  });

  resolvedCuts.forEach(function (rc) {
    if (!rc.zoneA || !rc.zoneB || rc.zoneA.height === rc.zoneB.height) return;
    var bottom = Math.min(rc.zoneA.height, rc.zoneB.height);
    var top = Math.max(rc.zoneA.height, rc.zoneB.height);
    var geo = buildBoxSegment(rc.p1.x, rc.p1.y, rc.p2.x, rc.p2.y, 20, toM(bottom), toM(top));
    if (geo) risersGroup.add(new THREE.Mesh(geo, riserMaterial));
  });

  var bounds = polygonBoundsM(zones);
  fitSunToRoom(bounds.span);

  if (!framedOnce && camera && controls) {
    framedOnce = true;
    controls.target.set(bounds.cx, 1.1, bounds.cz);
    camera.position.set(
      bounds.cx + bounds.span * 0.9,
      Math.max(2.2, bounds.span * 0.7),
      bounds.cz + bounds.span * 0.9
    );
    controls.update();
  }
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

function animate() {
  rafId = requestAnimationFrame(animate);
  if (controls) controls.update();
  if (renderer && scene && camera) renderer.render(scene, camera);
}

function onResize() {
  if (!mountEl || !renderer || !camera) return;
  var w = mountEl.clientWidth || 1, h = mountEl.clientHeight || 1;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

function mount(el) {
  if (mountEl === el && renderer) return Promise.resolve();
  if (mountEl) unmount();
  mountEl = el;
  ensureScene();

  camera = new THREE.PerspectiveCamera(50, (el.clientWidth || 1) / (el.clientHeight || 1), 0.05, 500);
  camera.position.set(6, 4, 6);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.shadowMap.enabled = true;
  // PCFSoftShadowMap triggers a runtime deprecation warning in current
  // Three.js (the constant still exists but the renderer silently downgrades
  // it to PCFShadowMap, confirmed live) - VSMShadowMap gives genuinely soft,
  // blurred shadow edges without that warning.
  renderer.shadowMap.type = THREE.VSMShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  // Do NOT clear el.innerHTML here - #stage3d already carries its own
  // static controls markup (the "Toon plafond" checkbox + reset-view
  // button, see index.html), and wiping it out on every mount silently
  // deleted them (confirmed live - the checkbox stopped existing after the
  // first mount). unmount() already removes our own canvas cleanly, so by
  // the time mount() runs again there's nothing of ours left to clear.
  el.prepend(renderer.domElement);
  renderer.domElement.addEventListener("webglcontextlost", function (e) {
    e.preventDefault();
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  });
  renderer.domElement.addEventListener("webglcontextrestored", function () {
    if (lastData) rebuildScene(lastData);
    if (!rafId) animate();
  });

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 0.5;

  onResize();
  if (window.ResizeObserver) {
    resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(el);
  } else {
    window.addEventListener("resize", onResize);
  }

  if (darkModeQuery && darkModeQuery.addEventListener) {
    darkModeQuery.addEventListener("change", function () {
      applyBackground();
      if (lastData) rebuildScene(lastData);
    });
  }

  framedOnce = false;
  if (lastData) rebuildScene(lastData);
  animate();
  return Promise.resolve();
}

function unmount() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
  else window.removeEventListener("resize", onResize);
  if (wallsGroup) disposeGroupChildren(wallsGroup);
  if (floorGroup) disposeGroupChildren(floorGroup);
  if (ceilingGroup) disposeGroupChildren(ceilingGroup);
  if (risersGroup) disposeGroupChildren(risersGroup);
  if (controls) { controls.dispose(); controls = null; }
  if (renderer) {
    renderer.dispose();
    if (renderer.domElement && renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    renderer = null;
  }
  scene = null;
  camera = null;
  sunLight = null;
  mountEl = null;
  framedOnce = false;
}

function isActive() {
  return !!mountEl;
}

function sync(data) {
  pendingSyncData = data;
  if (syncRafScheduled) return;
  syncRafScheduled = true;
  requestAnimationFrame(function () {
    syncRafScheduled = false;
    lastData = pendingSyncData;
    if (mountEl) rebuildScene(lastData);
  });
}

function setShowCeiling(v) {
  showCeiling = !!v;
  if (ceilingGroup) ceilingGroup.visible = showCeiling;
}

function resetView() {
  if (!lastData || !controls || !camera) return;
  var bounds = polygonBoundsM(lastData.zones || []);
  controls.target.set(bounds.cx, 1.1, bounds.cz);
  camera.position.set(
    bounds.cx + bounds.span * 0.9,
    Math.max(2.2, bounds.span * 0.7),
    bounds.cz + bounds.span * 0.9
  );
  controls.update();
}

window.Floorplan3D = {
  mount: mount,
  unmount: unmount,
  sync: sync,
  isActive: isActive,
  setShowCeiling: setShowCeiling,
  resetView: resetView
};
