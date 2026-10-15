import type { TargetProfile } from '../gpx/profile';
import { dijkstra } from '../graph/dijkstra';
import { otherNode, type Graph } from '../graph/types';
import { TURN_ANGLE_DEG, angleDiffDeg } from '../shared/geo';
import {
  assembleCourse,
  entryHeading,
  exitHeading,
  scoreCourse,
  DEFAULT_WEIGHTS,
  MIX_ROAD,
  OSCILLATION_WINDOW_M,
  type CoursePath,
  type SurfaceMix,
  type Weights,
} from './score';
import type { WalkCandidate } from './randomWalk';

export interface BeamOptions {
  /** Perturbs beam tie-breaking so "Try another" explores different courses. */
  seed?: number;
  beamWidth?: number;
  bucketSizeM?: number;
  lengthTolerance?: number;
  keepBest?: number;
  desiredMix?: SurfaceMix | null;
  weights?: Weights;
  /** Courses must end back at the start node. */
  returnToStart?: boolean;
  /**
   * 1 = node is a valid course end (e.g. inside the start/finish radius).
   * The course itself may go arbitrarily far away; states are pruned when
   * they can no longer reach a valid end within the length budget.
   */
  validEnd?: Uint8Array | null;
  onProgress?: (bucket: number, totalBuckets: number, best: WalkCandidate | null) => void;
  shouldCancel?: () => boolean;
}


interface StateStore {
  node: number[];
  dist: number[];
  sq: number[];
  sampleCount: number[];
  gain: number[];
  loss: number[];
  penaltyLen: number[];
  repeatLen: number[];
  turns: number[];
  exitHead: number[];
  parent: number[];
  edge: number[];
  dir: number[];
}

interface TargetPrefix {
  /** Cumulative target gain/loss per 25 m sample index. */
  cumGain: Float32Array;
  cumLoss: Float32Array;
  denom: number;
  turnsPerKm: number;
}

function targetPrefix(target: TargetProfile): TargetPrefix {
  const samples = target.samples;
  const cumGain = new Float32Array(samples.length);
  const cumLoss = new Float32Array(samples.length);
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i]! - samples[i - 1]!;
    cumGain[i] = cumGain[i - 1]! + (d > 0 ? d : 0);
    cumLoss[i] = cumLoss[i - 1]! + (d < 0 ? -d : 0);
  }
  return {
    cumGain,
    cumLoss,
    denom: Math.max(1, target.totalGain + target.totalLoss),
    turnsPerKm: target.turnsPerKm,
  };
}

function partialRank(s: StateStore, i: number, weights: Weights, tp: TargetPrefix): number {
  const d = Math.max(1, s.dist[i]!);
  const rmse = Math.sqrt(s.sq[i]! / Math.max(1, s.sampleCount[i]!));
  let ti = Math.round(s.dist[i]! / 25);
  if (ti >= tp.cumGain.length) ti = tp.cumGain.length - 1;
  const gainLossErr =
    (Math.abs(s.gain[i]! - tp.cumGain[ti]!) + Math.abs(s.loss[i]! - tp.cumLoss[ti]!)) / tp.denom;
  // Turn density is noisy on short prefixes; let it bite only after 500 m.
  const turnErr = d > 500 ? Math.abs(s.turns[i]! / (d / 1000) - tp.turnsPerKm) : 0;
  return (
    weights.rmse * rmse +
    weights.gainLoss * gainLossErr +
    weights.penalty * (s.penaltyLen[i]! / d) +
    // repeatLen is reuse inside the oscillation window (see recentReuse). Use
    // a fraction of the final weight: at full strength the term dominates the
    // partial rank in dense/small graphs and starves the beam of diversity.
    (weights.oscillation / 4) * (s.repeatLen[i]! / d) +
    weights.turns * turnErr
  );
}

function reconstruct(s: StateStore, i: number): CoursePath {
  const edges: number[] = [];
  const dirs: number[] = [];
  for (let cur = i; cur >= 0 && s.edge[cur]! >= 0; cur = s.parent[cur]!) {
    edges.push(s.edge[cur]!);
    dirs.push(s.dir[cur]!);
  }
  edges.reverse();
  dirs.reverse();
  return { edges, dirs };
}

/**
 * 0 = unused within the oscillation window, 1 = reused same direction,
 * 2 = reused in reverse. Walks back along the path for OSCILLATION_WINDOW_M.
 */
function recentReuse(s: StateStore, i: number, edgeIndex: number, dir: number): number {
  const fromDist = s.dist[i]!;
  let cur = i;
  while (cur >= 0 && s.edge[cur]! >= 0 && fromDist - s.dist[cur]! <= OSCILLATION_WINDOW_M) {
    if (s.edge[cur] === edgeIndex) return s.dir[cur] === dir ? 1 : 2;
    cur = s.parent[cur]!;
  }
  return 0;
}

export async function beamSearch(
  graph: Graph,
  startNode: number,
  target: TargetProfile,
  targetLengthM: number,
  options: BeamOptions = {},
): Promise<WalkCandidate[]> {
  const {
    seed = 1,
    beamWidth = 200,
    bucketSizeM = 100,
    lengthTolerance = 0.03,
    keepBest = 20,
    desiredMix = MIX_ROAD,
    weights = DEFAULT_WEIGHTS,
    returnToStart = false,
    validEnd = null,
    onProgress,
    shouldCancel,
  } = options;

  const minLen = targetLengthM * (1 - lengthTolerance);
  const maxLen = targetLengthM * (1 + lengthTolerance);
  const totalBuckets = Math.ceil(maxLen / bucketSizeM) + 1;

  let endMask: Uint8Array | null = null;
  if (returnToStart) {
    endMask = new Uint8Array(graph.nodeLat.length);
    endMask[startNode] = 1;
  } else if (validEnd) {
    endMask = validEnd;
  }
  const endSources: number[] = [];
  if (endMask) {
    for (let i = 0; i < endMask.length; i++) if (endMask[i]) endSources.push(i);
  }
  const distBack = endMask ? dijkstra(graph, endSources).dist : null;

  // Course elevation is taken relative to the start node's elevation.
  let elev0 = 0;
  const firstAdj = graph.adjOffset[startNode]!;
  if (firstAdj < graph.adjOffset[startNode + 1]!) {
    const e = graph.edges[graph.adjEdge[firstAdj]!]!;
    const elev = e.elev!;
    elev0 = e.a === startNode ? elev[0]! : elev[elev.length - 1]!;
  }

  const s: StateStore = {
    node: [startNode],
    dist: [0],
    sq: [0],
    sampleCount: [0],
    gain: [0],
    loss: [0],
    penaltyLen: [0],
    repeatLen: [0],
    turns: [0],
    exitHead: [Number.NaN],
    parent: [-1],
    edge: [-1],
    dir: [0],
  };
  const tp = targetPrefix(target);

  const buckets: number[][] = Array.from({ length: totalBuckets }, () => []);
  buckets[0]!.push(0);

  const best: WalkCandidate[] = [];
  const targetSamples = target.samples;
  const lastTargetIdx = targetSamples.length - 1;

  function complete(stateIdx: number): void {
    const path = reconstruct(s, stateIdx);
    if (path.edges.length === 0) return;
    const course = assembleCourse(graph, path);
    const score = scoreCourse(course, target, desiredMix, weights);
    if (best.length < keepBest || score < best[best.length - 1]!.score) {
      best.push({ path, course, score });
      best.sort((x, y) => x.score - y.score);
      if (best.length > keepBest) best.length = keepBest;
    }
  }

  for (let b = 0; b < totalBuckets; b++) {
    if (shouldCancel?.()) break;
    const bucket = buckets[b]!;
    if (bucket.length === 0) continue;

    // Seeded jitter breaks ties between near-equal states, so a new seed
    // ("Try another") explores a different part of the search space.
    const jitter = (i: number) => (((i * 2654435761 + seed * 97) >>> 0) % 1000) * 1e-7;
    bucket.sort(
      (x, y) =>
        partialRank(s, x, weights, tp) + jitter(x) - partialRank(s, y, weights, tp) - jitter(y),
    );
    // Keep at most 2 states per end node, or the beam fills with near-identical
    // prefixes of the single best path and loses diversity.
    const perNode = new Map<number, number>();
    let w = 0;
    for (const si of bucket) {
      const count = perNode.get(s.node[si]!) ?? 0;
      if (count >= 2) continue;
      perNode.set(s.node[si]!, count + 1);
      bucket[w++] = si;
      if (w >= beamWidth) break;
    }
    bucket.length = w;

    // Same-bucket states (short edges) are appended to this queue and processed
    // now; distance strictly increases, and the cap bounds worst-case blowup.
    const maxProcessed = beamWidth * 10;
    for (let qi = 0; qi < bucket.length && qi < maxProcessed; qi++) {
      const si = bucket[qi]!;
      const node = s.node[si]!;
      const dist = s.dist[si]!;
      for (let k = graph.adjOffset[node]!; k < graph.adjOffset[node + 1]!; k++) {
        const ei = graph.adjEdge[k]!;
        // Immediate same-edge reversal is the in-and-back-again pattern; with
        // dead ends pruned there is always another way onward, so forbid it.
        if (ei === s.edge[si]) continue;
        const e = graph.edges[ei]!;
        const newDist = dist + e.lengthM;
        if (newDist > maxLen) continue;
        const nextNode = otherNode(e, node);
        if (distBack && newDist + distBack[nextNode]! > maxLen) continue;

        const elev = e.elev!;
        const m = elev.length;
        const forward = e.a === node;
        const spacing = e.lengthM / (m - 1);
        let sq = s.sq[si]!;
        let gain = s.gain[si]!;
        let loss = s.loss[si]!;
        let prevRel = forward ? elev[0]! - elev0 : elev[m - 1]! - elev0;
        for (let p = 1; p < m; p++) {
          const rel = elev[forward ? p : m - 1 - p]! - elev0;
          let ti = Math.round((dist + p * spacing) / 25);
          if (ti > lastTargetIdx) ti = lastTargetIdx;
          const diff = rel - targetSamples[ti]!;
          sq += diff * diff;
          const delta = rel - prevRel;
          if (delta > 0) gain += delta;
          else loss -= delta;
          prevRel = rel;
        }

        const reuse = recentReuse(s, si, ei, forward ? 1 : 0);
        const repeat = reuse === 0 ? 0 : reuse === 1 ? e.lengthM : 2 * e.lengthM;

        const entry = entryHeading(e, forward);
        const prevExit = s.exitHead[si]!;
        let turns = s.turns[si]! + e.turnOffsets.length;
        if (
          Number.isFinite(prevExit) &&
          Number.isFinite(entry) &&
          Math.abs(angleDiffDeg(prevExit, entry)) > TURN_ANGLE_DEG
        ) {
          turns++;
        }

        const idx = s.node.length;
        s.node.push(nextNode);
        s.dist.push(newDist);
        s.sq.push(sq);
        s.sampleCount.push(s.sampleCount[si]! + m - 1);
        s.gain.push(gain);
        s.loss.push(loss);
        s.penaltyLen.push(s.penaltyLen[si]! + e.penalty * e.lengthM);
        s.repeatLen.push(s.repeatLen[si]! + repeat);
        s.turns.push(turns);
        s.exitHead.push(exitHeading(e, forward));
        s.parent.push(si);
        s.edge.push(ei);
        s.dir.push(forward ? 1 : 0);

        if (newDist >= minLen && (!endMask || endMask[nextNode])) complete(idx);
        const nb = Math.floor(newDist / bucketSizeM);
        if (nb === b) bucket.push(idx);
        else if (nb < totalBuckets) buckets[nb]!.push(idx);
      }
    }
    buckets[b] = [];

    onProgress?.(b + 1, totalBuckets, best[0] ?? null);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return best;
}
