import { buildGpx } from '../gpx/export';
import type { TargetProfile } from '../gpx/profile';
import type { CourseResult } from '../shared/messages';
import { renderInteractiveChart } from './profileChart';

const SURFACE_NAMES = ['paved', 'gravel', 'trail', 'unknown'];

export function renderResult(
  container: HTMLElement,
  course: CourseResult,
  target: TargetProfile,
  onTryAnother: () => void,
  onPoint: (sampleIndex: number | null) => void,
): void {
  container.hidden = false;
  container.textContent = '';

  const heading = document.createElement('h2');
  heading.textContent = 'Proposed course';
  container.appendChild(heading);

  const chart = document.createElement('div');
  container.appendChild(chart);
  renderInteractiveChart(chart, target.samples, course.samples, onPoint);

  const stats = document.createElement('p');
  stats.className = 'hint';
  const split = course.surfaceSplit
    .map((f, i) => (f > 0.005 ? `${Math.round(f * 100)} % ${SURFACE_NAMES[i]}` : null))
    .filter((s) => s !== null)
    .join(', ');
  stats.textContent =
    `${(course.lengthM / 1000).toFixed(2)} km, +${Math.round(course.gain)} m / ` +
    `\u2212${Math.round(course.loss)} m \u00b7 score ${course.score.toFixed(1)} \u00b7 ${split}`;
  container.appendChild(stats);

  const download = document.createElement('button');
  download.textContent = 'Download GPX';
  download.addEventListener('click', () => {
    const gpx = buildGpx(
      `Profile course ${(course.lengthM / 1000).toFixed(1)} km`,
      `Match score ${course.score.toFixed(2)} (seed ${course.seed})`,
      course.exportPoints,
    );
    const url = URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'profile-course.gpx';
    a.click();
    URL.revokeObjectURL(url);
  });
  container.appendChild(download);

  const tryAnother = document.createElement('button');
  tryAnother.textContent = `Try another (seed ${course.seed + 1})`;
  tryAnother.style.marginTop = '8px';
  tryAnother.addEventListener('click', onTryAnother);
  container.appendChild(tryAnother);

  const copyLink = document.createElement('button');
  copyLink.textContent = 'Copy link';
  copyLink.style.marginTop = '8px';
  copyLink.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      copyLink.textContent = 'Link copied';
      setTimeout(() => (copyLink.textContent = 'Copy link'), 1500);
    } catch {
      copyLink.textContent = location.href;
    }
  });
  container.appendChild(copyLink);
}
