import { cacheGet, cacheSet } from './cache';
import type { LatLon } from '../shared/messages';

export interface OverpassNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
}

export interface OverpassWay {
  type: 'way';
  id: number;
  nodes: number[];
  tags?: Record<string, string>;
}

export interface OverpassResponse {
  elements: (OverpassNode | OverpassWay)[];
}

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const RUNNABLE_HIGHWAYS =
  'footway|path|track|cycleway|residential|living_street|unclassified|tertiary|service|pedestrian|steps|bridleway';

export function buildQuery(center: LatLon, radiusMeters: number): string {
  return `[out:json][timeout:60];(way[highway~"^(${RUNNABLE_HIGHWAYS})$"][access!~"private|no"][foot!=no](around:${Math.round(radiusMeters)},${center.lat.toFixed(6)},${center.lon.toFixed(6)}););out body;>;out skel qt;`;
}

function cacheKey(center: LatLon, radiusMeters: number): string {
  return `overpass:${center.lat.toFixed(3)},${center.lon.toFixed(3)},${Math.round(radiusMeters / 100)}`;
}

export async function fetchNetwork(
  center: LatLon,
  radiusMeters: number,
  fetchFn: typeof fetch = (...args) => fetch(...args),
): Promise<OverpassResponse> {
  const key = cacheKey(center, radiusMeters);
  const cached = await cacheGet<OverpassResponse>(key);
  if (cached) return cached;

  const query = buildQuery(center, radiusMeters);
  let lastError: unknown = null;
  for (const endpoint of ENDPOINTS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 90_000);
      const res = await fetchFn(endpoint, {
        method: 'POST',
        body: `data=${encodeURIComponent(query)}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`Overpass ${endpoint} returned ${res.status}`);
      const json = (await res.json()) as OverpassResponse;
      await cacheSet(key, json);
      return json;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`All Overpass endpoints failed: ${String(lastError)}`);
}
