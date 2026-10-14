import { createMap } from './ui/map';
import type { MainToWorker, WorkerToMain } from './shared/messages';
import SearchWorker from './search/worker?worker';

const map = createMap('map');

const worker = new SearchWorker();
function send(msg: MainToWorker): void {
  worker.postMessage(msg);
}
worker.onmessage = (event: MessageEvent<WorkerToMain>) => {
  const msg = event.data;
  if (msg.type === 'pong') console.log('worker alive');
  if (msg.type === 'error') console.warn('worker:', msg.message);
};
send({ type: 'ping' });

const radiusSlider = document.getElementById('radius-slider') as HTMLInputElement;
const radiusValue = document.getElementById('radius-value') as HTMLOutputElement;
const findButton = document.getElementById('find-button') as HTMLButtonElement;
const startHint = document.getElementById('start-hint') as HTMLParagraphElement;

radiusSlider.addEventListener('input', () => {
  const km = Number(radiusSlider.value);
  radiusValue.textContent = km.toFixed(1);
  map.setRadius(km * 1000);
});

map.onStartChange((start) => {
  startHint.textContent = `Start: ${start.lat.toFixed(5)}, ${start.lon.toFixed(5)} (drag to adjust)`;
  updateFindEnabled();
});

let gpxLoaded = false;
const gpxInput = document.getElementById('gpx-input') as HTMLInputElement;
gpxInput.addEventListener('change', () => {
  gpxLoaded = gpxInput.files !== null && gpxInput.files.length > 0;
  updateFindEnabled();
});

function updateFindEnabled(): void {
  findButton.disabled = !(gpxLoaded && map.getStart() !== null);
}

findButton.addEventListener('click', () => {
  const start = map.getStart();
  if (!start) return;
  send({
    type: 'search',
    start,
    radiusMeters: Number(radiusSlider.value) * 1000,
    targetLengthMeters: 0,
    seed: 1,
  });
});
