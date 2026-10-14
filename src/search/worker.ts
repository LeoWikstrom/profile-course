import {
  buildGraph,
  edgeSamplePositions,
  filterToComponent,
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
  graph = filtered.graph;
  startNode = filtered.startNode;
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
): Promise<void> {
  cancelled = false;
  await ensurePrepared(start, radiusMeters);
  const g = graph!;
  const profile: TargetProfile = target;

  post({ type: 'progress', stage: 'searching', fraction: 0.3, bestScore: null });
  let lastBestScore = Infinity;
  const candidates = await randomWalkSearch(g, startNode, profile, targetLengthMeters, {
    seed,
    onProgress: (done, total, best) => {
      post({
        type: 'progress',
        stage: 'searching',
        fraction: 0.3 + 0.7 * (done / total),
        bestScore: best?.score ?? null,
      });
      if (best && best.score < lastBestScore) {
        lastBestScore = best.score;
        post({ type: 'bestSoFar', segments: pathSegments(g, best.path), score: best.score });
      }
    },
    shouldCancel: () => cancelled,
  });

  if (cancelled) return;
  const best = candidates[0];
  if (!best) {
    post({
      type: 'noCourse',
      message: 'No course found within ±3 % of the target length. Try a larger radius.',
    });
    return;
  }
  post({ type: 'result', course: toResult(g, best, seed) });
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
      search(msg.start, msg.radiusMeters, msg.target, msg.targetLengthMeters, msg.seed).catch(
        (err: unknown) =>
          post({ type: 'error', message: err instanceof Error ? err.message : String(err) }),
      );
      break;
    case 'cancel':
      cancelled = true;
      break;
  }
};
