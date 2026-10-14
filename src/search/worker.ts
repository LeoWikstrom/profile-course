import type { MainToWorker, WorkerToMain } from '../shared/messages';

function post(msg: WorkerToMain): void {
  postMessage(msg);
}

onmessage = (event: MessageEvent<MainToWorker>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'ping':
      post({ type: 'pong' });
      break;
    case 'search':
      post({ type: 'error', message: 'Search not implemented yet (phase 2)' });
      break;
    case 'cancel':
      break;
  }
};
