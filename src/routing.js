import { Line, SegmentGrid, angleDiff, bearing, distance, projectOnSegment, simplify } from './geo.js';
import { classify, describe, iconFor, overpass } from './traffic.js';

// Driving routes from the public OSRM servers (free, no key), plus what's on the
// way — traffic lights, signs, speed limits — from OpenStreetMap via Overpass.

const OSRM = ['https://router.project-osrm.org', 'https://routing.openstreetmap.de/routed-car'];

// Things that sit on the road itself are vertices of the route; anything further
// than this is on a crossing street. Signs and cameras stand by the roadside.
const ON_ROAD_M = 4;
const ROADSIDE_M = 25;
const ROADSIDE = new Set(['sign', 'camera']);

export class NoRouteError extends Error {}

export function formatDistance(m) {
  if (m >= 1000) return `${(m / 1000).toFixed(m >= 10000 ? 0 : 1).replace('.', ',')} km`;
  if (m >= 100) return `${Math.round(m / 10) * 10} m`;
  return `${Math.max(0, Math.round(m / 5) * 5)} m`;
}

// ---------- Maneuver icons (inline SVG, colored with currentColor) ----------

const ANGLE = {
  straight: 0,
  'slight right': 45,
  right: 90,
  'sharp right': 135,
  'slight left': -45,
  left: -90,
  'sharp left': -135,
};
const pt = (x, y) => `${x.toFixed(1)} ${y.toFixed(1)}`;

function arrowIcon(deg, roundabout) {
  const r = (deg * Math.PI) / 180;
  const ux = Math.sin(r);
  const uy = -Math.cos(r);
  const head = (ex, ey) => {
    const tip = pt(ex + ux * 8, ey + uy * 8);
    return `<path d="M${tip} L${pt(ex - uy * 7, ey + ux * 7)} L${pt(ex + uy * 7, ey - ux * 7)}Z" fill="currentColor"/>`;
  };
  const line = 'fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"';

  if (roundabout) {
    const sx = 24 + ux * 8;
    const sy = 22 + uy * 8;
    const ex = sx + ux * 5;
    const ey = sy + uy * 5;
    return `<svg viewBox="0 0 48 48"><circle cx="24" cy="22" r="8" fill="none" stroke="currentColor" stroke-width="4"/>
      <path d="M24 46V30" ${line}/><path d="M${pt(sx, sy)} L${pt(ex, ey)}" ${line}/>${head(ex, ey)}</svg>`;
  }
  const ex = 24 + ux * 13;
  const ey = 26 + uy * 13;
  return `<svg viewBox="0 0 48 48"><path d="M24 46V26 L${pt(ex, ey)}" ${line}/>${head(ex, ey)}</svg>`;
}

const UTURN_ICON = `<svg viewBox="0 0 48 48"><path d="M32 46V20a8 8 0 0 0-16 0v10" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/><path d="M16 42 L8.5 30 L23.5 30Z" fill="currentColor"/></svg>`;

const FLAG_ICON = (() => {
  let squares = '';
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      if ((row + col) % 2 === 0) squares += `<rect x="${14 + col * 6}" y="${6 + row * 6}" width="6" height="6"/>`;
    }
  }
  return `<svg viewBox="0 0 48 48"><path d="M12 45V5" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>
    <rect x="14" y="6" width="24" height="18" fill="none" stroke="currentColor" stroke-width="1.5"/><g fill="currentColor">${squares}</g></svg>`;
})();

export function maneuverIcon({ type, modifier }) {
  if (type === 'arrive') return FLAG_ICON;
  if (modifier === 'uturn') return UTURN_ICON;
  const roundabout = ['roundabout', 'rotary', 'roundabout turn', 'exit roundabout', 'exit rotary'].includes(type);
  return arrowIcon(ANGLE[modifier] ?? 0, roundabout);
}

// How much to slow down before a maneuver (used by the simulator).
export function turnSpeed({ type, modifier }) {
  if (type === 'arrive' || type === 'depart') return Infinity;
  if (['roundabout', 'rotary', 'roundabout turn'].includes(type)) return 7;
  if (!modifier || modifier === 'straight') return Infinity;
  if (modifier.startsWith('slight')) return 11;
  return modifier === 'uturn' ? 4 : 6.5;
}

// ---------- Route ----------

export const ROUTE_MODES = [
  { id: 'fastest', label: 'Más rápida' },
  { id: 'no-lights', label: 'Sin semáforos' },
  { id: 'fast', label: 'Alta velocidad' },
  { id: 'slow', label: 'Baja velocidad' },
];

// Valhalla (FOSSGIS, free, no key) can be told how to drive: these two shape
// the "high speed" and "low speed" routes.
const VALHALLA = 'https://valhalla1.openstreetmap.de/route';
const FAST_COSTING = { use_highways: 1 };
const SLOW_COSTING = { use_highways: 0, top_speed: 60 };

// How much slower than the quickest option a preference may make the trip.
const MAX_DETOUR = 1.4;
const MAX_DETOUR_FOR_LIGHTS = 1.6;

async function osrmRoutes(from, to, signal, alternatives = false) {
  const coords = [from, to].map(([lng, lat]) => `${lng.toFixed(6)},${lat.toFixed(6)}`).join(';');
  const path =
    `/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true&annotations=duration,speed` +
    (alternatives ? '&alternatives=3' : '');
  let lastError;
  for (const base of OSRM) {
    try {
      const res = await fetch(base + path, { signal });
      const data = await res.json();
      if (data.code === 'NoRoute' || data.code === 'NoSegment') {
        throw new NoRouteError('No hay ruta en coche hasta ese punto.');
      }
      if (!res.ok || data.code !== 'Ok') throw new Error(data.message || `OSRM ${res.status}`);
      return data.routes.map(buildRoute);
    } catch (err) {
      if (err.name === 'AbortError' || err instanceof NoRouteError) throw err;
      console.warn('OSRM:', err.message);
      lastError = err;
    }
  }
  throw lastError;
}

async function valhallaRoutes(from, to, costing, signal) {
  const res = await fetch(VALHALLA, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      locations: [from, to].map(([lon, lat]) => ({ lat, lon })),
      costing: 'auto',
      costing_options: { auto: costing },
      format: 'osrm',
      shape_format: 'geojson',
      alternates: 2,
      banner_instructions: false,
    }),
  });
  const data = await res.json();
  if (!res.ok || data.code !== 'Ok') throw new Error(data.error || `Valhalla ${res.status}`);
  return data.routes.map(fromValhalla);
}

// Valhalla answers in OSRM's format but without per-segment timings: rebuild
// them by spreading each step's time over its length.
function fromValhalla(route) {
  const coords = [];
  const duration = [];
  for (const step of route.legs[0].steps) {
    const g = step.geometry.coordinates;
    const lengths = g.slice(1).map((p, k) => distance(g[k], p));
    const stepLength = lengths.reduce((a, b) => a + b, 0);
    lengths.forEach((d) => duration.push(stepLength ? (step.duration * d) / stepLength : 0));
    // Steps share their joining point.
    if (coords.length) duration.splice(duration.length - lengths.length, 0, 0);
    coords.push(...g);
  }
  const line = new Line(coords);
  const speed = duration.map((t, i) => (t ? (line.cum[i + 1] - line.cum[i]) / t : 0));
  return buildRoute({ ...route, geometry: { coordinates: coords }, legs: [{ ...route.legs[0], annotation: { duration, speed } }] });
}

const avgSpeed = (route) => route.line.length / route.duration;

// Among the options not much slower than the quickest, the one scoring lowest.
function pick(routes, score) {
  const quickest = Math.min(...routes.map((r) => r.duration));
  return routes.filter((r) => r.duration <= quickest * MAX_DETOUR).sort((a, b) => score(a) - score(b))[0];
}

// Two engines often find the same road: keep one of each.
function distinct(routes) {
  const kept = [];
  for (const route of routes) {
    const mid = route.line.pointAt(route.line.length / 2);
    const same = kept.some(
      (k) => Math.abs(k.line.length - route.line.length) < route.line.length * 0.02 && distance(k.line.pointAt(k.line.length / 2), mid) < 60,
    );
    if (!same) kept.push(route);
  }
  return kept;
}

// The route for a preference. For "no lights" it also returns the candidates,
// which need counting before the best one is known.
export async function findRoute(from, to, mode, signal) {
  if (mode === 'fast' || mode === 'slow') {
    let routes;
    try {
      routes = await valhallaRoutes(from, to, mode === 'fast' ? FAST_COSTING : SLOW_COSTING, signal);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      console.warn('Valhalla:', err.message);
      routes = await osrmRoutes(from, to, signal, true);
    }
    // Fast: the briskest average speed. Slow: the calmest.
    return { route: pick(routes, (r) => (mode === 'fast' ? -avgSpeed(r) : avgSpeed(r))) };
  }

  if (mode === 'no-lights') {
    const results = await Promise.allSettled([
      osrmRoutes(from, to, signal, true),
      valhallaRoutes(from, to, FAST_COSTING, signal),
      valhallaRoutes(from, to, SLOW_COSTING, signal),
    ]);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const routes = distinct(results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])));
    if (!routes.length) throw results.find((r) => r.reason instanceof NoRouteError)?.reason ?? results[0].reason;
    routes.sort((a, b) => a.duration - b.duration);
    const candidates = routes.filter((r) => r.duration <= routes[0].duration * MAX_DETOUR_FOR_LIGHTS).slice(0, 6);
    return { route: candidates[0], candidates };
  }

  return { route: (await osrmRoutes(from, to, signal))[0] };
}

// Traffic lights on each route (pedestrian ones too), in one light Overpass
// query that only returns counts.
export async function countLights(routes) {
  const query = routes
    .map((route) => {
      const path = simplify(route.line.coords, 4)
        .map(([lng, lat]) => `${lat.toFixed(6)},${lng.toFixed(6)}`)
        .join(',');
      return `node(around:8,${path})[~"^(highway|crossing)$"~"^traffic_signals$"];out count;`;
    })
    .join('\n');
  const data = await overpass(`[out:json][timeout:60];\n${query}`);
  return data.elements.filter((e) => e.type === 'count').map((e) => Number(e.tags.nodes));
}

// Fewest lights wins; between equals, the quicker one.
export function fewestLights(routes, counts) {
  let best = 0;
  routes.forEach((route, i) => {
    if (counts[i] < counts[best] || (counts[i] === counts[best] && route.duration < routes[best].duration)) best = i;
  });
  return best;
}

function buildRoute(osrm) {
  const leg = osrm.legs[0];
  const line = new Line(osrm.geometry.coordinates);
  const n = line.coords.length;
  const durations = leg.annotation.duration;
  // Seconds from the start of each segment to the destination.
  const durationFrom = new Float64Array(n);
  for (let i = n - 2; i >= 0; i--) durationFrom[i] = durationFrom[i + 1] + durations[i];

  let from = 0;
  const steps = leg.steps.map((step) => {
    const hit = line.project(step.maneuver.location, from);
    from = hit.index;
    return {
      along: step.maneuver.type === 'arrive' ? line.length : hit.along,
      type: step.maneuver.type,
      modifier: step.maneuver.modifier,
    };
  });

  return {
    line,
    steps,
    durations,
    durationFrom,
    speeds: leg.annotation.speed, // m/s per segment, OSRM's estimate
    limits: null, // km/h per segment, once known
    items: [], // traffic lights, signs… sorted by distance along the route
    duration: osrm.duration,
    grid: segmentGrid(line),
  };
}

function segmentGrid(line) {
  const grid = new SegmentGrid();
  for (let i = 0; i < line.coords.length - 1; i++) grid.add(line.coords[i], line.coords[i + 1], i);
  return grid;
}

export function remainingSeconds(route, along) {
  const i = route.line.segmentAt(along);
  const len = route.line.cum[i + 1] - route.line.cum[i];
  const done = len ? Math.min(1, (along - route.line.cum[i]) / len) : 0;
  return route.durations[i] * (1 - done) + route.durationFrom[i + 1];
}

// ---------- What's on the way ----------

// One Overpass query: every traffic node within 25 m of the route, plus the
// roads near it (for speed limits and one-way-only signals).
export async function loadRouteDetails(route) {
  const path = simplify(route.line.coords, 2)
    .map(([lng, lat]) => `${lat.toFixed(6)},${lng.toFixed(6)}`)
    .join(',');
  const data = await overpass(`[out:json][timeout:90];
node(around:${ROADSIDE_M},${path})->.near;
(
  node.near[highway~"^(traffic_signals|stop|give_way|crossing|speed_camera)$"];
  node.near[traffic_calming];
  node.near[railway=level_crossing];
  node.near[traffic_sign];
);
out qt;
way(bn.near)[highway];
out tags geom qt;`);

  return {
    nodes: data.elements.filter((e) => e.type === 'node').map(({ id, lat, lon, tags }) => ({ id, lat, lon, tags })),
    ways: data.elements.filter((e) => e.type === 'way' && e.geometry),
  };
}

function parseMaxspeed(value) {
  if (!value) return null;
  if (/zone:?30|zone30/i.test(value)) return 30;
  if (/:urban/i.test(value)) return 50;
  if (/:rural/i.test(value)) return 90;
  if (/:motorway/i.test(value)) return 120;
  const n = parseFloat(value);
  if (!(n > 0)) return null;
  return /mph/.test(value) ? Math.round(n * 1.609) : n;
}

// For each route segment, the road it runs along and whether we drive it in the
// road's drawing direction. Matched by shape, not by node ids.
function matchWays(route, ways) {
  const grid = new SegmentGrid();
  for (const way of ways) {
    const g = way.geometry.map(({ lon, lat }) => [lon, lat]);
    for (let k = 0; k < g.length - 1; k++) grid.add(g[k], g[k + 1], way);
  }
  const { coords } = route.line;
  const matches = new Array(coords.length - 1).fill(null);
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const heading = bearing(a, b);
    let best = null;
    for (const seg of grid.near(mid)) {
      const turn = Math.abs(angleDiff(heading, bearing(seg.a, seg.b)));
      if (turn > 35 && turn < 145) continue; // a crossing street
      const { dist } = projectOnSegment(mid, seg.a, seg.b);
      if (dist < 4 && (!best || dist < best.dist)) best = { dist, way: seg.value, forward: turn <= 35 };
    }
    matches[i] = best;
  }
  return matches;
}

function speedLimits(matches) {
  return matches.map((m) => {
    if (!m) return null;
    const t = m.way.tags;
    return parseMaxspeed(m.forward ? t['maxspeed:forward'] : t['maxspeed:backward']) ?? parseMaxspeed(t.maxspeed);
  });
}

// Does a sign/light tagged for one direction face the way we're going?
function facesUs(tags, match) {
  const dir = tags['traffic_signals:direction'] ?? tags.direction;
  if (!match || (dir !== 'forward' && dir !== 'backward')) return true;
  return (dir === 'forward') === match.forward;
}

// Put traffic nodes on the route: distance along it, in driving order.
export function matchItems(route, nodes, ways) {
  const matches = ways ? matchWays(route, ways) : null;
  if (matches) route.limits = speedLimits(matches);

  const { line } = route;
  const items = [];
  for (const node of nodes) {
    const cat = classify(node.tags ?? {});
    if (!cat) continue;
    const p = [node.lon, node.lat];
    let best = { dist: Infinity };
    for (const seg of route.grid.near(p)) {
      const { t, dist } = projectOnSegment(p, seg.a, seg.b);
      if (dist < best.dist) best = { dist, index: seg.value, along: line.cum[seg.value] + t * distance(seg.a, seg.b) };
    }
    if (best.dist > (ROADSIDE.has(cat) ? ROADSIDE_M : ON_ROAD_M)) continue;
    if (!facesUs(node.tags, matches?.[best.index])) continue;

    const { title } = describe(cat, node.tags);
    items.push({ id: node.id, cat, tags: node.tags, along: best.along, title, icon: iconFor(cat, node.tags) });
  }

  items.sort((a, b) => a.along - b.along);
  // One crossing can be mapped as several nodes (one per lane); keep the first.
  route.items = items.filter(
    (item, i) => !items.slice(Math.max(0, i - 3), i).some((prev) => prev.cat === item.cat && item.along - prev.along < 15),
  );
  return route.items;
}
