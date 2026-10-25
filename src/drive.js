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
  spokenDistance,
  turnSpeed,
} from './routing.js';
import { iconDataUrl } from './traffic.js';

// Driving mode: a video-game style navigator. Chase camera behind a neon car,
// glowing route, next turn, upcoming lights/signs with a countdown, speedometer
// with the speed limit, voice, and a simulator to drive the route from a desk.

const NEON = '#2ef2ff';
const PINK = '#ff3df2';
const PITCH = 62;
const SIM_SPEEDS = [1, 2, 4];
const VOICE_KEY = 'maps-drive-voice';
const GAUGE_MAX_KMH = 160;
const ARRIVE_M = 15;
const OFF_ROUTE_M = 30;

const SOURCES = { full: 'nav-full', left: 'nav-left', next: 'nav-next' };

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
const SPOKEN_ITEMS = { camera: 'Radar', stop: 'Stop', rail: 'Paso a nivel' };

const ICONS = {
  voiceOn:
    '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  voiceOff:
    '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="m16 9 5 6m0-6-5 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15L19.5 12z" fill="currentColor"/></svg>',
  close:
    '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>',
  car: `<svg viewBox="0 0 48 48" width="48" height="48"><path d="M24 3 41 43 24 33.5 7 43Z" fill="#06181c" stroke="${NEON}" stroke-width="3" stroke-linejoin="round"/><path d="M24 12 33 35 24 29.5 15 35Z" fill="${NEON}" opacity=".35"/></svg>`,
};

const formatDuration = (s) =>
  s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
const clock = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const lowerFirst = (text) => text.charAt(0).toLowerCase() + text.slice(1);

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

export function setupDriving(map, traffic) {
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
  let stats = null;
  let spoken = new Set();
  let wakeLock = null;
  let voiceOn = true;
  try {
    voiceOn = localStorage.getItem(VOICE_KEY) !== 'off';
  } catch {
    // Default on.
  }

  const ui = buildUi();
  const carMarker = new maplibregl.Marker({
    element: Object.assign(document.createElement('div'), { className: 'nav-car', innerHTML: ICONS.car }),
    rotationAlignment: 'map',
    pitchAlignment: 'map',
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
        <div class="hud-turn">
          <div class="hud-turn__icon"></div>
          <div class="hud-turn__body">
            <div class="hud-turn__dist"></div>
            <div class="hud-turn__text"></div>
          </div>
        </div>
        <div class="hud-then" hidden><span>Luego</span><i></i></div>

        <div class="hud-next">
          <div class="nav-kicker">Próximos</div>
          <ol class="hud-next__list"></ol>
          <p class="hud-next__empty"></p>
        </div>

        <div class="hud-speed">
          <div class="hud-limit" hidden><span></span></div>
          <div class="hud-gauge">
            <svg viewBox="0 0 120 120" aria-hidden="true">
              <path class="hud-gauge__ticks" d="M31.7 88.3A40 40 0 1 1 88.3 88.3" pathLength="100"/>
              <path class="hud-gauge__track" d="M26.1 93.9A48 48 0 1 1 93.9 93.9" pathLength="100"/>
              <path class="hud-gauge__value" d="M26.1 93.9A48 48 0 1 1 93.9 93.9" pathLength="100"/>
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
            <button class="hud-btn" data-act="voice" aria-label="Voz"></button>
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
      turn: $('.hud-turn'),
      turnIcon: $('.hud-turn__icon'),
      turnDist: $('.hud-turn__dist'),
      turnText: $('.hud-turn__text'),
      then: $('.hud-then'),
      thenIcon: $('.hud-then i'),
      list: $('.hud-next__list'),
      empty: $('.hud-next__empty'),
      limit: $('.hud-limit'),
      limitNum: $('.hud-limit span'),
      gauge: $('.hud-gauge'),
      gaugeValue: $('.hud-gauge__value'),
      gaugeNum: $('.hud-gauge__num'),
      eta: $('[data-f="eta"]'),
      time: $('[data-f="time"]'),
      dist: $('[data-f="dist"]'),
      voice: $('[data-act="voice"]'),
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
    voice() {
      voiceOn = !voiceOn;
      if (!voiceOn) window.speechSynthesis?.cancel();
      try {
        localStorage.setItem(VOICE_KEY, voiceOn ? 'on' : 'off');
      } catch {
        // Not remembered next time.
      }
      renderButtons();
    },
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
    mode = next;
    ui.root.hidden = next === 'off';
    ui.root.dataset.state = next;
    document.body.classList.toggle('nav-on', next !== 'off');
    document.body.classList.toggle('driving', next === 'driving' || next === 'finished');
  }

  function renderButtons() {
    ui.voice.innerHTML = voiceOn ? ICONS.voiceOn : ICONS.voiceOff;
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
    const layers = [
      { id: 'nav-done', source: SOURCES.full, type: 'line', layout: round, paint: { 'line-color': NEON, 'line-opacity': 0.2, 'line-width': width(3, 9) } },
      { id: 'nav-glow', source: SOURCES.left, type: 'line', layout: round, paint: { 'line-color': NEON, 'line-opacity': 0.35, 'line-blur': 6, 'line-width': width(9, 30) } },
      { id: 'nav-line', source: SOURCES.left, type: 'line', layout: round, paint: { 'line-color': NEON, 'line-width': width(4, 12) } },
      { id: 'nav-core', source: SOURCES.left, type: 'line', layout: round, paint: { 'line-color': '#e6fdff', 'line-width': width(1, 3.5) } },
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
          'icon-pitch-alignment': 'map',
        },
        paint: { 'icon-opacity': 0.85 },
      },
      { id: 'nav-next-glow', source: SOURCES.next, type: 'circle', paint: { 'circle-radius': 16, 'circle-color': PINK, 'circle-opacity': 0.25, 'circle-blur': 0.8, 'circle-pitch-alignment': 'map' } },
      {
        id: 'nav-next',
        source: SOURCES.next,
        type: 'circle',
        paint: { 'circle-radius': 8, 'circle-color': '#000', 'circle-stroke-color': PINK, 'circle-stroke-width': 3, 'circle-pitch-alignment': 'map' },
      },
    ];
    for (const layer of layers) map.addLayer(layer, before);
  }

  const lineFeature = (coords) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} });

  function drawRoute() {
    ensureLayers();
    map.getSource(SOURCES.full).setData(lineFeature(route.line.coords));
    map.getSource(SOURCES.left).setData(lineFeature(route.line.coords));
    map.getSource(SOURCES.next).setData({ type: 'FeatureCollection', features: [] });
  }

  function clearRoute() {
    if (!map.getSource(SOURCES.full)) return;
    const empty = { type: 'FeatureCollection', features: [] };
    for (const id of Object.values(SOURCES)) map.getSource(id).setData(empty);
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
    spoken = new Set();
    shownStep = -1;
    shownItems = '';
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
    camZoom = 17.2;
    follow = true;
    setMode('driving');
    buildSimStops();
    renderButtons();
    applyPadding();
    ui.recenter.hidden = true;
    carMarker.setLngLat(position).setRotation(heading).addTo(map);
    map.jumpTo({ center: position, bearing: camBearing, pitch: PITCH, zoom: camZoom });

    if (!simulated) startGps();
    requestWakeLock();
    say(route.steps[0]?.text ?? 'Comenzamos');
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
    say('Recalculando');
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

    // Chase camera: turns with the car, pulls back as you go faster.
    const kmh = speed * 3.6;
    const zoomTarget = 17.4 - Math.min(1, Math.max(0, (kmh - 30) / 70)) * 1.6;
    camZoom += (zoomTarget - camZoom) * Math.min(1, dt * 1.5);
    camBearing += angleDiff(camBearing, heading) * Math.min(1, dt * 2.5);
    if (!follow && resumeFollowAt && now > resumeFollowAt) {
      follow = true;
      resumeFollowAt = 0;
    }
    if (follow) map.jumpTo({ center: position, bearing: camBearing, pitch: PITCH, zoom: camZoom });

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

  function updateHud(kmh) {
    const { line, steps } = route;

    // Next maneuver
    let k = steps.findIndex((s, i) => i > 0 && s.along > along + 2);
    if (k < 0) k = steps.length - 1;
    const step = steps[k];
    const toTurn = step.along - along;
    if (k !== shownStep) {
      shownStep = k;
      ui.turnIcon.innerHTML = maneuverIcon(step);
      ui.turnText.textContent = step.text;
      ui.turn.classList.remove('is-new');
      void ui.turn.offsetWidth; // restart the flash animation
      ui.turn.classList.add('is-new');
      const then = steps[k + 1];
      ui.then.hidden = !(then && then.along - step.along < 150 && step.type !== 'arrive');
      if (!ui.then.hidden) ui.thenIcon.innerHTML = maneuverIcon(then);
      const p = line.pointAt(step.along);
      map.getSource(SOURCES.next).setData({ type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: {} });
    }
    ui.turnDist.textContent = formatDistance(toTurn);
    ui.turn.classList.toggle('is-now', toTurn < 60);

    // Upcoming lights and signs
    const upcoming = route.items.filter((item) => item.along > along - 2).slice(0, 3);
    const key = upcoming.map((item) => item.id).join(',');
    if (key !== shownItems) {
      shownItems = key;
      ui.list.replaceChildren(
        ...upcoming.map((item) => {
          const li = document.createElement('li');
          li.className = `hud-item hud-item--${item.cat}`;
          li.innerHTML = '<img alt="" width="34" height="34"/><span class="hud-item__title"></span><b class="hud-item__dist"></b><i class="hud-item__bar"><i></i></i>';
          li.querySelector('img').src = iconDataUrl(item.icon);
          li.querySelector('.hud-item__title').textContent = item.title;
          return li;
        }),
      );
    }
    upcoming.forEach((item, i) => {
      const li = ui.list.children[i];
      const d = Math.max(0, item.along - along);
      li.querySelector('.hud-item__dist').textContent = formatDistance(d);
      li.querySelector('.hud-item__bar i').style.width = `${(1 - Math.min(d, 300) / 300) * 100}%`;
      li.classList.toggle('is-close', d < 60);
    });
    ui.empty.textContent = upcoming.length
      ? ''
      : route.detailsState === 'loading'
        ? 'Buscando semáforos y señales…'
        : route.detailsState === 'error'
          ? 'Sin datos de señales'
          : 'Vía libre';

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

    announce(k, step, toTurn, upcoming);
  }

  // ---------- Voice ----------

  function say(text) {
    if (!voiceOn || !('speechSynthesis' in window)) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'es-ES';
    const voice = speechSynthesis.getVoices().find((v) => v.lang.startsWith('es'));
    if (voice) utterance.voice = voice;
    speechSynthesis.speak(utterance);
  }

  function announce(k, step, toTurn, upcoming) {
    if (step.type !== 'arrive') {
      const far = Math.max(250, speed * 15);
      const near = Math.max(40, speed * 4);
      if (toTurn <= near && !spoken.has(`near${k}`)) {
        spoken.add(`near${k}`).add(`far${k}`);
        say(step.text);
      } else if (toTurn <= far && toTurn > near * 1.6 && !spoken.has(`far${k}`)) {
        spoken.add(`far${k}`);
        say(`En ${spokenDistance(toTurn)}, ${lowerFirst(step.text)}`);
      }
    }
    for (const item of upcoming) {
      const d = item.along - along;
      if (SPOKEN_ITEMS[item.cat] && d < 160 && d > 20 && !spoken.has(`item${item.id}`)) {
        spoken.add(`item${item.id}`);
        say(`${SPOKEN_ITEMS[item.cat]} a ${spokenDistance(d)}`);
      }
    }
  }

  // ---------- Camera follow ----------

  function applyPadding() {
    map.setPadding({ top: Math.round(map.getContainer().clientHeight * 0.42), bottom: 0, left: 0, right: 0 });
  }

  function setFollow(on) {
    ui.recenter.hidden = on;
    if (!on) {
      follow = false;
      resumeFollowAt = 0;
      return;
    }
    // Glide back behind the car, then lock on again.
    map.easeTo({ center: position, bearing: camBearing, pitch: PITCH, zoom: camZoom, duration: 700 });
    resumeFollowAt = performance.now() + 700;
  }

  for (const type of ['dragstart', 'rotatestart', 'pitchstart', 'zoomstart']) {
    map.on(type, (e) => {
      if (mode === 'driving' && e.originalEvent) setFollow(false);
    });
  }
  window.addEventListener('resize', () => {
    if (mode === 'driving') applyPadding();
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
    say('Has llegado a tu destino');
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
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    carMarker.remove();
    flagMarker.remove();
    clearRoute();
    route = null;
    sim = null;
    shownStep = -1;
    shownItems = '';
    ui.toast.hidden = true;
    setMode('off');
    traffic.setPaused(false);
    map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    if (wasDriving) map.easeTo({ pitch: 0, bearing: 0, zoom: Math.min(map.getZoom(), 16), duration: 1000 });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mode !== 'off' && document.activeElement?.tagName !== 'INPUT') exit();
  });

  renderButtons();

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
