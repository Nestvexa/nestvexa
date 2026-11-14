/* global document, window, navigator, CustomEvent */
// Connection status for every HBS page (served from /assets, CSP 'self').
//
// A Live request that fails without a response (server stopped, network
// down) or the browser going offline shows "connection lost" and starts
// probing /api/health with a capped backoff. When the server answers again
// the banner says so; if a component was suspended because its last action
// may or may not have reached the server, it offers a reload instead of
// resending anything. This script never repeats a request.
const banner = document.getElementById('connection-status');
let probing = false;
let hideTimer = 0;

function show(text, withReload) {
  if (!banner) return;
  window.clearTimeout(hideTimer);
  banner.replaceChildren();
  const message = document.createElement('span');
  message.id = 'connection-message';
  message.textContent = text;
  banner.append(message);
  if (withReload) {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'connection-reload';
    button.textContent = banner.dataset.reload ?? 'Reload';
    button.addEventListener('click', () => window.location.reload());
    banner.append(' ', button);
  }
  banner.hidden = false;
}

async function reachable() {
  try {
    const response = await fetch('/api/health', {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function probe() {
  if (probing || !banner) return;
  probing = true;
  banner.dataset.state = 'lost';
  show(banner.dataset.lost ?? 'Connection lost');
  let delay = 1000;
  while (!(navigator.onLine && (await reachable()))) {
    await new Promise((resolve) => window.setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 5000);
  }
  probing = false;
  banner.dataset.state = 'restored';
  const suspended = document.querySelector('[data-nv-suspended]') !== null;
  show(
    suspended
      ? `${banner.dataset.restored ?? ''} ${banner.dataset.suspended ?? ''}`
      : (banner.dataset.restored ?? ''),
    suspended,
  );
  if (!suspended)
    hideTimer = window.setTimeout(() => {
      banner.hidden = true;
    }, 6000);
}

document.addEventListener('nestvexa:error', (event) => {
  const code = event instanceof CustomEvent ? event.detail?.code : undefined;
  if (code === 'NETWORK' || code === 'TIMEOUT') void probe();
});
window.addEventListener('offline', () => void probe());
