// App settings, kept in this browser. Everything optional starts hidden.

const STORAGE_KEY = 'maps-settings';

const DEFAULTS = {
  mapStyle: 'map', // 'map' | 'satellite'
  trafficIcons: false, // lights and signs on the map while browsing
  routeMode: 'fastest', // 'fastest' | 'no-lights' | 'fast' | 'slow'
  hudMoreSigns: false, // the two signs after the next one
  hudTrip: false, // arrival time, time and distance left
  hudStatus: false, // clock and warning lamps
};

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}

const values = { ...DEFAULTS, ...load() };
const listeners = new Set();

export const settings = {
  get: (key) => values[key],
  set(key, value) {
    if (values[key] === value) return;
    values[key] = value;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
    } catch {
      // Not remembered next time; no big deal.
    }
    listeners.forEach((fn) => fn(key, value));
  },
  onChange(fn) {
    listeners.add(fn);
  },
};
