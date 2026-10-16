import {
  GRADIENT_BIN_COUNT,
  gainLoss,
  gradientHistogram,
  movingMedian5,
  type TargetProfile,
} from '../gpx/profile';
import { TURN_ANGLE_DEG, angleDiffDeg } from '../shared/geo';
import type { Graph, GraphEdge } from '../graph/types';

export interface Weights {
  rmse: number;
  gainLoss: number;
  histogram: number;
  surface: number;
  penalty: number;
  /** Far-apart edge reuse (legitimate laps), mildly discouraged. */
  repeat: number;
  /**
   * Edge reuse within OSCILLATION_WINDOW_M of the previous use — bouncing up
   * and down the same hill. Weighted hard: re-climbing a small hill to fake
   * the target's gain is never what the runner wants.
   */
  oscillation: number;
  /** Per |turns/km| difference from the target. */
  turns: number;
  /** Per dense turn (within 100 m of the previous turn) per km. */
  denseTurns: number;
  /** Per signalized crossing per km (0 = ignore traffic lights). */
  trafficLights: number;
  /**
   * Worst local shape mismatch: max over 500 m windows of offset-corrected
   * RMSE. Catches a spike where the target is flat, which global RMSE and
   * the gain/loss term happily trade away.
   */
  localShape: number;
}

// Local similarity (rmse, localShape) outweighs the global gain/loss match —
// Leo's explicit priority: a course that locally mirrors the race beats one
// that fakes matching totals.
export const DEFAULT_WEIGHTS: Weights = {
  rmse: 1.0,
  gainLoss: 8,
  histogram: 10,
  surface: 15,
  penalty: 30,
  // Lap-driven courses ("circles in the cemetery") reused a third of their
  // edges at weight 10 and barely noticed; 30 makes improve unroll laps.
  repeat: 30,
  oscillation: 80,
  turns: 2,
  denseTurns: 2,
  trafficLights: 0,
  localShape: 6,
};

export const OSCILLATION_WINDOW_M = 1000;

const DENSE_TURN_GAP_M = 100;

export function entryHeading(e: GraphEdge, forward: boolean): number {
  return forward ? e.headOutA : (e.headInB + 180) % 360;
}

export function exitHeading(e: GraphEdge, forward: boolean): number {
  return forward ? e.headInB : (e.headOutA + 180) % 360;
}

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
  oscillationFraction: number;
  turnsPerKm: number;
  denseTurnsPerKm: number;
  signalsPerKm: number;
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
  let oscillationLen = 0;
  /** Edge index -> direction and course distance of the last traversal. */
  const used = new Map<number, { dir: number; endDist: number }>();

  const turnDists: number[] = [];
  let prevExitHead = Number.NaN;
  let distSoFar = 0;
  let signalCount = 0;
  /** Corridor cell -> last pass {heading, course distance, edge}. */
  const corridor = new Map<number, { head: number; dist: number; edge: number }>();

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

    const entry = entryHeading(e, forward);
    if (
      Number.isFinite(prevExitHead) &&
      Number.isFinite(entry) &&
      Math.abs(angleDiffDeg(prevExitHead, entry)) > TURN_ANGLE_DEG
    ) {
      turnDists.push(distSoFar);
    }
    const t = e.turnOffsets;
    for (let k = 0; k < t.length; k++) {
      turnDists.push(distSoFar + (forward ? t[k]! : e.lengthM - t[t.length - 1 - k]!));
    }
    prevExitHead = exitHeading(e, forward);
    distSoFar += e.lengthM;

    surfaceLen[e.surface] += e.lengthM;
    penaltyLen += e.penalty * e.lengthM;
    signalCount += e.signals;

    // Corridor check: reversing along a parallel twin path (bike + foot side
    // by side) is an out-and-back even though the edges differ. ~14 m cells
    // keep opposite street sidewalks (15-20 m apart) distinct.
    if (e.cellIds && e.cellHead) {
      const m2 = e.cellIds.length;
      const spacing = e.lengthM / Math.max(1, m2 - 1);
      for (let k = 0; k < m2; k++) {
        const idx = forward ? k : m2 - 1 - k;
        const cell = e.cellIds[idx]!;
        const head = forward ? e.cellHead[idx]! : (e.cellHead[idx]! + 180) % 360;
        const d = distSoFar + k * spacing;
        const prevPass = corridor.get(cell);
        if (
          prevPass &&
          prevPass.edge !== ei && // same-edge reuse is handled below
          d - prevPass.dist < OSCILLATION_WINDOW_M &&
          Math.abs(angleDiffDeg(prevPass.head, head)) > 135
        ) {
          oscillationLen += 2 * spacing;
        }
        corridor.set(cell, { head, dist: d, edge: ei });
      }
    }

    const dir = forward ? 1 : 0;
    const prev = used.get(ei);
    if (prev !== undefined) {
      // Reversed reuse counts double; reuse soon after the previous pass is
      // oscillation (bouncing on the same hill), not a lap.
      const weighted = prev.dir === dir ? e.lengthM : 2 * e.lengthM;
      if (distSoFar - prev.endDist < OSCILLATION_WINDOW_M) oscillationLen += weighted;
      else repeatLen += weighted;
    }
    used.set(ei, { dir, endDist: distSoFar + e.lengthM });
  }

  // Same median filter as the target profile: kills single-sample DEM spikes
  // that survive per-edge smoothing (short edges, edge joints).
  const smoothed = movingMedian5(samples);
  const start = smoothed[0] ?? 0;
  for (let i = 0; i < w; i++) smoothed[i]! -= start;

  const { gain, loss } = gainLoss(smoothed);
  const split = surfaceLen.map((v) => (lengthM > 0 ? v / lengthM : 0)) as SurfaceMix;
  let denseTurns = 0;
  for (let i = 1; i < turnDists.length; i++) {
    if (turnDists[i]! - turnDists[i - 1]! < DENSE_TURN_GAP_M) denseTurns++;
  }
  const km = Math.max(0.001, lengthM / 1000);
  return {
    samples: smoothed,
    lengthM,
    gain,
    loss,
    surfaceSplit: split,
    penaltyFraction: lengthM > 0 ? penaltyLen / lengthM : 0,
    repeatFraction: lengthM > 0 ? repeatLen / lengthM : 0,
    oscillationFraction: lengthM > 0 ? oscillationLen / lengthM : 0,
    turnsPerKm: turnDists.length / km,
    denseTurnsPerKm: denseTurns / km,
    signalsPerKm: signalCount / km,
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

const SHAPE_WINDOW_SAMPLES = 20; // 500 m at 25 m spacing
const SHAPE_SHIFT_SAMPLES = 6; // tolerate ±150 m longitudinal misalignment

/**
 * Max over sliding windows of the offset-corrected RMSE, where each window may
 * shift up to ±150 m along the target. A real climb that sits slightly
 * earlier/later than in the race (e.g. a modelled bridge ramp) aligns at some
 * shift; a spike where the target is flat stays bad at every shift.
 */
export function worstWindowShapeError(course: Float32Array, target: Float32Array): number {
  const n = Math.min(course.length, target.length);
  if (n < SHAPE_WINDOW_SAMPLES) return 0;
  let worst = 0;
  for (let start = 0; start + SHAPE_WINDOW_SAMPLES <= n; start += SHAPE_WINDOW_SAMPLES / 2) {
    let best = Infinity;
    for (let shift = -SHAPE_SHIFT_SAMPLES; shift <= SHAPE_SHIFT_SAMPLES; shift++) {
      const t0 = start + shift;
      if (t0 < 0 || t0 + SHAPE_WINDOW_SAMPLES > target.length) continue;
      let mean = 0;
      for (let i = 0; i < SHAPE_WINDOW_SAMPLES; i++) {
        mean += course[start + i]! - target[t0 + i]!;
      }
      mean /= SHAPE_WINDOW_SAMPLES;
      let sq = 0;
      for (let i = 0; i < SHAPE_WINDOW_SAMPLES; i++) {
        const d = course[start + i]! - target[t0 + i]! - mean;
        sq += d * d;
      }
      const rmse = Math.sqrt(sq / SHAPE_WINDOW_SAMPLES);
      if (rmse < best) best = rmse;
    }
    if (best !== Infinity && best > worst) worst = best;
  }
  return worst;
}

export function scoreCourse(
  course: AssembledCourse,
  target: TargetProfile,
  desiredMix: SurfaceMix | null = MIX_ROAD,
  weights: Weights = DEFAULT_WEIGHTS,
): number {
  // Offset-corrected RMSE: a constant vertical offset between the two
  // profiles is DEM-vs-GPX measurement bias at the start point (observed:
  // 7 m at Slottsskogsvallen), not a real mismatch. Shape is what matters.
  const n = Math.min(course.samples.length, target.samples.length);
  let diffSum = 0;
  let diffSq = 0;
  for (let i = 0; i < n; i++) {
    const d = course.samples[i]! - target.samples[i]!;
    diffSum += d;
    diffSq += d * d;
  }
  const mean = n > 0 ? diffSum / n : 0;
  const rmse = n > 0 ? Math.sqrt(Math.max(0, diffSq / n - mean * mean)) : 0;

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
    weights.repeat * course.repeatFraction +
    weights.oscillation * course.oscillationFraction +
    weights.turns * Math.abs(course.turnsPerKm - target.turnsPerKm) +
    weights.denseTurns * course.denseTurnsPerKm +
    weights.trafficLights * course.signalsPerKm +
    weights.localShape * worstWindowShapeError(course.samples, target.samples)
  );
}

export { GRADIENT_BIN_COUNT };
