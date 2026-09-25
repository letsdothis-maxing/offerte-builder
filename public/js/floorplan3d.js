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
//                 wallHeightProfiles, wallSlants }, all in the SAME mm
//                 world-space coordinates index.html's own 2D state uses.
//                 wallHeightProfiles is { [wallId]: computeWallHeightProfile()
//                 result }, precomputed by the caller so this module never
//                 has to re-derive wall-height-vs-zone logic - see the
//                 index.html call site for why (keeps 2D/3D wall heights
//                 byte-for-byte identical by construction, not by
//                 coincidence). wallSlants is { [wallId]: {widthMm,
//                 maxHeightMm} } for any wall with a sloped ceiling -
//                 combined per zone the same MIN-of-every-slanted-wall way
//                 index.html's own ceilingHeightAt does (a second copy of
//                 that small algorithm, not a shared import, since this
//                 module is intentionally its own ES module).
//   isActive()  - whether the 3D view is the one currently visible, so the
//                 caller can skip building wallHeightProfiles/calling
//                 sync() at all while the user is only looking at 2D.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

function toM(mm) { return mm / 1000; }

var renderer = null, scene = null, camera = null, controls = null;
var wallsGroup, floorGroup, ceilingGroup, risersGroup;
var groundMesh = null;
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
// Per-wall slanted ceilings (state.wallSlants, from index.html)
// ---------------------------------------------------------------------

function pointInPolygon2D(x, y, polygon) {
  var inside = false;
  for (var i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    var xi = polygon[i].x, yi = polygon[i].y;
    var xj = polygon[j].x, yj = polygon[j].y;
    var hit = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
    if (hit) inside = !inside;
  }
  return inside;
}

function polygonCentroidMm(polygon) {
  var sx = 0, sy = 0;
  polygon.forEach(function (p) { sx += p.x; sy += p.y; });
  return { x: sx / polygon.length, y: sy / polygon.length };
}

// Same algorithm as index.html's own perpendicularDistanceIntoRoom -
// signed perpendicular distance from (px,py) to wall's infinite line,
// positive moving into the room (resolved against the zone centroid so
// it works for a wall at any angle).
function perpendicularDistanceIntoRoom(wall, px, py, centroid) {
  var dx = wall.x2 - wall.x1, dy = wall.y2 - wall.y1;
  var len = Math.hypot(dx, dy) || 1;
  var nx = -dy / len, ny = dx / len;
  var mx = (wall.x1 + wall.x2) / 2, my = (wall.y1 + wall.y2) / 2;
  if (nx * (centroid.x - mx) + ny * (centroid.y - my) < 0) { nx = -nx; ny = -ny; }
  return (px - wall.x1) * nx + (py - wall.y1) * ny;
}

// Same MIN-of-every-slanted-wall's-own-constraint combination as
// index.html's ceilingHeightAt - see that function's doc comment for why
// MIN is what produces a shared ridge/hip, or a flat strip between two
// slopes that don't reach each other.
function ceilingHeightAtMm(zone, px, py, wallsById, wallSlants, centroid) {
  var h = null;
  zone.wallIds.forEach(function (wid) {
    var slant = wallSlants[wid];
    if (!slant) return;
    var wall = wallsById[wid];
    if (!wall) return;
    var d = perpendicularDistanceIntoRoom(wall, px, py, centroid);
    var t = Math.max(0, Math.min(1, d / slant.widthMm));
    var localH = zone.height + (slant.maxHeightMm - zone.height) * t;
    if (h === null || localH < h) h = localH;
  });
  return h === null ? zone.height : h;
}

var CEILING_GRID_MM = 300;

// Builds the ceiling as two parallel tessellated surfaces (bottom at the
// real height field, top offset by thicknessM) instead of one infinitely
// thin plane - a fine regular grid, sampled at CEILING_GRID_MM and
// clipped to the zone's own polygon, since the real surface can be
// creased (a ridge/hip where two slanted walls meet) rather than one flat
// plane once more than one wall in the zone slopes. Cells with any corner
// outside the polygon are dropped rather than clipped, which loses a
// sliver of coverage right at a non-rectangular edge - an accepted
// simplification given this app's walls are themselves 90°-snapped, so
// real rooms are rectangular (or rectilinear) in the first place. Pushes
// its meshes straight into `group` (not a sub-group) so the caller's
// existing disposeGroupChildren(ceilingGroup) - which only disposes
// direct children - keeps working without also having to recurse.
function buildCeilingSurfaces(zone, wallsById, wallSlants, thicknessM, material, group) {
  var polygon = zone.polygon;
  if (!polygon || polygon.length < 3) return;
  var hasSlant = zone.wallIds.some(function (wid) { return !!wallSlants[wid]; });
  if (!hasSlant) {
    var flatBottom = buildFlatPolygonMesh(polygon, toM(zone.height), material);
    var flatTop = buildFlatPolygonMesh(polygon, toM(zone.height) + thicknessM, material);
    if (flatBottom) { flatBottom.castShadow = true; group.add(flatBottom); }
    if (flatTop) { flatTop.castShadow = true; group.add(flatTop); }
    return;
  }
  var centroid = polygonCentroidMm(polygon);
  var xs = polygon.map(function (p) { return p.x; }), ys = polygon.map(function (p) { return p.y; });
  var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
  var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
  var cols = Math.max(1, Math.ceil((maxX - minX) / CEILING_GRID_MM));
  var rows = Math.max(1, Math.ceil((maxY - minY) / CEILING_GRID_MM));
  var heights = [];
  for (var r = 0; r <= rows; r++) {
    var rowH = [];
    var py = minY + (r * (maxY - minY)) / rows;
    for (var c = 0; c <= cols; c++) {
      var px = minX + (c * (maxX - minX)) / cols;
      rowH.push(pointInPolygon2D(px, py, polygon) ? ceilingHeightAtMm(zone, px, py, wallsById, wallSlants, centroid) : null);
    }
    heights.push(rowH);
  }
  function buildSurface(offsetM) {
    var positions = [], indices = [], indexGrid = [];
    for (var r2 = 0; r2 <= rows; r2++) {
      var rowIdx = [];
      var py2 = minY + (r2 * (maxY - minY)) / rows;
      for (var c2 = 0; c2 <= cols; c2++) {
        var hMm = heights[r2][c2];
        if (hMm === null) { rowIdx.push(-1); continue; }
        var px2 = minX + (c2 * (maxX - minX)) / cols;
        rowIdx.push(positions.length / 3);
        positions.push(toM(px2), toM(hMm) + offsetM, toM(py2));
      }
      indexGrid.push(rowIdx);
    }
    for (var r3 = 0; r3 < rows; r3++) {
      for (var c3 = 0; c3 < cols; c3++) {
        var a = indexGrid[r3][c3], b = indexGrid[r3][c3 + 1], cc = indexGrid[r3 + 1][c3], d = indexGrid[r3 + 1][c3 + 1];
        if (a < 0 || b < 0 || cc < 0 || d < 0) continue;
        indices.push(a, cc, b);
        indices.push(b, cc, d);
      }
    }
    if (!indices.length) return null;
    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, material);
  }
  var bottom = buildSurface(0);
  var top = buildSurface(thicknessM);
  if (bottom) { bottom.castShadow = true; group.add(bottom); }
  if (top) { top.castShadow = true; group.add(top); }
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
var wallMaterial = new THREE.MeshStandardMaterial({ color: 0xfafaf8, roughness: 0.9, metalness: 0 });
var floorMaterial = new THREE.MeshStandardMaterial({ color: 0xf8f7f4, roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
var ceilingMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
var riserMaterial = new THREE.MeshStandardMaterial({ color: 0xe9e5f5, roughness: 0.85, metalness: 0 });
// Same color as the scene background (kept in sync in applyBackground) -
// no visible ground/sky seam, it's just there to catch shadows.
var groundMaterial = new THREE.MeshStandardMaterial({ color: 0xfafbfc, roughness: 1, metalness: 0 });

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
  var bg = dark ? 0x11151c : 0xfafbfc;
  scene.background = new THREE.Color(bg);
  groundMaterial.color.set(bg);
}

// A large flat plane standing in for "infinite ground" - the room's own
// per-zone floor (buildFlatPolygonMesh, added in rebuildScene) only covers
// its exact polygon, so with nothing beyond a room's walls the sun's
// shadows just vanished past the wall edges (nothing there to catch them)
// instead of falling naturally outside the footprint the way a real
// building's surroundings would show them. Sits a hair below y=0 so it
// never z-fights with the actual room floor drawn right on top of it.
// Fixed large size (not tied to room bounds) since it only ever needs to
// be bigger than whatever's plausibly visible in frame, not truly infinite.
function buildGround() {
  var geo = new THREE.PlaneGeometry(400, 400);
  geo.rotateX(-Math.PI / 2);
  var mesh = new THREE.Mesh(geo, groundMaterial);
  mesh.position.y = -0.01;
  mesh.receiveShadow = true;
  return mesh;
}

function ensureScene() {
  if (scene) return;
  scene = new THREE.Scene();
  groundMesh = buildGround(); scene.add(groundMesh);
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
  var wallSlants = data.wallSlants || {};
  var wallsById = {};
  walls.forEach(function (w) { wallsById[w.id] = w; });

  zones.forEach(function (z) {
    var floorMesh = buildFlatPolygonMesh(z.polygon, 0, floorMaterial);
    if (floorMesh) { floorMesh.receiveShadow = true; floorGroup.add(floorMesh); }
    // The ceiling always gets the same thickness as the walls holding it
    // up - the max thickness among this zone's own walls, so a project
    // with a genuinely uniform wall thickness (the normal case) just
    // reads as that value. castShadow on each surface so toggling "Toon
    // plafond" on actually blocks the sun from the room below (it didn't
    // - the sun passed straight through the ceiling plane onto the floor
    // regardless). ceilingGroup.visible already gates this correctly:
    // Three.js skips shadow casting for invisible objects, so with the
    // ceiling toggled off this is a no-op, same as today.
    var thicknessMm = null;
    z.wallIds.forEach(function (wid) {
      var w = wallsById[wid];
      if (w && (thicknessMm === null || w.thickness > thicknessMm)) thicknessMm = w.thickness;
    });
    if (thicknessMm === null) thicknessMm = 150;
    buildCeilingSurfaces(z, wallsById, wallSlants, toM(thicknessMm), ceilingMaterial, ceilingGroup);
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
  if (groundMesh) { groundMesh.geometry.dispose(); groundMesh = null; }
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
