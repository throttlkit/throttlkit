import { ThrottlTimeoutError } from './errors.js';

// Bounds caller waiting while leaving cancellation support to the underlying store.
export function controlled(work, { signal, timeoutMs } = {}) {
  signal?.throwIfAborted();
  if (!signal && !timeoutMs) return Promise.resolve().then(work);
  return new Promise((resolve, reject) => {
    let timer;
    const abort = () => finish(reject, signal.reason ?? new DOMException('Aborted', 'AbortError'));
    const finish = (settle, value) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      settle(value);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (timeoutMs) timer = setTimeout(() => finish(reject, new ThrottlTimeoutError()), timeoutMs);
    Promise.resolve().then(() => { signal?.throwIfAborted(); return work(); })
      .then(value => finish(resolve, value), error => finish(reject, error));
  });
}
