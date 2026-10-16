import {
  buildGraph,
  edgeSamplePositions,
  filterToComponent,
  pruneDeadEnds,
  sampleEdgeElevations,
  snapToNode,
} from '../graph/build';
import { otherNode, type Graph } from '../graph/types';
import { deleteArea, listAreas, saveArea } from '../net/areaStore';
import { fetchNetwork, getNetwork } from '../net/overpass';
import { TerrainSampler } from '../net/terrain';
import { haversineMeters } from '../shared/geo';
import type { TargetProfile } from '../gpx/profile';
import type {
  CourseResult,
  CourseSegment,
  LatLon,
  MainToWorker,
  TargetTransfer,
  ViaPoint,
  WorkerToMain,
} from '../shared/messages';
import { dijkstra } from '../graph/dijkstra';
import { matchTrackToGraph } from '../graph/match';
import { beamSearch } from './beam';
import { improveCandidates } from './improve';
import { randomWalkSearch, type WalkCandidate } from './randomWalk';
import {
  assembleCourse,
  scoreBreakdown,
  scoreCourse,
  DEFAULT_WEIGHTS,
  MIX_ROAD,
  type CoursePath,
} from './score';

function post(msg: WorkerToMain): void {
  postMessage(msg);
}

const sampler = new TerrainSampler();

function bytesProgress(stage: string, fraction: number): (bytes: number, endpoint: number) => void {
  let lastPosted = 0;
  return (bytes, endpoint) => {
    if (bytes - lastPosted < 512 * 1024) return;
    lastPosted = bytes;
    const mb = (bytes / 1048576).toFixed(1);
    const mirror = endpoint > 0 ? ', mirror' : '';
    post({ type: 'progress', stage: `${stage} (${mb} MB${mirror})`, fraction, bestScore: null });
  };
}

async function downloadArea(center: LatLon, radiusMeters: number): Promise<void> {
  post({ type: 'progress', stage: 'downloading area', fraction: 0.02, bestScore: null });
  // Overpass streams chunked without a length header; estimate the total from
  // the area (~0.3 MB/km² in a city, clamped) and cap the bar at 95 %.
  const km2 = Math.PI * (radiusMeters / 1000) ** 2;
  const estBytes = Math.max(2e6, km2 * 0.3e6);
  let lastPosted = 0;
  const response = await fetchNetwork(center, radiusMeters, {
    rounds: 4,
    onBytes: (bytes, endpoint) => {
      if (bytes - lastPosted < 256 * 1024) return;
      lastPosted = bytes;
      const mb = (bytes / 1048576).toFixed(1);
      const mirror = endpoint > 0 ? ', mirror' : '';
      post({
        type: 'progress',
        stage: `downloading area (${mb} MB${mirror})`,
        fraction: Math.min(0.95, bytes / estBytes),
        bestScore: null,
      });
    },
  });
  post({ type: 'progress', stage: 'downloading area (saving)', fraction: 0.97, bestScore: null });
  await saveArea(center, radiusMeters, response);
  post({ type: 'areas', areas: await listAreas() });
}

let graph: Graph | null = null;
let startNode = -1;
let validEnd: Uint8Array | null = null;
let preparedKey = '';
let cancelled = false;

/** Last map-matched uploaded course, for the Improve button. */
let matchedPath: CoursePath | null = null;
let matchedKey = '';

/** The course may leave the radius; cap how wide a network we are willing to pull. */
const MAX_GRAPH_RADIUS_M = 15_000;

async function ensurePrepared(
  start: LatLon,
  radiusMeters: number,
  targetLengthMeters: number,
  connectors = false,
): Promise<void> {
  // The radius is only the start/finish zone. A course of length L can reach
  // about L/2 out before it has to head back.
  const graphRadius = Math.min(radiusMeters + targetLengthMeters / 2, MAX_GRAPH_RADIUS_M);
  const key = `${start.lat.toFixed(5)},${start.lon.toFixed(5)},${Math.round(radiusMeters)},${Math.round(graphRadius)},${connectors ? 'c' : ''}`;
  if (graph && preparedKey === key) return;

  post({ type: 'progress', stage: 'fetching network', fraction: 0.05, bestScore: null });
  let result;
  try {
    result = await getNetwork(start, graphRadius, {
      onBytes: bytesProgress('fetching network', 0.05),
    });
  } catch (err) {
    if (!navigator.onLine) {
      throw new Error(
        'You are offline and no downloaded area covers this search. ' +
          'Download an offline area first, or reconnect.',
        { cause: err },
      );
    }
    throw err;
  }
  const { response, source } = result;
  if (source === 'offline-area') {
    post({ type: 'progress', stage: 'using offline area', fraction: 0.1, bestScore: null });
  }
  post({ type: 'progress', stage: 'building graph', fraction: 0.15, bestScore: null });
  const full = buildGraph(response, { connectors });
  const snapped = snapToNode(full, start.lat, start.lon);
  if (snapped < 0) {
    throw new Error('No path or road found within 100 m of the start point');
  }
  const filtered = filterToComponent(full, snapped);
  const pruned = pruneDeadEnds(filtered.graph, filtered.startNode);
  graph = pruned.graph;
  startNode = pruned.keepNode;

  validEnd = new Uint8Array(graph.nodeLat.length);
  for (let i = 0; i < validEnd.length; i++) {
    if (haversineMeters(start.lat, start.lon, graph.nodeLat[i]!, graph.nodeLon[i]!) <= radiusMeters) {
      validEnd[i] = 1;
    }
  }

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

function toResult(
  g: Graph,
  candidate: WalkCandidate,
  seed: number,
  breakdown: Record<string, number>,
): CourseResult {
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
    breakdown,
    surfaceSplit: candidate.course.surfaceSplit,
    seed,
  };
}

interface SearchOptionsIn {
  desiredMix: [number, number, number, number] | null;
  returnToStart: boolean;
  startAtPoint: boolean;
  weights: Record<string, number> | null;
  connectors: boolean;
  beamWidth: number;
  viaPoints: ViaPoint[];
}

const VIA_NEAR_M = 40;

function resolveVias(
  g: Graph,
  viaPoints: ViaPoint[],
): { nodes: Set<number>; dist: Float64Array; kmM: number | null }[] {
  return viaPoints.map((v, i) => {
    const nodes = new Set<number>();
    for (let n = 0; n < g.nodeLat.length; n++) {
      if (haversineMeters(v.lat, v.lon, g.nodeLat[n]!, g.nodeLon[n]!) <= VIA_NEAR_M) nodes.add(n);
    }
    if (nodes.size === 0) {
      throw new Error(`Via point ${i + 1} is more than ${VIA_NEAR_M} m from any path`);
    }
    return { nodes, dist: dijkstra(g, [...nodes]).dist, kmM: v.km !== null ? v.km * 1000 : null };
  });
}

/** True when the path visits every via node-set in order. */
function pathVisitsVias(
  g: Graph,
  path: CoursePath,
  vias: { nodes: Set<number> }[],
  root: number,
): boolean {
  let vi = 0;
  let node = root;
  if (vias.length === 0) return true;
  if (vias[0]!.nodes.has(node)) vi++;
  for (let i = 0; i < path.edges.length && vi < vias.length; i++) {
    node = otherNode(g.edges[path.edges[i]!]!, node);
    if (vias[vi]!.nodes.has(node)) vi++;
  }
  return vi >= vias.length;
}

async function search(
  start: LatLon,
  radiusMeters: number,
  target: TargetTransfer,
  targetLengthMeters: number,
  seed: number,
  algorithm: 'beam' | 'walk',
  opts: SearchOptionsIn,
): Promise<void> {
  cancelled = false;
  const t0 = performance.now();
  await ensurePrepared(start, radiusMeters, targetLengthMeters, opts.connectors);
  const g = graph!;
  const profile: TargetProfile = target;
  const tGraph = performance.now();

  // A loop (return-to-start) needs a fixed anchor; otherwise the course may
  // begin anywhere inside the start/finish zone unless pinned to the marker.
  let startNodes: number[] | null = null;
  if (!opts.startAtPoint && !opts.returnToStart && validEnd) {
    startNodes = [];
    for (let i = 0; i < validEnd.length; i++) if (validEnd[i]) startNodes.push(i);
  }

  const weights = { ...DEFAULT_WEIGHTS, ...(opts.weights ?? {}) };
  const vias = resolveVias(g, opts.viaPoints);
  if (vias.length > 0 && algorithm === 'walk') {
    throw new Error('Via points require the beam search algorithm');
  }
  const validatePath =
    vias.length > 0
      ? (path: CoursePath) => {
          const first = g.edges[path.edges[0]!];
          if (!first) return false;
          const root = path.dirs[0] === 1 ? first.a : first.b;
          return pathVisitsVias(g, path, vias, root);
        }
      : undefined;

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
          desiredMix: opts.desiredMix,
          returnToStart: opts.returnToStart,
          weights,
          validEnd,
          startNodes,
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
          beamWidth: Math.max(50, Math.min(800, opts.beamWidth || 200)),
          vias,
          desiredMix: opts.desiredMix,
          returnToStart: opts.returnToStart,
          weights,
          validEnd,
          startNodes,
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
    desiredMix: opts.desiredMix,
    weights,
    validatePath,
    shouldCancel: () => cancelled,
  });
  if (cancelled) return;

  const tDone = performance.now();
  console.log(
    `search timings (${algorithm}): prepare ${(tGraph - t0).toFixed(0)} ms, ` +
      `search ${(tSearch - tGraph).toFixed(0)} ms, improve ${(tDone - tSearch).toFixed(0)} ms, ` +
      `score ${candidates[0]!.score.toFixed(2)} -> ${improved[0]!.score.toFixed(2)}`,
  );
  post({
    type: 'result',
    course: toResult(
      g,
      improved[0]!,
      seed,
      scoreBreakdown(improved[0]!.course, profile, opts.desiredMix ?? MIX_ROAD, weights),
    ),
  });
}

async function matchCourse(
  lats: Float64Array,
  lons: Float64Array,
  target: TargetTransfer,
  desiredMix: [number, number, number, number] | null,
  weightsIn: Record<string, number> | null,
): Promise<void> {
  // Graph area from the course's own bounding box.
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (let i = 0; i < lats.length; i++) {
    minLat = Math.min(minLat, lats[i]!);
    maxLat = Math.max(maxLat, lats[i]!);
    minLon = Math.min(minLon, lons[i]!);
    maxLon = Math.max(maxLon, lons[i]!);
  }
  const center = { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };
  const halfDiag =
    haversineMeters(minLat, minLon, maxLat, maxLon) / 2 + 500;
  // Matching follows the user's own route, which may well cross streets
  // informally — always build this graph with connectors enabled.
  await ensurePrepared(center, Math.min(halfDiag, MAX_GRAPH_RADIUS_M), 0, true);
  const g = graph!;

  post({ type: 'progress', stage: 'matching course', fraction: 0.8, bestScore: null });
  const { path, snappedFraction } = matchTrackToGraph(g, lats, lons);
  const weights = { ...DEFAULT_WEIGHTS, ...(weightsIn ?? {}) };
  const course = assembleCourse(g, path);
  const score = scoreCourse(course, target, desiredMix ?? MIX_ROAD, weights);
  matchedPath = path;
  matchedKey = preparedKey;
  post({
    type: 'matched',
    course: toResult(
      g,
      { path, course, score },
      0,
      scoreBreakdown(course, target, desiredMix ?? MIX_ROAD, weights),
    ),
    snappedFraction,
    improvable: true,
  });
}

async function improveMatched(
  target: TargetTransfer,
  desiredMix: [number, number, number, number] | null,
  weightsIn: Record<string, number> | null,
): Promise<void> {
  if (!matchedPath || !graph || matchedKey !== preparedKey) {
    throw new Error('No matched course in memory — upload the course GPX again.');
  }
  cancelled = false;
  const g = graph;
  const weights = { ...DEFAULT_WEIGHTS, ...(weightsIn ?? {}) };
  const course = assembleCourse(g, matchedPath);
  const score = scoreCourse(course, target, desiredMix ?? MIX_ROAD, weights);
  post({ type: 'progress', stage: 'improving', fraction: 0.5, bestScore: score });
  const improved = await improveCandidates(
    g,
    startNode,
    [{ path: matchedPath, course, score }],
    target,
    course.lengthM,
    { desiredMix: desiredMix ?? MIX_ROAD, weights, maxCandidates: 1, passes: 6, shouldCancel: () => cancelled },
  );
  matchedPath = improved[0]!.path;
  post({
    type: 'matched',
    course: toResult(
      g,
      improved[0]!,
      0,
      scoreBreakdown(improved[0]!.course, target, desiredMix ?? MIX_ROAD, weights),
    ),
    snappedFraction: 1,
    improvable: true,
  });
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
      search(msg.start, msg.radiusMeters, msg.target, msg.targetLengthMeters, msg.seed, msg.algorithm, {
        desiredMix: msg.desiredMix,
        returnToStart: msg.returnToStart,
        startAtPoint: msg.startAtPoint,
        weights: msg.weights,
        connectors: msg.connectors,
        beamWidth: msg.beamWidth,
        viaPoints: msg.viaPoints,
      }).catch(
        (err: unknown) =>
          post({ type: 'error', message: err instanceof Error ? err.message : String(err) }),
      );
      break;
    case 'downloadArea':
      downloadArea(msg.center, msg.radiusMeters).catch((err: unknown) =>
        post({ type: 'error', message: err instanceof Error ? err.message : String(err) }),
      );
      break;
    case 'listAreas':
      listAreas()
        .then((areas) => post({ type: 'areas', areas }))
        .catch((err: unknown) => post({ type: 'error', message: String(err) }));
      break;
    case 'deleteArea':
      deleteArea(msg.id)
        .then((areas) => post({ type: 'areas', areas }))
        .catch((err: unknown) => post({ type: 'error', message: String(err) }));
      break;
    case 'matchCourse':
      matchCourse(msg.lats, msg.lons, msg.target, msg.desiredMix, msg.weights).catch(
        (err: unknown) =>
          post({ type: 'error', message: err instanceof Error ? err.message : String(err) }),
      );
      break;
    case 'improveCourse':
      improveMatched(msg.target, msg.desiredMix, msg.weights).catch((err: unknown) =>
        post({ type: 'error', message: err instanceof Error ? err.message : String(err) }),
      );
      break;
    case 'cancel':
      cancelled = true;
      break;
  }
};
