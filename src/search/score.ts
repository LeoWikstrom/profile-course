import {
  GRADIENT_BIN_COUNT,
  gainLoss,
  gradientHistogram,
  type TargetProfile,
} from '../gpx/profile';
import type { Graph } from '../graph/types';

export interface Weights {
  rmse: number;
  gainLoss: number;
  histogram: number;
  surface: number;
  penalty: number;
  repeat: number;
}

export const DEFAULT_WEIGHTS: Weights = {
  rmse: 1.0,
  gainLoss: 20,
  histogram: 10,
  surface: 15,
  penalty: 30,
  repeat: 10,
};

/**
 * Desired fraction of distance per surface class [paved, gravel, trail, unknown];
 * null = any surface is fine (no surface term).
 */
export type SurfaceMix = [number, number, number, number];
export const MIX_ROAD: SurfaceMix = [1, 0, 0, 0];
export const MIX_GRAVEL: SurfaceMix = [0.3, 0.7, 0, 0];
export const MIX_TRAIL: SurfaceMix = [0, 0.3, 0.7, 0];

export const SURFACE_PRESETS: Record<string, SurfaceMix | null> = {
  road: MIX_ROAD,
  gravel: MIX_GRAVEL,
  trail: MIX_TRAIL,
  any: null,
};

export interface CoursePath {
  edges: number[];
  /** 1 = traversed a→b, 0 = b→a. */
  dirs: number[];
}

export interface AssembledCourse {
  /** Elevation every ~25 m, relative to the course start. */
  samples: Float32Array;
  lengthM: number;
  gain: number;
  loss: number;
  surfaceSplit: SurfaceMix;
  penaltyFraction: number;
  repeatFraction: number;
}

export function assembleCourse(graph: Graph, path: CoursePath): AssembledCourse {
  let sampleCount = 1;
  let lengthM = 0;
  for (const ei of path.edges) {
    const e = graph.edges[ei]!;
    sampleCount += (e.elev?.length ?? 2) - 1;
    lengthM += e.lengthM;
  }

  const samples = new Float32Array(sampleCount);
  const surfaceLen: SurfaceMix = [0, 0, 0, 0];
  let penaltyLen = 0;
  let repeatLen = 0;
  /** Edge index -> direction of first traversal (0/1). */
  const used = new Map<number, number>();

  let w = 0;
  let first = true;
  for (let i = 0; i < path.edges.length; i++) {
    const ei = path.edges[i]!;
    const e = graph.edges[ei]!;
    const elev = e.elev;
    if (!elev) throw new Error('assembleCourse requires sampled edge elevations');
    const forward = path.dirs[i] === 1;
    const n = elev.length;
    for (let k = first ? 0 : 1; k < n; k++) {
      samples[w++] = elev[forward ? k : n - 1 - k]!;
    }
    first = false;

    surfaceLen[e.surface] += e.lengthM;
    penaltyLen += e.penalty * e.lengthM;
    const dir = forward ? 1 : 0;
    const firstDir = used.get(ei);
    if (firstDir === undefined) {
      used.set(ei, dir);
    } else {
      // A lap in the same direction is a mild repeat; going back the way we
      // came (in-and-back-again) counts double.
      repeatLen += firstDir === dir ? e.lengthM : 2 * e.lengthM;
    }
  }

  const start = samples[0] ?? 0;
  for (let i = 0; i < w; i++) samples[i]! -= start;

  const { gain, loss } = gainLoss(samples);
  const split = surfaceLen.map((v) => (lengthM > 0 ? v / lengthM : 0)) as SurfaceMix;
  return {
    samples,
    lengthM,
    gain,
    loss,
    surfaceSplit: split,
    penaltyFraction: lengthM > 0 ? penaltyLen / lengthM : 0,
    repeatFraction: lengthM > 0 ? repeatLen / lengthM : 0,
  };
}

/** 1D earth mover's distance between two histograms that each sum to ~1. */
export function emd(a: Float32Array, b: Float32Array): number {
  let cum = 0;
  let total = 0;
  for (let i = 0; i < a.length; i++) {
    cum += a[i]! - b[i]!;
    total += Math.abs(cum);
  }
  return total / a.length;
}

/**
 * Cost of running on class `row` when class `col` was wanted. Paved and
 * gravel are near-equivalent for a runner; trails differ meaningfully.
 */
const SURFACE_COST: number[][] = [
  // paved gravel trail unknown
  [0.0, 0.1, 1.0, 0.4], // paved
  [0.1, 0.0, 0.4, 0.3], // gravel
  [1.0, 0.4, 0.0, 0.4], // trail
  [0.4, 0.3, 0.4, 0.0], // unknown
];

/** Greedy transport of the actual mix onto the desired mix, weighted by SURFACE_COST. */
export function surfaceMismatch(actual: SurfaceMix, desired: SurfaceMix): number {
  const surplus = [0, 0, 0, 0];
  const deficit = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const d = actual[i]! - desired[i]!;
    if (d > 0) surplus[i] = d;
    else deficit[i] = -d;
  }
  const moves: { from: number; to: number; cost: number }[] = [];
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      if (i !== j) moves.push({ from: i, to: j, cost: SURFACE_COST[i]![j]! });
    }
  }
  moves.sort((a, b) => a.cost - b.cost);
  let total = 0;
  for (const m of moves) {
    const amount = Math.min(surplus[m.from]!, deficit[m.to]!);
    if (amount > 0) {
      surplus[m.from]! -= amount;
      deficit[m.to]! -= amount;
      total += amount * m.cost;
    }
  }
  return total;
}

export function scoreCourse(
  course: AssembledCourse,
  target: TargetProfile,
  desiredMix: SurfaceMix | null = MIX_ROAD,
  weights: Weights = DEFAULT_WEIGHTS,
): number {
  const n = Math.min(course.samples.length, target.samples.length);
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const d = course.samples[i]! - target.samples[i]!;
    sq += d * d;
  }
  const rmse = n > 0 ? Math.sqrt(sq / n) : 0;

  const denom = Math.max(1, target.totalGain + target.totalLoss);
  const gainLossErr =
    (Math.abs(course.gain - target.totalGain) + Math.abs(course.loss - target.totalLoss)) / denom;

  const courseHist = gradientHistogram(course.samples);
  const histErr = emd(courseHist, target.gradientHistogram);

  return (
    weights.rmse * rmse +
    weights.gainLoss * gainLossErr +
    weights.histogram * histErr +
    weights.surface * (desiredMix ? surfaceMismatch(course.surfaceSplit, desiredMix) : 0) +
    weights.penalty * course.penaltyFraction +
    weights.repeat * course.repeatFraction
  );
}

export { GRADIENT_BIN_COUNT };
