type BackendEvent<T> = { payload: T };

export async function listenWebEvent<T>(
  event: string,
  callback: (event: BackendEvent<T>) => void,
): Promise<() => void> {
  const listener = (browserEvent: Event) => {
    callback({ payload: (browserEvent as CustomEvent<T>).detail });
  };
  window.addEventListener(`noland:${event}`, listener);
  return () => window.removeEventListener(`noland:${event}`, listener);
}

export function emitWebEvent<T>(event: string, payload: T): void {
  window.dispatchEvent(new CustomEvent(`noland:${event}`, { detail: payload }));
}
