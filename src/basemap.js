import { settings } from './settings.js';

// Satellite imagery (Esri World Imagery, free, no key) that can replace the black
// map underneath, keeping place and street names on top like a "hybrid" view.
// Which one shows is a setting.

const SATELLITE_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

const SOURCE = 'satellite';
const LAYER = 'satellite';

// Map layers that cover the imagery: land, water, buildings and road lines.
// Labels and borders stay visible in satellite mode.
const coversImagery = (layer) => layer.type === 'fill' || (layer.type === 'line' && !layer.id.startsWith('boundary'));

// Adds the imagery to the style before the map is created, already in the
// chosen mode so there's no flash of the other one.
export function addSatellite(style) {
  const satellite = settings.get('mapStyle') === 'satellite';

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

export function setupBasemap(map) {
  let forced = null; // driving mode always shows the black map

  // The base style's covering layers, captured before the app adds its own
  // (route lines are lines too, and must stay visible).
  let covering = [];
  map.once('load', () => {
    covering = map.getStyle().layers.filter(coversImagery).map((layer) => layer.id);
  });

  function apply() {
    if (!map.getLayer(LAYER)) return;
    const satellite = (forced ?? settings.get('mapStyle')) === 'satellite';
    map.setLayoutProperty(LAYER, 'visibility', satellite ? 'visible' : 'none');
    for (const id of covering) map.setLayoutProperty(id, 'visibility', satellite ? 'none' : 'visible');
  }

  settings.onChange((key) => {
    if (key === 'mapStyle') apply();
  });

  return {
    // 'map' or 'satellite' overrides the setting; null hands it back.
    force(next) {
      forced = next;
      apply();
    },
  };
}
