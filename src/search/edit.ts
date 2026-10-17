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
    edges: [
      ...path.edges.slice(0, fromIdx),
      ...leg1.edges,
      ...leg2.edges,
      ...path.edges.slice(toIdx),
    ],
    dirs: [...path.dirs.slice(0, fromIdx), ...leg1.dirs, ...leg2.dirs, ...path.dirs.slice(toIdx)],
  };
}

/**
 * Node editing treats the course nodes as waypoints: an edit replaces the legs
 * around one of them with the shortest route, leaving the rest of the course
 * exactly as it was. Scores play no part — the user is in charge.
 */
export type NodeEditOptions = Pick<RerouteOptions, 'keepNodes' | 'keepEdges'>;

/** Long enough to reach around the edited node, short enough to stay local. */
const legBudget = (spanM: number) => Math.max(3000, spanM * 8);

function cumulative(graph: Graph, path: CoursePath): number[] {
  const cum: number[] = [0];
  for (const ei of path.edges) cum.push(cum[cum.length - 1]! + graph.edges[ei]!.lengthM);
  return cum;
}

type Legs = Pick<CoursePath, 'edges' | 'dirs'>;

/** Shortest legs a → via → b as one path, or null if either end is out of reach. */
function legsThrough(graph: Graph, a: number, via: number, b: number, budget: number): Legs | null {
  const tree = dijkstra(graph, [via], { maxDist: budget });
  const back = reconstructPath(graph, tree, via, a);
  const out = reconstructPath(graph, tree, via, b);
  if (!back || !out) return null;
  const first = reversed(back);
  return { edges: [...first.edges, ...out.edges], dirs: [...first.dirs, ...out.dirs] };
}

function splice(path: CoursePath, fromIdx: number, toIdx: number, legs: Legs): CoursePath {
  return {
    edges: [...path.edges.slice(0, fromIdx), ...legs.edges, ...path.edges.slice(toIdx)],
    dirs: [...path.dirs.slice(0, fromIdx), ...legs.dirs, ...path.dirs.slice(toIdx)],
  };
}

interface NodeSpot {
  nodes: number[];
  cum: number[];
  /** Index of the interior course node nearest the distance asked for. */
  at: number;
}

function locateNode(graph: Graph, path: CoursePath, atM: number): NodeSpot | null {
  const nodes = pathNodes(graph, path, pathRoot(graph, path));
  if (nodes.length < 4) return null;
  const cum = cumulative(graph, path);
  let at = 1;
  for (let i = 1; i < nodes.length - 1; i++) {
    if (Math.abs(cum[i]! - atM) < Math.abs(cum[at]! - atM)) at = i;
  }
  return { nodes, cum, at };
}

/** A via on the node, or on either leg into it, puts the node off limits. */
function pinned(path: CoursePath, spot: NodeSpot, options: NodeEditOptions): boolean {
  if (options.keepNodes?.has(spot.nodes[spot.at]!)) return true;
  return (
    options.keepEdges?.has(path.edges[spot.at - 1]!) === true ||
    options.keepEdges?.has(path.edges[spot.at]!) === true
  );
}

/**
 * Drop the course node nearest `atM`, reconnecting its two neighbours by the
 * shortest route. Returns null when the node carries a via or is an endpoint.
 */
export function deleteNodeFromPath(
  graph: Graph,
  path: CoursePath,
  atM: number,
  options: NodeEditOptions = {},
): CoursePath | null {
  const spot = locateNode(graph, path, atM);
  if (!spot || pinned(path, spot, options)) return null;
  const { nodes, cum, at } = spot;
  const from = nodes[at - 1]!;
  const to = nodes[at + 1]!;
  // The course went out to the node and straight back: both legs go with it.
  if (from === to) {
    if (path.edges.length <= 2) return null;
    return splice(path, at - 1, at + 1, { edges: [], dirs: [] });
  }
  const direct = reconstructPath(
    graph,
    dijkstra(graph, [from], { target: to, maxDist: legBudget(cum[at + 1]! - cum[at - 1]!) }),
    from,
    to,
  );
  if (!direct || direct.edges.length === 0) return null;
  return splice(path, at - 1, at + 1, direct);
}

/**
 * Move the course node nearest `atM` onto `targetNode`: its two neighbours
 * reconnect to it by the shortest route and nothing else on the course moves.
 */
export function moveNodeInPath(
  graph: Graph,
  path: CoursePath,
  atM: number,
  targetNode: number,
  options: NodeEditOptions = {},
): CoursePath | null {
  const spot = locateNode(graph, path, atM);
  if (!spot || pinned(path, spot, options)) return null;
  const { nodes, cum, at } = spot;
  const legs = legsThrough(
    graph,
    nodes[at - 1]!,
    targetNode,
    nodes[at + 1]!,
    legBudget(cum[at + 1]! - cum[at - 1]!),
  );
  if (!legs || legs.edges.length === 0) return null;
  return splice(path, at - 1, at + 1, legs);
}

/**
 * Add `targetNode` as a new course node on the leg covering `atM`, reached by
 * the shortest route from each end of that leg.
 */
export function insertNodeIntoPath(
  graph: Graph,
  path: CoursePath,
  atM: number,
  targetNode: number,
  options: NodeEditOptions = {},
): CoursePath | null {
  const nodes = pathNodes(graph, path, pathRoot(graph, path));
  const cum = cumulative(graph, path);
  const midOf = (i: number) => (cum[i]! + cum[i + 1]!) / 2;
  let leg = 0;
  for (let i = 1; i < path.edges.length; i++) {
    if (Math.abs(midOf(i) - atM) < Math.abs(midOf(leg) - atM)) leg = i;
  }
  if (options.keepEdges?.has(path.edges[leg]!)) return null;
  const a = nodes[leg]!;
  const b = nodes[leg + 1]!;
  if (targetNode === a || targetNode === b) return null;
  const legs = legsThrough(graph, a, targetNode, b, legBudget(cum[leg + 1]! - cum[leg]!));
  if (!legs || legs.edges.length === 0) return null;
  return splice(path, leg, leg + 1, legs);
}
