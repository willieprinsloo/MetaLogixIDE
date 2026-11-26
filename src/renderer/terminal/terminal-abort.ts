/** Stop waiting promptly; the operation retains ownership of any resources it creates late. */
export function untilAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    function abort() { reject(signal.reason); }
    function detach() { signal.removeEventListener('abort', abort); }
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { detach(); abort(); }
    void operation.then(value => { detach(); resolve(value); }, error => { detach(); reject(error); });
  });
}
