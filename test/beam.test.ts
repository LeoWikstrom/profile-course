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

  it('the beam pipeline beats or matches the baseline on an achievable target', async () => {
    // A flat target in this hilly 250 m fixture is unachievable, and comparing
    // noise floors is meaningless. Use a profile that provably exists in the
    // graph (a baseline course from another seed) as the target instead.
    const donor = await randomWalkSearch(graph, startNode, flatTarget(1200), 1200, {
      seed: 99,
      walks: 100,
    });
    expect(donor.length).toBeGreaterThan(0);
    const target = buildProfileFromSamples(
      donor[0]!.course.samples,
      donor[0]!.course.lengthM,
      donor[0]!.course.turnsPerKm,
    );

    const beam = await beamSearch(graph, startNode, target, target.totalDistance, { seed: 1 });
    const improved = await improveCandidates(graph, startNode, beam, target, target.totalDistance, {});
    const walk = await randomWalkSearch(graph, startNode, target, target.totalDistance, {
      seed: 1,
      walks: 500,
    });
    expect(improved.length).toBeGreaterThan(0);
    expect(walk.length).toBeGreaterThan(0);
    expect(improved[0]!.score).toBeLessThanOrEqual(walk[0]!.score + 0.01);
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

describe('validEnd mask (start/finish zone)', () => {
  it('beam courses end inside the zone even though they may leave it', async () => {
    // Only nodes within 120 m of the start are valid ends.
    const { haversineMeters } = await import('../src/shared/geo');
    const validEnd = new Uint8Array(graph.nodeLat.length);
    const sLat = graph.nodeLat[startNode]!;
    const sLon = graph.nodeLon[startNode]!;
    for (let i = 0; i < validEnd.length; i++) {
      if (haversineMeters(sLat, sLon, graph.nodeLat[i]!, graph.nodeLon[i]!) <= 120) validEnd[i] = 1;
    }
    const target = flatTarget(1000);
    const results = await beamSearch(graph, startNode, target, 1000, { seed: 1, validEnd });
    expect(results.length).toBeGreaterThan(0);
    for (const c of results) {
      let node = startNode;
      for (const ei of c.path.edges) {
        const e = graph.edges[ei]!;
        node = e.a === node ? e.b : e.a;
      }
      expect(validEnd[node]).toBe(1);
    }
  });
});

describe('peak guidance', () => {
  it('still finds courses when the target has a significant peak', async () => {
    // Triangle peaking +20 m at 600 m — enough to activate peak attractors.
    const samples = new Float32Array(49);
    for (let i = 0; i < 49; i++) samples[i] = 20 * (1 - Math.abs(i - 24) / 24);
    const target = buildProfileFromSamples(samples, 1200);
    const results = await beamSearch(graph, startNode, target, 1200, { seed: 1 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.course.lengthM).toBeGreaterThanOrEqual(1164);
    expect(results[0]!.course.lengthM).toBeLessThanOrEqual(1236);
  });
});

describe('oscillation accounting in assembleCourse', () => {
  it('an immediate out-and-back counts as oscillation, doubled for reversal', async () => {
    const { assembleCourse } = await import('../src/search/score');
    const ei = graph.adjEdge[graph.adjOffset[startNode]!]!;
    const e = graph.edges[ei]!;
    const dirOut = e.a === startNode ? 1 : 0;
    const course = assembleCourse(graph, { edges: [ei, ei], dirs: [dirOut, 1 - dirOut] });
    expect(course.oscillationFraction).toBeCloseTo(1, 5); // 2x length over 2x length
    expect(course.repeatFraction).toBe(0);
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
