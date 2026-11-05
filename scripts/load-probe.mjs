// Preloaded into example servers by scripts/load.mjs (`node --expose-gc --import`).
// Answers IPC memory samples after a full collection; it adds no routes and no
// behavior to the application under test.
process.on('message', (message) => {
  if (
    !message ||
    typeof message !== 'object' ||
    message.type !== 'nestvexa-load-sample'
  )
    return;
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
    globalThis.gc();
  }
  const usage = process.memoryUsage();
  process.send?.({
    type: 'nestvexa-load-sample',
    id: message.id,
    heapUsed: usage.heapUsed,
    rss: usage.rss,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  });
});
