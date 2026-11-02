// Browser script for the HBS page. Calls the generated, typed client:
// `actions.cart.addItem(input)` resolves to the server's CartSummary type.
import {
  createActionsClient,
  isActionClientError,
} from '@nestvexa/actions/client';
import { createActions } from './generated/actions-client.js';
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

document.addEventListener('click', (event) => {
  if (!(event.target instanceof HTMLButtonElement)) return;
  const button = event.target;
  const product = button.dataset['product'];
  if (product)
    void run(
      () => actions.cart.addItem({ productId: product, quantity: 1 }),
      'Added to cart.',
    );
  else if (button.id === 'clear-cart') void run(() => actions.cart.clear(), '');
});

if (document.querySelector('form[action="/logout"]'))
  void run(() => actions.cart.summary(), '');
