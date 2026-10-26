import * as maplibregl from 'maplibre-gl';
import { SegmentGrid, angleDiff, bearing, distance, lerp, projectOnSegment } from './geo.js';
import { notify } from './notify.js';
import { settings } from './settings.js';

// Exploration, open-world game style: the area is split into sectors (one per
// municipality) and every piece of road you drive with GPS gets discovered.
// Discovered roads light up, each sector shows its percentage, and the shade
// over a sector lifts as you uncover it. For now, A Coruña and around; the
// data comes from scripts/build_sectors.py.

const DATA_URL = `${import.meta.env.BASE_URL}data/coruna.json`;
const STORAGE_KEY = 'maps-explore-coruna';
const REGION = { west: -8.62, south: 43.2, east: -8.15, north: 43.42 }; // only load the data around here

const MATCH_M = 15; // pass this close to a piece of road to discover it…
const MAX_TURN = 35; // …heading along it, not across it
const MAX_ACCURACY_M = 40; // ignore vaguer fixes
const MAX_GAP_M = 300; // fill in between fixes up to this far apart
const STEP_M = 8;
const STREET_NOTICE_MS = 6000; // at most one "road discovered" notice this often
const MILESTONES = [10, 25, 50, 75, 100];
const SHADE = 0.45; // how dark an untouched sector is

const PINK = '#ff2d8a';
const SOURCES = { sectors: 'explore-sectors', roads: 'explore-roads', labels: 'explore-label-points' };
const LAYERS = ['explore-shade', 'explore-borders', 'explore-roads', 'explore-labels'];
export const EXPLORE_LABELS = 'explore-labels';

const ROAD_ICON =
  '<svg viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M9.5 3h2l-.5 4h2l-.5-4h2l3 18h-4.4l-.3-3h-1.6l-.3 3H6.5z"/></svg>';
const FLAG_ICON = '<svg viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M6 2.5h2v1h11l-2.5 4.5L19 12.5H8V21.5H6z"/></svg>';

const inRegion = (lng, lat) => lng > REGION.west && lng < REGION.east && lat > REGION.south && lat < REGION.north;

// Google encoded polyline (precision 5) → [[lng, lat], …]
function decode(str) {
  const coords = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < str.length) {
    for (let axis = 0; axis < 2; axis++) {
      let result = 0;
      let shift = 0;
      let b;
      do {
        b = str.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lng += delta;
    }
    coords.push([lng / 1e5, lat / 1e5]);
  }
  return coords;
}

const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export function formatPercent(value) {
  if (value >= 100) return '100%';
  return value < 10 ? `${(Math.floor(value * 10) / 10).toFixed(1).replace('.', ',')}%` : `${Math.floor(value)}%`;
}

export function setupExplorer(map) {
  let data = null; // { sectors, names, pieces }
  let loading = null;
  let found = null; // one bit per piece of road
  let grid = null;
  let stats = []; // per sector: { found: metres, streets: Set }
  let last = null; // previous GPS fix: { p, time }
  let driving = false;
  let lastStreetNotice = 0;
  let saveTimer;
  let drawTimer;
  const listeners = new Set();
  const mapReady = map.loaded() ? Promise.resolve() : new Promise((resolve) => map.once('load', resolve));

  // ---------- Data ----------

  function load() {
    loading ??= fetch(DATA_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(async (raw) => {
        await mapReady; // layers can only go on a loaded map
        prepare(raw);
      })
      .catch((err) => {
        console.warn('Exploration data:', err.message);
        loading = null; // try again next time
      });
    return loading;
  }

  function prepare(raw) {
    const pieces = raw.chunks.map(([sector, name, length, line]) => ({ sector, name, length, coords: decode(line) }));
    grid = new SegmentGrid();
    pieces.forEach((piece, i) => {
      for (let k = 0; k < piece.coords.length - 1; k++) grid.add(piece.coords[k], piece.coords[k + 1], i);
    });
    data = { ...raw, pieces };
    found = restore(raw.version, pieces.length);
    stats = raw.sectors.map(() => ({ found: 0, streets: new Set() }));
    pieces.forEach((piece, i) => {
      if (isFound(i)) count(piece);
    });
    addLayers();
    draw();
    listeners.forEach((fn) => fn());
  }

  function restore(version, n) {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved?.version === version) {
        const bytes = fromBase64(saved.found);
        if (bytes.length === Math.ceil(n / 8)) return bytes;
      }
    } catch {
      // Start fresh.
    }
    return new Uint8Array(Math.ceil(n / 8));
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: data.version, found: toBase64(found) }));
    } catch {
      // Progress stays for this visit only.
    }
  }

  const isFound = (i) => (found[i >> 3] >> (i & 7)) & 1;

  function count(piece) {
    const s = stats[piece.sector];
    s.found += piece.length;
    if (piece.name >= 0) s.streets.add(piece.name);
  }

  const percentOf = (i) => (data.sectors[i].length ? (stats[i].found / data.sectors[i].length) * 100 : 0);

  // ---------- Discovering ----------

  // A GPS fix. Pieces of road along the way from the previous fix get
  // discovered if you went along them (not just across them at a junction).
  function visit([lng, lat], accuracy = 0) {
    if (accuracy > MAX_ACCURACY_M) return;
    if (!inRegion(lng, lat)) {
      last = null;
      return;
    }
    if (!data) {
      load();
      return;
    }
    const p = [lng, lat];
    const now = Date.now();
    const prev = last && now - last.time < 15000 ? last.p : null;
    const gap = prev ? distance(prev, p) : 0;
    if (prev && gap < 3) return; // hardly moved: keep measuring from the earlier fix
    last = { p, time: now };
    if (!prev || gap > MAX_GAP_M) return;

    const heading = bearing(prev, p);
    const newly = [];
    for (let d = 0; d <= gap; d += STEP_M) {
      const q = lerp(prev, p, d / gap);
      for (const seg of grid.near(q)) {
        const i = seg.value;
        if (isFound(i)) continue;
        const turn = Math.abs(angleDiff(heading, bearing(seg.a, seg.b)));
        if (turn > MAX_TURN && turn < 180 - MAX_TURN) continue;
        if (projectOnSegment(q, seg.a, seg.b).dist > MATCH_M) continue;
        found[i >> 3] |= 1 << (i & 7);
        newly.push(i);
      }
    }
    if (newly.length) discovered(newly);
  }

  function discovered(indices) {
    const before = data.sectors.map((_, i) => percentOf(i));
    let newStreet = null;
    for (const i of indices) {
      const piece = data.pieces[i];
      const known = piece.name < 0 || stats[piece.sector].streets.has(piece.name);
      count(piece);
      if (!known) newStreet = piece;
    }

    const now = Date.now();
    if (newStreet && now - lastStreetNotice > STREET_NOTICE_MS) {
      lastStreetNotice = now;
      const s = stats[newStreet.sector];
      notify({
        kicker: `Carretera descubierta · ${s.streets.size}/${data.sectors[newStreet.sector].streets}`,
        title: data.names[newStreet.name],
        color: PINK,
        icon: ROAD_ICON,
      });
    }
    data.sectors.forEach((sector, i) => {
      const after = percentOf(i);
      const reached = MILESTONES.filter((m) => before[i] < m && after >= m).pop();
      if (reached) notify({ kicker: `Sector ${sector.name}`, title: `${reached}% descubierto`, color: PINK, icon: FLAG_ICON });
    });

    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 2000);
    if (!drawTimer) drawTimer = setTimeout(draw, 800);
    listeners.forEach((fn) => fn());
  }

  // ---------- Map ----------

  function addLayers() {
    if (map.getSource(SOURCES.sectors)) return;
    const empty = { type: 'FeatureCollection', features: [] };
    for (const id of Object.values(SOURCES)) map.addSource(id, { type: 'geojson', data: empty });
    const before = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
    map.addLayer(
      {
        id: 'explore-shade',
        type: 'fill',
        source: SOURCES.sectors,
        // The shade lifts as the sector gets uncovered.
        paint: { 'fill-color': '#000', 'fill-opacity': ['*', SHADE, ['-', 1, ['/', ['get', 'percent'], 100]]] },
      },
      before,
    );
    map.addLayer(
      {
        id: 'explore-borders',
        type: 'line',
        source: SOURCES.sectors,
        paint: { 'line-color': PINK, 'line-opacity': 0.55, 'line-width': 1.5, 'line-dasharray': [3, 2] },
      },
      before,
    );
    map.addLayer(
      {
        id: 'explore-roads',
        type: 'line',
        source: SOURCES.roads,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-opacity': 0.9,
          'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 11, 1.5, 18, 7],
        },
      },
      before,
    );
    map.addLayer({
      id: EXPLORE_LABELS,
      type: 'symbol',
      source: SOURCES.labels,
      layout: {
        'text-field': [
          'format',
          ['upcase', ['get', 'name']],
          { 'font-scale': 0.85 },
          '\n',
          {},
          ['get', 'percent'],
          { 'font-scale': 1.35, 'text-color': PINK },
        ],
        'text-font': ['Montserrat SemiBold', 'Open Sans Bold', 'Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 9, 11, 14, 17],
        'text-letter-spacing': 0.08,
        'text-line-height': 1.1,
        'text-allow-overlap': true,
      },
      paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0, 0, 0, 0.85)', 'text-halo-width': 2 },
    });
    applyVisibility();
  }

  function draw() {
    drawTimer = null;
    if (!data || !map.getSource(SOURCES.sectors)) return;
    map.getSource(SOURCES.sectors).setData({
      type: 'FeatureCollection',
      features: data.sectors.map((sector, i) => ({
        type: 'Feature',
        geometry: { type: 'MultiPolygon', coordinates: sector.rings.map((ring) => [ring]) },
        properties: { id: sector.id, percent: Math.min(100, percentOf(i)) },
      })),
    });
    map.getSource(SOURCES.labels).setData({
      type: 'FeatureCollection',
      features: data.sectors.map((sector, i) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: sector.label },
        properties: { index: i, name: sector.name, percent: formatPercent(percentOf(i)) },
      })),
    });
    const lines = [];
    data.pieces.forEach((piece, i) => {
      if (isFound(i)) lines.push(piece.coords);
    });
    map.getSource(SOURCES.roads).setData({ type: 'Feature', geometry: { type: 'MultiLineString', coordinates: lines }, properties: {} });
  }

  // Sectors are a browsing thing: while driving only the lit-up roads stay.
  function applyVisibility() {
    const show = settings.get('exploreMap');
    for (const id of LAYERS) {
      if (!map.getLayer(id)) continue;
      const visible = show && (id === 'explore-roads' || !driving);
      map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
  }

  settings.onChange((key) => {
    if (key === 'exploreMap') applyVisibility();
  });

  // Load the data once the map shows the region.
  function checkView() {
    if (data || loading || map.getZoom() < 8) return;
    const b = map.getBounds();
    const overlaps = b.getWest() < REGION.east && b.getEast() > REGION.west && b.getSouth() < REGION.north && b.getNorth() > REGION.south;
    if (overlaps) load();
  }
  map.on('moveend', checkView);
  mapReady.then(checkView);

  // ---------- Sector card ----------

  // Below the label, so the search bar never covers it.
  const card = new maplibregl.Popup({ anchor: 'top', offset: 18, maxWidth: '300px', className: 'sector-popup' });

  function openCard(i, lngLat) {
    const sector = data.sectors[i];
    const s = stats[i];
    const percent = percentOf(i);
    const box = document.createElement('div');
    box.className = 'sector-card';
    box.innerHTML = `
      <span class="sector-card__kicker">Sector</span>
      <strong></strong>
      <div class="sector-card__percent"></div>
      <i class="sector-card__bar"><i></i></i>
      <dl>
        <div><dt>Calles</dt><dd data-f="streets"></dd></div>
        <div><dt>Recorrido</dt><dd data-f="km"></dd></div>
      </dl>`;
    box.querySelector('strong').textContent = sector.name;
    box.querySelector('.sector-card__percent').textContent = formatPercent(percent);
    box.querySelector('.sector-card__bar i').style.width = `${Math.min(100, percent)}%`;
    box.querySelector('[data-f="streets"]').textContent = `${s.streets.size} / ${sector.streets}`;
    box.querySelector('[data-f="km"]').textContent = `${(s.found / 1000).toFixed(1).replace('.', ',')} / ${Math.round(sector.length / 1000)} km`;
    card.setLngLat(lngLat).setDOMContent(box).addTo(map);
  }

  map.on('click', EXPLORE_LABELS, (e) => openCard(e.features[0].properties.index, e.lngLat));
  map.on('mouseenter', EXPLORE_LABELS, () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', EXPLORE_LABELS, () => (map.getCanvas().style.cursor = ''));

  return {
    visit,
    load,
    setDriving(value) {
      driving = value;
      applyVisibility();
    },
    // Is there a sector label under this point? (Then a click opens its card, not a pin.)
    labelAt(point) {
      return Boolean(map.getLayer(EXPLORE_LABELS) && map.queryRenderedFeatures(point, { layers: [EXPLORE_LABELS] }).length);
    },
    progress() {
      if (!data) return null;
      return data.sectors.map((sector, i) => ({
        id: sector.id,
        name: sector.name,
        percent: percentOf(i),
        streets: stats[i].streets.size,
        totalStreets: sector.streets,
      }));
    },
    // Fly to a sector to see it whole.
    show(id) {
      const sector = data?.sectors.find((s) => s.id === id);
      if (!sector) return;
      const bounds = new maplibregl.LngLatBounds();
      for (const ring of sector.rings) for (const p of ring) bounds.extend(p);
      map.fitBounds(bounds, { padding: 60, duration: 1500 });
    },
    onChange(fn) {
      listeners.add(fn);
    },
  };
}
