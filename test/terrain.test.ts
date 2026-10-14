import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import {
  TILE_SIZE,
  bilinearSample,
  decodeTerrarium,
  latToTileY,
  lonToTileX,
} from '../src/net/terrain';

describe('tile maths', () => {
  it('maps Gothenburg to the expected z13 tile', () => {
    expect(Math.floor(lonToTileX(12.0381, 13))).toBe(4369);
    expect(Math.floor(latToTileY(57.7046, 13))).toBe(2479);
  });
});

describe('decodeTerrarium', () => {
  it('decodes the documented formula', () => {
    // elevation = R*256 + G + B/256 - 32768; sea level (0 m) is R=128, G=0, B=0
    const rgba = new Uint8ClampedArray([128, 0, 0, 255, 128, 100, 128, 255]);
    const out = decodeTerrarium(rgba);
    expect(out[0]).toBe(0);
    expect(out[1]).toBeCloseTo(100.5);
  });
});

describe('bilinearSample', () => {
  const grid = new Float32Array([0, 10, 20, 30]); // 2x2
  it('returns corners exactly', () => {
    expect(bilinearSample(grid, 2, 2, 0, 0)).toBe(0);
    expect(bilinearSample(grid, 2, 2, 1, 1)).toBe(30);
  });
  it('interpolates the centre', () => {
    expect(bilinearSample(grid, 2, 2, 0.5, 0.5)).toBe(15);
  });
  it('clamps outside the grid', () => {
    expect(bilinearSample(grid, 2, 2, -5, -5)).toBe(0);
    expect(bilinearSample(grid, 2, 2, 5, 5)).toBe(30);
  });
});

describe('real Skatås terrain tile', () => {
  const png = PNG.sync.read(readFileSync('test/fixtures/terrarium_13_4369_2479.png'));
  const grid = decodeTerrarium(new Uint8ClampedArray(png.data));

  it('decodes to a 256x256 grid of plausible Swedish elevations', () => {
    expect(png.width).toBe(TILE_SIZE);
    expect(png.height).toBe(TILE_SIZE);
    let min = Infinity;
    let max = -Infinity;
    for (const v of grid) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    expect(min).toBeGreaterThan(-50);
    expect(max).toBeLessThan(300);
    expect(max - min).toBeGreaterThan(20); // Skatås is hilly
  });

  it('Skatås hill area is well above sea level', () => {
    const xf = lonToTileX(12.0381, 13);
    const yf = latToTileY(57.7046, 13);
    const px = (xf - Math.floor(xf)) * TILE_SIZE - 0.5;
    const py = (yf - Math.floor(yf)) * TILE_SIZE - 0.5;
    const elev = bilinearSample(grid, TILE_SIZE, TILE_SIZE, px, py);
    expect(elev).toBeGreaterThan(30);
    expect(elev).toBeLessThan(150);
  });
});
