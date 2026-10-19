export interface LatLon {
  lat: number;
  lon: number;
}

export interface ViaPoint {
  lat: number;
  lon: number;
  /** Optional km (decimals) near which the point should be reached. */
  km: number | null;
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
  /** Per-term score contributions, for the breakdown line. */
  breakdown: Record<string, number>;
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
      /** Synthesize informal street crossings (experimental, slower). */
      connectors: boolean;
      /** Beam width (search effort); default 200. */
      beamWidth: number;
      /** Must-pass points, in order; each with an optional km. */
      viaPoints: ViaPoint[];
      /** Half-width of the km window around each via's km (km). */
      viaToleranceKm: number;
    }
  | {
      /** Map-match an uploaded course and score it against the target. */
      type: 'matchCourse';
      lats: Float64Array;
      lons: Float64Array;
      target: TargetTransfer;
      desiredMix: [number, number, number, number] | null;
      weights: Record<string, number> | null;
    }
  | {
      /** Reroute the current course so it passes through `to` near `atKm`. */
      type: 'editCourse';
      atKm: number;
      to: LatLon;
      /** The course's own points, to rebuild worker state after reloads. */
      lats: Float64Array;
      lons: Float64Array;
      target: TargetTransfer;
      desiredMix: [number, number, number, number] | null;
      weights: Record<string, number> | null;
      /** Re-match the sent points instead of trusting the worker's cached path. */
      resync?: boolean;
      /** Via points, which an edit may not reroute away from. */
      viaPoints?: ViaPoint[];
      /** Half-width of the stretch the edit may replace (m). */
      rerouteWindowM?: number;
    }
  | {
      /**
       * Node-level editing on the course node nearest `atKm`: move it to `to`,
       * delete it, or add `to` as a new node on that leg. Each only rewrites the
       * legs around that node, by shortest route, ignoring the score.
       */
      type: 'nodeEdit';
      op: 'move' | 'delete' | 'add';
      atKm: number;
      /** Every node a delete should take, when several are marked at once. */
      atKms?: number[];
      /** Where the node should sit; null for a delete. */
      to: LatLon | null;
      lats: Float64Array;
      lons: Float64Array;
      target: TargetTransfer;
      desiredMix: [number, number, number, number] | null;
      weights: Record<string, number> | null;
      resync?: boolean;
      viaPoints?: ViaPoint[];
    }
  | {
      /** Run the improvement pass on the current course. */
      type: 'improveCourse';
      lats: Float64Array;
      lons: Float64Array;
      target: TargetTransfer;
      desiredMix: [number, number, number, number] | null;
      weights: Record<string, number> | null;
      resync?: boolean;
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
  /**
   * Courses arrive one at a time: `courses` opens that many tabs, each filled
   * by a `course` of its own search, and `coursesDone` closes any the search
   * could not fill with a course worth offering.
   */
  | { type: 'courses'; total: number }
  | { type: 'courseProgress'; index: number; fraction: number }
  | { type: 'course'; index: number; course: CourseResult }
  | { type: 'coursesDone'; ready: number }
  | { type: 'matched'; course: CourseResult; snappedFraction: number; improvable: boolean }
  | { type: 'noCourse'; message: string }
  | { type: 'error'; message: string };
