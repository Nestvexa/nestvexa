/* global document, window */
// Host-owned browser glue, served from /assets/app.js under `script-src 'self'`.
// It wires @nestvexa/offline to this page; the Live client starts from
// /_nestvexa/boot.js independently.
import {
  attachOfflineDrafts,
  createDraftStore,
  createSnapshotCache,
  listenForLogout,
  loadRegion,
} from '/assets/offline.js';

// Drafts and snapshots are namespaced by the server-rendered identity hash.
const scope = document
  .querySelector('meta[name="nv-draft-scope"]')
  ?.getAttribute('content');
if (scope) {
  attachOfflineDrafts(document, { store: createDraftStore({ scope }) });
  // Another tab signing out clears this tab's drafts and snapshots too.
  listenForLogout();
  const cache = createSnapshotCache({ scope });
  const region = document.getElementById('recent-tickets');
  const refresh = document.getElementById('recent-refresh');
  const source = document.getElementById('recent-source');
  const messages = {
    network: 'Tickets are up to date.',
    cache: 'You are offline. Showing a read-only copy saved on this device.',
    unavailable: 'Tickets could not be loaded. Try again later.',
  };
  if (region && refresh && source) {
    cache.remember('recent', region);
    const reload = async () => {
      refresh.setAttribute('aria-busy', 'true');
      try {
        const result = await loadRegion(region, '/tickets/recent', {
          cache,
          key: 'recent',
          label: region.dataset.offlineLabel ?? 'Offline copy',
        });
        region.dataset.source = result;
        source.textContent = messages[result] ?? '';
      } finally {
        refresh.removeAttribute('aria-busy');
      }
    };
    refresh.addEventListener('click', () => {
      void reload();
    });
    window.addEventListener('nestvexa:event', (event) => {
      if (event.detail?.name === 'ticket-created') void reload();
    });
  }
}
