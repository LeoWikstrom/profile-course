import { buildTargetProfile, type TargetProfile } from './gpx/profile';
import { parseGpx, type ParsedGpx } from './gpx/parse';
import type { MainToWorker, WorkerToMain } from './shared/messages';
import { createMap } from './ui/map';
import { renderProfileChart } from './ui/profileChart';
import { renderResult } from './ui/resultPanel';
import SearchWorker from './search/worker?worker';

const map = createMap('map');
const worker = new SearchWorker();

function send(msg: MainToWorker): void {
  worker.postMessage(msg);
}

const radiusSlider = document.getElementById('radius-slider') as HTMLInputElement;
const radiusValue = document.getElementById('radius-value') as HTMLOutputElement;
const findButton = document.getElementById('find-button') as HTMLButtonElement;
const startHint = document.getElementById('start-hint') as HTMLParagraphElement;
const gpxInput = document.getElementById('gpx-input') as HTMLInputElement;
const gpxStats = document.getElementById('gpx-stats') as HTMLParagraphElement;
const targetChart = document.getElementById('target-chart') as HTMLDivElement;
const results = document.getElementById('results') as HTMLElement;

let targetProfile: TargetProfile | null = null;
let pendingGpx: ParsedGpx | null = null;
let seed = 1;
let searching = false;

function startSearch(): void {
  const start = map.getStart();
  if (!start || !targetProfile) return;
  searching = true;
  results.hidden = true;
  map.clearCourse();
  findButton.disabled = true;
  findButton.textContent = 'Working…';
  send({
    type: 'search',
    start,
    radiusMeters: Number(radiusSlider.value) * 1000,
    target: {
      totalDistance: targetProfile.totalDistance,
      samples: targetProfile.samples,
      totalGain: targetProfile.totalGain,
      totalLoss: targetProfile.totalLoss,
      gradientHistogram: targetProfile.gradientHistogram,
    },
    targetLengthMeters: targetProfile.totalDistance,
    seed,
  });
}

function searchDone(): void {
  searching = false;
  findButton.textContent = 'Find course';
  updateFindEnabled();
}

worker.onmessage = (event: MessageEvent<WorkerToMain>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'pong':
      console.log('worker alive');
      break;
    case 'elevated': {
      if (!pendingGpx) break;
      const points = pendingGpx.points.map((p, i) => ({ ...p, ele: msg.elevations[i]! }));
      pendingGpx = null;
      setTargetProfile(buildTargetProfile(points));
      break;
    }
    case 'prepared':
      console.log(
        `graph ready: ${msg.nodeCount} nodes, ${msg.edgeCount} edges; ` +
          `start node at ${msg.startNode.lat.toFixed(5)}, ${msg.startNode.lon.toFixed(5)}, ` +
          `elevation ${msg.startElevation.toFixed(1)} m`,
      );
      break;
    case 'progress':
      findButton.textContent =
        msg.bestScore !== null
          ? `${msg.stage} ${Math.round(msg.fraction * 100)} % (best ${msg.bestScore.toFixed(1)})`
          : `${msg.stage} ${Math.round(msg.fraction * 100)} %`;
      break;
    case 'bestSoFar':
      map.drawCourse(msg.segments, { faded: true });
      break;
    case 'result':
      map.drawCourse(msg.course.segments);
      if (targetProfile) {
        renderResult(results, msg.course, targetProfile, () => {
          seed += 1;
          startSearch();
        });
      }
      searchDone();
      break;
    case 'noCourse':
      startHint.textContent = msg.message;
      map.clearCourse();
      searchDone();
      break;
    case 'error':
      console.warn('worker:', msg.message);
      startHint.textContent = msg.message;
      searchDone();
      break;
  }
};
send({ type: 'ping' });

function setTargetProfile(profile: TargetProfile): void {
  targetProfile = profile;
  gpxStats.hidden = false;
  gpxStats.textContent = `${(profile.totalDistance / 1000).toFixed(1)} km, +${Math.round(profile.totalGain)} m / \u2212${Math.round(profile.totalLoss)} m`;
  renderProfileChart(targetChart, [{ samples: profile.samples, color: '#2563eb' }]);
  updateFindEnabled();
}

gpxInput.addEventListener('change', async () => {
  const file = gpxInput.files?.[0];
  if (!file) return;
  try {
    const gpx = parseGpx(await file.text());
    if (gpx.hasElevation) {
      setTargetProfile(buildTargetProfile(gpx.points));
    } else {
      gpxStats.hidden = false;
      gpxStats.textContent = 'No elevation in GPX; fetching from terrain model…';
      pendingGpx = gpx;
      const lats = new Float64Array(gpx.points.map((p) => p.lat));
      const lons = new Float64Array(gpx.points.map((p) => p.lon));
      send({ type: 'elevate', lats, lons });
    }
  } catch (err) {
    gpxStats.hidden = false;
    gpxStats.textContent = err instanceof Error ? err.message : String(err);
    targetProfile = null;
    updateFindEnabled();
  }
});

radiusSlider.addEventListener('input', () => {
  const km = Number(radiusSlider.value);
  radiusValue.textContent = km.toFixed(1);
  map.setRadius(km * 1000);
});

map.onStartChange((start) => {
  startHint.textContent = `Start: ${start.lat.toFixed(5)}, ${start.lon.toFixed(5)} (drag to adjust)`;
  updateFindEnabled();
});

function updateFindEnabled(): void {
  if (searching) return;
  findButton.disabled = !(targetProfile !== null && map.getStart() !== null);
}

findButton.addEventListener('click', startSearch);
