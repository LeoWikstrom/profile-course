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
  'footway|path|track|cycleway|residential|living_street|unclassified|tertiary|pedestrian|steps|bridleway';

export function buildQuery(center: LatLon, radiusMeters: number): string {
  const around = `(around:${Math.round(radiusMeters)},${center.lat.toFixed(6)},${center.lon.toFixed(6)})`;
  const common = '[access!~"private|no"][foot!=no]';
  // service ways are kept except driveways and parking aisles, which only add
  // noise and in-and-back detours.
  return (
    `[out:json][timeout:180];(` +
    `way[highway~"^(${RUNNABLE_HIGHWAYS})$"]${common}${around};` +
    `way[highway=service][service!~"^(driveway|parking_aisle)$"]${common}${around};` +
    `);out body;>;out skel qt;`
  );
}

function cacheKey(center: LatLon, radiusMeters: number): string {
  return `overpass:v2:${center.lat.toFixed(3)},${center.lon.toFixed(3)},${Math.round(radiusMeters / 100)}`;
}

export interface FetchNetworkOptions {
  fetchFn?: typeof fetch;
  /** Called with (bytesReceived, endpointIndex) while the response streams in. */
  onBytes?: (bytes: number, endpoint: number) => void;
}

async function readWithProgress(
  res: Response,
  onBytes: ((bytes: number, endpoint: number) => void) | undefined,
  endpoint: number,
): Promise<OverpassResponse> {
  if (!res.body || !onBytes) return (await res.json()) as OverpassResponse;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onBytes(received, endpoint);
  }
  const all = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(all)) as OverpassResponse;
}

export async function fetchNetwork(
  center: LatLon,
  radiusMeters: number,
  options: FetchNetworkOptions = {},
): Promise<OverpassResponse> {
  const fetchFn = options.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const key = cacheKey(center, radiusMeters);
  const cached = await cacheGet<OverpassResponse>(key);
  if (cached) return cached;

  const query = buildQuery(center, radiusMeters);
  let lastError: unknown = null;
  for (let i = 0; i < ENDPOINTS.length; i++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 180_000);
      const res = await fetchFn(ENDPOINTS[i]!, {
        method: 'POST',
        body: `data=${encodeURIComponent(query)}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: controller.signal,
      });
      if (!res.ok) {
        clearTimeout(timer);
        throw new Error(`Overpass ${ENDPOINTS[i]} returned ${res.status}`);
      }
      const json = await readWithProgress(res, options.onBytes, i);
      clearTimeout(timer);
      await cacheSet(key, json);
      return json;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`All Overpass endpoints failed: ${String(lastError)}`);
}
