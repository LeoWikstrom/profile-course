export interface LatLon {
  lat: number;
  lon: number;
}

export type MainToWorker =
  | { type: 'ping' }
  | { type: 'elevate'; lats: Float64Array; lons: Float64Array }
  | { type: 'prepare'; start: LatLon; radiusMeters: number }
  | {
      type: 'search';
      start: LatLon;
      radiusMeters: number;
      targetLengthMeters: number;
      seed: number;
    }
  | { type: 'cancel' };

export type WorkerToMain =
  | { type: 'pong' }
  | { type: 'elevated'; elevations: Float32Array }
  | {
      type: 'prepared';
      nodeCount: number;
      edgeCount: number;
      startNode: LatLon;
      startElevation: number;
    }
  | { type: 'progress'; stage: string; fraction: number; bestScore: number | null }
  | { type: 'error'; message: string };
