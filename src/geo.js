// Small geometry toolkit for [lng, lat] points. Distances in meters, bearings in degrees.

const R = 6371008.8;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export function distance([lon1, lat1], [lon2, lat2]) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function bearing([lon1, lat1], [lon2, lat2]) {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Signed smallest turn from a to b, in (-180, 180].
export function angleDiff(a, b) {
  return ((b - a + 540) % 360) - 180;
}

export function lerp(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

// Closest point of segment ab to p, on a local flat projection (fine at street scale).
export function projectOnSegment(p, a, b) {
  const k = Math.cos(toRad(p[1]));
  const ax = (a[0] - p[0]) * k;
  const ay = a[1] - p[1];
  const dx = (b[0] - a[0]) * k;
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? clamp(-(ax * dx + ay * dy) / len2, 0, 1) : 0;
  const qx = ax + dx * t;
  const qy = ay + dy * t;
  return { t, dist: toRad(Math.hypot(qx, qy)) * R };
}

// Douglas–Peucker, tolerance in meters.
export function simplify(coords, tolerance) {
  if (coords.length < 3) return coords;
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack = [[0, coords.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxDist = 0;
    let index = 0;
    for (let i = first + 1; i < last; i++) {
      const { dist } = projectOnSegment(coords[i], coords[first], coords[last]);
      if (dist > maxDist) {
        maxDist = dist;
        index = i;
      }
    }
    if (maxDist > tolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return coords.filter((_, i) => keep[i]);
}

// A polyline you can walk along: point at a distance, closest point to a position, etc.
export class Line {
  constructor(coords) {
    this.coords = coords;
    this.cum = new Float64Array(coords.length);
    for (let i = 1; i < coords.length; i++) this.cum[i] = this.cum[i - 1] + distance(coords[i - 1], coords[i]);
    this.length = this.cum[coords.length - 1];
  }

  // Index of the segment that contains this distance along the line.
  segmentAt(along) {
    let lo = 0;
    let hi = this.coords.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cum[mid] <= along) lo = mid;
      else hi = mid - 1;
    }
    return Math.max(0, lo);
  }

  pointAt(along) {
    const i = this.segmentAt(along);
    const len = this.cum[i + 1] - this.cum[i];
    return lerp(this.coords[i], this.coords[i + 1], len ? clamp((along - this.cum[i]) / len, 0, 1) : 0);
  }

  // Direction of travel around a distance, looking a little ahead so it doesn't twitch.
  bearingAt(along, ahead = 25) {
    const from = this.pointAt(Math.max(0, along - 5));
    const to = this.pointAt(Math.min(this.length, along + ahead));
    return bearing(from, to);
  }

  // Closest point to p, checking segments [from, to).
  project(p, from = 0, to = this.coords.length - 1) {
    let best = { dist: Infinity, along: 0, index: 0 };
    for (let i = Math.max(0, from); i < Math.min(to, this.coords.length - 1); i++) {
      const { t, dist } = projectOnSegment(p, this.coords[i], this.coords[i + 1]);
      if (dist < best.dist) best = { dist, index: i, along: this.cum[i] + t * (this.cum[i + 1] - this.cum[i]) };
    }
    return best;
  }

  // What's left of the line from a distance onwards.
  sliceFrom(along) {
    const i = this.segmentAt(along);
    return [this.pointAt(along), ...this.coords.slice(i + 1)];
  }
}

// Buckets segments by ~50 m grid cell so "what's near this point" doesn't scan everything.
export class SegmentGrid {
  static CELL = 0.0005;

  constructor() {
    this.cells = new Map();
  }

  key(x, y) {
    return `${x},${y}`;
  }

  add(a, b, value) {
    const c = SegmentGrid.CELL;
    const x0 = Math.floor(Math.min(a[0], b[0]) / c);
    const x1 = Math.floor(Math.max(a[0], b[0]) / c);
    const y0 = Math.floor(Math.min(a[1], b[1]) / c);
    const y1 = Math.floor(Math.max(a[1], b[1]) / c);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const k = this.key(x, y);
        if (!this.cells.has(k)) this.cells.set(k, []);
        this.cells.get(k).push({ a, b, value });
      }
    }
  }

  near(p) {
    const c = SegmentGrid.CELL;
    const cx = Math.floor(p[0] / c);
    const cy = Math.floor(p[1] / c);
    const found = [];
    for (let x = cx - 1; x <= cx + 1; x++) {
      for (let y = cy - 1; y <= cy + 1; y++) found.push(...(this.cells.get(this.key(x, y)) ?? []));
    }
    return found;
  }
}
