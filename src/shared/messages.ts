export interface LatLon {
  lat: number;
  lon: number;
}

export type MainToWorker =
  | { type: 'ping' }
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
  | { type: 'progress'; fraction: number; bestScore: number | null }
  | { type: 'error'; message: string };
