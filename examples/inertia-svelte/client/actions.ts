import { createActionsClient } from '@nestvexa/actions/client';
import { createActions } from './generated/actions-client.js';
import { createActionStores } from './generated/actions-client.svelte.js';

/**
 * The session's XSRF token from the readable `XSRF-TOKEN` cookie (the one the
 * official Inertia client echoes), sent by the actions client as
 * `x-nestvexa-csrf`. Read per call, so SSR never touches `document`.
 */
function xsrfToken(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  for (const part of document.cookie.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === 'XSRF-TOKEN') return decodeURIComponent(value.join('='));
  }
  return undefined;
}

/** Generated, typed stores for the server's @ActionGroup classes. */
export const actionStores = createActionStores(
  createActions(createActionsClient({ csrf: xsrfToken })),
);
