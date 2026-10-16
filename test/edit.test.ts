import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildGraph,
  filterToComponent,
  pruneDeadEnds,
  sampleEdgeElevations,
  snapToNode,
} from '../src/graph/build';
import { dijkstra } from '../src/graph/dijkstra';
import { pathNodes } from '../src/graph/ksp';
import type { Graph } from '../src/graph/types';
import type { OverpassResponse } from '../src/net/overpass';
import { buildProfileFromSamples } from '../src/gpx/profile';
import { beamSearch } from '../src/search/beam';
import { deleteNodeFromPath, pathRoot, reroutePath } from '../src/search/edit';
import { assembleCourse } from '../src/search/score';
import { FixtureSampler } from './helpers/fixtureSampler';

let graph: Graph;
let startNode: number;

beforeAll(async () => {
  const response = JSON.parse(
    readFileSync('test/fixtures/overpass_skatas_250m.json', 'utf8'),
  ) as OverpassResponse;
  const full = buildGraph(response);
  const snapped = snapToNode(full, 57.7046, 12.0381);
  const filtered = filterToComponent(full, snapped);
  const pruned = pruneDeadEnds(filtered.graph, filtered.startNode);
  graph = pruned.graph;
  startNode = pruned.keepNode;
  await sampleEdgeElevations(graph, new FixtureSampler());
});

describe('reroutePath', () => {
  it('reroutes a course window through a chosen node', async () => {
    const target = buildProfileFromSamples(new Float32Array(49), 1200);
    const results = await beamSearch(graph, startNode, target, 1200, { seed: 1 });
    const course = results[0]!;
    const courseNodes = new Set(pathNodes(graph, course.path, pathRoot(graph, course.path)));

    // A node reachable but not on the course.
    const { dist } = dijkstra(graph, [startNode]);
    let off = -1;
    for (let i = 0; i < graph.nodeLat.length; i++) {
      if (!courseNodes.has(i) && dist[i]! > 100 && dist[i]! < 400) {
        off = i;
        break;
      }
    }
    expect(off).toBeGreaterThanOrEqual(0);

    const rerouted = reroutePath(graph, course.path, 400, off);
    expect(rerouted).not.toBeNull();
    const newNodes = pathNodes(graph, rerouted!, pathRoot(graph, rerouted!));
    expect(newNodes).toContain(off);
    // Still a connected path that assembles.
    const assembled = assembleCourse(graph, rerouted!);
    expect(assembled.lengthM).toBeGreaterThan(200);
    // Same start, same end as before.
    expect(pathRoot(graph, rerouted!)).toBe(pathRoot(graph, course.path));
    const oldNodes = pathNodes(graph, course.path, pathRoot(graph, course.path));
    expect(newNodes[newNodes.length - 1]).toBe(oldNodes[oldNodes.length - 1]);
  });

  it('puts the chosen point near the km it was asked for, and keeps vias', async () => {
    const target = buildProfileFromSamples(new Float32Array(81), 2000);
    const results = await beamSearch(graph, startNode, target, 2000, { seed: 3 });
    const course = results[0]!;
    const nodes = pathNodes(graph, course.path, pathRoot(graph, course.path));
    const courseNodes = new Set(nodes);
    const { dist } = dijkstra(graph, [startNode]);
    let off = -1;
    for (let i = 0; i < graph.nodeLat.length; i++) {
      if (!courseNodes.has(i) && dist[i]! > 200 && dist[i]! < 600) {
        off = i;
        break;
      }
    }
    expect(off).toBeGreaterThanOrEqual(0);

    const atM = 800;
    const rerouted = reroutePath(graph, course.path, atM, off, { windowM: 600 });
    expect(rerouted).not.toBeNull();
    // Reached near the km that was asked for, without stretching the course.
    expect(Math.abs(distanceToNode(rerouted!, off) - atM)).toBeLessThan(300);
    const before = cumLengths(course.path);
    const after = cumLengths(rerouted!);
    expect(Math.abs(after[after.length - 1]! - before[before.length - 1]!)).toBeLessThan(300);

    // A via inside the window outranks the edit and stays on the course.
    const cum = cumLengths(course.path);
    let viaIdx = 0;
    for (let i = 0; i < nodes.length; i++) {
      if (Math.abs(cum[i]! - (atM - 250)) < Math.abs(cum[viaIdx]! - (atM - 250))) viaIdx = i;
    }
    const viaNode = nodes[viaIdx]!;
    const kept = reroutePath(graph, course.path, atM, off, {
      windowM: 600,
      keepNodes: new Set([viaNode]),
    });
    expect(kept).not.toBeNull();
    expect(pathNodes(graph, kept!, pathRoot(graph, kept!))).toContain(viaNode);
  });
});

describe('deleteNodeFromPath', () => {
  it('removes a course node and closes the gap around it', async () => {
    const target = buildProfileFromSamples(new Float32Array(81), 2000);
    const results = await beamSearch(graph, startNode, target, 2000, { seed: 3 });
    const course = results[0]!;
    const nodes = pathNodes(graph, course.path, pathRoot(graph, course.path));
    const cum = cumLengths(course.path);

    let at = 1;
    for (let i = 1; i < nodes.length - 1; i++) {
      if (Math.abs(cum[i]! - 700) < Math.abs(cum[at]! - 700)) at = i;
    }
    const victim = nodes[at]!;

    const trimmed = deleteNodeFromPath(graph, course.path, cum[at]!);
    expect(trimmed).not.toBeNull();
    const after = pathNodes(graph, trimmed!, pathRoot(graph, trimmed!));
    const visits = (list: number[]) => list.filter((n) => n === victim).length;
    // A loop course can pass the node twice; only the chosen visit goes.
    expect(visits(after)).toBe(visits(nodes) - 1);
    expect(after[after.length - 1]).toBe(nodes[nodes.length - 1]);
    expect(assembleCourse(graph, trimmed!).lengthM).toBeGreaterThan(200);

    // A via on that node outranks the delete.
    expect(
      deleteNodeFromPath(graph, course.path, cum[at]!, { keepNodes: new Set([victim]) }),
    ).toBeNull();
  });
});

function cumLengths(path: { edges: number[] }): number[] {
  const cum = [0];
  for (const ei of path.edges) cum.push(cum[cum.length - 1]! + graph.edges[ei]!.lengthM);
  return cum;
}

/** Distance along the path at which `node` is first reached, in metres. */
function distanceToNode(path: { edges: number[]; dirs: number[] }, node: number): number {
  const nodes = pathNodes(graph, path, pathRoot(graph, path));
  const cum = cumLengths(path);
  const i = nodes.indexOf(node);
  return i < 0 ? Infinity : cum[i]!;
}
