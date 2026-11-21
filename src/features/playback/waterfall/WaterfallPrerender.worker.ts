import {
  prepareWaterfallWindow, type WaterfallWindowSource, type WaterfallWorkerRequest, type WaterfallWorkerResponse,
} from './waterfallFrameCache';

const port = self as unknown as {
  onmessage: ((event: MessageEvent<WaterfallWorkerRequest>) => void) | null;
  postMessage(response: WaterfallWorkerResponse): void;
};
let source: WaterfallWindowSource | undefined;
let generation = -1;

port.onmessage = ({ data }) => {
  if (data.type === 'configure') {
    generation = data.generation;
    source = data.source;
    return;
  }
  if (!source || generation !== data.generation) return;
  const index = source;
  const windows = data.ids.map(id => prepareWaterfallWindow(index, id, data.visibleAhead));
  port.postMessage({ generation, request: data.request, windows });
};
