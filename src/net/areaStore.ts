import { haversineMeters } from '../shared/geo';
import type { LatLon } from '../shared/messages';
import { cacheGet, cacheSet } from './cache';
import type { OverpassResponse } from './overpass';

export interface StoredArea {
  id: string;
  lat: number;
  lon: number;
  radiusMeters: number;
  savedAt: number;
  ways: number;
  nodes: number;
}

const INDEX_KEY = 'areas:index';

export async function listAreas(): Promise<StoredArea[]> {
  return (await cacheGet<StoredArea[]>(INDEX_KEY)) ?? [];
}

export async function saveArea(
  center: LatLon,
  radiusMeters: number,
  response: OverpassResponse,
): Promise<StoredArea> {
  const area: StoredArea = {
    id: `${center.lat.toFixed(4)},${center.lon.toFixed(4)},${Math.round(radiusMeters)}`,
    lat: center.lat,
    lon: center.lon,
    radiusMeters,
    savedAt: Date.now(),
    ways: response.elements.filter((e) => e.type === 'way').length,
    nodes: response.elements.filter((e) => e.type === 'node').length,
  };
  await cacheSet(`area:${area.id}`, response);
  const areas = (await listAreas()).filter((a) => a.id !== area.id);
  areas.push(area);
  await cacheSet(INDEX_KEY, areas);
  return area;
}

export async function deleteArea(id: string): Promise<StoredArea[]> {
  const areas = (await listAreas()).filter((a) => a.id !== id);
  await cacheSet(INDEX_KEY, areas);
  await cacheSet(`area:${id}`, undefined);
  return areas;
}

/** Smallest stored area whose circle fully covers the requested one. */
export async function findCoveringArea(
  center: LatLon,
  radiusMeters: number,
): Promise<StoredArea | null> {
  const areas = await listAreas();
  let best: StoredArea | null = null;
  for (const a of areas) {
    const d = haversineMeters(center.lat, center.lon, a.lat, a.lon);
    if (d + radiusMeters <= a.radiusMeters && (!best || a.radiusMeters < best.radiusMeters)) {
      best = a;
    }
  }
  return best;
}

export async function loadArea(id: string): Promise<OverpassResponse | undefined> {
  return cacheGet<OverpassResponse>(`area:${id}`);
}
