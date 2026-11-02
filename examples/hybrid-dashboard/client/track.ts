/** Demo-only lifecycle counters the browser tests read. Not part of the library. */
export function track(id: string, event: 'mount' | 'unmount'): void {
  const store = window as unknown as { nvIslandLog?: string[] };
  store.nvIslandLog ??= [];
  store.nvIslandLog.push(`${id}:${event}`);
}
