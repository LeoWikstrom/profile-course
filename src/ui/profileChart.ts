import { SAMPLE_STEP_M } from '../gpx/profile';

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface ProfileSeries {
  samples: Float32Array;
  color: string;
}

export function renderProfileChart(
  container: HTMLElement,
  series: ProfileSeries[],
  width = 360,
  height = 120,
): void {
  container.textContent = '';
  if (series.length === 0) return;

  let min = Infinity;
  let max = -Infinity;
  let maxDist = 0;
  for (const s of series) {
    for (const v of s.samples) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    maxDist = Math.max(maxDist, (s.samples.length - 1) * SAMPLE_STEP_M);
  }
  if (max - min < 10) max = min + 10;

  const pad = 4;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Elevation profile');

  const x = (i: number) =>
    pad + ((i * SAMPLE_STEP_M) / maxDist) * (width - 2 * pad);
  const y = (v: number) => height - pad - ((v - min) / (max - min)) * (height - 2 * pad);

  for (const s of series) {
    const points: string[] = [];
    for (let i = 0; i < s.samples.length; i++) {
      points.push(`${x(i).toFixed(1)},${y(s.samples[i]!).toFixed(1)}`);
    }
    const line = document.createElementNS(SVG_NS, 'polyline');
    line.setAttribute('points', points.join(' '));
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', s.color);
    line.setAttribute('stroke-width', '1.5');
    svg.appendChild(line);
  }

  const label = document.createElementNS(SVG_NS, 'text');
  label.setAttribute('x', String(width - pad));
  label.setAttribute('y', '12');
  label.setAttribute('text-anchor', 'end');
  label.setAttribute('font-size', '10');
  label.setAttribute('fill', 'currentColor');
  label.textContent = `${(maxDist / 1000).toFixed(1)} km, ${Math.round(min)}–${Math.round(max)} m`;
  svg.appendChild(label);

  container.appendChild(svg);
}
