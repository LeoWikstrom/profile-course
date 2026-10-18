import type { TargetProfile } from './gpx/profile';
import { cacheGet, cacheSet } from './net/cache';
import type { CourseResult, LatLon } from './shared/messages';

export interface SessionSettings {
  start: LatLon | null;
  radiusKm: string;
  distanceKm: string;
  rangeFromKm: string;
  rangeToKm: string;
  surface: string;
  returnToStart: boolean;
  startAnywhere?: boolean;
  /** Search effort (beam width), which is a per-machine taste, not per course. */
  beamWidth?: number;
  viaPoints?: { lat: number; lon: number; km: number | null }[];
  seed: number;
}

export interface SessionState {
  profile: TargetProfile | null;
  gpxLabel: string | null;
  settings: SessionSettings;
  /** Last generated course plus the exact profile it was scored against. */
  result: { course: CourseResult; profile: TargetProfile } | null;
}

const KEY = 'session:v1';

let pending: SessionState | null = null;
let writing = false;

/** Coalesces rapid saves; IndexedDB writes are fire-and-forget. */
export function saveSession(state: SessionState): void {
  pending = state;
  if (writing) return;
  writing = true;
  queueMicrotask(async () => {
    try {
      while (pending) {
        const next = pending;
        pending = null;
        await cacheSet(KEY, next);
      }
    } finally {
      writing = false;
    }
  });
}

export async function loadSession(): Promise<SessionState | null> {
  return (await cacheGet<SessionState>(KEY)) ?? null;
}

/** Ask the browser not to evict our origin's storage under disk pressure. */
export async function requestPersistentStorage(): Promise<string> {
  try {
    if (!navigator.storage?.persist) return '';
    const persisted = (await navigator.storage.persisted()) || (await navigator.storage.persist());
    const estimate = await navigator.storage.estimate();
    const used = ((estimate.usage ?? 0) / 1048576).toFixed(1);
    const quota = ((estimate.quota ?? 0) / 1073741824).toFixed(1);
    return `Storage: ${used} MB used of ${quota} GB${persisted ? ', protected from eviction' : ''}`;
  } catch {
    return '';
  }
}
