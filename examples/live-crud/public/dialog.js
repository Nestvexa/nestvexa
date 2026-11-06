/* global document, Element, HTMLElement */
// Host-owned browser glue for the task editor dialog, served from
// /assets/dialog.js under `script-src 'self'`. Live renders the dialog; this
// file only manages focus the way a modal dialog should:
// - move focus into the dialog when it opens,
// - keep Tab/Shift+Tab inside it while it is open,
// - put focus on the first invalid field when a submit leaves focus nowhere,
// - return focus to the control that opened it when it closes.
const opened = new WeakSet();
let opener = null;
const focusable =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function dialog() {
  return document.querySelector('[data-task-editor]');
}

document.addEventListener('click', (event) => {
  const button =
    event.target instanceof Element
      ? event.target.closest('[data-opens-editor]')
      : null;
  if (button && button.id) opener = button.id;
});

document.addEventListener('keydown', (event) => {
  const current = dialog();
  if (event.key !== 'Tab' || !current) return;
  const items = [...current.querySelectorAll(focusable)];
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) return;
  const inside = current.contains(document.activeElement);
  if (event.shiftKey && (document.activeElement === first || !inside)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !inside)) {
    event.preventDefault();
    first.focus();
  }
});

document.addEventListener('nestvexa:updated', () => {
  const current = dialog();
  if (!current) return;
  if (!opened.has(current)) {
    opened.add(current);
    current.querySelector('input, select, textarea')?.focus();
    return;
  }
  // Only take focus when it was lost (for example the disabled submit
  // button lost it); never pull it away from a control the user chose.
  const active = document.activeElement;
  if (active && active !== document.body) return;
  const invalid = current.querySelector('[aria-invalid="true"]');
  if (invalid instanceof HTMLElement) invalid.focus();
});

// Removal hook: choosing the focus target here takes precedence over the
// Live client's fallback to the component root.
document.addEventListener('nestvexa:before-remove', (event) => {
  const removed = event.target;
  if (!(removed instanceof Element)) return;
  const closing = removed.matches('[data-task-editor]')
    ? removed
    : removed.querySelector('[data-task-editor]');
  if (!closing) return;
  const target =
    (opener && document.getElementById(opener)) ||
    document.getElementById('tasks-heading');
  opener = null;
  target?.focus();
});
