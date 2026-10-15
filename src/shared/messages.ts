export interface LatLon {
  lat: number;
  lon: number;
}

/** TargetProfile fields, structured-cloneable for postMessage. */
export interface TargetTransfer {
  totalDistance: number;
  samples: Float32Array;
  totalGain: number;
  totalLoss: number;
  gradientHistogram: Float32Array;
  turnsPerKm: number;
}

export interface CourseSegment {
  lats: Float64Array;
  lons: Float64Array;
  /** SurfaceClass of the edge this segment came from. */
  surface: number;
}

export interface CourseResult {
  segments: CourseSegment[];
  /** Elevation every ~25 m relative to course start. */
  samples: Float32Array;
  exportPoints: { lat: number; lon: number; ele: number }[];
  lengthM: number;
  gain: number;
  loss: number;
  score: number;
  surfaceSplit: [number, number, number, number];
  seed: number;
}

export interface AreaInfo {
  id: string;
  lat: number;
  lon: number;
  radiusMeters: number;
  savedAt: number;
  ways: number;
  nodes: number;
}

export type MainToWorker =
  | { type: 'ping' }
  | { type: 'elevate'; lats: Float64Array; lons: Float64Array }
  | { type: 'downloadArea'; center: LatLon; radiusMeters: number }
  | { type: 'listAreas' }
  | { type: 'deleteArea'; id: string }
  | {
      type: 'search';
      start: LatLon;
      radiusMeters: number;
      target: TargetTransfer;
      targetLengthMeters: number;
      seed: number;
      algorithm: 'beam' | 'walk';
      desiredMix: [number, number, number, number] | null;
      returnToStart: boolean;
      /** Course must begin at the marker; otherwise anywhere inside the zone. */
      startAtPoint: boolean;
      /** Overrides merged over DEFAULT_WEIGHTS (advanced settings). */
      weights: Record<string, number> | null;
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
  | { type: 'areas'; areas: AreaInfo[] }
  | { type: 'progress'; stage: string; fraction: number; bestScore: number | null }
  | { type: 'bestSoFar'; segments: CourseSegment[]; score: number }
  | { type: 'result'; course: CourseResult }
  | { type: 'noCourse'; message: string }
  | { type: 'error'; message: string };
