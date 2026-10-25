import * as maplibregl from 'maplibre-gl';
import { settings } from './settings.js';
import { lngLatToTile } from './tiles.js';

// Traffic lights, signs and friends from OpenStreetMap, loaded through Overpass
// for whatever area you're looking at.

// Tried in order; the next one starts if the current fails or is slow to answer.
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const HEDGE_MS = 10000;
const MAX_PARALLEL = 2; // be nice to the public servers
const REQUEST_TIMEOUT_MS = 90000;
const RETRY_MS = 15000;

export const MIN_ZOOM = 15;
const TILE_Z = 14; // data is fetched and cached per z14 tile (~2 km across)
const MAX_TILES = 12;

const CACHE_NAME = 'maps-traffic-v1';
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
const STORAGE_KEY = 'maps-traffic-enabled';

const SOURCE = 'traffic';
export const TRAFFIC_LAYER = 'traffic-icons';

export const CATEGORIES = [
  { id: 'signals', label: 'Semáforos', icon: 'tr-signals' },
  { id: 'crossing', label: 'Pasos de peatones', icon: 'tr-crossing' },
  { id: 'stop', label: 'Stop', icon: 'tr-stop' },
  { id: 'give_way', label: 'Ceda el paso', icon: 'tr-give-way' },
  { id: 'sign', label: 'Otras señales', icon: 'tr-sign' },
  { id: 'camera', label: 'Radares', icon: 'tr-camera' },
  { id: 'calming', label: 'Reductores de velocidad', icon: 'tr-calming' },
  { id: 'rail', label: 'Pasos a nivel', icon: 'tr-rail' },
];

// Later categories are drawn on top when icons overlap.
const RANK = { crossing: 1, sign: 2, calming: 3, give_way: 4, stop: 5, rail: 6, signals: 7, camera: 8 };

// ---------- Classification ----------

const STOP_SIGN = /(^|[^a-z])stop([^a-z]|$)|ES:R2(?!\d)|DE:206/i;
const GIVE_WAY_SIGN = /give_way|ES:R1(?!\d)|DE:205/i;
const SPEED_SIGN = /maxspeed|ES:R301|DE:274/i;

function speedLimit(tags) {
  const sign = tags.traffic_sign ?? '';
  if (!SPEED_SIGN.test(sign) && tags.highway !== 'speed_camera') return null;
  const n = parseInt(tags.maxspeed, 10) || parseInt(sign.match(/\[(\d{2,3})\]/)?.[1], 10);
  return n > 0 && n < 200 ? n : null;
}

export function classify(tags) {
  const sign = tags.traffic_sign ?? '';
  if (tags.highway === 'speed_camera') return 'camera';
  if (tags.highway === 'traffic_signals') return 'signals';
  if (tags.highway === 'crossing' && tags.crossing === 'traffic_signals') return 'signals';
  if (tags.highway === 'stop' || STOP_SIGN.test(sign)) return 'stop';
  if (tags.highway === 'give_way' || GIVE_WAY_SIGN.test(sign)) return 'give_way';
  if (tags.railway === 'level_crossing') return 'rail';
  if (tags.highway === 'crossing') return 'crossing';
  if (tags.traffic_calming) return 'calming';
  if (sign) return 'sign';
  return null;
}

export function iconFor(cat, tags) {
  if (cat === 'sign') {
    const speed = speedLimit(tags);
    if (speed) return `tr-speed-${speed}`;
  }
  return CATEGORIES.find((c) => c.id === cat).icon;
}

// ---------- Popup text ----------

const CALMING = {
  bump: 'Badén',
  hump: 'Lomo de asno',
  table: 'Paso elevado',
  cushion: 'Cojín berlinés',
  chicane: 'Chicane',
  choker: 'Estrechamiento',
  island: 'Isleta',
  rumble_strip: 'Bandas sonoras',
  dip: 'Badén hundido',
};
const SIGNAL_TYPE = {
  blinker: 'Intermitente',
  ramp_meter: 'Regulador de acceso',
  emergency: 'Solo para emergencias',
  level_crossing: 'De paso a nivel',
};
const SIGN_NAMES = {
  no_entry: 'Dirección prohibida',
  'ES:R101': 'Entrada prohibida',
  'ES:R100': 'Circulación prohibida',
  'ES:R302': 'Giro a la derecha prohibido',
  'ES:R303': 'Giro a la izquierda prohibido',
  'ES:R305': 'Adelantamiento prohibido',
  'ES:R307': 'Parada y estacionamiento prohibidos',
  'ES:R308': 'Estacionamiento prohibido',
  'ES:S13': 'Paso para peatones',
  'ES:S28': 'Calle residencial',
  city_limit: 'Entrada en población',
  overtaking: 'Adelantamiento prohibido',
  hazard: 'Peligro',
};
const DIRECTION = { forward: 'en el sentido de la vía', backward: 'en sentido contrario a la vía' };

export function describe(cat, tags) {
  const lines = [];
  const yes = (k) => tags[k] === 'yes';
  const direction = DIRECTION[tags['traffic_signals:direction'] ?? tags.direction];
  let title;

  switch (cat) {
    case 'signals':
      title = tags.highway === 'crossing' ? 'Semáforo de peatones' : 'Semáforo';
      if (SIGNAL_TYPE[tags.traffic_signals]) lines.push(SIGNAL_TYPE[tags.traffic_signals]);
      if (direction) lines.push(`Orientado ${direction}`);
      if (yes('button_operated')) lines.push('Con pulsador');
      if (yes('traffic_signals:sound')) lines.push('Aviso sonoro');
      if (yes('traffic_signals:vibration')) lines.push('Vibración para invidentes');
      if (yes('traffic_signals:countdown')) lines.push('Cuenta atrás');
      break;
    case 'crossing':
      title = 'Paso de peatones';
      if (['marked', 'zebra', 'uncontrolled'].includes(tags.crossing) || tags.crossing_ref === 'zebra') {
        lines.push('Paso de cebra');
      } else if (tags.crossing === 'unmarked') {
        lines.push('Sin marcar');
      }
      if (yes('crossing:island')) lines.push('Con isleta central');
      if (['lowered', 'flush'].includes(tags.kerb)) lines.push('Bordillo rebajado');
      if (yes('tactile_paving')) lines.push('Pavimento táctil');
      break;
    case 'stop':
      title = 'Stop';
      if (tags.stop === 'all') lines.push('En todos los accesos');
      if (direction) lines.push(`Válido ${direction}`);
      break;
    case 'give_way':
      title = 'Ceda el paso';
      if (direction) lines.push(`Válido ${direction}`);
      break;
    case 'camera': {
      title = 'Radar de velocidad';
      const speed = speedLimit(tags);
      if (speed) lines.push(`Límite: ${speed} km/h`);
      if (direction) lines.push(`Controla ${direction}`);
      break;
    }
    case 'calming':
      title = CALMING[tags.traffic_calming] ?? 'Reductor de velocidad';
      break;
    case 'rail':
      title = 'Paso a nivel';
      if (tags['crossing:barrier'] === 'no') lines.push('Sin barreras');
      else if (tags['crossing:barrier']) lines.push('Con barreras');
      if (yes('crossing:light')) lines.push('Con luces');
      if (yes('crossing:bell')) lines.push('Con señal acústica');
      break;
    case 'sign': {
      const speed = speedLimit(tags);
      const known = tags.traffic_sign.split(/[;,]/).map((part) => SIGN_NAMES[part.trim().replace(/\[.*$/, '')]);
      title = speed ? `Límite de velocidad: ${speed} km/h` : (known.find(Boolean) ?? 'Señal de tráfico');
      break;
    }
  }
  if (tags.traffic_sign) lines.push(`Código de señal: ${tags.traffic_sign}`);
  if (tags.name) lines.unshift(tags.name);
  return { title, lines };
}

// ---------- Icons ----------

const ICON_SIZE = 40;
const RATIO = 2;
const RED = '#d32f2f';

function canvas(draw) {
  const c = document.createElement('canvas');
  c.width = c.height = ICON_SIZE * RATIO;
  const ctx = c.getContext('2d');
  ctx.scale(RATIO, RATIO);
  ctx.lineJoin = 'round';
  draw(ctx);
  return c;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function triangle(ctx, pointsDown) {
  ctx.beginPath();
  if (pointsDown) {
    ctx.moveTo(4, 7);
    ctx.lineTo(36, 7);
    ctx.lineTo(20, 35);
  } else {
    ctx.moveTo(20, 5);
    ctx.lineTo(36, 33);
    ctx.lineTo(4, 33);
  }
  ctx.closePath();
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.strokeStyle = RED;
  ctx.lineWidth = 4;
  ctx.stroke();
}

const DRAW = {
  'tr-signals': (ctx) => {
    roundRect(ctx, 11, 2, 18, 36, 5);
    ctx.fillStyle = '#151515';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ['#ff3b30', '#ffcc00', '#34c759'].forEach((color, i) => {
      ctx.beginPath();
      ctx.arc(20, 10 + i * 10, 4, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    });
  },
  'tr-crossing': (ctx) => {
    roundRect(ctx, 5, 5, 30, 30, 5);
    ctx.fillStyle = '#1565c0';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    for (let x = 10; x < 30; x += 6) ctx.fillRect(x, 11, 3.5, 18);
  },
  'tr-stop': (ctx) => {
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = Math.PI / 8 + (i * Math.PI) / 4;
      ctx.lineTo(20 + 17 * Math.cos(a), 20 + 17 * Math.sin(a));
    }
    ctx.closePath();
    ctx.fillStyle = RED;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px -apple-system, Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('STOP', 20, 20.5);
  },
  'tr-give-way': (ctx) => triangle(ctx, true),
  'tr-sign': (ctx) => {
    ctx.fillStyle = '#9aa0a6';
    ctx.fillRect(18.5, 22, 3, 16);
    ctx.beginPath();
    ctx.arc(20, 14, 11, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.strokeStyle = RED;
    ctx.lineWidth = 3.5;
    ctx.stroke();
  },
  'tr-camera': (ctx) => {
    roundRect(ctx, 4, 6, 32, 28, 6);
    ctx.fillStyle = '#f5a623';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#111';
    roundRect(ctx, 9, 14, 22, 14, 3);
    ctx.fill();
    ctx.fillRect(14, 11, 8, 4);
    ctx.beginPath();
    ctx.arc(20, 21, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = '#f5a623';
    ctx.fill();
  },
  'tr-calming': (ctx) => {
    triangle(ctx, false);
    ctx.beginPath();
    ctx.moveTo(10, 28);
    ctx.quadraticCurveTo(20, 15, 30, 28);
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 3;
    ctx.stroke();
  },
  'tr-rail': (ctx) => {
    ctx.lineCap = 'butt';
    for (const [width, color] of [
      [10, RED],
      [5, '#fff'],
    ]) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(7, 7);
      ctx.lineTo(33, 33);
      ctx.moveTo(33, 7);
      ctx.lineTo(7, 33);
      ctx.stroke();
    }
  },
};

function speedIcon(speed) {
  return canvas((ctx) => {
    ctx.beginPath();
    ctx.arc(20, 20, 16, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.strokeStyle = RED;
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.fillStyle = '#111';
    ctx.font = `bold ${speed >= 100 ? 12 : 15}px -apple-system, Helvetica, Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(speed), 20, 21);
  });
}

const iconUrls = new Map();

// PNG data URL of any traffic icon (including the speed-limit ones), for HTML.
export function iconDataUrl(id) {
  if (!iconUrls.has(id)) {
    const speed = id.match(/^tr-speed-(\d+)$/)?.[1];
    iconUrls.set(id, (speed ? speedIcon(Number(speed)) : canvas(DRAW[id])).toDataURL());
  }
  return iconUrls.get(id);
}

function addIcon(map, id, c) {
  if (map.hasImage(id)) return;
  const data = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  map.addImage(id, data, { pixelRatio: RATIO });
}

// ---------- Tiles & cache ----------

function tileBounds(x, y, z) {
  const n = 2 ** z;
  const lat = (ty) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))) * 180) / Math.PI;
  return { west: (x / n) * 360 - 180, east: ((x + 1) / n) * 360 - 180, north: lat(y), south: lat(y + 1) };
}

function visibleTiles(map) {
  const b = map.getBounds();
  const [x0, y0] = lngLatToTile(b.getWest(), b.getNorth(), TILE_Z).map(Math.floor);
  const [x1, y1] = lngLatToTile(b.getEast(), b.getSouth(), TILE_Z).map(Math.floor);
  const c = map.getCenter();
  const [cx, cy] = lngLatToTile(c.lng, c.lat, TILE_Z);
  const tiles = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) tiles.push({ x, y, d: Math.hypot(x + 0.5 - cx, y + 0.5 - cy) });
  }
  // When the map is tilted the horizon can cover a huge area: keep the tiles nearest the center.
  return tiles.sort((a, b) => a.d - b.d).slice(0, MAX_TILES).map(({ x, y }) => `${x}/${y}`);
}

const cacheUrl = (key) => `/__traffic-cache/${TILE_Z}/${key}`;

async function readCache(key) {
  try {
    const cache = await caches.open(CACHE_NAME);
    const res = await cache.match(cacheUrl(key));
    if (!res) return null;
    const { time, nodes } = await res.json();
    return Date.now() - time < CACHE_TTL_MS ? nodes : null;
  } catch {
    return null; // no Cache API (e.g. plain http on a LAN IP)
  }
}

async function writeCache(key, nodes) {
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(cacheUrl(key), new Response(JSON.stringify({ time: Date.now(), nodes })));
  } catch {
    // Caching is a nice-to-have.
  }
}

// ---------- Overpass ----------

function buildQuery({ south, west, north, east }) {
  const bbox = [south, west, north, east].map((n) => n.toFixed(6)).join(',');
  return `[out:json][timeout:60][bbox:${bbox}];
(
  node[highway~"^(traffic_signals|stop|give_way|crossing|speed_camera)$"];
  node[traffic_sign];
  node[traffic_calming];
  node[railway=level_crossing];
);
out qt;`;
}

// Ask the first server; if it errors move on at once, if it's just slow start the
// next one in parallel. First good answer wins and the rest are cancelled.
export function overpass(query) {
  return new Promise((resolve, reject) => {
    const controllers = [];
    let launched = 0;
    let failed = 0;
    let done = false;
    let hedge;

    const finish = (fn, value) => {
      done = true;
      clearTimeout(hedge);
      controllers.forEach((c) => c.abort());
      fn(value);
    };

    const launch = () => {
      if (done || launched >= OVERPASS.length) return;
      const url = OVERPASS[launched++];
      const controller = new AbortController();
      controllers.push(controller);
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), signal: controller.signal })
        .then((res) => {
          if (!res.ok) throw new Error(`${url} → ${res.status}`);
          return res.json();
        })
        .then((data) => {
          if (data.remark?.includes('error')) throw new Error(`${url} → ${data.remark}`);
          if (!done) finish(resolve, data);
        })
        .catch((err) => {
          if (done) return;
          console.warn('Overpass:', err.message);
          if (++failed === OVERPASS.length) finish(reject, err);
          else if (failed === launched) launch();
        })
        .finally(() => clearTimeout(timeout));

      clearTimeout(hedge);
      hedge = setTimeout(() => {
        if (launched - failed < MAX_PARALLEL) launch();
      }, HEDGE_MS);
    };

    launch();
  });
}

// ---------- Setup ----------

export function setupTraffic(map) {
  const nodes = new Map(); // osm id -> { id, lat, lon, tags, cat }
  const tiles = new Map(); // "x/y" -> 'loading' | 'done'
  let inFlight = false;
  let queued = false;
  let retry;
  let driving = false; // the route brings its own data and draws its own icons

  let enabled = new Set(CATEGORIES.map((c) => c.id));
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(saved)) enabled = new Set(saved);
  } catch {
    // Fall back to everything on.
  }

  // Icons only show, and only load, when they're switched on in the settings.
  const wanted = () => settings.get('trafficIcons') && !driving;

  // ---- Map layer ----

  function addLayer() {
    for (const [id, draw] of Object.entries(DRAW)) addIcon(map, id, canvas(draw));
    map.addSource(SOURCE, { type: 'geojson', data: toGeoJSON() });
    map.addLayer({
      id: TRAFFIC_LAYER,
      type: 'symbol',
      source: SOURCE,
      minzoom: MIN_ZOOM - 0.5,
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 15, 0.5, 17, 0.7, 19, 0.95],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'symbol-sort-key': ['get', 'rank'],
        visibility: wanted() ? 'visible' : 'none',
      },
      filter: categoryFilter(),
    });
  }

  map.once('load', () => {
    addLayer();
    update();
  });

  map.on('styleimagemissing', (e) => {
    const speed = e.id.match(/^tr-speed-(\d+)$/)?.[1];
    if (speed) addIcon(map, e.id, speedIcon(Number(speed)));
  });

  function categoryFilter() {
    return ['in', ['get', 'cat'], ['literal', [...enabled]]];
  }

  function toGeoJSON() {
    return {
      type: 'FeatureCollection',
      features: [...nodes.values()].map((n) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [n.lon, n.lat] },
        // OSM ids don't fit in 32 bits, so keep ours in a property rather than the feature id.
        properties: { osm: n.id, cat: n.cat, icon: iconFor(n.cat, n.tags), rank: RANK[n.cat] },
      })),
    };
  }

  function addNodes(list) {
    for (const n of list) {
      const cat = classify(n.tags ?? {});
      if (cat) nodes.set(n.id, { id: n.id, lat: n.lat, lon: n.lon, tags: n.tags, cat });
    }
    map.getSource(SOURCE)?.setData(toGeoJSON());
  }

  function applyVisibility() {
    if (map.getLayer(TRAFFIC_LAYER)) map.setLayoutProperty(TRAFFIC_LAYER, 'visibility', wanted() ? 'visible' : 'none');
    update();
  }

  // ---- Loading ----

  async function update() {
    if (!wanted() || !enabled.size || map.getZoom() < MIN_ZOOM) return;
    if (inFlight) {
      queued = true;
      return;
    }

    const missing = visibleTiles(map).filter((key) => !tiles.has(key));
    if (!missing.length) return;
    clearTimeout(retry);

    inFlight = true;
    try {
      const cached = await Promise.all(missing.map(readCache));
      const toFetch = [];
      missing.forEach((key, i) => {
        if (cached[i]) {
          addNodes(cached[i]);
          tiles.set(key, 'done');
        } else {
          toFetch.push(key);
        }
      });

      if (toFetch.length) {
        toFetch.forEach((key) => tiles.set(key, 'loading'));
        const boxes = toFetch.map((key) => tileBounds(...key.split('/').map(Number), TILE_Z));
        const union = {
          south: Math.min(...boxes.map((b) => b.south)),
          west: Math.min(...boxes.map((b) => b.west)),
          north: Math.max(...boxes.map((b) => b.north)),
          east: Math.max(...boxes.map((b) => b.east)),
        };

        try {
          const data = await overpass(buildQuery(union));
          const elements = data.elements.map(({ id, lat, lon, tags }) => ({ id, lat, lon, tags }));
          addNodes(elements);
          // Split the answer back into tiles so each one can be cached on its own.
          const perTile = new Map(toFetch.map((key) => [key, []]));
          for (const el of elements) {
            const key = lngLatToTile(el.lon, el.lat, TILE_Z).map(Math.floor).join('/');
            perTile.get(key)?.push(el);
          }
          for (const [key, list] of perTile) {
            tiles.set(key, 'done');
            writeCache(key, list);
          }
        } catch {
          toFetch.forEach((key) => tiles.delete(key));
          retry = setTimeout(update, RETRY_MS);
        }
      }
    } finally {
      inFlight = false;
    }

    if (queued) {
      queued = false;
      update();
    }
  }

  // The driving camera moves every frame, so don't recheck tiles more than once a second.
  let lastUpdate = 0;
  let trailing;
  map.on('moveend', () => {
    clearTimeout(trailing);
    const wait = 1000 - (Date.now() - lastUpdate);
    const run = () => {
      lastUpdate = Date.now();
      update();
    };
    if (wait <= 0) run();
    else trailing = setTimeout(run, wait);
  });

  settings.onChange((key) => {
    if (key === 'trafficIcons') applyVisibility();
  });

  // ---- Popups ----

  const popup = new maplibregl.Popup({ offset: 14, maxWidth: '280px' });

  map.on('click', TRAFFIC_LAYER, (e) => {
    const node = nodes.get(e.features[0].properties.osm);
    if (!node) return;
    const { title, lines } = describe(node.cat, node.tags);

    const box = document.createElement('div');
    box.className = 'pin-popup';
    const heading = document.createElement('strong');
    heading.textContent = title;
    box.append(heading);
    for (const line of lines) {
      const p = document.createElement('span');
      p.className = 'pin-popup__line';
      p.textContent = line;
      box.append(p);
    }
    popup.setLngLat([node.lon, node.lat]).setDOMContent(box).addTo(map);
  });

  map.on('mouseenter', TRAFFIC_LAYER, () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', TRAFFIC_LAYER, () => (map.getCanvas().style.cursor = ''));

  return {
    getNodes: () => [...nodes.values()],
    addNodes,
    // While planning or driving, the route brings its own data and icons;
    // don't compete with it for Overpass, and don't clutter the map.
    setDriving(value) {
      driving = value;
      applyVisibility();
    },
    categories: () => CATEGORIES.map((c) => ({ ...c, on: enabled.has(c.id) })),
    setCategory(id, on) {
      if (on) enabled.add(id);
      else enabled.delete(id);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...enabled]));
      } catch {
        // Not remembered next time; no big deal.
      }
      if (map.getLayer(TRAFFIC_LAYER)) map.setFilter(TRAFFIC_LAYER, categoryFilter());
      update();
    },
  };
}
