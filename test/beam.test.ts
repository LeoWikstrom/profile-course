import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildProfileFromSamples, type TargetProfile } from '../src/gpx/profile';
import {
  buildGraph,
  filterToComponent,
  pruneDeadEnds,
  sampleEdgeElevations,
  snapToNode,
} from '../src/graph/build';
import type { Graph } from '../src/graph/types';
import type { OverpassResponse } from '../src/net/overpass';
import { beamSearch } from '../src/search/beam';
import { improveCandidates } from '../src/search/improve';
import { randomWalkSearch } from '../src/search/randomWalk';
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

function flatTarget(lengthM: number): TargetProfile {
  return buildProfileFromSamples(new Float32Array(Math.floor(lengthM / 25) + 1), lengthM);
}

describe('beamSearch on the Skatås fixture', () => {
  it('finds courses within the length tolerance, deterministically', async () => {
    const target = flatTarget(1000);
    const a = await beamSearch(graph, startNode, target, 1000, { seed: 1 });
    const b = await beamSearch(graph, startNode, target, 1000, { seed: 1 });
    expect(a.length).toBeGreaterThan(0);
    expect(a[0]!.score).toBe(b[0]!.score);
    for (const c of a) {
      expect(c.course.lengthM).toBeGreaterThanOrEqual(970);
      expect(c.course.lengthM).toBeLessThanOrEqual(1030);
    }
  });

  it('beats or matches the random-walk baseline', async () => {
    const target = flatTarget(1200);
    const beam = await beamSearch(graph, startNode, target, 1200, { seed: 1 });
    const walk = await randomWalkSearch(graph, startNode, target, 1200, { seed: 1, walks: 500 });
    expect(beam.length).toBeGreaterThan(0);
    expect(walk.length).toBeGreaterThan(0);
    expect(beam[0]!.score).toBeLessThanOrEqual(walk[0]!.score + 0.01);
  });
});

describe('no in-and-back-again', () => {
  it('beam courses never reverse onto the edge they came from', async () => {
    const target = flatTarget(1500);
    const results = await beamSearch(graph, startNode, target, 1500, { seed: 5 });
    expect(results.length).toBeGreaterThan(0);
    for (const c of results) {
      for (let i = 1; i < c.path.edges.length; i++) {
        expect(c.path.edges[i]).not.toBe(c.path.edges[i - 1]);
      }
    }
  });

  it('random-walk courses never reverse onto the edge they came from', async () => {
    const target = flatTarget(1000);
    const results = await randomWalkSearch(graph, startNode, target, 1000, { seed: 5, walks: 300 });
    for (const c of results) {
      for (let i = 1; i < c.path.edges.length; i++) {
        expect(c.path.edges[i]).not.toBe(c.path.edges[i - 1]);
      }
    }
  });
});

describe('return to start', () => {
  it('beam courses end at the start node', async () => {
    const target = flatTarget(1000);
    const results = await beamSearch(graph, startNode, target, 1000, {
      seed: 1,
      returnToStart: true,
    });
    expect(results.length).toBeGreaterThan(0);
    for (const c of results) {
      let node = startNode;
      for (let i = 0; i < c.path.edges.length; i++) {
        const e = graph.edges[c.path.edges[i]!]!;
        node = e.a === node ? e.b : e.a;
      }
      expect(node).toBe(startNode);
    }
  });

  it('random-walk courses end at the start node', async () => {
    const target = flatTarget(800);
    const results = await randomWalkSearch(graph, startNode, target, 800, {
      seed: 1,
      walks: 500,
      returnToStart: true,
    });
    expect(results.length).toBeGreaterThan(0);
    for (const c of results) {
      let node = startNode;
      for (const ei of c.path.edges) {
        const e = graph.edges[ei]!;
        node = e.a === node ? e.b : e.a;
      }
      expect(node).toBe(startNode);
    }
  });
});

describe('improveCandidates', () => {
  it('never worsens the best score', async () => {
    const target = flatTarget(1200);
    const beam = await beamSearch(graph, startNode, target, 1200, { seed: 2 });
    const improved = await improveCandidates(graph, startNode, beam, target, 1200, {});
    expect(improved[0]!.score).toBeLessThanOrEqual(beam[0]!.score + 1e-9);
    expect(improved[0]!.course.lengthM).toBeGreaterThanOrEqual(1200 * 0.97);
    expect(improved[0]!.course.lengthM).toBeLessThanOrEqual(1200 * 1.03);
  });
});

describe('pruned graph has no dead ends', () => {
  it('every node has degree >= 2 except possibly the start', () => {
    const degree = new Int32Array(graph.nodeLat.length);
    for (const e of graph.edges) {
      degree[e.a]!++;
      degree[e.b]!++;
    }
    for (let i = 0; i < degree.length; i++) {
      if (i !== startNode) expect(degree[i]).toBeGreaterThanOrEqual(2);
    }
  });
});
