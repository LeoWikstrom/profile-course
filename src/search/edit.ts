import { dijkstra, reconstructPath } from '../graph/dijkstra';
import { pathNodes } from '../graph/ksp';
import type { Graph } from '../graph/types';
import type { CoursePath } from './score';

const DEFAULT_WINDOW_M = 600;

/** Root node of a path (start of its first edge). */
export function pathRoot(graph: Graph, path: CoursePath): number {
  const first = graph.edges[path.edges[0]!]!;
  return path.dirs[0] === 1 ? first.a : first.b;
}

/**
 * Reroute the course window around `atM` so it passes through `targetNode`:
 * the edges between roughly atM ± windowM are replaced by shortest paths
 * windowStart → target → windowEnd. Returns null when no route exists.
 */
export function reroutePath(
  graph: Graph,
  path: CoursePath,
  atM: number,
  targetNode: number,
  windowM: number = DEFAULT_WINDOW_M,
): CoursePath | null {
  const root = pathRoot(graph, path);
  const nodes = pathNodes(graph, path, root);
  const cum: number[] = [0];
  for (const ei of path.edges) cum.push(cum[cum.length - 1]! + graph.edges[ei]!.lengthM);
  const total = cum[cum.length - 1]!;
  const at = Math.max(0, Math.min(atM, total));

  let fromIdx = 0;
  while (fromIdx < nodes.length - 2 && cum[fromIdx + 1]! < at - windowM) fromIdx++;
  let toIdx = nodes.length - 1;
  while (toIdx > fromIdx + 1 && cum[toIdx - 1]! > at + windowM) toIdx--;

  const fromNode = nodes[fromIdx]!;
  const toNode = nodes[toIdx]!;
  const windowLen = cum[toIdx]! - cum[fromIdx]!;
  const budget = Math.max(1500, windowLen * 4);

  const leg1 = reconstructPath(
    graph,
    dijkstra(graph, [fromNode], { target: targetNode, maxDist: budget }),
    fromNode,
    targetNode,
  );
  if (!leg1) return null;
  const leg2 = reconstructPath(
    graph,
    dijkstra(graph, [targetNode], { target: toNode, maxDist: budget }),
    targetNode,
    toNode,
  );
  if (!leg2) return null;

  return {
    edges: [...path.edges.slice(0, fromIdx), ...leg1.edges, ...leg2.edges, ...path.edges.slice(toIdx)],
    dirs: [...path.dirs.slice(0, fromIdx), ...leg1.dirs, ...leg2.dirs, ...path.dirs.slice(toIdx)],
  };
}
