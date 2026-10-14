export const SURFACE_PAVED = 0;
export const SURFACE_GRAVEL = 1;
export const SURFACE_TRAIL = 2;
export const SURFACE_UNKNOWN = 3;
export type SurfaceClass = 0 | 1 | 2 | 3;

export interface GraphEdge {
  a: number;
  b: number;
  lengthM: number;
  surface: SurfaceClass;
  /** 0 = fine; >0 = per-metre penalty weight (steps, busy roads, rough tracks). */
  penalty: number;
  /** Geometry from node a to node b, inclusive of both endpoints. */
  lats: Float64Array;
  lons: Float64Array;
  /** Elevation every SAMPLE_STEP_M along the edge (a→b), filled by sampleEdgeElevations. */
  elev: Float32Array | null;
  /** Distances (m from the a-end) of internal turns along the edge geometry. */
  turnOffsets: Float64Array;
  /** Heading when entering at a / leaving at b, degrees; NaN for degenerate geometry. */
  headOutA: number;
  headInB: number;
}

export interface Graph {
  nodeLat: Float64Array;
  nodeLon: Float64Array;
  edges: GraphEdge[];
  /** CSR adjacency: edges incident to node i are adjEdge[adjOffset[i]..adjOffset[i+1]). */
  adjOffset: Int32Array;
  adjEdge: Int32Array;
}

export function otherNode(edge: GraphEdge, node: number): number {
  return edge.a === node ? edge.b : edge.a;
}
