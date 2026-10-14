import { haversineMeters } from '../shared/geo';
import { findCoveringArea, loadArea } from './areaStore';
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
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const RUNNABLE_HIGHWAYS =
  'footway|path|track|cycleway|residential|living_street|unclassified|tertiary|service|pedestrian|steps|bridleway';

// Driveways and parking aisles are filtered client-side in buildGraph; a
// single query clause keeps the server-side cost down.
export function buildQuery(center: LatLon, radiusMeters: number): string {
  const around = `(around:${Math.round(radiusMeters)},${center.lat.toFixed(6)},${center.lon.toFixed(6)})`;
  return `[out:json][timeout:180];(way[highway~"^(${RUNNABLE_HIGHWAYS})$"][access!~"private|no"][foot!=no]${around};);out body;>;out skel qt;`;
}

function cacheKey(center: LatLon, radiusMeters: number): string {
  return `overpass:v2:${center.lat.toFixed(3)},${center.lon.toFixed(3)},${Math.round(radiusMeters / 100)}`;
}

export interface FetchNetworkOptions {
  fetchFn?: typeof fetch;
  /** Called with (bytesReceived, endpointIndex) while the response streams in. */
  onBytes?: (bytes: number, endpoint: number) => void;
  /** Rounds over all endpoints before giving up (default 2). */
  rounds?: number;
}

/** Keep only ways with at least one node inside the circle (plus their nodes). */
export function filterByRadius(
  response: OverpassResponse,
  center: LatLon,
  radiusMeters: number,
): OverpassResponse {
  const nodePos = new Map<number, { lat: number; lon: number }>();
  for (const el of response.elements) {
    if (el.type === 'node') nodePos.set(el.id, { lat: el.lat, lon: el.lon });
  }
  // Cheap bounding-box prefilter, then exact haversine.
  const latPad = (radiusMeters / 111_320) * 1.05;
  const lonPad = latPad / Math.cos((center.lat * Math.PI) / 180);
  const inside = (id: number): boolean => {
    const p = nodePos.get(id);
    if (!p) return false;
    if (Math.abs(p.lat - center.lat) > latPad || Math.abs(p.lon - center.lon) > lonPad) return false;
    return haversineMeters(center.lat, center.lon, p.lat, p.lon) <= radiusMeters;
  };

  const keptWays: OverpassWay[] = [];
  const keptNodeIds = new Set<number>();
  for (const el of response.elements) {
    if (el.type !== 'way') continue;
    if (el.nodes.some(inside)) {
      keptWays.push(el);
      for (const id of el.nodes) keptNodeIds.add(id);
    }
  }
  const elements: (OverpassNode | OverpassWay)[] = [...keptWays];
  for (const el of response.elements) {
    if (el.type === 'node' && keptNodeIds.has(el.id)) elements.push(el);
  }
  return { elements };
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
  // The public servers reject or hang individually and intermittently (quick
  // 504s under load, dead mirrors), so fail fast per endpoint and make two
  // rounds over all of them before giving up.
  const rounds = options.rounds ?? 2;
  for (let round = 0; round < rounds; round++) {
    for (let i = 0; i < ENDPOINTS.length; i++) {
      try {
        const controller = new AbortController();
        // Fast-fail if no response headers arrive; dead mirrors otherwise
        // stall the whole search.
        let timer = setTimeout(() => controller.abort(), 25_000);
        const res = await fetchFn(ENDPOINTS[i]!, {
          method: 'POST',
          body: `data=${encodeURIComponent(query)}`,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`Overpass ${ENDPOINTS[i]} returned ${res.status}`);
        timer = setTimeout(() => controller.abort(), 180_000);
        const json = await readWithProgress(res, options.onBytes, i);
        clearTimeout(timer);
        if (!Array.isArray(json.elements)) {
          throw new Error(`Overpass ${ENDPOINTS[i]} returned no elements`);
        }
        await cacheSet(key, json);
        return json;
      } catch (err) {
        lastError = err;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`All Overpass endpoints failed twice: ${String(lastError)}`);
}

export interface NetworkResult {
  response: OverpassResponse;
  source: 'offline-area' | 'cache-or-network';
}

/**
 * Preferred entry point: serve from a stored offline area when one covers the
 * requested circle, otherwise fall back to cache/network.
 */
export async function getNetwork(
  center: LatLon,
  radiusMeters: number,
  options: FetchNetworkOptions = {},
): Promise<NetworkResult> {
  const area = await findCoveringArea(center, radiusMeters);
  if (area) {
    const stored = await loadArea(area.id);
    if (stored) {
      return { response: filterByRadius(stored, center, radiusMeters), source: 'offline-area' };
    }
  }
  return { response: await fetchNetwork(center, radiusMeters, options), source: 'cache-or-network' };
}
