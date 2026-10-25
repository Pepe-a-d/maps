import * as maplibregl from 'maplibre-gl';
import { angleDiff, bearing, distance, lerp } from './geo.js';
import {
  NoRouteError,
  fetchRoute,
  formatDistance,
  loadRouteDetails,
  maneuverIcon,
  matchItems,
  remainingSeconds,
  turnSpeed,
} from './routing.js';
import { iconDataUrl } from './traffic.js';

// Driving mode, Need for Speed style: a top-down radar view that turns with the
// car, the glowing route, the next turn as an arrow, and the lights and signs
// ahead as the stars of the HUD. A simulator drives the route from a desk.

const NEON = '#2ef2ff';
const PINK = '#ff3df2';
const SIM_SPEEDS = [1, 2, 4];
const GAUGE_MAX_KMH = 160;
const ARRIVE_M = 15;
const OFF_ROUTE_M = 30;
const ITEMS_AHEAD_M = 2000; // how far ahead the map shows lights and signs
const CAR_Y = 0.63; // the car sits a bit low so you see more of what's coming

const SOURCES = { full: 'nav-full', left: 'nav-left', next: 'nav-next', items: 'nav-items' };

// Accent per kind of item, shared by the map halos and the HUD cards.
const CAT_COLOR = {
  signals: '#ffcc00',
  stop: '#ff3b45',
  give_way: '#ff3b45',
  rail: '#ff3b45',
  camera: '#ff9800',
  calming: '#ff9800',
  crossing: '#2f8cff',
  sign: '#ffffff',
};

const PLURAL = {
  signals: ['semáforo', 'semáforos'],
  crossing: ['paso de peatones', 'pasos de peatones'],
  stop: ['stop', 'stops'],
  give_way: ['ceda el paso', 'ceda el paso'],
  sign: ['señal', 'señales'],
  camera: ['radar', 'radares'],
  calming: ['reductor', 'reductores'],
  rail: ['paso a nivel', 'pasos a nivel'],
};

const ICONS = {
  pause: '<svg viewBox="0 0 24 24"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15L19.5 12z" fill="currentColor"/></svg>',
  close:
    '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>',
  car: `<svg viewBox="0 0 48 48" width="52" height="52"><path d="M24 3 41 43 24 33.5 7 43Z" fill="#06181c" stroke="${NEON}" stroke-width="3" stroke-linejoin="round"/><path d="M24 12 33 35 24 29.5 15 35Z" fill="${NEON}" opacity=".35"/></svg>`,
};

const formatDuration = (s) =>
  s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
const clock = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// "120 m" → ["120", "m"], to draw the number big and the unit small.
const splitDistance = (m) => formatDistance(m).split(' ');

function countsText(items) {
  const counts = {};
  for (const item of items) counts[item.cat] = (counts[item.cat] ?? 0) + 1;
  return Object.entries(PLURAL)
    .filter(([cat]) => counts[cat])
    .map(([cat, [one, many]]) => `${counts[cat]} ${counts[cat] === 1 ? one : many}`)
    .join(' · ');
}

function currentPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve([p.coords.longitude, p.coords.latitude]),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 },
    );
  });
}

export function setupDriving(map, traffic, basemap) {
  // off | locating | pick-origin | routing | preview | driving | finished
  let mode = 'off';
  let route = null;
  let dest = null; // { lngLat, name }
  let origin = null; // { lngLat, gps }
  let sim = null; // simulator state, or null when following the real GPS
  let abort = null;

  // Car state
  let along = 0;
  let speed = 0; // m/s
  let position = null;
  let heading = 0;
  let camBearing = 0;
  let camZoom = 17;
  let follow = true;
  let resumeFollowAt = 0;

  let gps = null;
  let watchId = null;
  let rerouting = false;
  let lastReroute = 0;

  let raf = 0;
  let lastFrame = 0;
  let lastHud = 0;
  let shownStep = -1; // what the HUD currently shows, to skip rebuilding it
  let shownItems = '';
  let shownMapItems = '';
  let stats = null;
  let wakeLock = null;

  const ui = buildUi();
  const carMarker = new maplibregl.Marker({
    element: Object.assign(document.createElement('div'), { className: 'nav-car', innerHTML: ICONS.car }),
    rotationAlignment: 'map',
  });
  const flagMarker = new maplibregl.Marker({
    element: Object.assign(document.createElement('div'), { className: 'nav-flag', innerHTML: maneuverIcon({ type: 'arrive' }) }),
    anchor: 'bottom-left',
    offset: [-10, 2], // put the pole, not the box corner, on the spot
  });

  // ---------- UI ----------

  function buildUi() {
    const root = document.createElement('div');
    root.className = 'nav';
    root.hidden = true;
    root.innerHTML = `
      <section class="nav-sheet">
        <p class="nav-kicker">Ruta</p>
        <h2 class="nav-sheet__dest"></h2>
        <p class="nav-sheet__summary"></p>
        <p class="nav-sheet__extras"></p>
        <p class="nav-sheet__note"></p>
        <div class="nav-sheet__actions">
          <button class="nav-btn" data-act="cancel">Cancelar</button>
          <button class="nav-btn" data-act="sim">Simular</button>
          <button class="nav-btn nav-btn--go" data-act="go">Conducir</button>
        </div>
      </section>

      <section class="hud">
        <div class="hud-radar" aria-hidden="true">
          <svg viewBox="-100 -100 200 200">
            <circle class="hud-radar__ring" r="97"/>
            <circle class="hud-radar__ticks" r="91" pathLength="360"/>
            <g class="hud-radar__north">
              <path d="M0 -100 L7 -88 L-7 -88Z"/>
              <text y="-73">N</text>
            </g>
          </svg>
        </div>

        <div class="hud-turn">
          <div class="hud-turn__icon"></div>
          <div class="hud-turn__dist"><b></b><small></small></div>
        </div>

        <div class="hud-hazard">
          <div class="hud-hazard__main" hidden>
            <img class="hud-hazard__icon" alt="" width="84" height="84"/>
            <div class="hud-hazard__body">
              <div class="hud-hazard__dist"><b></b><small></small></div>
              <div class="hud-hazard__title"></div>
            </div>
            <i class="hud-hazard__bar"><i></i></i>
          </div>
          <ol class="hud-hazard__more"></ol>
          <p class="hud-hazard__empty"></p>
        </div>

        <div class="hud-speed">
          <div class="hud-limit" hidden><span></span></div>
          <div class="hud-gauge">
            <svg viewBox="0 0 120 120" aria-hidden="true">
              <defs>
                <linearGradient id="hud-gauge-grad" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0" stop-color="${NEON}"/>
                  <stop offset="0.6" stop-color="${PINK}"/>
                  <stop offset="1" stop-color="#ff3b45"/>
                </linearGradient>
              </defs>
              <path class="hud-gauge__track" d="M26.1 93.9A48 48 0 1 1 93.9 93.9" pathLength="100"/>
              <path class="hud-gauge__value" d="M26.1 93.9A48 48 0 1 1 93.9 93.9" pathLength="100" stroke="url(#hud-gauge-grad)"/>
              <path class="hud-gauge__cuts" d="M26.1 93.9A48 48 0 1 1 93.9 93.9" pathLength="100"/>
            </svg>
            <div class="hud-gauge__num">0</div>
            <div class="hud-gauge__unit">km/h</div>
          </div>
        </div>

        <div class="hud-trip">
          <div class="hud-trip__stat"><b data-f="eta">--:--</b><small>llegada</small></div>
          <div class="hud-trip__stat"><b data-f="time">-</b><small>restante</small></div>
          <div class="hud-trip__stat"><b data-f="dist">-</b><small>distancia</small></div>
          <div class="hud-trip__controls">
            <button class="hud-btn sim-only" data-act="pause" aria-label="Pausa"></button>
            <button class="hud-btn sim-only hud-btn--text" data-act="simspeed" aria-label="Velocidad de simulación"></button>
            <button class="hud-btn hud-btn--exit" data-act="exit" aria-label="Salir">${ICONS.close}</button>
          </div>
        </div>

        <button class="nav-btn hud-recenter" data-act="recenter" hidden>Recentrar</button>
        <div class="hud-toast" hidden></div>
      </section>

      <section class="nav-finish">
        <p class="nav-kicker">Ruta completada</p>
        <h2 class="nav-finish__title">Destino alcanzado</h2>
        <dl class="nav-finish__stats"></dl>
        <button class="nav-btn nav-btn--go" data-act="exit">Volver al mapa</button>
      </section>`;

    root.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act) actions[act]?.();
    });
    document.body.append(root);

    const $ = (sel) => root.querySelector(sel);
    return {
      root,
      dest: $('.nav-sheet__dest'),
      summary: $('.nav-sheet__summary'),
      extras: $('.nav-sheet__extras'),
      note: $('.nav-sheet__note'),
      go: $('[data-act="go"]'),
      simBtn: $('[data-act="sim"]'),
      north: $('.hud-radar__north'),
      northLabel: $('.hud-radar__north text'),
      turn: $('.hud-turn'),
      turnIcon: $('.hud-turn__icon'),
      turnNum: $('.hud-turn__dist b'),
      turnUnit: $('.hud-turn__dist small'),
      hazard: $('.hud-hazard__main'),
      hazardIcon: $('.hud-hazard__icon'),
      hazardNum: $('.hud-hazard__dist b'),
      hazardUnit: $('.hud-hazard__dist small'),
      hazardTitle: $('.hud-hazard__title'),
      hazardBar: $('.hud-hazard__bar i'),
      more: $('.hud-hazard__more'),
      empty: $('.hud-hazard__empty'),
      limit: $('.hud-limit'),
      limitNum: $('.hud-limit span'),
      gauge: $('.hud-gauge'),
      gaugeValue: $('.hud-gauge__value'),
      gaugeNum: $('.hud-gauge__num'),
      eta: $('[data-f="eta"]'),
      time: $('[data-f="time"]'),
      dist: $('[data-f="dist"]'),
      pause: $('[data-act="pause"]'),
      simSpeed: $('[data-act="simspeed"]'),
      recenter: $('.hud-recenter'),
      toast: $('.hud-toast'),
      finishStats: $('.nav-finish__stats'),
    };
  }

  const actions = {
    cancel: exit,
    exit,
    go: () => start(false),
    sim: () => start(true),
    recenter: () => setFollow(true),
    pause() {
      sim.paused = !sim.paused;
      renderButtons();
    },
    simspeed() {
      sim.mult = SIM_SPEEDS[(SIM_SPEEDS.indexOf(sim.mult) + 1) % SIM_SPEEDS.length];
      renderButtons();
    },
  };

  function setMode(next) {
    const driving = next === 'driving' || next === 'finished';
    const wasDriving = mode === 'driving' || mode === 'finished';
    mode = next;
    ui.root.hidden = next === 'off';
    ui.root.dataset.state = next;
    document.body.classList.toggle('nav-on', next !== 'off');
    document.body.classList.toggle('driving', driving);
    if (driving !== wasDriving) {
      // Behind the wheel: black map only, and just the lights/signs on the route.
      basemap.force(driving ? 'map' : null);
      traffic.setVisible(!driving);
    }
  }

  function renderButtons() {
    ui.root.classList.toggle('is-sim', Boolean(sim));
    if (sim) {
      ui.pause.innerHTML = sim.paused ? ICONS.play : ICONS.pause;
      ui.simSpeed.textContent = `×${sim.mult}`;
    }
  }

  let toastTimer;
  function toast(text, ms = 2500) {
    ui.toast.textContent = text;
    ui.toast.hidden = false;
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(() => (ui.toast.hidden = true), ms);
  }

  function sheet({ summary = '', extras = '', note = '', canGo = false, canSim = false }) {
    ui.dest.textContent = dest?.name ?? 'Destino';
    ui.summary.textContent = summary;
    ui.extras.textContent = extras;
    ui.note.textContent = note;
    ui.go.disabled = !canGo;
    ui.simBtn.disabled = !canSim;
  }

  function refreshSheet() {
    if (mode !== 'preview' || !route) return;
    const details =
      route.detailsState === 'loading'
        ? 'Buscando semáforos y señales…'
        : route.detailsState === 'error'
          ? 'No se pudieron cargar las señales (servidores ocupados).'
          : route.items.length
            ? countsText(route.items)
            : 'Sin semáforos ni señales mapeados en la ruta.';
    sheet({
      summary: `${formatDistance(route.line.length)} · ${formatDuration(route.duration)}`,
      extras: route.detailsState === 'loading' && route.items.length ? `${countsText(route.items)} · buscando más…` : details,
      note: origin.gps ? '' : 'Sin GPS: la ruta sale del punto que elegiste. Puedes simularla.',
      canGo: origin.gps,
      canSim: true,
    });
  }

  // ---------- Map layers ----------

  function ensureLayers() {
    if (map.getSource(SOURCES.full)) return;
    const empty = { type: 'FeatureCollection', features: [] };
    for (const id of Object.values(SOURCES)) map.addSource(id, { type: 'geojson', data: empty });

    const chevron = document.createElement('canvas');
    chevron.width = chevron.height = 32;
    const ctx = chevron.getContext('2d');
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 5;
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(10, 6);
    ctx.lineTo(22, 16);
    ctx.lineTo(10, 26);
    ctx.stroke();
    map.addImage('nav-chevron', ctx.getImageData(0, 0, 32, 32), { pixelRatio: 2 });

    const before = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
    const width = (min, max) => ['interpolate', ['exponential', 1.5], ['zoom'], 12, min, 18, max];
    const round = { 'line-join': 'round', 'line-cap': 'round' };
    const catColor = ['match', ['get', 'cat'], ...Object.entries(CAT_COLOR).flat(), '#ffffff'];
    const routeLayers = [
      { id: 'nav-done', source: SOURCES.full, type: 'line', layout: round, paint: { 'line-color': NEON, 'line-opacity': 0.2, 'line-width': width(3, 9) } },
      { id: 'nav-glow', source: SOURCES.left, type: 'line', layout: round, paint: { 'line-color': NEON, 'line-opacity': 0.35, 'line-blur': 6, 'line-width': width(10, 34) } },
      { id: 'nav-line', source: SOURCES.left, type: 'line', layout: round, paint: { 'line-color': NEON, 'line-width': width(5, 14) } },
      { id: 'nav-core', source: SOURCES.left, type: 'line', layout: round, paint: { 'line-color': '#e6fdff', 'line-width': width(1.5, 4) } },
      {
        id: 'nav-arrows',
        source: SOURCES.left,
        type: 'symbol',
        layout: {
          'symbol-placement': 'line',
          'symbol-spacing': 70,
          'icon-image': 'nav-chevron',
          'icon-size': ['interpolate', ['linear'], ['zoom'], 14, 0.45, 18, 0.9],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'icon-rotation-alignment': 'map',
        },
        paint: { 'icon-opacity': 0.85 },
      },
      { id: 'nav-next-glow', source: SOURCES.next, type: 'circle', paint: { 'circle-radius': 18, 'circle-color': PINK, 'circle-opacity': 0.25, 'circle-blur': 0.8 } },
      {
        id: 'nav-next',
        source: SOURCES.next,
        type: 'circle',
        paint: { 'circle-radius': 9, 'circle-color': '#000', 'circle-stroke-color': PINK, 'circle-stroke-width': 3 },
      },
    ];
    for (const layer of routeLayers) map.addLayer(layer, before);

    // Lights and signs on the route go on top of everything, big and haloed.
    const itemLayers = [
      {
        id: 'nav-items-halo',
        source: SOURCES.items,
        type: 'circle',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 12, 18, 34],
          'circle-color': catColor,
          'circle-opacity': 0.3,
          'circle-blur': 0.7,
        },
      },
      {
        id: 'nav-items-next',
        source: SOURCES.items,
        type: 'circle',
        filter: ['==', ['get', 'next'], true],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 15, 18, 40],
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-color': catColor,
          'circle-stroke-width': 3,
        },
      },
      {
        id: 'nav-items',
        source: SOURCES.items,
        type: 'symbol',
        layout: {
          'icon-image': ['get', 'icon'],
          'icon-size': ['interpolate', ['linear'], ['zoom'], 14, 0.75, 18, 1.4],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'symbol-sort-key': ['get', 'order'], // nearest on top
        },
      },
    ];
    for (const layer of itemLayers) map.addLayer(layer);
  }

  const lineFeature = (coords) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} });
  const emptyCollection = { type: 'FeatureCollection', features: [] };

  function drawRoute() {
    ensureLayers();
    map.getSource(SOURCES.full).setData(lineFeature(route.line.coords));
    map.getSource(SOURCES.left).setData(lineFeature(route.line.coords));
    map.getSource(SOURCES.next).setData(emptyCollection);
    map.getSource(SOURCES.items).setData(emptyCollection);
  }

  function clearRoute() {
    if (!map.getSource(SOURCES.full)) return;
    for (const id of Object.values(SOURCES)) map.getSource(id).setData(emptyCollection);
  }

  function fitRoute() {
    const bounds = new maplibregl.LngLatBounds();
    for (const c of route.line.coords) bounds.extend(c);
    const sheetHeight = ui.root.querySelector('.nav-sheet').offsetHeight || 220;
    map.fitBounds(bounds, {
      padding: { top: 80, left: 40, right: 80, bottom: sheetHeight + 40 },
      maxZoom: 17,
      pitch: 0,
      bearing: 0,
      duration: 1200,
    });
  }

  // ---------- Planning ----------

  async function planTo(lngLat, name) {
    exit();
    dest = { lngLat, name };
    setMode('locating');
    sheet({ summary: 'Buscando tu ubicación…' });
    traffic.setPaused(true);
    flagMarker.setLngLat(lngLat).addTo(map);

    const here = await currentPosition();
    if (mode !== 'locating') return; // cancelled meanwhile
    if (here) {
      origin = { lngLat: here, gps: true };
      await planRoute();
    } else {
      setMode('pick-origin');
      sheet({ summary: 'No hay GPS disponible.', note: 'Toca en el mapa el punto de salida para simular la ruta.' });
    }
  }

  async function planRoute() {
    setMode('routing');
    sheet({ summary: 'Calculando ruta…' });
    abort = new AbortController();
    try {
      const next = await fetchRoute(origin.lngLat, dest.lngLat, abort.signal);
      if (mode !== 'routing') return;
      setRoute(next);
      setMode('preview');
      refreshSheet();
      fitRoute();
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error(err);
      setMode('preview');
      sheet({ summary: err instanceof NoRouteError ? err.message : 'No se pudo calcular la ruta. Inténtalo de nuevo.' });
    }
  }

  function setRoute(next) {
    route = next;
    along = 0;
    shownStep = -1;
    shownItems = '';
    shownMapItems = '';
    drawRoute();
    loadDetails(next);
    buildSimStops();
  }

  async function loadDetails(r) {
    // Whatever the map already loaded shows up at once; the full query fills in the rest.
    matchItems(r, traffic.getNodes(), null);
    r.detailsState = 'loading';
    refreshSheet();
    try {
      const { nodes, ways } = await loadRouteDetails(r);
      traffic.addNodes(nodes);
      matchItems(r, nodes, ways);
      r.detailsState = 'done';
    } catch (err) {
      console.warn('Route details:', err.message);
      r.detailsState = 'error';
    }
    if (r !== route) return;
    refreshSheet();
    buildSimStops();
    shownItems = '';
    shownMapItems = '';
    lastHud = 0;
  }

  // ---------- Driving ----------

  function start(simulated) {
    if (!route) return;
    stats = { time: 0, dist: 0, maxSpeed: 0, start: performance.now() };
    sim = simulated ? { mult: 1, paused: false, wait: 0, stops: [] } : null;
    along = 0;
    speed = 0;
    position = route.line.coords[0];
    heading = camBearing = route.line.bearingAt(0);
    camZoom = 17.6;
    follow = true;
    setMode('driving');
    buildSimStops();
    renderButtons();
    applyLayout();
    ui.recenter.hidden = true;
    carMarker.setLngLat(position).setRotation(heading).addTo(map);
    map.jumpTo({ center: position, bearing: camBearing, pitch: 0, zoom: camZoom });

    if (!simulated) startGps();
    requestWakeLock();
    lastFrame = performance.now();
    lastHud = 0;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  }

  function buildSimStops() {
    if (!sim || !route) return;
    sim.stops = route.items
      .filter((item) => item.along > along + 12 && (item.cat === 'stop' || item.cat === 'signals'))
      .map((item) => ({
        along: item.along,
        // Stop signs always; traffic lights are red some of the time.
        wait: item.cat === 'stop' ? 1.5 : Math.random() < 0.4 ? 3 + Math.random() * 5 : 0,
      }))
      .filter((stop) => stop.wait > 0);
  }

  function simulate(dt) {
    if (sim.paused) return;
    if (sim.wait > 0) {
      sim.wait -= dt;
      speed = 0;
      return;
    }
    const { line } = route;
    const i = line.segmentAt(along);
    let target = route.speeds[i] || 12;
    const limit = route.limits?.[i];
    if (limit) target = Math.min(target, limit / 3.6);

    // Brake ahead of turns…
    for (const step of route.steps) {
      if (step.along <= along) continue;
      const d = step.along - along;
      if (d > 250) break;
      target = Math.min(target, Math.sqrt(turnSpeed(step) ** 2 + 2 * 2.5 * Math.max(0, d - 4)));
    }
    // …stop at stop signs and red lights…
    const stop = sim.stops.find((s) => !s.done);
    if (stop) {
      const d = stop.along - 4 - along;
      if (d <= 0.3) {
        stop.done = true;
        sim.wait = stop.wait;
        speed = 0;
        return;
      }
      target = Math.min(target, Math.sqrt(2 * 3 * d));
    }
    // …and roll to a halt at the destination.
    target = Math.min(target, Math.sqrt(2 * 2.5 * Math.max(0, line.length - along)) + 0.6);

    speed = speed < target ? Math.min(target, speed + 2.8 * dt) : Math.max(target, speed - 5 * dt);
    along = Math.min(line.length, along + speed * dt);
  }

  function startGps() {
    gps = { time: 0, along: 0, speed: 0, raw: null, onRoute: true, off: 0, heading: null };
    watchId = navigator.geolocation.watchPosition(onFix, () => toast('Sin señal GPS', 3000), {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 15000,
    });
  }

  function onFix(pos) {
    if (!route) return;
    const p = [pos.coords.longitude, pos.coords.latitude];
    const now = performance.now();
    const { line } = route;
    const seg = line.segmentAt(gps.along);
    let hit = line.project(p, seg - 3, seg + 80);
    if (hit.dist > OFF_ROUTE_M) hit = line.project(p); // jumped ahead (tunnel, lost signal…)

    let v = pos.coords.speed;
    if (v == null && gps.raw && gps.time) v = distance(gps.raw, p) / Math.max(0.5, (now - gps.time) / 1000);
    const travelled = gps.raw ? bearing(gps.raw, p) : null;

    gps = {
      ...gps,
      time: now,
      raw: p,
      speed: v ?? 0,
      along: hit.along,
      onRoute: hit.dist <= OFF_ROUTE_M,
      heading: pos.coords.heading ?? (gps.raw && distance(gps.raw, p) > 3 ? travelled : gps.heading),
    };
    if (gps.onRoute) gps.off = 0;
    else if (++gps.off >= 3) reroute(p);
  }

  function followGps(dt, now) {
    if (!gps.time) return;
    speed += (gps.speed - speed) * Math.min(1, dt * 2);
    if (gps.onRoute) {
      // Fixes come about once a second: glide between them so the camera doesn't jump.
      const predicted = gps.along + gps.speed * Math.min(2, (now - gps.time) / 1000);
      along += (predicted - along) * Math.min(1, dt * 3);
    }
  }

  async function reroute(from) {
    if (rerouting || performance.now() - lastReroute < 10000) return;
    rerouting = true;
    lastReroute = performance.now();
    toast('Recalculando ruta…', 0);
    try {
      setRoute(await fetchRoute(from, dest.lngLat));
      gps.along = 0;
      gps.off = 0;
      toast('Ruta actualizada');
    } catch {
      toast('No se pudo recalcular la ruta', 3000);
    } finally {
      rerouting = false;
    }
  }

  function tick(now) {
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    const before = along;

    if (sim) {
      const simDt = sim.paused ? 0 : dt * sim.mult;
      simulate(simDt);
      stats.time += simDt;
    } else {
      followGps(dt, now);
      stats.time = (now - stats.start) / 1000;
    }
    stats.dist += Math.max(0, along - before);
    stats.maxSpeed = Math.max(stats.maxSpeed, speed);

    const offRoute = gps && !gps.onRoute && gps.raw;
    if (offRoute) {
      position = lerp(position, gps.raw, Math.min(1, dt * 3));
      if (gps.heading != null) heading += angleDiff(heading, gps.heading) * Math.min(1, dt * 3);
    } else {
      position = route.line.pointAt(along);
      heading += angleDiff(heading, route.line.bearingAt(along)) * Math.min(1, dt * 4);
    }
    heading = (heading + 360) % 360;
    carMarker.setLngLat(position).setRotation(heading);

    // Radar camera: straight down, turning with the car, zooming out with speed.
    const kmh = speed * 3.6;
    const zoomTarget = 17.6 - Math.min(1, Math.max(0, (kmh - 30) / 70)) * 1.5;
    camZoom += (zoomTarget - camZoom) * Math.min(1, dt * 1.5);
    camBearing = (camBearing + angleDiff(camBearing, heading) * Math.min(1, dt * 2.5) + 360) % 360;
    if (!follow && resumeFollowAt && now > resumeFollowAt) {
      follow = true;
      resumeFollowAt = 0;
      ui.root.classList.remove('is-free');
    }
    if (follow) map.jumpTo({ center: position, bearing: camBearing, pitch: 0, zoom: camZoom });
    // Keep the radar's N pointing north, with the letter upright.
    ui.north.setAttribute('transform', `rotate(${-camBearing})`);
    ui.northLabel.setAttribute('transform', `rotate(${camBearing} 0 -79)`);

    if (now - lastHud > 150) {
      lastHud = now;
      updateHud(kmh);
    }

    const end = route.line.length;
    const arrived = gps?.raw ? along >= end - ARRIVE_M || distance(gps.raw, route.line.coords.at(-1)) < 25 : along >= end - 1;
    if (arrived) return finish();
    raf = requestAnimationFrame(tick);
  }

  // ---------- HUD ----------

  function setDistance(numEl, unitEl, m) {
    const [num, unit] = splitDistance(m);
    numEl.textContent = num;
    unitEl.textContent = unit;
  }

  function updateHud(kmh) {
    const { line, steps } = route;

    // Next turn: just the arrow and how far.
    let k = steps.findIndex((s, i) => i > 0 && s.along > along + 2);
    if (k < 0) k = steps.length - 1;
    const step = steps[k];
    const toTurn = step.along - along;
    if (k !== shownStep) {
      shownStep = k;
      ui.turnIcon.innerHTML = maneuverIcon(step);
      ui.turn.classList.remove('is-new');
      void ui.turn.offsetWidth; // restart the flash animation
      ui.turn.classList.add('is-new');
      const p = line.pointAt(step.along);
      map.getSource(SOURCES.next).setData({ type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: {} });
    }
    setDistance(ui.turnNum, ui.turnUnit, toTurn);
    ui.turn.classList.toggle('is-now', toTurn < 60);

    // Lights and signs: the next one big, the two after it small.
    const upcoming = route.items.filter((item) => item.along > along - 2);
    const [next, ...rest] = upcoming;
    const more = rest.slice(0, 2);
    const key = upcoming
      .slice(0, 3)
      .map((item) => item.id)
      .join(',');
    ui.hazard.hidden = !next;
    if (key !== shownItems) {
      shownItems = key;
      if (next) {
        ui.hazard.dataset.cat = next.cat;
        ui.hazard.style.setProperty('--c', CAT_COLOR[next.cat]);
        ui.hazardIcon.src = iconDataUrl(next.icon);
        ui.hazardTitle.textContent = next.title;
        ui.hazard.classList.remove('is-new');
        void ui.hazard.offsetWidth;
        ui.hazard.classList.add('is-new');
      }
      ui.more.replaceChildren(
        ...more.map((item) => {
          const li = document.createElement('li');
          li.style.setProperty('--c', CAT_COLOR[item.cat]);
          li.innerHTML = '<img alt="" width="40" height="40"/><b></b>';
          li.querySelector('img').src = iconDataUrl(item.icon);
          li.title = item.title;
          return li;
        }),
      );
    }
    if (next) {
      const d = Math.max(0, next.along - along);
      setDistance(ui.hazardNum, ui.hazardUnit, d);
      ui.hazardBar.style.width = `${(1 - Math.min(d, 300) / 300) * 100}%`;
      ui.hazard.classList.toggle('is-close', d < 60);
    }
    more.forEach((item, i) => {
      ui.more.children[i].querySelector('b').textContent = formatDistance(Math.max(0, item.along - along));
    });
    ui.empty.textContent = next
      ? ''
      : route.detailsState === 'loading'
        ? 'Buscando semáforos y señales…'
        : route.detailsState === 'error'
          ? 'Sin datos de señales'
          : 'Vía libre';

    // The same items on the map, only the stretch ahead.
    const onMap = upcoming.filter((item) => item.along < along + ITEMS_AHEAD_M);
    const mapKey = `${onMap[0]?.id}-${onMap.at(-1)?.id}-${onMap.length}`;
    if (mapKey !== shownMapItems) {
      shownMapItems = mapKey;
      map.getSource(SOURCES.items).setData({
        type: 'FeatureCollection',
        features: onMap.map((item, i) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: line.pointAt(item.along) },
          properties: { icon: item.icon, cat: item.cat, next: i === 0, order: onMap.length - i },
        })),
      });
    }

    // Speed
    const seg = line.segmentAt(along);
    const limit = route.limits?.[seg];
    ui.limit.hidden = !limit;
    if (limit) ui.limitNum.textContent = limit;
    const over = limit && kmh > limit + 3;
    ui.gauge.classList.toggle('is-over', Boolean(over));
    ui.limit.classList.toggle('is-over', Boolean(over));
    ui.gaugeNum.textContent = Math.round(kmh);
    ui.gaugeValue.style.strokeDasharray = `${Math.min(1, kmh / GAUGE_MAX_KMH) * 100} 100`;

    // Trip
    const left = remainingSeconds(route, along);
    const eta = new Date(Date.now() + left * 1000);
    ui.eta.textContent = eta.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    ui.time.textContent = formatDuration(left);
    ui.dist.textContent = formatDistance(line.length - along);

    // Throttle the remaining-route redraw along with the HUD.
    map.getSource(SOURCES.left).setData(lineFeature(line.sliceFrom(along)));
  }

  // ---------- Camera follow ----------

  // Put the car low on screen and center the radar ring on it.
  function applyLayout() {
    const { clientWidth: w, clientHeight: h } = map.getContainer();
    const top = Math.round(h * (2 * CAR_Y - 1));
    map.setPadding({ top, bottom: 0, left: 0, right: 0 });
    ui.root.style.setProperty('--cx', `${w / 2}px`);
    ui.root.style.setProperty('--cy', `${top + (h - top) / 2}px`);
    ui.root.style.setProperty('--r', `${Math.round(Math.max(110, Math.min(260, Math.min(w, h) * 0.3)))}px`);
  }

  function setFollow(on) {
    ui.recenter.hidden = on;
    if (!on) {
      follow = false;
      resumeFollowAt = 0;
      ui.root.classList.add('is-free');
      return;
    }
    // Glide back over the car, then lock on again.
    map.easeTo({ center: position, bearing: camBearing, pitch: 0, zoom: camZoom, duration: 700 });
    resumeFollowAt = performance.now() + 700;
  }

  for (const type of ['dragstart', 'rotatestart', 'pitchstart', 'zoomstart']) {
    map.on(type, (e) => {
      if (mode === 'driving' && e.originalEvent) setFollow(false);
    });
  }
  window.addEventListener('resize', () => {
    if (mode === 'driving') applyLayout();
  });

  // ---------- Wake lock ----------

  async function requestWakeLock() {
    try {
      wakeLock = await navigator.wakeLock?.request('screen');
    } catch {
      // Not supported or not allowed; the screen may dim.
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && mode === 'driving') requestWakeLock();
  });

  // ---------- Finish / exit ----------

  function finish() {
    cancelAnimationFrame(raf);
    stopGps();
    setMode('finished');
    const passed = route.items.filter((item) => item.along <= along);
    const count = (cat) => passed.filter((item) => item.cat === cat).length;
    const avg = stats.time ? (stats.dist / stats.time) * 3.6 : 0;
    const rows = [
      ['Tiempo', clock(stats.time)],
      ['Distancia', formatDistance(stats.dist)],
      ['Velocidad media', `${Math.round(avg)} km/h`],
      ['Velocidad máxima', `${Math.round(stats.maxSpeed * 3.6)} km/h`],
      ['Semáforos', count('signals')],
      ['Pasos de peatones', count('crossing')],
      ['Stops y ceda el paso', count('stop') + count('give_way')],
      ['Radares', count('camera')],
    ];
    ui.finishStats.replaceChildren(
      ...rows.flatMap(([label, value]) => {
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        dd.textContent = value;
        return [dt, dd];
      }),
    );
  }

  function stopGps() {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    gps = null;
  }

  function exit() {
    if (mode === 'off') return;
    const wasDriving = mode === 'driving' || mode === 'finished';
    abort?.abort();
    cancelAnimationFrame(raf);
    stopGps();
    wakeLock?.release().catch(() => {});
    wakeLock = null;
    carMarker.remove();
    flagMarker.remove();
    clearRoute();
    route = null;
    sim = null;
    shownStep = -1;
    shownItems = '';
    shownMapItems = '';
    ui.toast.hidden = true;
    ui.root.classList.remove('is-free');
    setMode('off');
    traffic.setPaused(false);
    map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    if (wasDriving) map.easeTo({ bearing: 0, zoom: Math.min(map.getZoom(), 16), duration: 1000 });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mode !== 'off' && document.activeElement?.tagName !== 'INPUT') exit();
  });

  return {
    planTo,
    isActive: () => mode !== 'off',
    // Map clicks while planning: pick the starting point when there's no GPS.
    handleClick(lngLat) {
      if (mode === 'off') return false;
      if (mode === 'pick-origin') {
        origin = { lngLat: [lngLat.lng, lngLat.lat], gps: false };
        planRoute();
      }
      return true;
    },
  };
}
