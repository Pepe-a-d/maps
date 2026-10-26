import * as maplibregl from 'maplibre-gl';
import { angleDiff, bearing, distance, lerp } from './geo.js';
import {
  NoRouteError,
  ROUTE_MODES,
  countLights,
  fewestLights,
  formatDistance,
  loadRouteDetails,
  maneuverIcon,
  findRoute,
  matchItems,
  remainingSeconds,
  turnSpeed,
} from './routing.js';
import { settings } from './settings.js';
import { iconDataUrl } from './traffic.js';

// Driving mode in the style of a racing game HUD: the map fills the screen like
// the game world, turning with you, and the HUD floats on top — the next sign
// as a big notification card (the star of the show), the next turn, and a round
// speedometer with the speed limit. Clock and lamps, the signs after the next
// one and trip data are optional (settings). A simulator drives the route from a desk.

const ROUTE_COLOR = '#ff2d8a';
const SIM_SPEEDS = [1, 2, 4];
const GAUGE_MAX_KMH = 160;
const ARRIVE_M = 15;
const OFF_ROUTE_M = 30;
const ITEMS_AHEAD_M = 2000; // how far ahead the map shows lights and signs
const RADAR_LAMP_M = 300;
const CAR_Y = 0.64; // where you sit on screen, from the top

// The speedometer's arc (270°, open at the bottom) and the ring of ticks around it.
const GAUGE_ARC = 'M26.1 93.9A48 48 0 1 1 93.9 93.9';
const GAUGE_TICKS = 'M21.1 98.9A55 55 0 1 1 98.9 98.9';

const SOURCES = { full: 'nav-full', left: 'nav-left', next: 'nav-next', items: 'nav-items' };

// Colour per kind of item, shared by the map discs and the HUD tiles.
const CAT_COLOR = {
  signals: '#ffc93c',
  stop: '#ff4d4d',
  give_way: '#ff4d4d',
  rail: '#ff4d4d',
  camera: '#ff9a3c',
  calming: '#ff9a3c',
  crossing: '#4c8dff',
  sign: '#f4f4f1',
};

const ICONS = {
  pause: '<svg viewBox="0 0 24 24"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15L19.5 12z" fill="currentColor"/></svg>',
  close:
    '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>',
  car: '<svg viewBox="0 0 48 48" width="44" height="44"><path d="M24 4 40 42 24 33 8 42Z" fill="#f4f4f1"/></svg>',
  gps: '<svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7Zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5Z" fill="currentColor"/></svg>',
  radar:
    '<svg viewBox="0 0 24 24"><path d="M4 8h12l2-3h2v14h-2l-2-3H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Zm5 2.2A1.8 1.8 0 1 0 9 13.8a1.8 1.8 0 0 0 0-3.6Z" fill="currentColor" fill-rule="evenodd"/></svg>',
  limit:
    '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 3.2a5.8 5.8 0 1 1 0 11.6 5.8 5.8 0 0 1 0-11.6Z" fill="currentColor" fill-rule="evenodd"/><path d="M11 8.5h2v4.5h-2zM11 14.5h2v2h-2z" fill="currentColor"/></svg>',
};

const formatDuration = (s) =>
  s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
const clock = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const timeOfDay = (date) => date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

// "120 m" → ["120", "m"], to draw the number big and the unit small.
const splitDistance = (m) => formatDistance(m).split(' ');

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

  // Bike state
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
        <p class="nav-label">Ruta</p>
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
        <div class="hud-left">
          <div class="hud-sign">
            <div class="hud-sign__main" hidden>
              <span class="hud-sign__badge"><img class="hud-sign__icon" alt="" width="72" height="72"/></span>
              <div class="hud-sign__body">
                <div class="hud-sign__title"></div>
                <div class="hud-sign__dist"><b></b><small></small></div>
              </div>
            </div>
            <p class="hud-sign__empty"></p>
            <i class="hud-sign__bar"><i></i></i>
          </div>
          <ol class="hud-more"></ol>
        </div>

        <div class="hud-turn">
          <div class="hud-turn__icon"></div>
          <div class="hud-turn__dist"><b></b><small></small></div>
        </div>

        <div class="hud-right">
          <header class="hud-status">
            <b class="hud-status__clock">--:--</b>
            <span class="hud-lamps">
              <i class="lamp lamp--gps" title="GPS">${ICONS.gps}</i>
              <i class="lamp lamp--radar" title="Radar cerca">${ICONS.radar}</i>
              <i class="lamp lamp--limit" title="Por encima del límite">${ICONS.limit}</i>
              <i class="lamp lamp--sim" title="Simulación">SIM</i>
            </span>
          </header>
          <dl class="hud-trip">
            <div><dt>Llegada</dt><dd data-f="eta">--:--</dd></div>
            <div><dt>Restante</dt><dd data-f="time">-</dd></div>
            <div><dt>Distancia</dt><dd data-f="dist">-</dd></div>
          </dl>
        </div>

        <div class="hud-speed">
          <img class="hud-limit" alt="" width="56" height="56" hidden/>
          <div class="hud-gauge">
            <svg viewBox="0 0 120 120" aria-hidden="true">
              <path class="hud-gauge__track" d="${GAUGE_ARC}" pathLength="100"/>
              <path class="hud-gauge__zone" d="${GAUGE_ARC}" pathLength="100"/>
              <path class="hud-gauge__value" d="${GAUGE_ARC}" pathLength="100"/>
              <path class="hud-gauge__ticks" d="${GAUGE_TICKS}" pathLength="100"/>
            </svg>
            <b class="hud-speed__num">0</b>
            <small class="hud-speed__unit">km/h</small>
          </div>
        </div>

        <div class="hud-controls">
          <button class="hud-btn sim-only" data-act="pause" aria-label="Pausa"></button>
          <button class="hud-btn sim-only hud-btn--text" data-act="simspeed" aria-label="Velocidad de simulación"></button>
          <button class="hud-btn hud-btn--exit" data-act="exit" aria-label="Salir">${ICONS.close}</button>
        </div>

        <button class="nav-btn hud-recenter" data-act="recenter" hidden>Recentrar</button>
        <div class="hud-toast" hidden></div>
      </section>

      <section class="nav-finish">
        <div class="nav-finish__card">
          <p class="nav-label">Ruta completada</p>
          <h2 class="nav-finish__title">Destino alcanzado</h2>
          <dl class="nav-finish__stats"></dl>
          <button class="nav-btn nav-btn--go" data-act="exit">Volver al mapa</button>
        </div>
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
      clock: $('.hud-status__clock'),
      lampGps: $('.lamp--gps'),
      lampRadar: $('.lamp--radar'),
      lampLimit: $('.lamp--limit'),
      turn: $('.hud-turn'),
      turnIcon: $('.hud-turn__icon'),
      turnNum: $('.hud-turn__dist b'),
      turnUnit: $('.hud-turn__dist small'),
      sign: $('.hud-sign'),
      signMain: $('.hud-sign__main'),
      signIcon: $('.hud-sign__icon'),
      signNum: $('.hud-sign__dist b'),
      signUnit: $('.hud-sign__dist small'),
      signTitle: $('.hud-sign__title'),
      signBar: $('.hud-sign__bar i'),
      signEmpty: $('.hud-sign__empty'),
      more: $('.hud-more'),
      speedTile: $('.hud-speed'),
      gaugeValue: $('.hud-gauge__value'),
      gaugeZone: $('.hud-gauge__zone'),
      speedNum: $('.hud-speed__num'),
      limit: $('.hud-limit'),
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
    // On the road: black map only.
    if (driving !== wasDriving) basemap.force(driving ? 'map' : null);
  }

  // Optional bits of the HUD, off unless switched on in the settings.
  function applyHudSettings() {
    ui.root.classList.toggle('show-status', settings.get('hudStatus'));
    ui.root.classList.toggle('show-more', settings.get('hudMoreSigns'));
    ui.root.classList.toggle('show-trip', settings.get('hudTrip'));
    if (mode === 'driving') requestAnimationFrame(applyLayout);
  }
  settings.onChange((key) => {
    if (key.startsWith('hud')) applyHudSettings();
  });

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
    const lights = route.items.filter((item) => item.cat === 'signals').length;
    const cameras = route.items.filter((item) => item.cat === 'camera').length;
    const found =
      route.detailsState === 'done'
        ? [lights ? `${lights} ${lights === 1 ? 'semáforo' : 'semáforos'}` : 'Sin semáforos', cameras && `${cameras} ${cameras === 1 ? 'radar' : 'radares'}`]
        : [route.detailsState === 'loading' && 'buscando semáforos…'];
    const modeLabel = ROUTE_MODES.find((m) => m.id === settings.get('routeMode'))?.label;
    sheet({
      summary: `${formatDistance(route.line.length)} · ${formatDuration(route.duration)}`,
      extras: [modeLabel, route.lightsNote ?? '', ...found].filter(Boolean).join(' · '),
      note: origin.gps ? '' : 'Sin GPS: sale del punto que elegiste. Puedes simularla.',
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
    ctx.lineWidth = 4;
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(11, 7);
    ctx.lineTo(21, 16);
    ctx.lineTo(11, 25);
    ctx.stroke();
    map.addImage('nav-chevron', ctx.getImageData(0, 0, 32, 32), { pixelRatio: 2 });

    const before = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
    const width = (min, max) => ['interpolate', ['exponential', 1.5], ['zoom'], 12, min, 18, max];
    const round = { 'line-join': 'round', 'line-cap': 'round' };
    const catColor = ['match', ['get', 'cat'], ...Object.entries(CAT_COLOR).flat(), '#ffffff'];
    const routeLayers = [
      { id: 'nav-done', source: SOURCES.full, type: 'line', layout: round, paint: { 'line-color': '#3a3e46', 'line-width': width(3, 10) } },
      { id: 'nav-line', source: SOURCES.left, type: 'line', layout: round, paint: { 'line-color': ROUTE_COLOR, 'line-width': width(5, 16) } },
      {
        id: 'nav-arrows',
        source: SOURCES.left,
        type: 'symbol',
        layout: {
          'symbol-placement': 'line',
          'symbol-spacing': 80,
          'icon-image': 'nav-chevron',
          'icon-size': ['interpolate', ['linear'], ['zoom'], 14, 0.45, 18, 0.9],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'icon-rotation-alignment': 'map',
        },
        paint: { 'icon-opacity': 0.75 },
      },
      { id: 'nav-next', source: SOURCES.next, type: 'circle', paint: { 'circle-radius': 8, 'circle-color': '#f4f4f1' } },
    ];
    for (const layer of routeLayers) map.addLayer(layer, before);

    // Lights and signs on the route go on top of everything, big, on a flat disc.
    const itemLayers = [
      {
        id: 'nav-items-disc',
        source: SOURCES.items,
        type: 'circle',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 13, 18, 34],
          'circle-color': catColor,
          'circle-opacity': ['case', ['==', ['get', 'next'], true], 0.5, 0.2],
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
    // Leave room for the sheet: below the route, or beside it on a phone held sideways.
    const box = ui.root.querySelector('.nav-sheet').getBoundingClientRect();
    const { clientWidth: w, clientHeight: h } = map.getContainer();
    const beside = box.left > w / 2;
    map.fitBounds(bounds, {
      padding: beside
        ? { top: 40, left: 40, right: w - box.left + 30, bottom: 40 }
        : { top: 80, left: 40, right: 80, bottom: h - box.top + 30 },
      maxZoom: 17,
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
    traffic.setDriving(true);
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
      const { route: next, candidates } = await findRoute(origin.lngLat, dest.lngLat, settings.get('routeMode'), abort.signal);
      if (mode !== 'routing') return;
      const comparing = candidates?.length > 1;
      // While comparing, hold the sign download: it's for whichever route wins.
      setRoute(next, !comparing);
      setMode('preview');
      refreshSheet();
      fitRoute();
      if (comparing) pickFewestLights(next, candidates);
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error(err);
      setMode('preview');
      sheet({ summary: err instanceof NoRouteError ? err.message : 'No se pudo calcular la ruta. Inténtalo de nuevo.' });
    }
  }

  // "No lights": show the quickest route at once, then switch to the one with
  // fewer lights when the count arrives (if you haven't set off yet).
  async function pickFewestLights(shown, candidates) {
    shown.lightsNote = 'comparando rutas…';
    refreshSheet();
    let best = shown;
    try {
      const counts = await countLights(candidates);
      best = candidates[fewestLights(candidates, counts)];
    } catch {
      // Keep the quickest.
    }
    shown.lightsNote = null;
    if (route !== shown || mode !== 'preview') return;
    if (best !== shown) {
      setRoute(best);
      fitRoute();
    } else if (!shown.detailsState) {
      loadDetails(shown);
    }
    refreshSheet();
  }

  function setRoute(next, withDetails = true) {
    route = next;
    along = 0;
    shownStep = -1;
    shownItems = '';
    shownMapItems = '';
    drawRoute();
    if (withDetails) loadDetails(next);
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
    if (!route.detailsState) loadDetails(route); // set off before the light count came back
    stats = { time: 0, dist: 0, maxSpeed: 0, start: performance.now() };
    sim = simulated ? { mult: 1, paused: false, wait: 0, stops: [] } : null;
    along = 0;
    speed = 0;
    position = route.line.coords[0];
    heading = camBearing = route.line.bearingAt(0);
    camZoom = 17.4;
    follow = true;
    setMode('driving');
    applyHudSettings();
    buildSimStops();
    renderButtons();
    ui.recenter.hidden = true;
    carMarker.setLngLat(position).setRotation(heading).addTo(map);
    applyLayout();
    map.jumpTo({ center: position, bearing: camBearing, zoom: camZoom });

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
      setRoute((await findRoute(from, dest.lngLat, settings.get('routeMode'))).route);
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

    // Top-down camera that turns with the bike and zooms out with speed.
    const kmh = speed * 3.6;
    const zoomTarget = 17.4 - Math.min(1, Math.max(0, (kmh - 30) / 70)) * 1.5;
    camZoom += (zoomTarget - camZoom) * Math.min(1, dt * 1.5);
    camBearing = (camBearing + angleDiff(camBearing, heading) * Math.min(1, dt * 2.5) + 360) % 360;
    if (!follow && resumeFollowAt && now > resumeFollowAt) {
      follow = true;
      resumeFollowAt = 0;
    }
    if (follow) map.jumpTo({ center: position, bearing: camBearing, zoom: camZoom });

    if (now - lastHud > 150) {
      lastHud = now;
      updateHud(kmh, now);
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

  function updateHud(kmh, now) {
    const { line, steps } = route;

    ui.clock.textContent = timeOfDay(new Date());

    // Next turn: just the arrow and how far.
    let k = steps.findIndex((s, i) => i > 0 && s.along > along + 2);
    if (k < 0) k = steps.length - 1;
    const step = steps[k];
    const toTurn = step.along - along;
    if (k !== shownStep) {
      shownStep = k;
      ui.turnIcon.innerHTML = maneuverIcon(step);
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
    ui.signMain.hidden = !next;
    if (key !== shownItems) {
      shownItems = key;
      if (next) {
        ui.sign.style.setProperty('--c', CAT_COLOR[next.cat]);
        ui.signIcon.src = iconDataUrl(next.icon);
        ui.signTitle.textContent = next.title;
      }
      ui.more.replaceChildren(
        ...more.map((item) => {
          const li = document.createElement('li');
          li.className = 'tile';
          li.style.setProperty('--c', CAT_COLOR[item.cat]);
          li.innerHTML = '<img alt="" width="36" height="36"/><b></b>';
          li.querySelector('img').src = iconDataUrl(item.icon);
          li.title = item.title;
          return li;
        }),
      );
    }
    const toSign = next ? Math.max(0, next.along - along) : Infinity;
    if (next) {
      setDistance(ui.signNum, ui.signUnit, toSign);
      ui.signBar.style.width = `${(1 - Math.min(toSign, 300) / 300) * 100}%`;
    } else {
      ui.signBar.style.width = '0';
    }
    ui.sign.classList.toggle('is-close', toSign < 60);
    more.forEach((item, i) => {
      ui.more.children[i].querySelector('b').textContent = formatDistance(Math.max(0, item.along - along));
    });
    ui.signEmpty.textContent = next
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

    // Speed: big number, the arc filling up, and past the limit the red zone.
    const seg = line.segmentAt(along);
    const limit = route.limits?.[seg];
    const over = Boolean(limit && kmh > limit + 3);
    ui.speedNum.textContent = Math.round(kmh);
    ui.speedTile.classList.toggle('is-over', over);
    ui.gaugeValue.style.strokeDasharray = `${Math.min(1, kmh / GAUGE_MAX_KMH) * 100} 100`;
    const limitAt = limit ? Math.min(1, limit / GAUGE_MAX_KMH) * 100 : 100;
    ui.gaugeZone.style.strokeDasharray = `${100 - limitAt} 100`;
    ui.gaugeZone.style.strokeDashoffset = `${-limitAt}`;
    ui.limit.hidden = !limit;
    if (limit) {
      const src = iconDataUrl(`tr-speed-${limit}`);
      if (ui.limit.getAttribute('src') !== src) ui.limit.src = src;
    }

    // Warning lamps
    const fresh = gps?.time && now - gps.time < 5000;
    ui.lampGps.classList.toggle('on', Boolean(fresh));
    ui.lampRadar.classList.toggle(
      'on',
      upcoming.some((item) => item.cat === 'camera' && item.along - along < RADAR_LAMP_M),
    );
    ui.lampLimit.classList.toggle('on', over);

    // Trip
    const left = remainingSeconds(route, along);
    ui.eta.textContent = timeOfDay(new Date(Date.now() + left * 1000));
    ui.time.textContent = formatDuration(left);
    ui.dist.textContent = formatDistance(line.length - along);

    // Throttle the remaining-route redraw along with the HUD.
    map.getSource(SOURCES.left).setData(lineFeature(line.sliceFrom(along)));
  }

  // ---------- Camera follow ----------

  // You sit low on screen, so more of the road ahead is in view.
  function applyLayout() {
    const h = map.getContainer().clientHeight;
    map.setPadding({ top: Math.round(h * (2 * CAR_Y - 1)), bottom: 0, left: 0, right: 0 });
  }

  function setFollow(on) {
    ui.recenter.hidden = on;
    if (!on) {
      follow = false;
      resumeFollowAt = 0;
      return;
    }
    // Glide back over the bike, then lock on again.
    map.easeTo({ center: position, bearing: camBearing, zoom: camZoom, duration: 700 });
    resumeFollowAt = performance.now() + 700;
  }

  for (const type of ['dragstart', 'zoomstart']) {
    map.on(type, (e) => {
      if (mode === 'driving' && e.originalEvent) setFollow(false);
    });
  }
  window.addEventListener('resize', () => {
    if (mode === 'driving') requestAnimationFrame(applyLayout);
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
    const avg = stats.time ? (stats.dist / stats.time) * 3.6 : 0;
    const rows = [
      ['Tiempo', clock(stats.time)],
      ['Distancia', formatDistance(stats.dist)],
      ['Vel. media', `${Math.round(avg)} km/h`],
      ['Vel. máxima', `${Math.round(stats.maxSpeed * 3.6)} km/h`],
    ];
    ui.finishStats.replaceChildren(
      ...rows.map(([label, value]) => {
        const tile = document.createElement('div');
        tile.className = 'tile';
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        dd.textContent = value;
        tile.append(dt, dd);
        return tile;
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
    setMode('off');
    traffic.setDriving(false);
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
