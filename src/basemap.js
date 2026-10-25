import { lngLatToTile } from './tiles.js';

// Satellite imagery (Esri World Imagery, free, no key) that can replace the black
// map underneath, keeping place and street names on top like a "hybrid" view.

const SATELLITE_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
// Raster version of the dark map, only used for the switch's thumbnail.
const MAP_TILES = 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png';

const SOURCE = 'satellite';
const LAYER = 'satellite';
const STORAGE_KEY = 'maps-basemap';

// Map layers that cover the imagery: land, water, buildings and road lines.
// Labels and borders stay visible in satellite mode.
const coversImagery = (layer) => layer.type === 'fill' || (layer.type === 'line' && !layer.id.startsWith('boundary'));

function savedMode() {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'satellite' ? 'satellite' : 'map';
  } catch {
    return 'map';
  }
}

// Adds the imagery to the style before the map is created, already in the
// mode you left it in so there's no flash of the other one.
export function addSatellite(style) {
  const satellite = savedMode() === 'satellite';

  style.sources[SOURCE] = {
    type: 'raster',
    tiles: [SATELLITE_TILES],
    tileSize: 256,
    maxzoom: 19,
    attribution: 'Imágenes © Esri, Maxar, Earthstar Geographics',
  };

  for (const layer of style.layers) {
    if (satellite && coversImagery(layer)) layer.layout = { ...layer.layout, visibility: 'none' };
  }

  const background = style.layers.findIndex((layer) => layer.type === 'background');
  style.layers.splice(background + 1, 0, {
    id: LAYER,
    type: 'raster',
    source: SOURCE,
    layout: { visibility: satellite ? 'visible' : 'none' },
    paint: { 'raster-fade-duration': 150 },
  });
}

export function setupBasemapSwitch(map) {
  let mode = savedMode();
  let forced = null; // driving mode always shows the black map

  // The base style's covering layers, captured before the app adds its own
  // (route lines are lines too, and must stay visible).
  let covering = [];
  map.once('load', () => {
    covering = map.getStyle().layers.filter(coversImagery).map((layer) => layer.id);
  });

  function apply() {
    const satellite = (forced ?? mode) === 'satellite';
    map.setLayoutProperty(LAYER, 'visibility', satellite ? 'visible' : 'none');
    for (const id of covering) map.setLayoutProperty(id, 'visibility', satellite ? 'none' : 'visible');
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'basemap';
  button.innerHTML = '<img alt="" width="64" height="64" /><span></span>';
  const img = button.querySelector('img');
  const label = button.querySelector('span');
  document.body.append(button);

  // The thumbnail previews the *other* view of the place you're looking at.
  function updateThumbnail() {
    const z = Math.max(0, Math.min(17, Math.round(map.getZoom()) - 1));
    const c = map.getCenter();
    const [x, y] = lngLatToTile(c.lng, c.lat, z).map(Math.floor);
    const template = mode === 'satellite' ? MAP_TILES : SATELLITE_TILES;
    const url = template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    if (img.src !== url) img.src = url;
  }

  function render() {
    label.textContent = mode === 'satellite' ? 'Mapa' : 'Satélite';
    button.setAttribute('aria-label', mode === 'satellite' ? 'Cambiar a vista de mapa' : 'Cambiar a vista satélite');
    updateThumbnail();
  }

  button.addEventListener('click', () => {
    mode = mode === 'satellite' ? 'map' : 'satellite';
    apply();
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // Not remembered next time; no big deal.
    }
    render();
  });

  map.on('moveend', updateThumbnail);
  render();

  return {
    // 'map' or 'satellite' overrides the viewer's choice; null hands it back.
    force(next) {
      forced = next;
      if (map.getLayer(LAYER)) apply();
    },
  };
}
