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

  it('car roads without sidewalks or with high maxspeed are worse', () => {
    const bare = edgePenalty({ highway: 'residential' });
    const withSidewalk = edgePenalty({ highway: 'residential', sidewalk: 'both' });
    const fast = edgePenalty({ highway: 'residential', sidewalk: 'both', maxspeed: '70' });
    expect(bare).toBeGreaterThan(withSidewalk);
    expect(fast).toBeGreaterThan(withSidewalk);
  });

  it('cycleways, designated foot paths and lit ways get a bonus', () => {
    expect(edgePenalty({ highway: 'cycleway' })).toBeLessThan(0);
    expect(edgePenalty({ highway: 'footway', foot: 'designated' })).toBeLessThan(0);
    expect(edgePenalty({ highway: 'footway', lit: 'yes' })).toBeLessThan(0);
    expect(edgePenalty({ highway: 'cycleway', lit: 'yes' })).toBeGreaterThanOrEqual(-0.1);
  });
});

describe('bridge and tunnel handling', () => {
  it('flags bridges and tunnels as levelled', () => {
    const mkResponse = (tags: Record<string, string>): OverpassResponse => ({
      elements: [
        { type: 'node', id: 1, lat: 57.7, lon: 12.0 },
        { type: 'node', id: 2, lat: 57.701, lon: 12.0 },
        { type: 'way', id: 10, nodes: [1, 2], tags },
      ],
    });
    expect(buildGraph(mkResponse({ highway: 'footway', bridge: 'yes' })).edges[0]!.levelled).toBe(true);
    expect(buildGraph(mkResponse({ highway: 'footway', tunnel: 'yes' })).edges[0]!.levelled).toBe(true);
    expect(buildGraph(mkResponse({ highway: 'footway', bridge: 'no' })).edges[0]!.levelled).toBe(false);
    expect(buildGraph(mkResponse({ highway: 'footway' })).edges[0]!.levelled).toBe(false);
  });

  it('levelled edges get linearly interpolated elevation', async () => {
    const { sampleEdgeElevations } = await import('../src/graph/build');
    const response: OverpassResponse = {
      elements: [
        { type: 'node', id: 1, lat: 57.7, lon: 12.03 },
        { type: 'node', id: 2, lat: 57.703, lon: 12.03 }, // ~330 m, many samples
        { type: 'way', id: 10, nodes: [1, 2], tags: { highway: 'footway', bridge: 'yes' } },
      ],
    };
    const graph = buildGraph(response);
    // A sampler pretending there is a deep valley everywhere except endpoints.
    const { TerrainSampler } = await import('../src/net/terrain');
    class ValleySampler extends TerrainSampler {
      constructor() {
        super(13, () => {
          throw new Error('no network');
        });
      }
      override async elevations(lats: ArrayLike<number>): Promise<Float32Array> {
        const out = new Float32Array(lats.length).fill(-40);
        out[0] = 20;
        out[lats.length - 1] = 24;
        return out;
      }
    }
    await sampleEdgeElevations(graph, new ValleySampler());
    const elev = graph.edges[0]!.elev!;
    expect(elev[0]).toBeCloseTo(20);
    expect(elev[elev.length - 1]).toBeCloseTo(24);
    const mid = elev[Math.floor(elev.length / 2)]!;
    expect(mid).toBeGreaterThan(20); // no valley dip
    expect(mid).toBeLessThan(24);
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
