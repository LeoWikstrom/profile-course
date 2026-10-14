import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OverpassResponse } from '../src/net/overpass';
import { buildQuery } from '../src/net/overpass';
import {
  buildGraph,
  classifySurface,
  edgePenalty,
  edgeSamplePositions,
  filterToComponent,
  snapToNode,
} from '../src/graph/build';
import { SURFACE_GRAVEL, SURFACE_PAVED, SURFACE_TRAIL, SURFACE_UNKNOWN } from '../src/graph/types';

const skatas = JSON.parse(
  readFileSync('test/fixtures/overpass_skatas_250m.json', 'utf8'),
) as OverpassResponse;

describe('classifySurface', () => {
  it('maps surface tags first', () => {
    expect(classifySurface({ surface: 'asphalt', highway: 'track' })).toBe(SURFACE_PAVED);
    expect(classifySurface({ surface: 'gravel' })).toBe(SURFACE_GRAVEL);
    expect(classifySurface({ surface: 'grass' })).toBe(SURFACE_TRAIL);
  });

  it('falls back to highway type', () => {
    expect(classifySurface({ highway: 'path' })).toBe(SURFACE_TRAIL);
    expect(classifySurface({ highway: 'residential' })).toBe(SURFACE_PAVED);
    expect(classifySurface({ highway: 'track' })).toBe(SURFACE_GRAVEL);
    expect(classifySurface({ highway: 'bridleway' })).toBe(SURFACE_UNKNOWN);
  });
});

describe('edgePenalty', () => {
  it('penalises steps, rough tracks and tertiary roads', () => {
    expect(edgePenalty({ highway: 'steps' })).toBe(1);
    expect(edgePenalty({ highway: 'track', tracktype: 'grade5' })).toBe(0.5);
    expect(edgePenalty({ highway: 'tertiary' })).toBeGreaterThan(0);
    expect(edgePenalty({ highway: 'footway' })).toBe(0);
  });
});

describe('buildGraph on the Skatås fixture', () => {
  const graph = buildGraph(skatas);

  it('produces a connected-looking graph', () => {
    expect(graph.nodeLat.length).toBeGreaterThan(20);
    expect(graph.edges.length).toBeGreaterThan(20);
    expect(graph.adjOffset.length).toBe(graph.nodeLat.length + 1);
    expect(graph.adjEdge.length).toBe(graph.edges.length * 2);
  });

  it('edge lengths are positive and sane', () => {
    for (const e of graph.edges) {
      expect(e.lengthM).toBeGreaterThan(0);
      expect(e.lengthM).toBeLessThan(3000);
    }
  });

  it('snaps a point near Skatås to a node within 100 m', () => {
    const node = snapToNode(graph, 57.7046, 12.0381);
    expect(node).toBeGreaterThanOrEqual(0);
  });

  it('returns -1 when nothing is within 100 m', () => {
    expect(snapToNode(graph, 58.5, 13.0)).toBe(-1);
  });

  it('filterToComponent keeps the start and drops nothing vital', () => {
    const start = snapToNode(graph, 57.7046, 12.0381);
    const { graph: sub, startNode } = filterToComponent(graph, start);
    expect(startNode).toBeGreaterThanOrEqual(0);
    expect(sub.nodeLat.length).toBeGreaterThan(10);
    expect(sub.nodeLat.length).toBeLessThanOrEqual(graph.nodeLat.length);
    expect(sub.adjEdge.length).toBe(sub.edges.length * 2);
  });

  it('edgeSamplePositions covers the edge endpoints', () => {
    const edge = graph.edges.find((e) => e.lengthM > 100)!;
    const { lats, lons } = edgeSamplePositions(edge);
    expect(lats.length).toBeGreaterThanOrEqual(2);
    expect(lats[0]).toBeCloseTo(edge.lats[0]!, 6);
    expect(lons[lons.length - 1]).toBeCloseTo(edge.lons[edge.lons.length - 1]!, 6);
  });
});

describe('buildQuery', () => {
  it('includes radius, centre and highway filter', () => {
    const q = buildQuery({ lat: 57.7, lon: 11.97 }, 5000);
    expect(q).toContain('around:5000,57.700000,11.970000');
    expect(q).toContain('footway|path');
    expect(q).toContain('out:json');
  });
});
