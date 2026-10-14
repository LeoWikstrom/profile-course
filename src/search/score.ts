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

/** Desired fraction of distance per surface class [paved, gravel, trail, unknown]. */
export type SurfaceMix = [number, number, number, number];
export const MIX_ROAD: SurfaceMix = [1, 0, 0, 0];

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
    const uses = used.get(ei) ?? 0;
    if (uses > 0) repeatLen += e.lengthM;
    used.set(ei, uses + 1);
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

export function surfaceMismatch(actual: SurfaceMix, desired: SurfaceMix): number {
  let tv = 0;
  for (let i = 0; i < 4; i++) tv += Math.abs(actual[i]! - desired[i]!);
  return tv / 2;
}

export function scoreCourse(
  course: AssembledCourse,
  target: TargetProfile,
  desiredMix: SurfaceMix = MIX_ROAD,
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
    weights.surface * surfaceMismatch(course.surfaceSplit, desiredMix) +
    weights.penalty * course.penaltyFraction +
    weights.repeat * course.repeatFraction
  );
}

export { GRADIENT_BIN_COUNT };
