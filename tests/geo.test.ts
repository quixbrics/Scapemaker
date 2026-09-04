import { describe, expect, it } from 'vitest';
import { haversineKm, boundingBox, absRanges } from '../src/sources/geo';

describe('haversineKm', () => {
  it('is zero for the same point', () => {
    expect(haversineKm({ lat: 53.48, lon: -2.24 }, { lat: 53.48, lon: -2.24 })).toBeCloseTo(0, 6);
  });
  it('Manchester → Berlin is ~1050 km', () => {
    const d = haversineKm({ lat: 53.4808, lon: -2.2426 }, { lat: 52.52, lon: 13.405 });
    expect(d).toBeGreaterThan(1000);
    expect(d).toBeLessThan(1100);
  });
  it('one degree of latitude is ~111 km anywhere', () => {
    expect(haversineKm({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(111.19, 0);
    expect(haversineKm({ lat: -33, lon: 151 }, { lat: -34, lon: 151 })).toBeCloseTo(111.19, 0);
  });
});

describe('boundingBox', () => {
  it('contains the circle: every box corner is at least radius away on one axis', () => {
    const centre = { lat: 53.48, lon: -2.24 };
    const box = boundingBox(centre, 10);
    // north/south edges at least 10 km
    expect(haversineKm(centre, { lat: box.north, lon: centre.lon })).toBeGreaterThanOrEqual(9.9);
    expect(haversineKm(centre, { lat: centre.lat, lon: box.east })).toBeGreaterThanOrEqual(9.9);
  });
});

describe('absRanges — archive.org sign-stripped coordinate index (spike S2)', () => {
  const box = (lat: number, lon: number, km = 10) => absRanges(boundingBox({ lat, lon }, km));

  it('Manchester (−lon): longitude range is positive and brackets |2.24|', () => {
    const r = box(53.4808, -2.2426);
    expect(r.lonLo).toBeGreaterThanOrEqual(0);
    expect(r.lonLo).toBeLessThan(2.2426);
    expect(r.lonHi).toBeGreaterThan(2.2426);
    expect(r.latLo).toBeLessThan(53.4808);
    expect(r.latHi).toBeGreaterThan(53.4808);
  });

  it('Berlin (+/+): both ranges positive and bracket the point', () => {
    const r = box(52.52, 13.405);
    expect(r.latLo).toBeLessThan(52.52);
    expect(r.latHi).toBeGreaterThan(52.52);
    expect(r.lonLo).toBeLessThan(13.405);
    expect(r.lonHi).toBeGreaterThan(13.405);
  });

  it('Rio (−/−): both ranges are positive, bracketing the absolute values', () => {
    const r = box(-22.906, -43.177);
    expect(r.latLo).toBeGreaterThanOrEqual(0);
    expect(r.latLo).toBeLessThan(22.906);
    expect(r.latHi).toBeGreaterThan(22.906);
    expect(r.lonLo).toBeLessThan(43.177);
    expect(r.lonHi).toBeGreaterThan(43.177);
  });

  it('Sydney (−lat, +lon): latitude range positive bracketing |33.87|', () => {
    const r = box(-33.87, 151.21);
    expect(r.latLo).toBeGreaterThanOrEqual(0);
    expect(r.latLo).toBeLessThan(33.87);
    expect(r.latHi).toBeGreaterThan(33.87);
    expect(r.lonLo).toBeLessThan(151.21);
  });

  it('equator straddle collapses the latitude low bound to 0', () => {
    const r = absRanges(boundingBox({ lat: 0.05, lon: 10 }, 20));
    expect(r.latLo).toBe(0);
    expect(r.latHi).toBeGreaterThan(0.1);
  });
});
