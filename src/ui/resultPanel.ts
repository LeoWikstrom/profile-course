import { buildGpx } from '../gpx/export';
import type { CourseResult } from '../shared/messages';

const SURFACE_NAMES = ['paved', 'gravel', 'trail', 'unknown'];

export interface ResultElements {
  stats: HTMLElement;
  actions: HTMLElement;
  downloadButton: HTMLButtonElement;
}

export function hideResult(els: ResultElements): void {
  els.stats.hidden = true;
  els.actions.hidden = true;
  els.downloadButton.hidden = true;
}

export function renderResult(
  els: ResultElements,
  course: CourseResult,
  action: { label: string; onAction: () => void },
  onEdit?: () => void,
): void {
  const split = course.surfaceSplit
    .map((f, i) => (f > 0.005 ? `${Math.round(f * 100)} % ${SURFACE_NAMES[i]}` : null))
    .filter((s) => s !== null)
    .join(', ');
  const topTerms = Object.entries(course.breakdown ?? {})
    .filter(([, v]) => v >= 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, v]) => `${k} ${v.toFixed(1)}`)
    .join(', ');
  els.stats.hidden = false;
  els.stats.textContent =
    `${(course.lengthM / 1000).toFixed(2)} km, +${Math.round(course.gain)} m / ` +
    `\u2212${Math.round(course.loss)} m \u00b7 mismatch ${course.score.toFixed(1)} (lower is better` +
    (topTerms ? `; mostly ${topTerms}` : '') +
    `) \u00b7 ${split}`;

  els.downloadButton.hidden = false;
  els.downloadButton.onclick = () => {
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
  };

  els.actions.hidden = false;
  els.actions.textContent = '';
  const actionButton = document.createElement('button');
  actionButton.textContent = action.label;
  actionButton.addEventListener('click', action.onAction);
  els.actions.appendChild(actionButton);

  if (onEdit) {
    const edit = document.createElement('button');
    edit.textContent = 'Edit';
    edit.title = 'Tap a point on the course, then tap where it should go instead';
    edit.addEventListener('click', onEdit);
    els.actions.appendChild(edit);
  }

  const copyLink = document.createElement('button');
  copyLink.textContent = 'Copy link';
  copyLink.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      copyLink.textContent = 'Link copied';
      setTimeout(() => (copyLink.textContent = 'Copy link'), 1500);
    } catch {
      copyLink.textContent = location.href;
    }
  });
  els.actions.appendChild(copyLink);
}
