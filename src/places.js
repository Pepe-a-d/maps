import * as maplibregl from 'maplibre-gl';

// Saved places, drawn like locations on a video game map: a floating diamond
// with the place's glyph, its name underneath, and a "new location" banner
// when you save one. Tapping one plans the route there. Stored in this browser only.

const STORAGE_KEY = 'maps-places';
const LABEL_MIN_ZOOM = 12;

export const PLACE_TYPES = [
  { id: 'home', label: 'Casa', color: '#4c8dff', glyph: '<path d="M12 3.5 2.5 11.5H5V20h5.5v-5.5h3V20H19v-8.5h2.5z"/>' },
  {
    id: 'work',
    label: 'Trabajo',
    color: '#9b7bff',
    glyph: '<path fill-rule="evenodd" d="M9 4h6a1.5 1.5 0 0 1 1.5 1.5V7H20a1.5 1.5 0 0 1 1.5 1.5v10A1.5 1.5 0 0 1 20 20H4a1.5 1.5 0 0 1-1.5-1.5v-10A1.5 1.5 0 0 1 4 7h3.5V5.5A1.5 1.5 0 0 1 9 4Zm.5 3h5V6h-5z"/>',
  },
  { id: 'star', label: 'Favorito', color: '#ffd23f', glyph: '<path d="m12 2.8 2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.2l-5.6 3 1.1-6.3-4.6-4.4 6.3-.9z"/>' },
  {
    id: 'food',
    label: 'Comer',
    color: '#ff5c7a',
    glyph: '<path d="M6.5 3v7a2.5 2.5 0 0 0 2 2.4V21h2v-8.6a2.5 2.5 0 0 0 2-2.4V3H11v6h-1V3H9v6H8V3zM17.5 3C15.6 3 14 5.2 14 8.5V14h2v7h2V3z"/>',
  },
  {
    id: 'fuel',
    label: 'Gasolina',
    color: '#34c77b',
    glyph: '<path fill-rule="evenodd" d="M4.5 4A1.5 1.5 0 0 1 6 2.5h7A1.5 1.5 0 0 1 14.5 4v7.5h.5a2 2 0 0 1 2 2v3.5a.75.75 0 0 0 1.5 0V9.3l-2.3-2.3 1.1-1.1L20 8.6V17a2.25 2.25 0 0 1-4.5 0v-3.5h-1V21h-10zm2 .5v5h6v-5z"/>',
  },
  {
    id: 'garage',
    label: 'Taller',
    color: '#9aa3ad',
    glyph: '<path d="M21 7.2a5.2 5.2 0 0 1-6.9 5.9l-7.3 7.3a2.1 2.1 0 0 1-3-3l7.3-7.3A5.2 5.2 0 0 1 17 3.2l-3.1 3.1.6 2.7 2.7.6z"/>',
  },
  { id: 'view', label: 'Mirador', color: '#22c3d6', glyph: '<path d="m2.5 19.5 7-10.5 4.2 6.2 2.6-3.6 5.2 7.9z"/><circle cx="17" cy="6" r="2.2"/>' },
  { id: 'flag', label: 'Punto', color: '#f4f4f1', glyph: '<path d="M6 2.5h2v1h11l-2.5 4.5L19 12.5H8V21.5H6z"/>' },
];

const typeOf = (id) => PLACE_TYPES.find((t) => t.id === id) ?? PLACE_TYPES.at(-1);

// Dark glyph on light badges (gold, white), light glyph on the rest.
function glyphColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.65 ? '#111214' : '#ffffff';
}

export function placeGlyph(typeId) {
  const type = typeOf(typeId);
  return `<svg viewBox="0 0 24 24" fill="${glyphColor(type.color)}" aria-hidden="true">${type.glyph}</svg>`;
}

// Search without caring about case or accents.
const fold = (text) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

function load() {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function setupPlaces(map, { onGo }) {
  let places = load();
  const markers = new Map(); // id -> Marker
  const listeners = new Set();

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(places));
    } catch {
      showBanner('No se pudo guardar', 'El navegador no deja guardar datos');
    }
    listeners.forEach((fn) => fn());
  }

  // ---------- Markers ----------

  function markerElement(place, isNew) {
    const type = typeOf(place.type);
    const el = document.createElement('div');
    el.className = `place${isNew ? ' place--new' : ''}`;
    el.style.setProperty('--c', type.color);
    // Each marker bobs on its own beat, like pickups in a game.
    el.style.setProperty('--delay', `${-Math.random() * 2.4}s`);
    el.innerHTML = `<div class="place__badge">${placeGlyph(place.type)}</div><div class="place__label"></div>`;
    el.querySelector('.place__label').textContent = place.name;
    el.addEventListener('click', (e) => {
      e.stopPropagation(); // don't drop a pin underneath
      onGo(place);
    });
    return el;
  }

  function addMarker(place, isNew = false) {
    markers.get(place.id)?.remove();
    const marker = new maplibregl.Marker({ element: markerElement(place, isNew) }).setLngLat([place.lng, place.lat]).addTo(map);
    markers.set(place.id, marker);
  }

  function updateLabels() {
    map.getContainer().classList.toggle('places-far', map.getZoom() < LABEL_MIN_ZOOM);
  }

  places.forEach((place) => addMarker(place));
  map.on('zoom', updateLabels);
  updateLabels();

  function remove(id) {
    places = places.filter((p) => p.id !== id);
    persist();
    markers.get(id)?.remove();
    markers.delete(id);
  }

  // ---------- Save / edit dialog ----------

  const dialog = document.createElement('div');
  dialog.className = 'place-dialog';
  dialog.hidden = true;
  dialog.innerHTML = `
    <form class="place-dialog__card" role="dialog" aria-modal="true" aria-labelledby="place-dialog-title">
      <h2 id="place-dialog-title"></h2>
      <input name="name" maxlength="40" placeholder="Nombre del sitio" autocomplete="off" required />
      <div class="place-dialog__types" role="radiogroup" aria-label="Tipo de sitio">
        ${PLACE_TYPES.map(
          (t) => `
          <label class="place-type" style="--c: ${t.color}">
            <input type="radio" name="type" value="${t.id}" />
            <span class="place-type__badge">${placeGlyph(t.id)}</span>
            <span class="place-type__label">${t.label}</span>
          </label>`,
        ).join('')}
      </div>
      <div class="place-dialog__actions">
        <button type="button" class="place-dialog__cancel">Cancelar</button>
        <button type="submit" class="place-dialog__save">Guardar</button>
      </div>
    </form>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form');
  let editing = null; // { place } or { lngLat }

  function openDialog(target) {
    editing = target;
    const { place } = target;
    dialog.querySelector('h2').textContent = place ? 'Editar sitio' : 'Guardar sitio';
    form.elements.name.value = place?.name ?? target.name ?? '';
    form.elements.type.value = place?.type ?? 'star';
    dialog.hidden = false;
    form.elements.name.focus();
    form.elements.name.select();
  }

  function closeDialog() {
    dialog.hidden = true;
    editing = null;
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = form.elements.name.value.trim();
    if (!name) return;
    const type = form.elements.type.value || 'flag';
    if (editing.place) {
      Object.assign(editing.place, { name, type });
      persist();
      addMarker(editing.place);
    } else {
      const [lng, lat] = editing.lngLat;
      const place = { id: crypto.randomUUID?.() ?? String(Date.now()), name, type, lng, lat, created: Date.now() };
      places.push(place);
      persist();
      addMarker(place, true);
      showBanner('Nueva ubicación', name, typeOf(type));
    }
    closeDialog();
  });
  dialog.querySelector('.place-dialog__cancel').addEventListener('click', closeDialog);
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) closeDialog();
  });
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeDialog();
    }
  });

  // ---------- "New location" banner ----------

  const banner = document.createElement('div');
  banner.className = 'discover';
  banner.setAttribute('role', 'status');
  document.body.append(banner);
  let bannerTimer;

  function showBanner(kicker, title, type) {
    banner.innerHTML = `${type ? `<span class="discover__badge" style="--c: ${type.color}">${placeGlyph(type.id)}</span>` : ''}
      <span class="discover__text"><small></small><b></b></span>`;
    banner.querySelector('small').textContent = kicker;
    banner.querySelector('b').textContent = title;
    banner.classList.remove('is-shown');
    void banner.offsetWidth; // restart the animation
    banner.classList.add('is-shown');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => banner.classList.remove('is-shown'), 3200);
  }

  return {
    all: () => [...places].sort((a, b) => b.created - a.created),
    find(query) {
      const q = fold(query.trim());
      return q ? places.filter((p) => fold(p.name).includes(q)) : [];
    },
    typeOf: (place) => typeOf(place.type),
    save(lngLat, name) {
      openDialog({ lngLat, name });
    },
    edit(place) {
      openDialog({ place });
    },
    remove,
    onChange(fn) {
      listeners.add(fn);
    },
  };
}
