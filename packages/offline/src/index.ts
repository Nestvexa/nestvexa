/**
 * @nestvexa/offline browser module: identity-scoped, opt-in form drafts, inert
 * read-only HTML snapshots and a reconnect flow that never replays actions.
 *
 * This file is intentionally self-contained (no relative imports) so a host
 * can serve `dist/index.js` directly under `script-src 'self'`. It touches no
 * browser global at module evaluation time and is safe to import in Node.
 */

export type DraftValue = string | readonly string[] | boolean;
export interface DraftStoreOptions {
  /** Opaque server-rendered identity hash (see `draftScope` in `./server`). */
  readonly scope: string;
  /** Defaults to `window.localStorage`; failures degrade to a no-op. */
  readonly storage?: Storage;
  /** Draft lifetime in milliseconds; default 24 hours, maximum 7 days. */
  readonly ttlMs?: number;
  /** Storage key prefix; default `nv-draft`. */
  readonly prefix?: string;
  readonly now?: () => number;
  /** Serialized bytes per draft; default 32 KiB. */
  readonly maxBytes?: number;
  readonly onError?: (error: unknown) => void;
}
export interface DraftRecord {
  readonly form: string;
  readonly savedAt: number;
  readonly expiresAt: number;
  readonly fields: Readonly<Record<string, DraftValue>>;
}
export interface DraftStore {
  save(form: string, fields: DraftRecord['fields']): void;
  load(form: string): DraftRecord | null;
  clear(form: string): void;
  /** Remove expired drafts and every draft of another scope under this prefix. */
  purge(): number;
  /** Remove every draft under this prefix, for all scopes. */
  clearAll(): number;
}
export interface OfflineMessages {
  readonly restored?: string;
  readonly interrupted?: string;
  readonly reconnected?: string;
}
export interface AttachOfflineOptions {
  readonly store: DraftStore;
  readonly window?: Window;
  /** Trailing save debounce in milliseconds; default 400. */
  readonly debounceMs?: number;
  readonly messages?: OfflineMessages;
}
export interface OfflineController {
  refresh(): void;
  dispose(): void;
}
export interface LogoutOptions {
  readonly window?: Window;
  /** Draft storage; default `window.localStorage`. */
  readonly storage?: Storage;
  /** Draft prefix; default `nv-draft`. */
  readonly prefix?: string;
  /** Snapshot storage; default `window.sessionStorage`. */
  readonly snapshotStorage?: Storage;
  /** Snapshot prefix; default `nv-snapshot`. */
  readonly snapshotPrefix?: string;
  /** BroadcastChannel name; default `nestvexa-logout`. */
  readonly channel?: string;
}
export interface SnapshotCacheOptions {
  readonly scope: string;
  /** Defaults to `window.sessionStorage`; failures degrade to a no-op. */
  readonly storage?: Storage;
  /** Snapshot lifetime in milliseconds; default 1 hour, maximum 24 hours. */
  readonly ttlMs?: number;
  readonly prefix?: string;
  /** Serialized bytes per snapshot; default 256 KiB. */
  readonly maxBytes?: number;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}
export interface SnapshotCache {
  remember(key: string, element: Element): void;
  restore(key: string, target: Element, options?: { label?: string }): boolean;
  clear(key?: string): void;
}
export interface LoadRegionOptions {
  readonly cache: SnapshotCache;
  readonly key: string;
  readonly fetch?: typeof fetch;
  readonly label?: string;
  readonly signal?: AbortSignal;
}

const hour = 3_600_000;
const forbiddenNames = new Set(['__proto__', 'prototype', 'constructor']);
const scopePattern = /^[A-Za-z0-9_-]{16,128}$/;
const idPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const prefixPattern = /^[a-z][a-z0-9-]{0,31}$/;
const fieldPattern = /^[A-Za-z_][\w.\-[\]:]{0,127}$/;
const maxFields = 128;
const maxArray = 256;
const defaultMessages = Object.freeze({
  restored:
    'A saved draft was restored on this device. It has not been sent. Review it and submit when ready.',
  interrupted:
    'Not sent. Your draft is saved on this device. Submit again when you are back online.',
  reconnected: 'Connection restored. Review and submit again.',
});

function fail(message: string): never {
  throw new TypeError(message);
}
function checkScope(scope: unknown): string {
  return typeof scope === 'string' && scopePattern.test(scope)
    ? scope
    : fail('Draft scope must be an opaque 16–128 character identifier');
}
function checkId(value: unknown, label: string): string {
  return typeof value === 'string' && idPattern.test(value)
    ? value
    : fail(`Invalid ${label} identifier`);
}
function checkPrefix(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  return typeof value === 'string' && prefixPattern.test(value)
    ? value
    : fail('Invalid storage prefix');
}
function bounded(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : fail(`${label} must be an integer from ${minimum} through ${maximum}`);
}
function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
/** Null-prototype record from a parsed JSON object, rejecting dangerous keys. */
function plainObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return null;
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (forbiddenNames.has(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) return null;
    output[key] = descriptor.value;
  }
  return output;
}
function draftValue(value: unknown): DraftValue | undefined {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (
    Array.isArray(value) &&
    value.length <= maxArray &&
    value.every((item) => typeof item === 'string')
  )
    return Object.freeze([...(value as string[])]);
  return undefined;
}
function copyFields(value: unknown): Readonly<Record<string, DraftValue>> {
  const source = plainObject(value);
  if (!source) fail('Draft fields must be a plain object');
  const keys = Object.keys(source);
  if (keys.length > maxFields) fail('Too many draft fields');
  const output = Object.create(null) as Record<string, DraftValue>;
  for (const key of keys) {
    if (!fieldPattern.test(key) || forbiddenNames.has(key))
      fail('Invalid draft field name');
    const item = draftValue(source[key]);
    if (item === undefined) fail('Invalid draft field value');
    output[key] = item;
  }
  return Object.freeze(output);
}
function storageKeys(storage: Storage): string[] {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key !== null) keys.push(key);
  }
  return keys;
}
function removeMatching(
  storage: Storage | undefined,
  prefix: string,
  test: (key: string) => boolean = () => true,
): number {
  if (!storage) return 0;
  let removed = 0;
  for (const key of storageKeys(storage)) {
    if (!key.startsWith(`${prefix}:v1:`) || !test(key)) continue;
    storage.removeItem(key);
    removed++;
  }
  return removed;
}
function defaultStorage(
  kind: 'localStorage' | 'sessionStorage',
  onError?: (error: unknown) => void,
): Storage | undefined {
  try {
    const value: unknown = Reflect.get(globalThis, kind);
    return value && typeof value === 'object' ? (value as Storage) : undefined;
  } catch (error) {
    onError?.(error);
    return undefined;
  }
}

export function createDraftStore(options: DraftStoreOptions): DraftStore {
  const scope = checkScope(options.scope);
  const prefix = checkPrefix(options.prefix, 'nv-draft');
  const ttl = bounded(options.ttlMs, 24 * hour, 1_000, 7 * 24 * hour, 'ttlMs');
  const maxBytes = bounded(
    options.maxBytes,
    32_768,
    256,
    1_048_576,
    'maxBytes',
  );
  const now = options.now ?? Date.now;
  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      /* Error observers never break storage degradation. */
    }
  };
  const storage =
    options.storage ?? defaultStorage('localStorage', (error) => report(error));
  const keyFor = (form: string): string =>
    `${prefix}:v1:${scope}:${checkId(form, 'draft form')}`;
  const guarded = <T>(fallback: T, run: (storage: Storage) => T): T => {
    if (!storage) return fallback;
    try {
      return run(storage);
    } catch (error) {
      report(error);
      return fallback;
    }
  };
  function parse(form: string, raw: string): DraftRecord | null {
    if (byteLength(raw) > maxBytes) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
    const record = plainObject(value);
    if (
      !record ||
      record['v'] !== 1 ||
      record['scope'] !== scope ||
      record['form'] !== form
    )
      return null;
    const savedAt = record['savedAt'];
    const expiresAt = record['expiresAt'];
    const current = now();
    if (
      typeof savedAt !== 'number' ||
      typeof expiresAt !== 'number' ||
      !Number.isFinite(savedAt) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= current ||
      expiresAt - savedAt > 7 * 24 * hour ||
      savedAt > current + 60_000
    )
      return null;
    let fields: Readonly<Record<string, DraftValue>>;
    try {
      fields = copyFields(record['fields']);
    } catch {
      return null;
    }
    return Object.freeze({ form, savedAt, expiresAt, fields });
  }
  return Object.freeze({
    save(form: string, fields: DraftRecord['fields']): void {
      const key = keyFor(form);
      const copy = copyFields(fields);
      const savedAt = now();
      const serialized = JSON.stringify({
        v: 1,
        scope,
        form,
        savedAt,
        expiresAt: savedAt + ttl,
        fields: copy,
      });
      if (byteLength(serialized) > maxBytes) {
        report(new RangeError('Draft exceeds the configured size limit'));
        guarded(undefined, (target) => target.removeItem(key));
        return;
      }
      guarded(undefined, (target) => target.setItem(key, serialized));
    },
    load(form: string): DraftRecord | null {
      const key = keyFor(form);
      return guarded(null, (target) => {
        const raw = target.getItem(key);
        if (raw === null) return null;
        const record = parse(form, raw);
        if (!record) target.removeItem(key);
        return record;
      });
    },
    clear(form: string): void {
      const key = keyFor(form);
      guarded(undefined, (target) => target.removeItem(key));
    },
    purge(): number {
      return guarded(0, (target) =>
        removeMatching(target, prefix, (key) => {
          const rest = key.slice(`${prefix}:v1:`.length);
          const separator = rest.indexOf(':');
          if (separator < 0 || rest.slice(0, separator) !== scope) return true;
          const form = rest.slice(separator + 1);
          if (!idPattern.test(form)) return true;
          const raw = target.getItem(key);
          return raw === null || parse(form, raw) === null;
        }),
      );
    },
    clearAll(): number {
      return guarded(0, (target) => removeMatching(target, prefix));
    },
  });
}

export function clearAllDrafts(storage?: Storage, prefix?: string): number {
  const name = checkPrefix(prefix, 'nv-draft');
  try {
    return removeMatching(storage ?? defaultStorage('localStorage'), name);
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------------ */
/* Form drafts                                                              */
/* ------------------------------------------------------------------------ */

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
const neverTypes = new Set([
  'password',
  'file',
  'hidden',
  'submit',
  'button',
  'reset',
  'image',
]);
const sensitiveAutocomplete =
  /(?:^|\s)(?:cc-[a-z-]+|current-password|new-password|one-time-code)(?:\s|$)/i;

function isField(element: Element): element is Field {
  const tag = element.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
}
/** Opt-in only: the field must be marked and must not be sensitive. */
function eligible(element: Element): element is Field {
  if (!isField(element) || !element.name || element.disabled) return false;
  if (!element.hasAttribute('data-nv-draft-field')) return false;
  if (element.hasAttribute('data-nv-draft-never')) return false;
  if (!fieldPattern.test(element.name) || forbiddenNames.has(element.name))
    return false;
  if (element instanceof HTMLInputElement && neverTypes.has(element.type))
    return false;
  const autocomplete = element.getAttribute('autocomplete') ?? '';
  return !sensitiveAutocomplete.test(autocomplete);
}
function draftForms(root: ParentNode): HTMLFormElement[] {
  const forms: HTMLFormElement[] = [];
  if (root instanceof HTMLFormElement && root.hasAttribute('data-nv-draft'))
    forms.push(root);
  for (const form of root.querySelectorAll('form[data-nv-draft]'))
    if (form instanceof HTMLFormElement) forms.push(form);
  return forms;
}
function formId(form: HTMLFormElement): string | undefined {
  const value = form.getAttribute('data-nv-draft');
  return value !== null && idPattern.test(value) ? value : undefined;
}
function fieldsOf(form: HTMLFormElement): Field[] {
  return [...form.elements].filter(eligible);
}
function atDefault(field: Field): boolean {
  if (field instanceof HTMLInputElement) {
    if (field.type === 'checkbox' || field.type === 'radio')
      return field.checked === field.defaultChecked;
    return field.value === field.defaultValue;
  }
  if (field instanceof HTMLTextAreaElement)
    return field.value === field.defaultValue;
  return [...field.options].every(
    (option) => option.selected === option.defaultSelected,
  );
}
function capture(form: HTMLFormElement): Record<string, DraftValue> | null {
  const fields = fieldsOf(form);
  if (fields.every(atDefault)) return null;
  const values = Object.create(null) as Record<string, DraftValue>;
  const groups = new Map<string, Field[]>();
  for (const field of fields) {
    const group = groups.get(field.name);
    if (group) group.push(field);
    else groups.set(field.name, [field]);
  }
  for (const [name, group] of groups) {
    const first = group[0];
    if (!first) continue;
    if (first instanceof HTMLInputElement && first.type === 'checkbox') {
      const boxes = group.filter(
        (item): item is HTMLInputElement =>
          item instanceof HTMLInputElement && item.type === 'checkbox',
      );
      values[name] =
        boxes.length === 1
          ? first.checked
          : boxes
              .filter((box) => box.checked)
              .map((box) => box.value)
              .slice(0, maxArray);
    } else if (first instanceof HTMLInputElement && first.type === 'radio') {
      const checked = group.find(
        (item) => item instanceof HTMLInputElement && item.checked,
      );
      if (checked) values[name] = checked.value;
    } else if (first instanceof HTMLSelectElement && first.multiple) {
      values[name] = [...first.selectedOptions]
        .map((option) => option.value)
        .slice(0, maxArray);
    } else values[name] = first.value;
  }
  return values;
}
function fire(field: Field): void {
  const view = field.ownerDocument.defaultView;
  if (!view) return;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
}
/** Writes values only; never submits, clicks or calls an action. */
function apply(
  form: HTMLFormElement,
  values: Readonly<Record<string, DraftValue>>,
): number {
  let restored = 0;
  const changed = new Set<Field>();
  for (const field of fieldsOf(form)) {
    if (!Object.hasOwn(values, field.name)) continue;
    const value = values[field.name];
    if (field instanceof HTMLInputElement && field.type === 'checkbox') {
      const next =
        typeof value === 'boolean'
          ? value
          : Array.isArray(value) && value.includes(field.value);
      if (field.checked !== next) {
        field.checked = next;
        changed.add(field);
      }
    } else if (field instanceof HTMLInputElement && field.type === 'radio') {
      const next = typeof value === 'string' && field.value === value;
      if (field.checked !== next) {
        field.checked = next;
        changed.add(field);
      }
    } else if (field instanceof HTMLSelectElement && field.multiple) {
      if (!Array.isArray(value)) continue;
      for (const option of field.options) {
        const next = value.includes(option.value);
        if (option.selected !== next) {
          option.selected = next;
          changed.add(field);
        }
      }
    } else if (typeof value === 'string' && field.value !== value) {
      field.value = value;
      changed.add(field);
    }
  }
  for (const field of changed) {
    fire(field);
    restored++;
  }
  return restored;
}
function message(
  form: HTMLFormElement,
  kind: keyof typeof defaultMessages,
  messages: OfflineMessages | undefined,
): string {
  return (
    form.getAttribute(`data-nv-draft-message-${kind}`) ??
    messages?.[kind] ??
    defaultMessages[kind]
  );
}
function announce(form: HTMLFormElement, text: string): void {
  const status = form.querySelector('[data-nv-draft-status]');
  if (status) status.textContent = text;
}

/** Mark a non-Live form as accepted by the server; the attached controller clears its draft. */
export function markCommitted(form: HTMLFormElement): void {
  form.setAttribute('data-nv-draft-committed', String(Date.now()));
}

function resolveWindow(
  root: Element | Document | undefined,
  explicit: Window | undefined,
): Window {
  const view =
    explicit ??
    (root
      ? (root instanceof Document ? root : root.ownerDocument).defaultView
      : (Reflect.get(globalThis, 'window') as Window | undefined));
  if (!view) throw new TypeError('A browser window is required');
  return view;
}

export function attachOfflineDrafts(
  root: Element | Document,
  options: AttachOfflineOptions,
): OfflineController {
  const win = resolveWindow(root, options.window);
  const doc = root instanceof Document ? root : root.ownerDocument;
  const store = options.store;
  const debounce = bounded(options.debounceMs, 400, 0, 10_000, 'debounceMs');
  const timers = new Map<HTMLFormElement, ReturnType<typeof setTimeout>>();
  const restoredForms = new WeakSet<HTMLFormElement>();
  const committedTokens = new WeakMap<HTMLFormElement, string | null>();
  const attempts = new WeakMap<HTMLFormElement, number>();
  let suspended = false;
  let disposed = false;
  const inRoot = (node: Node): boolean =>
    node.isConnected && (node === root || root.contains(node));

  function save(form: HTMLFormElement): void {
    const id = formId(form);
    if (!id || suspended || disposed || !form.isConnected) return;
    const values = capture(form);
    try {
      if (values) store.save(id, values);
      else store.clear(id);
    } catch {
      /* Invalid live markup never interrupts typing. */
    }
  }
  function schedule(form: HTMLFormElement): void {
    const pending = timers.get(form);
    if (pending !== undefined) win.clearTimeout(pending);
    timers.set(
      form,
      win.setTimeout(() => {
        timers.delete(form);
        save(form);
      }, debounce),
    );
  }
  function flush(): void {
    for (const [form, timer] of [...timers]) {
      win.clearTimeout(timer);
      timers.delete(form);
      save(form);
    }
  }
  function reset(form: HTMLFormElement): void {
    form.removeAttribute('data-nv-draft-state');
    announce(form, '');
  }
  function commit(form: HTMLFormElement): void {
    const id = formId(form);
    const pending = timers.get(form);
    if (pending !== undefined) {
      win.clearTimeout(pending);
      timers.delete(form);
    }
    if (id) store.clear(id);
    attempts.delete(form);
    reset(form);
  }
  function inspect(form: HTMLFormElement): void {
    const id = formId(form);
    if (!id) return;
    const token = form.getAttribute('data-nv-draft-committed');
    const seen = committedTokens.has(form);
    const previous = committedTokens.get(form) ?? null;
    committedTokens.set(form, token);
    if (token !== null && (!seen || token !== previous)) {
      // A changed marker always means a new commit. On first sight (initial
      // load or a replaced form) an epoch-millisecond marker only clears
      // drafts saved before that commit, so a newer draft survives a reload.
      const at = /^\d{1,15}$/.test(token) ? Number(token) : undefined;
      const existing = seen || at === undefined ? null : store.load(id);
      if (seen || at === undefined || !existing || existing.savedAt <= at) {
        commit(form);
        restoredForms.add(form);
        return;
      }
    }
    if (restoredForms.has(form) || suspended) return;
    restoredForms.add(form);
    const draft = store.load(id);
    if (!draft || !fieldsOf(form).every(atDefault)) return;
    if (apply(form, draft.fields) === 0) return;
    form.setAttribute('data-nv-draft-state', 'restored');
    announce(form, message(form, 'restored', options.messages));
  }
  function refresh(): void {
    if (disposed) return;
    for (const form of draftForms(root)) inspect(form);
  }
  const draftFormFor = (target: EventTarget | null): HTMLFormElement | null => {
    if (!(target instanceof Element)) return null;
    const form = isField(target)
      ? target.form
      : target.closest('form[data-nv-draft]');
    return form instanceof HTMLFormElement &&
      form.hasAttribute('data-nv-draft') &&
      inRoot(form)
      ? form
      : null;
  };
  const onInput = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element) || !eligible(target)) return;
    const form = draftFormFor(target);
    if (form) schedule(form);
  };
  const onSubmit = (event: Event): void => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !inRoot(form)) return;
    if (form.hasAttribute('data-nv-logout')) {
      logout();
      return;
    }
    if (!form.hasAttribute('data-nv-draft')) return;
    attempts.set(form, Date.now());
    const pending = timers.get(form);
    if (pending !== undefined) win.clearTimeout(pending);
    timers.delete(form);
    save(form);
  };
  const onClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const logoutControl = target.closest('[data-nv-logout]');
    if (
      logoutControl &&
      !(logoutControl instanceof HTMLFormElement) &&
      inRoot(logoutControl)
    ) {
      logout();
      return;
    }
    const button = target.closest('button, input[type="submit"]');
    if (
      !button ||
      (button instanceof HTMLButtonElement && button.type !== 'submit') ||
      (button instanceof HTMLInputElement && button.type !== 'submit')
    )
      return;
    const form = draftFormFor(button);
    if (form) attempts.set(form, Date.now());
  };
  const onError = (event: Event): void => {
    if (!(event instanceof CustomEvent)) return;
    const detail: unknown = event.detail;
    const code =
      detail && typeof detail === 'object'
        ? Reflect.get(detail, 'code')
        : undefined;
    if (code !== 'NETWORK' && code !== 'TIMEOUT') return;
    const component = event.target;
    if (!(component instanceof Element)) return;
    for (const form of draftForms(component)) {
      const attempted = attempts.get(form);
      if (
        !inRoot(form) ||
        attempted === undefined ||
        Date.now() - attempted > 120_000
      )
        continue;
      attempts.delete(form);
      save(form);
      form.setAttribute('data-nv-draft-state', 'interrupted');
      announce(form, message(form, 'interrupted', options.messages));
    }
  };
  const onUpdated = (event: Event): void => {
    const component = event.target;
    if (!(component instanceof Element)) return;
    for (const form of draftForms(component)) {
      if (!inRoot(form)) continue;
      const state = form.getAttribute('data-nv-draft-state');
      // A response arrived, so the server was reachable for this component.
      if (state === 'interrupted' || state === 'reconnected') reset(form);
      attempts.delete(form);
      inspect(form);
    }
  };
  const onOnline = (): void => {
    for (const form of draftForms(root)) {
      if (form.getAttribute('data-nv-draft-state') !== 'interrupted') continue;
      // Message only: never resubmit, never move focus.
      form.setAttribute('data-nv-draft-state', 'reconnected');
      announce(form, message(form, 'reconnected', options.messages));
    }
  };
  const onLogout = (): void => {
    suspended = true;
    for (const timer of timers.values()) win.clearTimeout(timer);
    timers.clear();
  };
  const onPageHide = (): void => flush();
  function logout(): void {
    onLogout();
    store.clearAll();
    announceLogout({ window: win });
  }
  const observer = new MutationObserver((records) => {
    if (disposed) return;
    const forms = new Set<HTMLFormElement>();
    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.target instanceof HTMLFormElement) forms.add(record.target);
        continue;
      }
      for (const node of record.addedNodes)
        if (node instanceof Element)
          for (const form of draftForms(node)) forms.add(form);
      for (const node of record.removedNodes)
        if (node instanceof Element)
          for (const form of draftForms(node)) {
            const timer = timers.get(form);
            if (timer !== undefined && !form.isConnected) {
              win.clearTimeout(timer);
              timers.delete(form);
            }
          }
    }
    for (const form of forms) if (inRoot(form)) inspect(form);
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-nv-draft', 'data-nv-draft-committed'],
  });
  root.addEventListener('input', onInput);
  root.addEventListener('change', onInput);
  root.addEventListener('submit', onSubmit, true);
  root.addEventListener('click', onClick, true);
  doc.addEventListener('nestvexa:error', onError);
  doc.addEventListener('nestvexa:updated', onUpdated);
  win.addEventListener('online', onOnline);
  win.addEventListener('nestvexa:logout', onLogout);
  win.addEventListener('pagehide', onPageHide);
  try {
    store.purge();
  } catch {
    /* Storage failures are reported by the store. */
  }
  refresh();
  return Object.freeze({
    refresh,
    dispose(): void {
      if (disposed) return;
      flush();
      disposed = true;
      observer.disconnect();
      root.removeEventListener('input', onInput);
      root.removeEventListener('change', onInput);
      root.removeEventListener('submit', onSubmit, true);
      root.removeEventListener('click', onClick, true);
      doc.removeEventListener('nestvexa:error', onError);
      doc.removeEventListener('nestvexa:updated', onUpdated);
      win.removeEventListener('online', onOnline);
      win.removeEventListener('nestvexa:logout', onLogout);
      win.removeEventListener('pagehide', onPageHide);
    },
  });
}

/* ------------------------------------------------------------------------ */
/* Logout                                                                   */
/* ------------------------------------------------------------------------ */

function logoutSettings(options: LogoutOptions = {}) {
  const win = resolveWindow(undefined, options.window);
  const storageOf = (kind: 'localStorage' | 'sessionStorage') => {
    try {
      return win[kind];
    } catch {
      return undefined;
    }
  };
  const channel = options.channel ?? 'nestvexa-logout';
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(channel))
    throw new TypeError('Invalid logout channel name');
  const prefix = checkPrefix(options.prefix, 'nv-draft');
  return {
    win,
    storage: options.storage ?? storageOf('localStorage'),
    prefix,
    snapshotStorage: options.snapshotStorage ?? storageOf('sessionStorage'),
    snapshotPrefix: checkPrefix(options.snapshotPrefix, 'nv-snapshot'),
    channel,
    signal: `${prefix}:logout-signal`,
  };
}
function clearLocal(settings: ReturnType<typeof logoutSettings>): number {
  let removed = 0;
  try {
    removed += removeMatching(settings.storage, settings.prefix);
  } catch {
    /* Blocked storage holds nothing to clear. */
  }
  try {
    removed += removeMatching(
      settings.snapshotStorage,
      settings.snapshotPrefix,
    );
  } catch {
    /* Blocked storage holds nothing to clear. */
  }
  return removed;
}
function randomId(win: Window): string {
  const bytes = new Uint8Array(12);
  win.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Clear every draft and snapshot in this tab, notify other tabs of the same
 * origin and dispatch `nestvexa:logout` on the window. Returns removed entries.
 */
export function announceLogout(options: LogoutOptions = {}): number {
  const settings = logoutSettings(options);
  const removed = clearLocal(settings);
  const id = randomId(settings.win);
  const Channel = Reflect.get(settings.win, 'BroadcastChannel') as
    typeof BroadcastChannel | undefined;
  if (typeof Channel === 'function') {
    try {
      const channel = new Channel(settings.channel);
      channel.postMessage({ type: 'nestvexa-logout', id });
      channel.close();
    } catch {
      /* The storage signal below remains as a fallback. */
    }
  }
  try {
    settings.storage?.setItem(settings.signal, id);
    settings.storage?.removeItem(settings.signal);
  } catch {
    /* Blocked storage cannot signal other tabs. */
  }
  settings.win.dispatchEvent(
    new CustomEvent('nestvexa:logout', { detail: { id } }),
  );
  return removed;
}

/** Clear drafts and snapshots when another tab announces logout. Returns an unsubscribe function. */
export function listenForLogout(options: LogoutOptions = {}): () => void {
  const settings = logoutSettings(options);
  const seen = new Set<string>();
  const handle = (id: unknown): void => {
    if (typeof id !== 'string' || !/^[0-9a-f]{24}$/.test(id) || seen.has(id))
      return;
    if (seen.size > 64) seen.clear();
    seen.add(id);
    clearLocal(settings);
    settings.win.dispatchEvent(
      new CustomEvent('nestvexa:logout', { detail: { id } }),
    );
  };
  const onStorage = (event: StorageEvent): void => {
    if (event.key === settings.signal && event.newValue !== null)
      handle(event.newValue);
  };
  settings.win.addEventListener('storage', onStorage);
  let channel: BroadcastChannel | undefined;
  const Channel = Reflect.get(settings.win, 'BroadcastChannel') as
    typeof BroadcastChannel | undefined;
  if (typeof Channel === 'function') {
    try {
      channel = new Channel(settings.channel);
      channel.onmessage = (event: MessageEvent) => {
        const data: unknown = event.data;
        if (
          data &&
          typeof data === 'object' &&
          Reflect.get(data, 'type') === 'nestvexa-logout'
        )
          handle(Reflect.get(data, 'id'));
      };
    } catch {
      channel = undefined;
    }
  }
  return () => {
    settings.win.removeEventListener('storage', onStorage);
    channel?.close();
  };
}

/* ------------------------------------------------------------------------ */
/* Read-only snapshots                                                      */
/* ------------------------------------------------------------------------ */

const removedElements =
  'script,iframe,frame,frameset,object,embed,applet,template,link,meta,style,base,noscript,portal';
const urlAttributes = new Set([
  'href',
  'src',
  'action',
  'formaction',
  'xlink:href',
  'poster',
  'background',
  'cite',
  'srcset',
  'ping',
]);
function unsafeUrl(value: string): boolean {
  // Browsers ignore control characters and whitespace inside URL schemes.
  let compact = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code > 0x20 && code !== 0x7f) compact += character;
  }
  return /(?:^|,)(?:javascript|vbscript|data):/i.test(compact);
}
/**
 * Strip executable and Live-ownership content in place. `snapshot` mode also
 * removes every Live marker, hidden input and form target so restored copies
 * can never mount or submit with a stale snapshot or CSRF token.
 */
function sanitize(fragment: DocumentFragment, snapshot: boolean): void {
  for (const element of fragment.querySelectorAll(removedElements))
    element.remove();
  if (snapshot)
    for (const element of fragment.querySelectorAll(
      'input[type="hidden" i], [name="_csrf"], [name="csrf"], [name="csrfToken"]',
    ))
      element.remove();
  for (const element of fragment.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const remove =
        name.startsWith('on') ||
        name === 'srcdoc' ||
        name === 'style' ||
        (urlAttributes.has(name) && unsafeUrl(attribute.value)) ||
        (snapshot &&
          (name.startsWith('data-nv-') ||
            name.startsWith('nv:') ||
            name.startsWith('x-') ||
            name.startsWith('@') ||
            name === 'action' ||
            name === 'formaction' ||
            name === 'autofocus'));
      if (remove) element.removeAttribute(attribute.name);
    }
  }
}
function parseHtml(doc: Document, html: string): DocumentFragment {
  const template = doc.createElement('template');
  template.innerHTML = html;
  return template.content;
}

export function createSnapshotCache(
  options: SnapshotCacheOptions,
): SnapshotCache {
  const scope = checkScope(options.scope);
  const prefix = checkPrefix(options.prefix, 'nv-snapshot');
  const ttl = bounded(options.ttlMs, hour, 1_000, 24 * hour, 'ttlMs');
  const maxBytes = bounded(
    options.maxBytes,
    262_144,
    1_024,
    2_097_152,
    'maxBytes',
  );
  const now = options.now ?? Date.now;
  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      /* Error observers never break degradation. */
    }
  };
  const storage = options.storage ?? defaultStorage('sessionStorage', report);
  const keyFor = (key: string): string =>
    `${prefix}:v1:${scope}:${checkId(key, 'snapshot')}`;
  function read(key: string): { html: string; savedAt: number } | null {
    if (!storage) return null;
    const name = keyFor(key);
    try {
      const raw = storage.getItem(name);
      if (raw === null) return null;
      let parsed: unknown = null;
      try {
        parsed = byteLength(raw) <= maxBytes ? JSON.parse(raw) : null;
      } catch {
        parsed = null;
      }
      const record = plainObject(parsed);
      const savedAt = record?.['savedAt'];
      const expiresAt = record?.['expiresAt'];
      const html = record?.['html'];
      if (
        !record ||
        record['v'] !== 1 ||
        record['scope'] !== scope ||
        record['key'] !== key ||
        typeof html !== 'string' ||
        typeof savedAt !== 'number' ||
        typeof expiresAt !== 'number' ||
        expiresAt <= now() ||
        expiresAt - savedAt > 24 * hour
      ) {
        storage.removeItem(name);
        return null;
      }
      return { html, savedAt };
    } catch (error) {
      report(error);
      return null;
    }
  }
  return Object.freeze({
    remember(key: string, element: Element): void {
      const name = keyFor(key);
      const doc = element.ownerDocument;
      const template = doc.createElement('template');
      for (const child of element.childNodes)
        template.content.append(child.cloneNode(true));
      sanitize(template.content, true);
      const savedAt = now();
      const serialized = JSON.stringify({
        v: 1,
        scope,
        key,
        savedAt,
        expiresAt: savedAt + ttl,
        html: template.innerHTML,
      });
      if (!storage) return;
      try {
        if (byteLength(serialized) > maxBytes) {
          storage.removeItem(name);
          report(new RangeError('Snapshot exceeds the configured size limit'));
          return;
        }
        storage.setItem(name, serialized);
      } catch (error) {
        report(error);
      }
    },
    restore(
      key: string,
      target: Element,
      restoreOptions: { label?: string } = {},
    ): boolean {
      const record = read(key);
      if (!record) return false;
      const doc = target.ownerDocument;
      // Stored HTML is sanitized again: storage is not a trusted channel.
      const content = parseHtml(doc, record.html);
      sanitize(content, true);
      for (const control of content.querySelectorAll(
        'input, select, textarea, button, fieldset',
      ))
        control.setAttribute('disabled', '');
      const label = restoreOptions.label ?? 'Offline copy (read-only)';
      const wrapper = doc.createElement('div');
      wrapper.setAttribute('data-nv-offline-copy', '');
      wrapper.setAttribute('role', 'region');
      wrapper.setAttribute('aria-label', label);
      const banner = doc.createElement('p');
      banner.setAttribute('data-nv-offline-banner', '');
      const saved = new Date(record.savedAt);
      const time = doc.createElement('time');
      time.dateTime = saved.toISOString();
      time.textContent = saved.toLocaleString(doc.documentElement.lang || []);
      banner.append(`${label} `, time);
      const body = doc.createElement('div');
      body.inert = true;
      body.setAttribute('aria-readonly', 'true');
      body.append(content);
      wrapper.append(banner, body);
      target.replaceChildren(wrapper);
      return true;
    },
    clear(key?: string): void {
      if (!storage) return;
      try {
        if (key === undefined)
          removeMatching(storage, prefix, (name) =>
            name.startsWith(`${prefix}:v1:${scope}:`),
          );
        else storage.removeItem(keyFor(key));
      } catch (error) {
        report(error);
      }
    },
  });
}

function samePath(url: unknown, win: Window): URL {
  if (
    typeof url !== 'string' ||
    url.length > 2048 ||
    !url.startsWith('/') ||
    url.startsWith('//') ||
    url.includes('\\') ||
    [...url].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  )
    throw new TypeError('Region URL must be a same-origin absolute path');
  const resolved = new URL(url, win.location.origin);
  if (resolved.origin !== win.location.origin)
    throw new TypeError('Region URL must be same-origin');
  return resolved;
}

/**
 * Fetch a same-origin HTML fragment into `target`. On a network failure, show
 * the last remembered copy as an inert read-only region. HTTP errors (for
 * example 401 after logout) never fall back to a cached copy.
 */
export async function loadRegion(
  target: Element,
  url: string,
  options: LoadRegionOptions,
): Promise<'network' | 'cache' | 'unavailable'> {
  const doc = target.ownerDocument;
  const win = resolveWindow(target, undefined);
  const resolved = samePath(url, win);
  checkId(options.key, 'snapshot');
  const request = options.fetch ?? win.fetch.bind(win);
  let response: Response;
  try {
    response = await request(resolved.href, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'text/html' },
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return options.cache.restore(
      options.key,
      target,
      options.label === undefined ? {} : { label: options.label },
    )
      ? 'cache'
      : 'unavailable';
  }
  const type = response.headers.get('content-type') ?? '';
  if (
    !response.ok ||
    !/^text\/html(?:;|$)/i.test(type) ||
    (response.url && new URL(response.url).origin !== win.location.origin)
  )
    return 'unavailable';
  const html = await response.text();
  if (byteLength(html) > 1_048_576) return 'unavailable';
  const fragment = parseHtml(doc, html);
  sanitize(fragment, false);
  target.replaceChildren(fragment);
  options.cache.remember(options.key, target);
  return 'network';
}
