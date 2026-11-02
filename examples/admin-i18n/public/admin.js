/* global document, window, localStorage */
// Host-owned browser glue for the admin example. Served from /assets/admin.js
// under `script-src 'self'`; it only wires the optional packages together.
import { app } from '/_nestvexa/boot.js';
import { initUi } from '/assets/ui.js';
import {
  attachOfflineDrafts,
  createDraftStore,
  createSnapshotCache,
  listenForLogout,
  loadRegion,
} from '/assets/offline.js';
import { connectAssistant } from '/assets/ai.js';

initUi();

// Theme preference is a per-viewer convenience; the page works without it.
const themeSelect = document.getElementById('theme-select');
function applyTheme(value) {
  if (value === 'light' || value === 'dark')
    document.documentElement.dataset.theme = value;
  else delete document.documentElement.dataset.theme;
}
let storedTheme = 'system';
try {
  storedTheme = localStorage.getItem('admin-theme') ?? 'system';
} catch {
  // Storage can be unavailable (private mode, blocked site data).
}
applyTheme(storedTheme);
if (themeSelect instanceof window.HTMLSelectElement) {
  themeSelect.value = ['light', 'dark'].includes(storedTheme)
    ? storedTheme
    : 'system';
  themeSelect.addEventListener('change', () => {
    applyTheme(themeSelect.value);
    try {
      localStorage.setItem('admin-theme', themeSelect.value);
    } catch {
      // Ignore: the preference simply is not remembered.
    }
  });
}

// Drafts and offline snapshots are namespaced by the server-rendered identity hash.
const scope = document
  .querySelector('meta[name="nv-draft-scope"]')
  ?.getAttribute('content');
if (scope) {
  attachOfflineDrafts(document, { store: createDraftStore({ scope }) });
  listenForLogout();
  const cache = createSnapshotCache({ scope });
  const activity = document.getElementById('activity');
  const refresh = document.getElementById('activity-refresh');
  if (activity && refresh) {
    cache.remember('activity', activity);
    const reload = () =>
      loadRegion(activity, '/admin/activity', {
        cache,
        key: 'activity',
        label: activity.dataset.offlineLabel ?? '',
      }).then((source) => {
        activity.dataset.source = source;
      });
    refresh.addEventListener('click', () => {
      void reload();
    });
    window.addEventListener('nestvexa:event', (event) => {
      const name = event.detail?.name;
      if (name === 'product-created' || name === 'product-archived')
        void reload();
    });
  }
}

for (const panel of document.querySelectorAll('[data-nv-ai]'))
  connectAssistant(panel, app.client);
