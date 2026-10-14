import { haversineMeters } from '../shared/geo';
import { SAMPLE_STEP_M, movingMedian5 } from '../gpx/profile';
import type { OverpassResponse, OverpassWay } from '../net/overpass';
import type { TerrainSampler } from '../net/terrain';
import {
  SURFACE_GRAVEL,
  SURFACE_PAVED,
  SURFACE_TRAIL,
  SURFACE_UNKNOWN,
  type Graph,
  type GraphEdge,
  type SurfaceClass,
} from './types';

const PAVED_SURFACES = new Set(['asphalt', 'paved', 'concrete', 'paving_stones', 'sett']);
const GRAVEL_SURFACES = new Set(['gravel', 'fine_gravel', 'compacted', 'pebblestone']);
const TRAIL_SURFACES = new Set([
  'dirt',
  'earth',
  'ground',
  'grass',
  'mud',
  'sand',
  'wood',
  'unpaved',
]);
const PAVED_HIGHWAYS = new Set([
  'residential',
  'living_street',
  'tertiary',
  'unclassified',
  'service',
  'cycleway',
  'footway',
  'pedestrian',
]);

export function classifySurface(tags: Record<string, string>): SurfaceClass {
  const surface = tags['surface'];
  if (surface) {
    if (PAVED_SURFACES.has(surface)) return SURFACE_PAVED;
    if (GRAVEL_SURFACES.has(surface)) return SURFACE_GRAVEL;
    if (TRAIL_SURFACES.has(surface)) return SURFACE_TRAIL;
  }
  const highway = tags['highway'];
  if (highway === 'path' && !surface) return SURFACE_TRAIL;
  if (highway && PAVED_HIGHWAYS.has(highway) && !surface) return SURFACE_PAVED;
  if (highway === 'track' && !surface) return SURFACE_GRAVEL;
  return SURFACE_UNKNOWN;
}

export function edgePenalty(tags: Record<string, string>): number {
  const highway = tags['highway'];
  if (highway === 'steps') return 1.0;
  const tracktype = tags['tracktype'];
  if (tracktype === 'grade4' || tracktype === 'grade5') return 0.5;
  if (highway === 'tertiary') return 0.4;
  return 0;
}

export function buildGraph(response: OverpassResponse): Graph {
  const nodeCoord = new Map<number, { lat: number; lon: number }>();
  const ways: OverpassWay[] = [];
  for (const el of response.elements) {
    if (el.type === 'node') nodeCoord.set(el.id, { lat: el.lat, lon: el.lon });
    else if (el.type === 'way') ways.push(el);
  }

  const usage = new Map<number, number>();
  for (const way of ways) {
    for (const id of way.nodes) usage.set(id, (usage.get(id) ?? 0) + 1);
  }

  const graphNodeIndex = new Map<number, number>();
  const nodeLats: number[] = [];
  const nodeLons: number[] = [];
  function graphNode(osmId: number): number {
    let idx = graphNodeIndex.get(osmId);
    if (idx === undefined) {
      const coord = nodeCoord.get(osmId);
      if (!coord) return -1;
      idx = nodeLats.length;
      graphNodeIndex.set(osmId, idx);
      nodeLats.push(coord.lat);
      nodeLons.push(coord.lon);
    }
    return idx;
  }

  const edges: GraphEdge[] = [];
  for (const way of ways) {
    const tags = way.tags ?? {};
    // Driveways and parking aisles only add noise and in-and-back detours.
    const service = tags['service'];
    if (tags['highway'] === 'service' && (service === 'driveway' || service === 'parking_aisle')) {
      continue;
    }
    const surface = classifySurface(tags);
    const penalty = edgePenalty(tags);
    let segStart = 0;
    for (let i = 1; i < way.nodes.length; i++) {
      const isLast = i === way.nodes.length - 1;
      const isJunction = (usage.get(way.nodes[i]!) ?? 0) >= 2;
      if (!isLast && !isJunction) continue;

      const segIds = way.nodes.slice(segStart, i + 1);
      segStart = i;
      const coords = segIds
        .map((id) => nodeCoord.get(id))
        .filter((c): c is { lat: number; lon: number } => c !== undefined);
      if (coords.length < 2) continue;

      const a = graphNode(segIds[0]!);
      const b = graphNode(segIds[segIds.length - 1]!);
      if (a < 0 || b < 0 || a === b) continue;

      const lats = new Float64Array(coords.length);
      const lons = new Float64Array(coords.length);
      let lengthM = 0;
      for (let j = 0; j < coords.length; j++) {
        lats[j] = coords[j]!.lat;
        lons[j] = coords[j]!.lon;
        if (j > 0) {
          lengthM += haversineMeters(lats[j - 1]!, lons[j - 1]!, lats[j]!, lons[j]!);
        }
      }
      if (lengthM < 1) continue;
      edges.push({ a, b, lengthM, surface, penalty, lats, lons, elev: null });
    }
  }

  const nodeCount = nodeLats.length;
  const degree = new Int32Array(nodeCount);
  for (const e of edges) {
    degree[e.a]!++;
    degree[e.b]!++;
  }
  const adjOffset = new Int32Array(nodeCount + 1);
  for (let i = 0; i < nodeCount; i++) adjOffset[i + 1] = adjOffset[i]! + degree[i]!;
  const adjEdge = new Int32Array(edges.length * 2);
  const fill = Int32Array.from(adjOffset.subarray(0, nodeCount));
  for (let ei = 0; ei < edges.length; ei++) {
    const e = edges[ei]!;
    adjEdge[fill[e.a]!++] = ei;
    adjEdge[fill[e.b]!++] = ei;
  }

  return {
    nodeLat: Float64Array.from(nodeLats),
    nodeLon: Float64Array.from(nodeLons),
    edges,
    adjOffset,
    adjEdge,
  };
}

/** Nearest graph node to (lat, lon) within maxDistM, or -1. */
export function snapToNode(graph: Graph, lat: number, lon: number, maxDistM = 100): number {
  let best = -1;
  let bestDist = maxDistM;
  for (let i = 0; i < graph.nodeLat.length; i++) {
    const d = haversineMeters(lat, lon, graph.nodeLat[i]!, graph.nodeLon[i]!);
    if (d <= bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/**
 * Remove dead-end subtrees (cul-de-sacs, driveways) so courses never need an
 * in-and-back-out detour. The start node is kept even if it is a leaf.
 */
export function pruneDeadEnds(graph: Graph, keepNode: number): { graph: Graph; keepNode: number } {
  const n = graph.nodeLat.length;
  const alive = new Uint8Array(graph.edges.length).fill(1);
  const degree = new Int32Array(n);
  for (const e of graph.edges) {
    degree[e.a]!++;
    degree[e.b]!++;
  }

  const queue: number[] = [];
  for (let i = 0; i < n; i++) {
    if (degree[i] === 1 && i !== keepNode) queue.push(i);
  }
  while (queue.length > 0) {
    const node = queue.pop()!;
    if (degree[node] !== 1 || node === keepNode) continue;
    for (let k = graph.adjOffset[node]!; k < graph.adjOffset[node + 1]!; k++) {
      const ei = graph.adjEdge[k]!;
      if (!alive[ei]) continue;
      alive[ei] = 0;
      const e = graph.edges[ei]!;
      const next = e.a === node ? e.b : e.a;
      degree[node]!--;
      degree[next]!--;
      if (degree[next] === 1 && next !== keepNode) queue.push(next);
    }
  }

  const keptEdges = graph.edges.filter((_, ei) => alive[ei] === 1);
  const used = new Uint8Array(n);
  used[keepNode] = 1;
  for (const e of keptEdges) {
    used[e.a] = 1;
    used[e.b] = 1;
  }
  const remap = new Int32Array(n).fill(-1);
  const nodeLats: number[] = [];
  const nodeLons: number[] = [];
  for (let i = 0; i < n; i++) {
    if (used[i]) {
      remap[i] = nodeLats.length;
      nodeLats.push(graph.nodeLat[i]!);
      nodeLons.push(graph.nodeLon[i]!);
    }
  }
  const edges = keptEdges.map((e) => ({ ...e, a: remap[e.a]!, b: remap[e.b]! }));
  return {
    graph: buildAdjacency(Float64Array.from(nodeLats), Float64Array.from(nodeLons), edges),
    keepNode: remap[keepNode]!,
  };
}

/** Keep only nodes/edges reachable from startNode; returns the new graph and start index. */
export function filterToComponent(graph: Graph, startNode: number): { graph: Graph; startNode: number } {
  const n = graph.nodeLat.length;
  const visited = new Uint8Array(n);
  const stack = [startNode];
  visited[startNode] = 1;
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (let k = graph.adjOffset[node]!; k < graph.adjOffset[node + 1]!; k++) {
      const e = graph.edges[graph.adjEdge[k]!]!;
      const next = e.a === node ? e.b : e.a;
      if (!visited[next]) {
        visited[next] = 1;
        stack.push(next);
      }
    }
  }

  const remap = new Int32Array(n).fill(-1);
  const nodeLats: number[] = [];
  const nodeLons: number[] = [];
  for (let i = 0; i < n; i++) {
    if (visited[i]) {
      remap[i] = nodeLats.length;
      nodeLats.push(graph.nodeLat[i]!);
      nodeLons.push(graph.nodeLon[i]!);
    }
  }
  const edges = graph.edges
    .filter((e) => visited[e.a] && visited[e.b])
    .map((e) => ({ ...e, a: remap[e.a]!, b: remap[e.b]! }));

  const sub = buildAdjacency(Float64Array.from(nodeLats), Float64Array.from(nodeLons), edges);
  return { graph: sub, startNode: remap[startNode]! };
}

function buildAdjacency(nodeLat: Float64Array, nodeLon: Float64Array, edges: GraphEdge[]): Graph {
  const nodeCount = nodeLat.length;
  const degree = new Int32Array(nodeCount);
  for (const e of edges) {
    degree[e.a]!++;
    degree[e.b]!++;
  }
  const adjOffset = new Int32Array(nodeCount + 1);
  for (let i = 0; i < nodeCount; i++) adjOffset[i + 1] = adjOffset[i]! + degree[i]!;
  const adjEdge = new Int32Array(edges.length * 2);
  const fill = Int32Array.from(adjOffset.subarray(0, nodeCount));
  for (let ei = 0; ei < edges.length; ei++) {
    const e = edges[ei]!;
    adjEdge[fill[e.a]!++] = ei;
    adjEdge[fill[e.b]!++] = ei;
  }
  return { nodeLat, nodeLon, edges, adjOffset, adjEdge };
}

/** Positions every SAMPLE_STEP_M along an edge's geometry (both endpoints included). */
export function edgeSamplePositions(edge: GraphEdge): { lats: Float64Array; lons: Float64Array } {
  const count = Math.max(2, Math.floor(edge.lengthM / SAMPLE_STEP_M) + 1);
  const lats = new Float64Array(count);
  const lons = new Float64Array(count);
  const segLen: number[] = [];
  let total = 0;
  for (let j = 1; j < edge.lats.length; j++) {
    const d = haversineMeters(edge.lats[j - 1]!, edge.lons[j - 1]!, edge.lats[j]!, edge.lons[j]!);
    segLen.push(d);
    total += d;
  }
  let seg = 0;
  let segStartDist = 0;
  for (let i = 0; i < count; i++) {
    const d = (i / (count - 1)) * total;
    while (seg < segLen.length - 1 && segStartDist + segLen[seg]! < d) {
      segStartDist += segLen[seg]!;
      seg++;
    }
    const t = segLen[seg]! > 0 ? (d - segStartDist) / segLen[seg]! : 0;
    lats[i] = edge.lats[seg]! + t * (edge.lats[seg + 1]! - edge.lats[seg]!);
    lons[i] = edge.lons[seg]! + t * (edge.lons[seg + 1]! - edge.lons[seg]!);
  }
  return { lats, lons };
}

export async function sampleEdgeElevations(graph: Graph, sampler: TerrainSampler): Promise<void> {
  const pending: { edge: GraphEdge; count: number }[] = [];
  let total = 0;
  for (const edge of graph.edges) {
    if (edge.elev) continue;
    const count = Math.max(2, Math.floor(edge.lengthM / SAMPLE_STEP_M) + 1);
    pending.push({ edge, count });
    total += count;
  }
  if (pending.length === 0) return;

  const lats = new Float64Array(total);
  const lons = new Float64Array(total);
  let offset = 0;
  for (const { edge } of pending) {
    const pos = edgeSamplePositions(edge);
    lats.set(pos.lats, offset);
    lons.set(pos.lons, offset);
    offset += pos.lats.length;
  }

  const elev = await sampler.elevations(lats, lons);
  offset = 0;
  for (const { edge, count } of pending) {
    edge.elev = movingMedian5(elev.subarray(offset, offset + count));
    offset += count;
  }
}
