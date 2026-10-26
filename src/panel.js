import { formatPercent } from './explore.js';
import { ROUTE_MODES } from './routing.js';
import { settings } from './settings.js';
import { iconDataUrl } from './traffic.js';
import { placeGlyph } from './places.js';

// The settings panel: route preference, map look, exploration progress, what
// the driving screen shows, and your saved places.

const CLOSE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

const toggle = (key, label) => `
  <label class="switch">
    <span>${label}</span>
    <input type="checkbox" data-setting="${key}" />
    <i aria-hidden="true"></i>
  </label>`;

export function setupSettingsPanel({ traffic, places, explorer, onGo }) {
  const root = document.createElement('div');
  root.className = 'settings';
  root.hidden = true;
  root.innerHTML = `
    <div class="settings__sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header class="settings__head">
        <h2 id="settings-title">Ajustes</h2>
        <button class="settings__close" type="button" aria-label="Cerrar">${CLOSE_ICON}</button>
      </header>

      <section>
        <h3>Rutas</h3>
        <div class="seg seg--grid" data-setting="routeMode">
          ${ROUTE_MODES.map((m) => `<button type="button" data-value="${m.id}">${m.label}</button>`).join('')}
        </div>
      </section>

      <section>
        <h3>Mapa</h3>
        <div class="seg" data-setting="mapStyle">
          <button type="button" data-value="map">Mapa</button>
          <button type="button" data-value="satellite">Satélite</button>
        </div>
        ${toggle('trafficIcons', 'Semáforos y señales')}
        <ul class="settings__cats"></ul>
      </section>

      <section>
        <h3>Exploración · A Coruña</h3>
        ${toggle('exploreMap', 'Sectores y carreteras descubiertas')}
        <ul class="settings__sectors"></ul>
      </section>

      <section>
        <h3>Pantalla de conducción</h3>
        ${toggle('hudMoreSigns', 'Siguientes señales')}
        ${toggle('hudTrip', 'Llegada, tiempo y distancia')}
        ${toggle('hudStatus', 'Hora y testigos')}
      </section>

      <section>
        <h3>Sitios guardados</h3>
        <ul class="settings__places"></ul>
      </section>
    </div>`;
  document.body.append(root);

  const cats = root.querySelector('.settings__cats');
  const sectorList = root.querySelector('.settings__sectors');
  const placeList = root.querySelector('.settings__places');

  // ---------- Rendering ----------

  function render() {
    for (const seg of root.querySelectorAll('.seg')) {
      const value = settings.get(seg.dataset.setting);
      for (const button of seg.children) button.setAttribute('aria-pressed', String(button.dataset.value === value));
    }
    for (const input of root.querySelectorAll('input[data-setting]')) input.checked = settings.get(input.dataset.setting);
    cats.hidden = !settings.get('trafficIcons');
    renderCategories();
    renderSectors();
    renderPlaces();
  }

  function renderSectors() {
    const progress = explorer.progress();
    if (!progress) {
      // The road data loads on demand; draw the list once it's here.
      sectorList.innerHTML = '<li class="settings__empty">Cargando sectores…</li>';
      explorer.load();
      return;
    }
    sectorList.replaceChildren(
      ...progress.map((sector) => {
        const li = document.createElement('li');
        li.innerHTML = `
          <button type="button" class="settings__sector" title="Ver en el mapa">
            <span class="settings__sector-name"></span>
            <b></b>
            <i class="settings__sector-bar"><i></i></i>
            <small></small>
          </button>`;
        li.querySelector('.settings__sector-name').textContent = sector.name;
        li.querySelector('b').textContent = formatPercent(sector.percent);
        li.querySelector('.settings__sector-bar i').style.width = `${Math.min(100, sector.percent)}%`;
        li.querySelector('small').textContent = `${sector.streets} / ${sector.totalStreets} calles`;
        li.querySelector('button').addEventListener('click', () => {
          close();
          explorer.show(sector.id);
        });
        return li;
      }),
    );
  }

  function renderCategories() {
    cats.replaceChildren(
      ...traffic.categories().map((cat) => {
        const li = document.createElement('li');
        li.innerHTML = `<label class="settings__cat"><img alt="" width="26" height="26" /><span></span><input type="checkbox" /></label>`;
        li.querySelector('img').src = iconDataUrl(cat.icon);
        li.querySelector('span').textContent = cat.label;
        const input = li.querySelector('input');
        input.checked = cat.on;
        input.addEventListener('change', () => traffic.setCategory(cat.id, input.checked));
        return li;
      }),
    );
  }

  function renderPlaces() {
    const list = places.all();
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'settings__empty';
      li.textContent = 'Toca el mapa y pulsa Guardar para añadir sitios.';
      placeList.replaceChildren(li);
      return;
    }
    placeList.replaceChildren(
      ...list.map((place) => {
        const type = places.typeOf(place);
        const li = document.createElement('li');
        li.className = 'settings__place';
        li.innerHTML = `
          <button type="button" class="settings__place-go" title="Ir aquí">
            <span class="badge" style="--c: ${type.color}">${placeGlyph(type.id)}</span>
            <span class="settings__place-name"></span>
          </button>
          <button type="button" data-act="edit">Editar</button>
          <button type="button" data-act="delete">Borrar</button>`;
        li.querySelector('.settings__place-name').textContent = place.name;
        li.querySelector('.settings__place-go').addEventListener('click', () => {
          close();
          onGo(place);
        });
        li.querySelector('[data-act="edit"]').addEventListener('click', () => places.edit(place));
        const del = li.querySelector('[data-act="delete"]');
        del.addEventListener('click', () => {
          // Second tap confirms.
          if (del.dataset.armed) places.remove(place.id);
          else {
            del.dataset.armed = 'yes';
            del.textContent = '¿Seguro?';
            del.classList.add('is-danger');
          }
        });
        return li;
      }),
    );
  }

  // ---------- Input ----------

  root.addEventListener('click', (e) => {
    const button = e.target.closest('.seg button');
    if (button) settings.set(button.parentElement.dataset.setting, button.dataset.value);
    if (e.target === root) close();
  });
  root.addEventListener('change', (e) => {
    if (e.target.dataset.setting) settings.set(e.target.dataset.setting, e.target.checked);
  });
  root.querySelector('.settings__close').addEventListener('click', close);
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  settings.onChange(() => {
    if (!root.hidden) render();
  });
  places.onChange(() => {
    if (!root.hidden) renderPlaces();
  });
  explorer.onChange(() => {
    if (!root.hidden) renderSectors();
  });

  function open() {
    render();
    root.hidden = false;
    root.querySelector('.settings__close').focus();
  }

  function close() {
    root.hidden = true;
  }

  return { open };
}
