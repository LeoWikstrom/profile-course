import { dijkstra, reconstructPath, type EdgePath } from '../graph/dijkstra';
import { pathNodes } from '../graph/ksp';
import type { Graph } from '../graph/types';
import type { CoursePath } from './score';

export const DEFAULT_WINDOW_M = 600;

export interface RerouteOptions {
  /** Half-width of the stretch that may be replaced (m). */
  windowM?: number;
  /** Nodes the reroute must leave on the course (via points). */
  keepNodes?: ReadonlySet<number>;
  /** Edges the reroute must leave on the course (via points). */
  keepEdges?: ReadonlySet<number>;
}

/** Root node of a path (start of its first edge). */
export function pathRoot(graph: Graph, path: CoursePath): number {
  const first = graph.edges[path.edges[0]!]!;
  return path.dirs[0] === 1 ? first.a : first.b;
}

function reversed(leg: EdgePath): EdgePath {
  return {
    edges: [...leg.edges].reverse(),
    dirs: [...leg.dirs].reverse().map((d) => (d === 1 ? 0 : 1)),
    lengthM: leg.lengthM,
  };
}

/**
 * Reroute the course around `atM` so it passes through `targetNode`: the
 * stretch between two course nodes within `windowM` of `atM` is replaced by
 * shortest paths windowStart → target → windowEnd. The window start is picked
 * so the target is reached as near `atM` as the network allows, and the end so
 * the course keeps its length. Returns null when no route exists.
 */
export function reroutePath(
  graph: Graph,
  path: CoursePath,
  atM: number,
  targetNode: number,
  options: RerouteOptions = {},
): CoursePath | null {
  const windowM = options.windowM ?? DEFAULT_WINDOW_M;
  const root = pathRoot(graph, path);
  const nodes = pathNodes(graph, path, root);
  const cum: number[] = [0];
  for (const ei of path.edges) cum.push(cum[cum.length - 1]! + graph.edges[ei]!.lengthM);
  const total = cum[cum.length - 1]!;
  const at = Math.max(0, Math.min(atM, total));

  let atIdx = 0;
  for (let i = 1; i < nodes.length; i++) {
    if (Math.abs(cum[i]! - at) < Math.abs(cum[atIdx]! - at)) atIdx = i;
  }

  // Vias outrank edits: shrink the window until it holds no via of its own.
  let lowFrom = 0;
  let highTo = nodes.length - 1;
  for (let i = 0; i < nodes.length; i++) {
    if (!options.keepNodes?.has(nodes[i]!)) continue;
    if (i <= atIdx) lowFrom = Math.max(lowFrom, i);
    if (i >= atIdx) highTo = Math.min(highTo, i);
  }
  for (let i = 0; i < path.edges.length; i++) {
    if (!options.keepEdges?.has(path.edges[i]!)) continue;
    if (i + 1 <= atIdx) lowFrom = Math.max(lowFrom, i + 1);
    if (i >= atIdx) highTo = Math.min(highTo, i);
  }
  if (lowFrom >= highTo) return null;

  const budget = Math.max(1500, windowM * 4);
  const tree = dijkstra(graph, [targetNode], { maxDist: budget });

  let fromIdx = -1;
  let fromErr = Infinity;
  for (let i = Math.min(atIdx, highTo - 1); i >= lowFrom; i--) {
    if (cum[i]! < at - windowM && fromIdx >= 0) break;
    const d = tree.dist[nodes[i]!]!;
    if (!Number.isFinite(d)) continue;
    const err = Math.abs(cum[i]! + d - at);
    if (err < fromErr) {
      fromErr = err;
      fromIdx = i;
    }
  }
  if (fromIdx < 0) return null;
  const outM = tree.dist[nodes[fromIdx]!]!;

  let toIdx = -1;
  let toErr = Infinity;
  for (let j = Math.max(atIdx, fromIdx + 1); j <= highTo; j++) {
    if (cum[j]! > at + windowM && toIdx >= 0) break;
    const d = tree.dist[nodes[j]!]!;
    if (!Number.isFinite(d)) continue;
    const err = Math.abs(outM + d - (cum[j]! - cum[fromIdx]!));
    if (err < toErr) {
      toErr = err;
      toIdx = j;
    }
  }
  if (toIdx < 0) return null;

  const back = reconstructPath(graph, tree, targetNode, nodes[fromIdx]!);
  const leg2 = reconstructPath(graph, tree, targetNode, nodes[toIdx]!);
  if (!back || !leg2) return null;
  const leg1 = reversed(back);

  return {
    edges: [...path.edges.slice(0, fromIdx), ...leg1.edges, ...leg2.edges, ...path.edges.slice(toIdx)],
    dirs: [...path.dirs.slice(0, fromIdx), ...leg1.dirs, ...leg2.dirs, ...path.dirs.slice(toIdx)],
  };
}
