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
import { mulberry32, type WalkCandidate } from './randomWalk';

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
  /** Additional allowed start nodes (e.g. everything inside the zone). */
  startNodes?: number[] | null;
  /**
   * Must-pass constraints, in order. nodes = graph nodes counting as "at the
   * via"; dist = multi-source Dijkstra distances to them; kmM = optional
   * course distance (metres) near which the via must be reached.
   */
  vias?: { nodes: Set<number>; edges?: Set<number>; dist: Float64Array; kmM: number | null }[];
  /** Half-width of the km window around each via's km, metres. */
  viaSlackM?: number;
  onProgress?: (bucket: number, totalBuckets: number, best: WalkCandidate | null) => void;
  shouldCancel?: () => boolean;
}


interface StateStore {
  node: number[];
  dist: number[];
  sq: number[];
  /** Sum of (course − target) diffs, for offset-corrected partial RMSE. */
  diffSum: number[];
  sampleCount: number[];
  gain: number[];
  loss: number[];
  penaltyLen: number[];
  repeatLen: number[];
  /** Bitmask of via points visited so far, in order. */
  viaMask: number[];
  /** Running max of per-edge offset-corrected shape error (localShape proxy). */
  shapeMax: number[];
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
  /**
   * Guidance toward the target's highest feature: distance from every node to
   * the nearest "peak-capable" terrain (elevation ≈ start + peak value).
   * Without it the beam is myopic — a big climb at km 5 cannot influence
   * which flat prefixes survive at km 2, so features like a high bridge are
   * never reached (the Älvsborgsbron case).
   */
  peakDist: Float64Array | null;
  peakAtM: number;
}

const MAX_ROOTS = 120;

function rootCell(graph: Graph, node: number): number {
  const cy = Math.round((graph.nodeLat[node]! * 111320) / 250);
  const cx = Math.round((graph.nodeLon[node]! * 58000) / 250);
  return cy * 1_000_003 + cx;
}

const PEAK_MIN_HEIGHT_M = 15;
// Generous: elev0 carries DEM bias (7 m observed at Slottsskogsvallen), and
// the RMSE is offset-corrected anyway — guidance just needs to include all
// plausibly peak-capable terrain.
const PEAK_ELEV_TOLERANCE_M = 15;
const PEAK_MISS_WEIGHT_PER_KM = 10;

function targetPrefix(target: TargetProfile, graph: Graph, elev0: number): TargetPrefix {
  const samples = target.samples;
  const cumGain = new Float32Array(samples.length);
  const cumLoss = new Float32Array(samples.length);
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i]! - samples[i - 1]!;
    cumGain[i] = cumGain[i - 1]! + (d > 0 ? d : 0);
    cumLoss[i] = cumLoss[i - 1]! + (d < 0 ? -d : 0);
  }

  let peakDist: Float64Array | null = null;
  let peakAtM = 0;
  let peakIdx = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i]! > samples[peakIdx]!) peakIdx = i;
  }
  const peakValue = samples[peakIdx]!;
  if (peakValue >= PEAK_MIN_HEIGHT_M) {
    const wantElev = elev0 + peakValue;
    const attractors: number[] = [];
    const nodeElev = new Float64Array(graph.nodeLat.length).fill(Number.NaN);
    for (const e of graph.edges) {
      if (!e.elev) continue;
      nodeElev[e.a] = e.elev[0]!;
      nodeElev[e.b] = e.elev[e.elev.length - 1]!;
    }
    for (let i = 0; i < nodeElev.length; i++) {
      if (Math.abs(nodeElev[i]! - wantElev) <= PEAK_ELEV_TOLERANCE_M) attractors.push(i);
    }
    if (attractors.length > 0) {
      peakDist = dijkstra(graph, attractors).dist;
      peakAtM = peakIdx * 25;
    }
  }

  return {
    cumGain,
    cumLoss,
    denom: Math.max(1, target.totalGain + target.totalLoss),
    turnsPerKm: target.turnsPerKm,
    peakDist,
    peakAtM,
  };
}

function partialRank(s: StateStore, i: number, weights: Weights, tp: TargetPrefix): number {
  const d = Math.max(1, s.dist[i]!);
  const n = Math.max(1, s.sampleCount[i]!);
  const mean = s.diffSum[i]! / n;
  const rmse = Math.sqrt(Math.max(0, s.sq[i]! / n - mean * mean));
  let ti = Math.round(s.dist[i]! / 25);
  if (ti >= tp.cumGain.length) ti = tp.cumGain.length - 1;
  const gainLossErr =
    (Math.abs(s.gain[i]! - tp.cumGain[ti]!) + Math.abs(s.loss[i]! - tp.cumLoss[ti]!)) / tp.denom;
  // Turn density is noisy on short prefixes; let it bite only after 500 m.
  const turnErr = d > 500 ? Math.abs(s.turns[i]! / (d / 1000) - tp.turnsPerKm) : 0;
  // Before the target's main peak: penalise states that can no longer reach
  // peak-capable terrain in the remaining distance (they will miss the climb).
  let peakMiss = 0;
  if (tp.peakDist && s.dist[i]! < tp.peakAtM) {
    const shortfall = tp.peakDist[s.node[i]!]! - (tp.peakAtM - s.dist[i]!);
    if (shortfall > 0) peakMiss = (shortfall / 1000) * PEAK_MISS_WEIGHT_PER_KM;
  }
  return (
    peakMiss +
    weights.rmse * rmse +
    weights.gainLoss * gainLossErr +
    weights.penalty * (s.penaltyLen[i]! / d) +
    // repeatLen is reuse inside the oscillation window (see recentReuse). Use
    // a fraction of the final weight: at full strength the term dominates the
    // partial rank in dense/small graphs and starves the beam of diversity.
    (weights.oscillation / 4) * (s.repeatLen[i]! / d) +
    weights.turns * turnErr +
    weights.localShape * s.shapeMax[i]!
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
    startNodes = null,
    vias = [],
    viaSlackM = Math.max(500, targetLengthM * 0.05),
    onProgress,
    shouldCancel,
  } = options;
  const fullViaMask = (1 << vias.length) - 1;

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

  // Multi-start: the course may begin at any allowed start node, but seeding
  // every zone node dilutes the beam across thousands of half-developed
  // lineages (measured: 54 vs 37 mismatch and a 10x slowdown). Subsample to
  // at most one root per ~250 m cell, max MAX_ROOTS, seeded shuffle first so
  // each seed picks a different representative per cell.
  let roots = returnToStart || !startNodes || startNodes.length === 0 ? [startNode] : startNodes;
  if (roots.length > 1) {
    const rng = mulberry32(seed * 7919 + 1);
    roots = [...roots];
    for (let i = roots.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [roots[i], roots[j]] = [roots[j]!, roots[i]!];
    }
    if (roots.length > MAX_ROOTS) {
      const cells = new Set<number>();
      const picked: number[] = [startNode];
      cells.add(rootCell(graph, startNode));
      for (const r of roots) {
        if (picked.length >= MAX_ROOTS) break;
        const c = rootCell(graph, r);
        if (cells.has(c)) continue;
        cells.add(c);
        picked.push(r);
      }
      roots = picked;
    }
  }
  const s: StateStore = {
    node: [...roots],
    dist: roots.map(() => 0),
    sq: roots.map(() => 0),
    diffSum: roots.map(() => 0),
    sampleCount: roots.map(() => 0),
    gain: roots.map(() => 0),
    loss: roots.map(() => 0),
    penaltyLen: roots.map(() => 0),
    repeatLen: roots.map(() => 0),
    viaMask: roots.map(() => 0),
    shapeMax: roots.map(() => 0),
    turns: roots.map(() => 0),
    exitHead: roots.map(() => Number.NaN),
    parent: roots.map(() => -1),
    edge: roots.map(() => -1),
    dir: roots.map(() => 0),
  };
  const tp = targetPrefix(target, graph, elev0);

  const buckets: number[][] = Array.from({ length: totalBuckets }, () => []);
  for (let i = 0; i < roots.length; i++) buckets[0]!.push(i);

  const best: WalkCandidate[] = [];
  const targetSamples = target.samples;
  const lastTargetIdx = targetSamples.length - 1;

  function complete(stateIdx: number): void {
    // Cheap near-lower-bound gate before the expensive assemble + full score:
    // offset-corrected RMSE and the shape max both reappear in the final
    // score, and every other term is >= -2 (penalty bonuses).
    if (best.length >= keepBest) {
      const n = Math.max(1, s.sampleCount[stateIdx]!);
      const mean = s.diffSum[stateIdx]! / n;
      const rmse = Math.sqrt(Math.max(0, s.sq[stateIdx]! / n - mean * mean));
      const bound = weights.rmse * rmse + weights.localShape * s.shapeMax[stateIdx]! - 3;
      if (bound > best[best.length - 1]!.score) return;
    }
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

    // Seeded multiplicative noise on the pruning rank, so a new seed ("Try
    // another") explores genuinely different courses. With multi-start the
    // per-seed root selection already differs, so no rank noise is needed —
    // it measurably worsens pruning (observed 80 vs 46 beam score). Pinned
    // starts need a little noise for seeds to differ; seed 1 stays clean.
    const amp = roots.length > 1 || seed === 1 ? 0 : 0.03;
    const noise = (i: number) =>
      1 + amp * ((((i * 2654435761 + seed * 2246822519) >>> 0) % 1024) / 1024);
    bucket.sort(
      (x, y) =>
        partialRank(s, x, weights, tp) * noise(x) - partialRank(s, y, weights, tp) * noise(y),
    );
    // Cap states per end node, or the beam fills with near-identical prefixes
    // of the single best path and loses diversity. Small graphs have few
    // nodes, so the cap scales up to keep distinct histories alive.
    const perNodeCap = Math.max(
      2,
      Math.min(8, Math.floor((2 * beamWidth) / Math.max(1, graph.nodeLat.length))),
    );
    // First pass: best state per ~400 m map cell, so the frontier stays
    // spatially spread — otherwise the whole beam collapses onto one
    // neighbourhood and distant features (a bridge at km 5) are unreachable.
    const cellOf = (si: number) => {
      const n = s.node[si]!;
      const cy = Math.round((graph.nodeLat[n]! * 111320) / 400);
      const cx = Math.round((graph.nodeLon[n]! * 58000) / 400);
      return cy * 1_000_003 + cx;
    };
    const chosen = new Set<number>();
    const cells = new Set<number>();
    // Half the beam for spatial spread: measured best (a quarter lost ground
    // on the 21 km benchmark, 46.9 vs 45.5 average over three seeds).
    const diversityQuota = Math.floor(beamWidth / 2);
    for (const si of bucket) {
      if (chosen.size >= diversityQuota) break;
      const c = cellOf(si);
      if (cells.has(c)) continue;
      cells.add(c);
      chosen.add(si);
    }
    // Diversity picks are guaranteed slots; the rest fill up by rank.
    const kept: number[] = [];
    for (const si of bucket) if (chosen.has(si)) kept.push(si);
    const perNode = new Map<number, number>();
    for (const si of bucket) {
      if (kept.length >= beamWidth) break;
      if (chosen.has(si)) continue;
      // Via progress is part of a state's identity: a lineage that already
      // passed via 1 must not be deduped against one that has not.
      const key = s.node[si]! * 16 + (s.viaMask[si]! & 15);
      const count = perNode.get(key) ?? 0;
      if (count >= perNodeCap) continue;
      perNode.set(key, count + 1);
      kept.push(si);
    }
    bucket.length = 0;
    bucket.push(...kept);

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

        // Via constraints: the next unvisited via must stay reachable within
        // its km window (or within the course budget if it has no km).
        let viaMask = s.viaMask[si]!;
        if (vias.length > 0 && viaMask !== fullViaMask) {
          let vi = 0;
          while (vi < vias.length && (viaMask & (1 << vi)) !== 0) vi++;
          const via = vias[vi]!;
          if (via.nodes.has(nextNode) || via.edges?.has(ei)) {
            if (via.kmM === null || Math.abs(newDist - via.kmM) <= viaSlackM) {
              viaMask |= 1 << vi;
            }
          }
          if ((viaMask & (1 << vi)) === 0) {
            const reach = via.dist[nextNode]!;
            if (via.kmM !== null) {
              if (newDist > via.kmM + viaSlackM) continue; // window missed
              if (newDist + reach > via.kmM + viaSlackM) continue; // can't make it
            } else if (newDist + reach > maxLen) {
              continue;
            }
          }
        }

        const elev = e.elev!;
        const m = elev.length;
        const forward = e.a === node;
        const spacing = e.lengthM / (m - 1);
        let sq = s.sq[si]!;
        let gain = s.gain[si]!;
        let loss = s.loss[si]!;
        let diffSum = 0;
        let diffSq = 0;
        let prevRel = forward ? elev[0]! - elev0 : elev[m - 1]! - elev0;
        for (let p = 1; p < m; p++) {
          const rel = elev[forward ? p : m - 1 - p]! - elev0;
          let ti = Math.round((dist + p * spacing) / 25);
          if (ti > lastTargetIdx) ti = lastTargetIdx;
          const diff = rel - targetSamples[ti]!;
          sq += diff * diff;
          diffSum += diff;
          diffSq += diff * diff;
          const delta = rel - prevRel;
          if (delta > 0) gain += delta;
          else loss -= delta;
          prevRel = rel;
        }
        // Offset-corrected shape error over this edge: a cheap incremental
        // proxy for the final localShape window term.
        const mean = diffSum / (m - 1);
        const edgeShape = Math.sqrt(Math.max(0, diffSq / (m - 1) - mean * mean));
        const shapeMax = Math.max(s.shapeMax[si]!, edgeShape);

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
        s.diffSum.push(s.diffSum[si]! + diffSum);
        s.sampleCount.push(s.sampleCount[si]! + m - 1);
        s.gain.push(gain);
        s.loss.push(loss);
        s.penaltyLen.push(s.penaltyLen[si]! + e.penalty * e.lengthM);
        s.repeatLen.push(s.repeatLen[si]! + repeat);
        s.viaMask.push(viaMask);
        s.shapeMax.push(shapeMax);
        s.turns.push(turns);
        s.exitHead.push(exitHeading(e, forward));
        s.parent.push(si);
        s.edge.push(ei);
        s.dir.push(forward ? 1 : 0);

        if (newDist >= minLen && (!endMask || endMask[nextNode]) && viaMask === fullViaMask) {
          complete(idx);
        }
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
