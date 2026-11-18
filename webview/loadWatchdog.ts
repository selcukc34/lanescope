// Fires once if the host does not answer within a time limit, so the viewer
// shows an error instead of "Loading…" forever. DOM-free, so it is
// unit-testable in plain Node.

export const LOAD_TIMEOUT_MS = 10_000;

export interface LoadWatchdog {
  /** The host answered (render or error message): the timeout no longer fires. */
  answered(): void;
  /** True when the timeout has fired. */
  readonly timedOut: boolean;
}

export function startLoadWatchdog(onTimeout: () => void, timeoutMs = LOAD_TIMEOUT_MS): LoadWatchdog {
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    timer = undefined;
    watchdog.timedOut = true;
    onTimeout();
  }, timeoutMs);

  const watchdog = {
    timedOut: false,
    answered(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
  return watchdog;
}
