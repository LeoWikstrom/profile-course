import { buildTargetProfile, type TargetProfile } from './gpx/profile';
import { parseGpx, type ParsedGpx } from './gpx/parse';
import type { MainToWorker, WorkerToMain } from './shared/messages';
import { createMap } from './ui/map';
import { renderProfileChart } from './ui/profileChart';
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

let targetProfile: TargetProfile | null = null;
let pendingGpx: ParsedGpx | null = null;

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
      startHint.textContent = `Start snapped; graph: ${msg.nodeCount} nodes, ${msg.edgeCount} edges, start at ${msg.startElevation.toFixed(0)} m`;
      findButton.disabled = false;
      findButton.textContent = 'Find course';
      break;
    case 'progress':
      findButton.textContent = `Working: ${msg.stage}…`;
      break;
    case 'error':
      console.warn('worker:', msg.message);
      startHint.textContent = msg.message;
      findButton.disabled = false;
      findButton.textContent = 'Find course';
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
  findButton.disabled = !(targetProfile !== null && map.getStart() !== null);
}

findButton.addEventListener('click', () => {
  const start = map.getStart();
  if (!start || !targetProfile) return;
  findButton.disabled = true;
  send({ type: 'prepare', start, radiusMeters: Number(radiusSlider.value) * 1000 });
});
