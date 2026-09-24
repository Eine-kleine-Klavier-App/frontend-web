import { useAuthStore } from './authStore';
import { refreshSessionOnce } from './authApi';
import { AuthRequiredError } from './authorizedFetch';

/** Authenticate in the first frame: tokens never appear in URLs or subprotocol logs. */
export async function authorizedWebSocket(url: string, signal: AbortSignal): Promise<WebSocket> {
  if (useAuthStore.getState().status === 'loading') await useAuthStore.getState().bootstrap();
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal.aborted) throw new DOMException('Preview stopped.', 'AbortError');
    const token = useAuthStore.getState().accessToken;
    if (!token) throw new AuthRequiredError();
    try { return await connect(url, token, signal); }
    catch (error) {
      if (!(error instanceof AuthRequiredError) || attempt) throw error;
      const session = await refreshSessionOnce();
      if (!session) { useAuthStore.getState().clearSession(); throw error; }
      useAuthStore.getState().applyAccessToken(session.access_token);
    }
  }
  throw new AuthRequiredError();
}

function connect(url: string, token: string, signal: AbortSignal): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    const timer = setTimeout(() => fail(new Error('Live preview connection timed out.')), 8000);
    const cleanup = () => {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      socket.removeEventListener('open', open); socket.removeEventListener('message', message);
      socket.removeEventListener('error', error); socket.removeEventListener('close', close);
    };
    const fail = (reason: unknown) => { cleanup(); socket.close(); reject(reason); };
    const abort = () => fail(new DOMException('Preview stopped.', 'AbortError'));
    const open = () => socket.send(JSON.stringify({ type: 'auth', token }));
    const message = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type !== 'ready') throw new Error('Invalid live preview handshake.');
        cleanup(); resolve(socket);
      } catch (error) { fail(error); }
    };
    const error = () => fail(new Error('Could not connect live preview.'));
    const close = (event: CloseEvent) => fail(event.code === 4401 ? new AuthRequiredError() : new Error('Live preview connection refused.'));
    socket.addEventListener('open', open); socket.addEventListener('message', message);
    socket.addEventListener('error', error); socket.addEventListener('close', close);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
