import { buildGraph, filterToComponent, sampleEdgeElevations, snapToNode } from '../graph/build';
import type { Graph } from '../graph/types';
import { fetchNetwork } from '../net/overpass';
import { TerrainSampler } from '../net/terrain';
import type { LatLon, MainToWorker, WorkerToMain } from '../shared/messages';

function post(msg: WorkerToMain): void {
  postMessage(msg);
}

const sampler = new TerrainSampler();

let graph: Graph | null = null;
let startNode = -1;

async function prepare(start: LatLon, radiusMeters: number): Promise<void> {
  post({ type: 'progress', stage: 'network', fraction: 0, bestScore: null });
  const response = await fetchNetwork(start, radiusMeters);
  post({ type: 'progress', stage: 'graph', fraction: 0.3, bestScore: null });
  const full = buildGraph(response);
  const snapped = snapToNode(full, start.lat, start.lon);
  if (snapped < 0) {
    throw new Error('No path or road found within 100 m of the start point');
  }
  const filtered = filterToComponent(full, snapped);
  graph = filtered.graph;
  startNode = filtered.startNode;
  post({ type: 'progress', stage: 'elevation', fraction: 0.5, bestScore: null });
  await sampleEdgeElevations(graph, sampler);
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
    case 'prepare':
      prepare(msg.start, msg.radiusMeters).catch((err: unknown) =>
        post({ type: 'error', message: err instanceof Error ? err.message : String(err) }),
      );
      break;
    case 'search':
      post({ type: 'error', message: 'Search not implemented yet (phase 2)' });
      break;
    case 'cancel':
      break;
  }
};
