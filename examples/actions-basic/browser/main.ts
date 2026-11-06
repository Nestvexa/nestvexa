// Browser script for the HBS page. Calls the generated, typed client:
// `actions.cart.addItem(input)` resolves to the server's CartSummary type.
import {
  createActionsClient,
  isActionClientError,
} from '@nestvexa/actions/client';
import { createActions } from './generated/actions-client.js';
import { createActionBindings } from './generated/actions-client.live.js';
import type { CartSummary } from './generated/actions-client.js';

const status = document.getElementById('status');
const lines = document.getElementById('cart-lines');
const total = document.getElementById('cart-total');

function say(message: string): void {
  if (status) status.textContent = message;
}

const actions = createActions(
  createActionsClient({
    // Defaults read the CSRF token from <meta name="nestvexa-csrf">.
    onNotifications: (notifications) =>
      say(notifications.map((notification) => notification.message).join(' ')),
  }),
);

function render(cart: CartSummary): void {
  if (!lines || !total) return;
  lines.replaceChildren(
    ...cart.lines.map((line) => {
      const item = document.createElement('li');
      item.textContent = `${line.quantity} × ${line.name}`;
      item.dataset['product'] = line.productId;
      return item;
    }),
  );
  total.textContent = (cart.totalCents / 100).toFixed(2);
}

async function run(operation: () => Promise<CartSummary>, done: string) {
  try {
    render(await operation());
    if (done) say(done);
  } catch (error) {
    if (isActionClientError(error))
      say(
        error.code === 'UNAUTHENTICATED'
          ? 'Sign in to use the cart.'
          : `${error.code}: ${error.message}`,
      );
    else say('The request failed. Check your connection.');
  }
}

// Generated Live/HBS helper: binds each server-rendered product button to the
// typed cart.add-item action (state in data-nv-action-state / aria-busy).
const bindings = createActionBindings(actions);
for (const button of document.querySelectorAll<HTMLButtonElement>(
  'button[data-product]',
))
  bindings.bindCartAddItem(button, {
    input: (element) => ({
      productId: element.dataset['product'] ?? '',
      quantity: 1,
    }),
    onSettled: (outcome) => {
      if (outcome.ok) {
        render(outcome.data);
        say('Added to cart.');
      } else
        say(
          outcome.error.code === 'UNAUTHENTICATED'
            ? 'Sign in to use the cart.'
            : `${outcome.error.code}: ${outcome.error.message}`,
        );
    },
  });

document.getElementById('clear-cart')?.addEventListener('click', () => {
  void run(() => actions.cart.clear(), '');
});

if (document.querySelector('form[action="/logout"]'))
  void run(() => actions.cart.summary(), '');
