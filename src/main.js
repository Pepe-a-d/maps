import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { setupTraffic, TRAFFIC_LAYER } from './traffic.js';
import { addSatellite, setupBasemap } from './basemap.js';
import { setupDriving } from './drive.js';
import { setupSettingsPanel } from './panel.js';
import { placeGlyph, setupPlaces } from './places.js';
import { showSplash } from './splash.js';

// MapLibre 6 finds its worker next to its own file, which Vite moves; point at it explicitly.
maplibregl.setWorkerUrl(workerUrl);

// Base: CARTO Dark Matter (free, no API key). We repaint it on top of pure black.
const STYLE_URL = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const GEOCODER_URL = 'https://photon.komoot.io/api/';

const COLORS = {
  land: '#000000',
  water: '#0c1419',
  buildings: '#111114',
};

// Zoom to use when a search result has no bounding box.
const ZOOM_BY_TYPE = {
  country: 4.5,
  state: 6.5,
  county: 8,
  city: 11,
  district: 13,
  locality: 14,
  street: 16,
  house: 17.5,
};

const mapEl = document.getElementById('map');
const searchInput = document.getElementById('search-input');
const resultsEl = document.getElementById('search-results');

// ---------- Style ----------

// Walk any paint value (plain colors, stops, expressions) and swap the
// Dark Matter base grey for pure black.
function blacken(value) {
  if (typeof value === 'string') return value.toLowerCase() === '#0e0e0e' ? COLORS.land : value;
  if (Array.isArray(value)) return value.map(blacken);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, blacken(v)]));
  }
  return value;
}

async function loadStyle() {
  const res = await fetch(STYLE_URL);
  if (!res.ok) throw new Error(`Style request failed: ${res.status}`);
  const style = await res.json();

  for (const layer of style.layers) {
    if (layer.paint) layer.paint = blacken(layer.paint);
    if (layer.id === 'water') layer.paint['fill-color'] = COLORS.water;
    if (layer.id === 'building-top') layer.paint['fill-color'] = COLORS.buildings;
  }

  addSatellite(style);
  return style;
}

// ---------- Map ----------

// The start screen goes up at once; the map loads behind it meanwhile.
const started = showSplash();
const sharedView = Boolean(location.hash); // a link that already says where to look

let map;
try {
  // A flat, north-up map: no globe, no tilting, no rotating by hand.
  // (Driving mode still turns it with the bike.)
  map = new maplibregl.Map({
    container: mapEl,
    style: await loadStyle(),
    center: [8, 45],
    zoom: 4,
    hash: true,
    attributionControl: { compact: true },
    maxPitch: 0,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
} catch (err) {
  console.error(err);
  mapEl.innerHTML = '<p class="map-error">No se pudo cargar el mapa. Revisa la conexión y recarga.</p>';
  throw err;
}

const mapReady = new Promise((resolve) => map.once('load', resolve));

// The only control on the map: go to where you are. Zoom is by pinch or wheel.
const geolocate = new maplibregl.GeolocateControl({
  positionOptions: { enableHighAccuracy: true },
  trackUserLocation: true,
});
map.addControl(geolocate, 'bottom-right');

// The credits stay one tap away instead of open on the map.
mapReady.then(() => map.getContainer().querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));

const traffic = setupTraffic(map);
const basemap = setupBasemap(map);
const drive = setupDriving(map, traffic, basemap);
const goTo = (place) => {
  pin.remove(); // a pin left from before would only get in the way
  drive.planTo([place.lng, place.lat], place.name);
};
const places = setupPlaces(map, { onGo: goTo });
const settingsPanel = setupSettingsPanel({ traffic, places, onGo: goTo });
document.getElementById('settings-button').addEventListener('click', () => settingsPanel.open());

// ---------- Pin ----------

const pinEl = document.createElement('div');
pinEl.className = 'pin';
const pin = new maplibregl.Marker({ element: pinEl });
// Clicks elsewhere move the pin, so the popup doesn't close itself on them.
const popup = new maplibregl.Popup({ offset: 16, maxWidth: '280px', closeOnClick: false });
pin.setPopup(popup);
popup.on('close', () => pin.remove());

function dropPin(lngLat, title) {
  const { lng, lat } = maplibregl.LngLat.convert(lngLat);

  const box = document.createElement('div');
  box.className = 'pin-popup';
  if (title) {
    const name = document.createElement('strong');
    name.textContent = title;
    box.append(name);
  }

  const actions = document.createElement('div');
  actions.className = 'pin-popup__actions';
  const goBtn = document.createElement('button');
  goBtn.className = 'pin-popup__go';
  goBtn.textContent = 'Ir aquí';
  goBtn.onclick = () => {
    pin.remove();
    drive.planTo([lng, lat], title || 'Punto en el mapa');
  };
  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Guardar';
  saveBtn.onclick = () => {
    pin.remove();
    places.save([lng, lat], title);
  };
  actions.append(goBtn, saveBtn);

  box.append(actions);
  popup.setDOMContent(box);
  pin.setLngLat([lng, lat]).addTo(map);
  if (!popup.isOpen()) pin.togglePopup();
}

map.on('click', (e) => {
  if (drive.handleClick(e.lngLat)) return;
  // A click on a traffic light, sign, etc. opens that icon's popup instead.
  if (map.getLayer(TRAFFIC_LAYER) && map.queryRenderedFeatures(e.point, { layers: [TRAFFIC_LAYER] }).length) return;
  dropPin(e.lngLat);
});

// ---------- Search: your saved places first, then Photon ----------

let results = []; // { place } or { feature }
let active = -1;
let pending;
let debounce;

function describe(feature) {
  const p = feature.properties;
  const name = p.name || [p.street, p.housenumber].filter(Boolean).join(' ') || p.city || p.country;
  const detail = [...new Set([p.city, p.state, p.country])].filter((part) => part && part !== name);
  return { name, detail: detail.join(', ') };
}

const placeResults = (query) =>
  places
    .find(query)
    .slice(0, 4)
    .map((place) => ({ place }));

function renderResults() {
  resultsEl.replaceChildren();
  const query = searchInput.value.trim();
  if (!query && !results.length) {
    resultsEl.hidden = true;
    return;
  }
  const note = (text) => {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = text;
    resultsEl.append(li);
  };
  if (!query) note('Tus sitios');
  else if (!results.length) note('Sin resultados');

  results.forEach((result, i) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(i === active));
    li.innerHTML = '<span class="badge"></span><span class="text"><span class="name"></span><span class="detail"></span></span>';
    if (result.place) {
      const type = places.typeOf(result.place);
      const badge = li.querySelector('.badge');
      badge.innerHTML = placeGlyph(type.id);
      badge.style.setProperty('--c', type.color);
      li.querySelector('.name').textContent = result.place.name;
      li.querySelector('.detail').textContent = type.label;
    } else {
      const { name, detail } = describe(result.feature);
      li.querySelector('.name').textContent = name;
      li.querySelector('.detail').textContent = detail;
    }
    li.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep focus so the blur handler doesn't hide the list first
      choose(i);
    });
    resultsEl.append(li);
  });
  resultsEl.hidden = false;
}

async function search(query) {
  pending?.abort();
  pending = new AbortController();

  const params = new URLSearchParams({ q: query, limit: '6' });
  // Prefer places near what you're looking at once you've zoomed in a bit.
  if (map.getZoom() >= 4) {
    const c = map.getCenter();
    params.set('lat', c.lat.toFixed(4));
    params.set('lon', c.lng.toFixed(4));
  }

  let features = [];
  try {
    const res = await fetch(`${GEOCODER_URL}?${params}`, { signal: pending.signal });
    const data = await res.json();
    features = data.features ?? [];
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error(err);
  }
  results = [...placeResults(query), ...features.map((feature) => ({ feature }))];
  active = results.length ? 0 : -1;
  renderResults();
}

function choose(i) {
  const result = results[i];
  if (!result) return;
  resultsEl.hidden = true;
  searchInput.blur();

  // A saved place: straight to the route.
  if (result.place) {
    searchInput.value = '';
    goTo(result.place);
    return;
  }

  const { feature } = result;
  const { name } = describe(feature);
  const [lng, lat] = feature.geometry.coordinates;
  const extent = feature.properties.extent; // [minLon, maxLat, maxLon, minLat]

  if (extent) {
    map.fitBounds(
      [
        [extent[0], extent[3]],
        [extent[2], extent[1]],
      ],
      { padding: 80, maxZoom: 16, duration: 2500 },
    );
  } else {
    map.flyTo({ center: [lng, lat], zoom: ZOOM_BY_TYPE[feature.properties.type] ?? 15, duration: 2500 });
  }
  dropPin([lng, lat], name);
  searchInput.value = name;
}

// With an empty box, the list shows your saved places.
function showSavedPlaces() {
  results = places
    .all()
    .slice(0, 8)
    .map((place) => ({ place }));
  active = -1;
  renderResults();
}

searchInput.addEventListener('input', () => {
  clearTimeout(debounce);
  const query = searchInput.value.trim();
  if (!query) {
    pending?.abort();
    showSavedPlaces();
    return;
  }
  // Saved places answer at once; the geocoder catches up.
  results = placeResults(query);
  active = results.length ? 0 : -1;
  renderResults();
  debounce = setTimeout(() => search(query), 250);
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!results.length) return;
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    active = (active + step + results.length) % results.length;
    renderResults();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    choose(Math.max(active, 0));
  } else if (e.key === 'Escape') {
    if (searchInput.value) {
      searchInput.value = '';
      showSavedPlaces();
    } else {
      searchInput.blur();
    }
  }
});

searchInput.addEventListener('focus', () => {
  if (!searchInput.value.trim()) showSavedPlaces();
  else if (results.length) renderResults();
});
searchInput.addEventListener('blur', () => {
  resultsEl.hidden = true;
});

// "/" jumps to the search box from anywhere.
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== searchInput) {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});

// ---------- Start ----------

// Once the engine's on, go to where you are (unless a shared link says otherwise).
started.then(async () => {
  await mapReady;
  if (!sharedView) geolocate.trigger();
});
