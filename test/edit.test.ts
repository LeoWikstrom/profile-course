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
import { pathRoot, reroutePath } from '../src/search/edit';
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
});
