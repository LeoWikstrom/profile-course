import {
  buildGraph,
  edgeSamplePositions,
  filterToComponent,
  pruneDeadEnds,
  sampleEdgeElevations,
  snapToNode,
} from '../graph/build';
import type { Graph } from '../graph/types';
import { fetchNetwork } from '../net/overpass';
import { TerrainSampler } from '../net/terrain';
import type { TargetProfile } from '../gpx/profile';
import type {
  CourseResult,
  CourseSegment,
  LatLon,
  MainToWorker,
  TargetTransfer,
  WorkerToMain,
} from '../shared/messages';
import { beamSearch } from './beam';
import { improveCandidates } from './improve';
import { randomWalkSearch, type WalkCandidate } from './randomWalk';
import type { CoursePath } from './score';

function post(msg: WorkerToMain): void {
  postMessage(msg);
}

const sampler = new TerrainSampler();

let graph: Graph | null = null;
let startNode = -1;
let preparedKey = '';
let cancelled = false;

async function ensurePrepared(start: LatLon, radiusMeters: number): Promise<void> {
  const key = `${start.lat.toFixed(5)},${start.lon.toFixed(5)},${Math.round(radiusMeters)}`;
  if (graph && preparedKey === key) return;

  post({ type: 'progress', stage: 'fetching network', fraction: 0.05, bestScore: null });
  const response = await fetchNetwork(start, radiusMeters);
  post({ type: 'progress', stage: 'building graph', fraction: 0.15, bestScore: null });
  const full = buildGraph(response);
  const snapped = snapToNode(full, start.lat, start.lon);
  if (snapped < 0) {
    throw new Error('No path or road found within 100 m of the start point');
  }
  const filtered = filterToComponent(full, snapped);
  const pruned = pruneDeadEnds(filtered.graph, filtered.startNode);
  graph = pruned.graph;
  startNode = pruned.keepNode;
  post({ type: 'progress', stage: 'sampling elevation', fraction: 0.25, bestScore: null });
  await sampleEdgeElevations(graph, sampler);
  preparedKey = key;

  const lat = graph.nodeLat[startNode]!;
  const lon = graph.nodeLon[startNode]!;
  post({
    type: 'prepared',
    nodeCount: graph.nodeLat.length,
    edgeCount: graph.edges.length,
    startNode: { lat, lon },
    startElevation: await sampler.elevationAt(lat, lon),
  });
}

function pathSegments(g: Graph, path: CoursePath): CourseSegment[] {
  return path.edges.map((ei, i) => {
    const e = g.edges[ei]!;
    if (path.dirs[i] === 1) return { lats: e.lats, lons: e.lons, surface: e.surface };
    return {
      lats: Float64Array.from(e.lats).reverse(),
      lons: Float64Array.from(e.lons).reverse(),
      surface: e.surface,
    };
  });
}

function toResult(g: Graph, candidate: WalkCandidate, seed: number): CourseResult {
  const exportPoints: CourseResult['exportPoints'] = [];
  for (let i = 0; i < candidate.path.edges.length; i++) {
    const e = g.edges[candidate.path.edges[i]!]!;
    const { lats, lons } = edgeSamplePositions(e);
    const elev = e.elev!;
    const n = lats.length;
    const forward = candidate.path.dirs[i] === 1;
    for (let k = exportPoints.length === 0 ? 0 : 1; k < n; k++) {
      const j = forward ? k : n - 1 - k;
      exportPoints.push({ lat: lats[j]!, lon: lons[j]!, ele: elev[Math.min(j, elev.length - 1)]! });
    }
  }
  return {
    segments: pathSegments(g, candidate.path),
    samples: candidate.course.samples,
    exportPoints,
    lengthM: candidate.course.lengthM,
    gain: candidate.course.gain,
    loss: candidate.course.loss,
    score: candidate.score,
    surfaceSplit: candidate.course.surfaceSplit,
    seed,
  };
}

async function search(
  start: LatLon,
  radiusMeters: number,
  target: TargetTransfer,
  targetLengthMeters: number,
  seed: number,
  algorithm: 'beam' | 'walk',
): Promise<void> {
  cancelled = false;
  const t0 = performance.now();
  await ensurePrepared(start, radiusMeters);
  const g = graph!;
  const profile: TargetProfile = target;
  const tGraph = performance.now();

  post({ type: 'progress', stage: 'searching', fraction: 0.3, bestScore: null });
  let lastBestScore = Infinity;
  const streamBest = (best: { path: CoursePath; score: number } | null) => {
    if (best && best.score < lastBestScore) {
      lastBestScore = best.score;
      post({ type: 'bestSoFar', segments: pathSegments(g, best.path), score: best.score });
    }
  };

  const candidates =
    algorithm === 'walk'
      ? await randomWalkSearch(g, startNode, profile, targetLengthMeters, {
          seed,
          onProgress: (done, total, best) => {
            post({
              type: 'progress',
              stage: 'searching',
              fraction: 0.3 + 0.6 * (done / total),
              bestScore: best?.score ?? null,
            });
            streamBest(best);
          },
          shouldCancel: () => cancelled,
        })
      : await beamSearch(g, startNode, profile, targetLengthMeters, {
          seed,
          onProgress: (bucket, total, best) => {
            post({
              type: 'progress',
              stage: 'searching',
              fraction: 0.3 + 0.6 * (bucket / total),
              bestScore: best?.score ?? null,
            });
            streamBest(best);
          },
          shouldCancel: () => cancelled,
        });

  if (cancelled) return;
  if (candidates.length === 0) {
    post({
      type: 'noCourse',
      message: 'No course found within ±3 % of the target length. Try a larger radius.',
    });
    return;
  }

  const tSearch = performance.now();
  post({ type: 'progress', stage: 'improving', fraction: 0.92, bestScore: candidates[0]!.score });
  const improved = await improveCandidates(g, startNode, candidates, profile, targetLengthMeters, {
    shouldCancel: () => cancelled,
  });
  if (cancelled) return;

  const tDone = performance.now();
  console.log(
    `search timings (${algorithm}): prepare ${(tGraph - t0).toFixed(0)} ms, ` +
      `search ${(tSearch - tGraph).toFixed(0)} ms, improve ${(tDone - tSearch).toFixed(0)} ms, ` +
      `score ${candidates[0]!.score.toFixed(2)} -> ${improved[0]!.score.toFixed(2)}`,
  );
  post({ type: 'result', course: toResult(g, improved[0]!, seed) });
}

onmessage = (event: MessageEvent<MainToWorker>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'ping':
      post({ type: 'pong' });
      break;
    case 'elevate':
      sampler
        .elevations(msg.lats, msg.lons)
        .then((elevations) => post({ type: 'elevated', elevations }))
        .catch((err: unknown) => post({ type: 'error', message: String(err) }));
      break;
    case 'search':
      search(
        msg.start,
        msg.radiusMeters,
        msg.target,
        msg.targetLengthMeters,
        msg.seed,
        msg.algorithm,
      ).catch(
        (err: unknown) =>
          post({ type: 'error', message: err instanceof Error ? err.message : String(err) }),
      );
      break;
    case 'cancel':
      cancelled = true;
      break;
  }
};
