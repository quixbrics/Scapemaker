/*
 * Geo maths for the map + aporee radius search (Build Plan §6.7).
 * Bounding box uses a proper latitude correction; the true circle is a
 * client-side haversine filter over the box.
 */

export const EARTH_RADIUS_KM = 6371;

export interface LatLon {
  lat: number;
  lon: number;
}

export interface BBox {
  south: number;
  north: number;
  west: number;
  east: number;
}

/** Great-circle distance in km. */
export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Bounding box that fully contains a circle of `radiusKm` around `centre`. */
export function boundingBox(centre: LatLon, radiusKm: number): BBox {
  const dLat = radiusKm / 111.32;
  const cosLat = Math.max(0.01, Math.cos(toRad(centre.lat)));
  const dLon = radiusKm / (111.32 * cosLat);
  return {
    south: clampLat(centre.lat - dLat),
    north: clampLat(centre.lat + dLat),
    west: wrapLon(centre.lon - dLon),
    east: wrapLon(centre.lon + dLon),
  };
}

function clampLat(v: number): number {
  return Math.max(-90, Math.min(90, v));
}
function wrapLon(v: number): number {
  let x = v;
  while (x > 180) x -= 360;
  while (x < -180) x += 360;
  return x;
}

/**
 * archive.org's `advancedsearch.php` indexes `latitude`/`longitude` numerically
 * but SIGN-STRIPPED — the index holds the absolute value — and its query parser
 * rejects a bare `-` in a range (`longitude:[-2.4 TO -2.1]` errors; a quoted
 * `"-2.4"` silently matches nothing). Proof: `longitude:[2.1 TO 2.4]` returns
 * Manchester items whose real longitude is -2.24.
 *
 * So: send the bounding box as ABSOLUTE-VALUE ranges, over-fetch, and then apply
 * a SIGNED haversine filter client-side (see aporee.ts) — that removes both the
 * box corners and the mirror-hemisphere matches the abs box also lets through.
 * A box straddling the equator or prime meridian collapses to [0 .. max|bound|]
 * on that axis.
 */
export interface AbsRanges {
  latLo: number;
  latHi: number;
  lonLo: number;
  lonHi: number;
}

export function absRanges(box: BBox): AbsRanges {
  const lat = axisAbs(box.south, box.north);
  const lon = axisAbs(box.west, box.east);
  return { latLo: lat[0], latHi: lat[1], lonLo: lon[0], lonHi: lon[1] };
}

function axisAbs(a: number, b: number): [number, number] {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  let absLo: number;
  let absHi: number;
  if (lo < 0 && hi > 0) {
    absLo = 0;
    absHi = Math.max(Math.abs(lo), Math.abs(hi));
  } else {
    absLo = Math.min(Math.abs(lo), Math.abs(hi));
    absHi = Math.max(Math.abs(lo), Math.abs(hi));
  }
  // tiny pad so boundary points aren't lost to float noise
  return [Math.max(0, absLo - 1e-4), absHi + 1e-4];
}
