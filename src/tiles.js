// Web Mercator tile coordinates (fractional) for a point at zoom z.
export function lngLatToTile(lng, lat, z) {
  const n = 2 ** z;
  const rad = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  return [((lng + 180) / 360) * n, ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n];
}
