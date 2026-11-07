/**
 * @nestvexa/offline browser module: identity-scoped, opt-in form drafts, inert
 * read-only HTML snapshots, a reconnect flow that never replays draft forms,
 * and an opt-in queue that replays only server-allowlisted idempotent actions.
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
  /** Offline action queue prefix in `storage`; default `nv-queue`. */
  readonly queuePrefix?: string;
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
    queuePrefix: checkPrefix(options.queuePrefix, 'nv-queue'),
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
    removed += removeMatching(settings.storage, settings.queuePrefix);
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
 * Clear every draft, queued offline action and snapshot in this tab, notify other tabs of the same
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

/** Clear drafts, queued actions and snapshots when another tab announces logout. Returns an unsubscribe function. */
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

/* ------------------------------------------------------------------------ */
/* Offline action queue                                                     */
/* ------------------------------------------------------------------------ */

export type QueueValue = string | number | boolean | null | readonly string[];
export type QueueFields = Readonly<Record<string, QueueValue>>;
/** A server-declared queueable operation (see `offlineActionAllowlist` in `./server`). */
export interface QueuedAction {
  readonly id: string;
  readonly method: 'POST' | 'PUT' | 'PATCH';
  readonly path: string;
  readonly encoding: 'form' | 'action';
  readonly label?: string;
  /** Entries without a literal `true` are ignored: only idempotent operations are queueable. */
  readonly idempotent: true;
}
export type QueueEntryState = 'pending' | 'sending' | 'retrying' | 'failed';
export interface QueueEntry {
  /** Request ID, sent as `Idempotency-Key` on every attempt. */
  readonly id: string;
  readonly action: string;
  /** Server-provided label, or the action id. Plain text. */
  readonly label: string;
  readonly state: QueueEntryState;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly attempts: number;
  /** Last HTTP status of a failed entry. */
  readonly status?: number;
  /** Failure code of a failed entry (server error code, `HTTP_<status>` or `REDIRECT`). */
  readonly code?: string;
}
export type QueueEvent =
  | { readonly type: 'change' }
  | { readonly type: 'queued'; readonly entry: QueueEntry }
  | { readonly type: 'sent'; readonly entry: QueueEntry }
  | { readonly type: 'failed'; readonly entry: QueueEntry }
  | { readonly type: 'expired'; readonly entries: readonly QueueEntry[] }
  | { readonly type: 'discarded'; readonly entry: QueueEntry };
export type OfflineQueueErrorCode =
  | 'NOT_ALLOWLISTED'
  | 'SENSITIVE_FIELD'
  | 'INVALID_FIELDS'
  | 'TOO_LARGE'
  | 'QUEUE_FULL'
  | 'STORAGE'
  | 'CLOSED';
export class OfflineQueueError extends Error {
  readonly code: OfflineQueueErrorCode;
  constructor(code: OfflineQueueErrorCode, message: string) {
    super(message);
    this.name = 'OfflineQueueError';
    this.code = code;
  }
}
export interface OfflineQueueOptions {
  /** Opaque identity hash (`draftScope` in `./server`), shared with drafts. */
  readonly scope: string;
  /**
   * The server allowlist: `<meta name="nv-offline-actions">` content (JSON) or
   * parsed actions. Default: that meta element in `document.head`.
   */
  readonly actions?: string | readonly QueuedAction[];
  readonly window?: Window;
  /** Defaults to `window.localStorage`. */
  readonly storage?: Storage;
  /** Storage key prefix; default `nv-queue`. */
  readonly prefix?: string;
  /** Entry lifetime; default 1 hour, maximum 24 hours. Expired entries are never sent. */
  readonly ttlMs?: number;
  /** Maximum queued entries per identity; default 20, maximum 100. */
  readonly maxEntries?: number;
  /** Serialized bytes per entry; default 16 KiB, maximum 256 KiB. */
  readonly maxBytes?: number;
  /** Current CSRF token, read at each send. Default: `<meta name="nestvexa-csrf" content>`. */
  readonly csrf?: () => string | null | undefined;
  /** Default `x-nestvexa-csrf`. */
  readonly csrfHeader?: string;
  /** Exponential backoff for network errors and transient statuses. */
  readonly retry?: { readonly baseMs?: number; readonly maxMs?: number };
  /** Per-attempt timeout; default 30 seconds. A timeout is retried. */
  readonly timeoutMs?: number;
  /** Send pending entries on creation; default `true`. */
  readonly autoReplay?: boolean;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}
export interface OfflineQueue {
  readonly actions: readonly QueuedAction[];
  canQueue(action: string): boolean;
  /** Persist one call; throws {@link OfflineQueueError}. Call `replay()` to send. */
  enqueue(action: string, fields: QueueFields): QueueEntry;
  list(): readonly QueueEntry[];
  /** Remove a pending or failed entry; an entry being sent cannot be discarded. */
  discard(id: string): boolean;
  /** Return a failed entry to pending (same request ID) and replay. */
  retry(id: string): boolean;
  /** Send pending entries in order with their original request IDs. */
  replay(): Promise<void>;
  /** Remove every entry of this identity. */
  clear(): number;
  subscribe(listener: (event: QueueEvent) => void): () => void;
  dispose(): void;
}

interface QueueRecord {
  readonly id: string;
  readonly action: string;
  readonly order: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly attempts: number;
  readonly state: 'pending' | 'failed';
  readonly status?: number;
  readonly code?: string;
  readonly fields: QueueFields;
}

const queueIdPattern = /^[0-9a-f]{32}$/;
const actionIdPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const actionPathPattern = /^\/(?!\/)[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*$/;
const codePattern = /^[A-Z][A-Z0-9_]{0,63}$/;
const secretWords = new Set([
  'password',
  'passwd',
  'passphrase',
  'pwd',
  'pass',
  'secret',
  'token',
  'csrf',
  'xsrf',
  'otp',
  'totp',
  'pin',
  'cvc',
  'cvv',
  'ssn',
  'iban',
  'card',
  'cardnumber',
  'auth',
  'authorization',
  'bearer',
  'jwt',
  'session',
  'cookie',
  'nonce',
  'credential',
  'credentials',
  'apikey',
  'signature',
]);
const transientStatuses = new Set([408, 425, 429, 502, 503, 504]);

function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}
/** Field names that look like credentials, tokens or payment data. */
function secretName(name: string): boolean {
  const parts = nameWords(name);
  return (
    parts.some((part) => secretWords.has(part)) ||
    /apikey|privatekey|accesskey|secretkey|clientsecret/.test(parts.join(''))
  );
}
function csrfName(name: string): boolean {
  const parts = nameWords(name);
  return (
    parts.includes('csrf') ||
    parts.includes('xsrf') ||
    name === '_token' ||
    name === 'authenticity_token'
  );
}
function queueValue(value: unknown): QueueValue | undefined {
  if (typeof value === 'string' || typeof value === 'boolean' || value === null)
    return value;
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : undefined;
  if (
    Array.isArray(value) &&
    value.length <= maxArray &&
    value.every((item) => typeof item === 'string')
  )
    return Object.freeze([...(value as string[])]);
  return undefined;
}
/** Validated, frozen copy; throws for secret-looking names or invalid values. */
function copyQueueFields(value: unknown): QueueFields {
  const source = plainObject(value);
  if (!source)
    throw new OfflineQueueError(
      'INVALID_FIELDS',
      'Fields must be a plain object',
    );
  const keys = Object.keys(source);
  if (keys.length > maxFields)
    throw new OfflineQueueError('INVALID_FIELDS', 'Too many fields');
  const output = Object.create(null) as Record<string, QueueValue>;
  for (const key of keys) {
    if (!fieldPattern.test(key) || forbiddenNames.has(key))
      throw new OfflineQueueError('INVALID_FIELDS', 'Invalid field name');
    if (secretName(key))
      throw new OfflineQueueError(
        'SENSITIVE_FIELD',
        'Passwords, tokens, CSRF values and payment data are never queued',
      );
    const item = queueValue(source[key]);
    if (item === undefined)
      throw new OfflineQueueError('INVALID_FIELDS', 'Invalid field value');
    output[key] = item;
  }
  return Object.freeze(output);
}
function parseQueuedActions(
  source: string | readonly QueuedAction[] | null | undefined,
): ReadonlyMap<string, QueuedAction> {
  let list: unknown = source;
  if (typeof source === 'string') {
    try {
      const parsed = plainObject(JSON.parse(source));
      list = parsed?.['v'] === 1 ? parsed['actions'] : undefined;
    } catch {
      list = undefined;
    }
  }
  const actions = new Map<string, QueuedAction>();
  if (!Array.isArray(list)) return actions;
  for (const item of list.slice(0, 64) as unknown[]) {
    const record = plainObject(item);
    // Only operations the server declared idempotent are queueable.
    if (!record || record['idempotent'] !== true) continue;
    const id = record['id'];
    const path = record['path'];
    const method = record['method'] ?? 'POST';
    const encoding = record['encoding'] ?? 'form';
    const label = record['label'];
    if (
      typeof id !== 'string' ||
      id.length > 64 ||
      !actionIdPattern.test(id) ||
      actions.has(id) ||
      typeof path !== 'string' ||
      path.length > 2048 ||
      !actionPathPattern.test(path) ||
      (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') ||
      (encoding !== 'form' && encoding !== 'action') ||
      (label !== undefined &&
        (typeof label !== 'string' || label.length === 0 || label.length > 200))
    )
      continue;
    actions.set(
      id,
      Object.freeze({
        id,
        path,
        method,
        encoding,
        ...(label === undefined ? {} : { label }),
        idempotent: true as const,
      }),
    );
  }
  return actions;
}
function requestId(win: Window): string {
  const bytes = new Uint8Array(16);
  win.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
/** Bounded read of a failure body's machine code (`error.code` / `error.reason`). */
async function failureCode(
  response: Response,
): Promise<{ code?: string; reason?: string }> {
  try {
    const text = await response.text();
    if (text.length > 65_536) return {};
    const body = plainObject(JSON.parse(text));
    const error = plainObject(body?.['error']);
    const code = error?.['code'];
    const reason = error?.['reason'];
    return {
      ...(typeof code === 'string' && codePattern.test(code) ? { code } : {}),
      ...(typeof reason === 'string' && codePattern.test(reason)
        ? { reason }
        : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Identity-scoped, bounded, expiring queue of server-allowlisted idempotent
 * operations. Entries replay in order with their original request ID; the
 * first non-retryable failure halts the queue until the user discards or
 * retries it. CSRF tokens are never stored: the current one is read per send.
 */
export function createOfflineQueue(options: OfflineQueueOptions): OfflineQueue {
  const scope = checkScope(options.scope);
  const win = resolveWindow(undefined, options.window);
  const prefix = checkPrefix(options.prefix, 'nv-queue');
  const ttl = bounded(options.ttlMs, hour, 1_000, 24 * hour, 'ttlMs');
  const maxEntries = bounded(options.maxEntries, 20, 1, 100, 'maxEntries');
  const maxBytes = bounded(options.maxBytes, 16_384, 256, 262_144, 'maxBytes');
  const baseMs = bounded(
    options.retry?.baseMs,
    1_000,
    10,
    60_000,
    'retry.baseMs',
  );
  const maxMs = bounded(
    options.retry?.maxMs,
    Math.max(60_000, baseMs),
    baseMs,
    600_000,
    'retry.maxMs',
  );
  const timeoutMs = bounded(
    options.timeoutMs,
    30_000,
    1_000,
    120_000,
    'timeoutMs',
  );
  const csrfHeader = options.csrfHeader ?? 'x-nestvexa-csrf';
  if (!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(csrfHeader))
    fail('Invalid CSRF header name');
  const now = options.now ?? Date.now;
  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      /* Error observers never break the queue. */
    }
  };
  const storage = options.storage ?? defaultStorage('localStorage', report);
  const actions = parseQueuedActions(
    options.actions ??
      win.document.head
        .querySelector('meta[name="nv-offline-actions"]')
        ?.getAttribute('content'),
  );
  const request = options.fetch ?? win.fetch.bind(win);
  const readCsrf =
    options.csrf ??
    (() =>
      win.document
        .querySelector('meta[name="nestvexa-csrf"]')
        ?.getAttribute('content'));
  const own = `${prefix}:v1:${scope}:`;
  const listeners = new Set<(event: QueueEvent) => void>();
  const transient = new Map<string, 'sending' | 'retrying'>();
  const nextAttempt = new Map<string, number>();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let rerun = false;
  let closed = false;

  function emit(event: QueueEvent): void {
    for (const listener of [...listeners])
      try {
        listener(event);
      } catch (error) {
        report(error);
      }
  }
  function entryOf(record: QueueRecord): QueueEntry {
    return Object.freeze({
      id: record.id,
      action: record.action,
      label: actions.get(record.action)?.label ?? record.action,
      state: transient.get(record.id) ?? record.state,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      attempts: record.attempts,
      ...(record.status === undefined ? {} : { status: record.status }),
      ...(record.code === undefined ? {} : { code: record.code }),
    });
  }
  function serialize(record: QueueRecord): string {
    return JSON.stringify({ v: 1, scope, ...record });
  }
  /** Storage is not a trusted channel: every field is revalidated on read. */
  function parse(id: string, raw: string): QueueRecord | null {
    if (byteLength(raw) > maxBytes) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
    const record = plainObject(value);
    if (!record || record['v'] !== 1 || record['scope'] !== scope) return null;
    const action = record['action'];
    const order = record['order'];
    const createdAt = record['createdAt'];
    const expiresAt = record['expiresAt'];
    const attempts = record['attempts'];
    const state = record['state'];
    const status = record['status'];
    const code = record['code'];
    if (
      record['id'] !== id ||
      typeof action !== 'string' ||
      !actionIdPattern.test(action) ||
      typeof order !== 'number' ||
      !Number.isSafeInteger(order) ||
      typeof createdAt !== 'number' ||
      typeof expiresAt !== 'number' ||
      !Number.isFinite(createdAt) ||
      !Number.isFinite(expiresAt) ||
      expiresAt - createdAt > 24 * hour ||
      createdAt > now() + 60_000 ||
      typeof attempts !== 'number' ||
      !Number.isSafeInteger(attempts) ||
      attempts < 0 ||
      (state !== 'pending' && state !== 'failed') ||
      (status !== undefined &&
        (typeof status !== 'number' || !Number.isSafeInteger(status))) ||
      (code !== undefined &&
        (typeof code !== 'string' || !codePattern.test(code)))
    )
      return null;
    let fields: QueueFields;
    try {
      fields = copyQueueFields(record['fields']);
    } catch {
      return null;
    }
    return Object.freeze({
      id,
      action,
      order,
      createdAt,
      expiresAt,
      attempts,
      state,
      ...(status === undefined ? {} : { status }),
      ...(code === undefined ? {} : { code }),
      fields,
    });
  }
  function load(): QueueRecord[] {
    if (!storage) return [];
    const records: QueueRecord[] = [];
    const expired: QueueRecord[] = [];
    try {
      for (const key of storageKeys(storage)) {
        if (!key.startsWith(own)) continue;
        const id = key.slice(own.length);
        const raw = storage.getItem(key);
        if (raw === null) continue;
        const record = queueIdPattern.test(id) ? parse(id, raw) : null;
        if (!record) storage.removeItem(key);
        else if (record.expiresAt <= now()) {
          storage.removeItem(key);
          expired.push(record);
        } else records.push(record);
      }
    } catch (error) {
      report(error);
    }
    records.sort(
      (a, b) =>
        a.order - b.order ||
        a.createdAt - b.createdAt ||
        (a.id < b.id ? -1 : 1),
    );
    for (const record of expired) {
      transient.delete(record.id);
      nextAttempt.delete(record.id);
    }
    if (expired.length)
      emit({ type: 'expired', entries: Object.freeze(expired.map(entryOf)) });
    armExpiry(records);
    return records;
  }
  function armExpiry(records: readonly QueueRecord[]): void {
    if (expiryTimer !== undefined) win.clearTimeout(expiryTimer);
    expiryTimer = undefined;
    if (closed || !records.length) return;
    const earliest = Math.min(...records.map((record) => record.expiresAt));
    expiryTimer = win.setTimeout(
      () => {
        expiryTimer = undefined;
        if (!closed) load();
      },
      Math.min(Math.max(earliest - now(), 0) + 5, 2_147_483_647),
    );
  }
  function find(id: string): QueueRecord | undefined {
    return load().find((record) => record.id === id);
  }
  function write(record: QueueRecord): void {
    try {
      storage?.setItem(`${own}${record.id}`, serialize(record));
    } catch (error) {
      report(error);
    }
  }
  function remove(id: string): void {
    try {
      storage?.removeItem(`${own}${id}`);
    } catch (error) {
      report(error);
    }
    transient.delete(id);
    nextAttempt.delete(id);
  }
  function schedule(delay: number): void {
    if (retryTimer !== undefined) win.clearTimeout(retryTimer);
    retryTimer = win.setTimeout(() => {
      retryTimer = undefined;
      void replay();
    }, delay);
  }
  async function send(
    record: QueueRecord,
    action: QueuedAction,
  ): Promise<{
    readonly kind: 'sent' | 'retry' | 'failed';
    readonly status?: number;
    readonly code: string;
  }> {
    const headers = new Headers({
      Accept: 'application/json',
      'Idempotency-Key': record.id,
      'X-Nestvexa-Offline-Scope': scope,
    });
    let token: string | null | undefined;
    try {
      token = readCsrf();
    } catch (error) {
      report(error);
    }
    if (typeof token === 'string' && token) headers.set(csrfHeader, token);
    let body: string;
    if (action.encoding === 'form') {
      const params = new URLSearchParams();
      for (const [name, value] of Object.entries(record.fields)) {
        if (value === null) continue;
        if (Array.isArray(value))
          for (const item of value as readonly string[])
            params.append(name, item);
        else params.append(name, String(value));
      }
      body = params.toString();
      headers.set(
        'Content-Type',
        'application/x-www-form-urlencoded;charset=UTF-8',
      );
    } else {
      body = JSON.stringify({ input: record.fields });
      headers.set('Content-Type', 'application/json');
    }
    const controller = new AbortController();
    const timer = win.setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await request(new URL(action.path, win.location.origin).href, {
        method: action.method,
        headers,
        body,
        credentials: 'same-origin',
        redirect: 'manual',
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch {
      return { kind: 'retry', code: 'NETWORK' };
    } finally {
      win.clearTimeout(timer);
    }
    const status = response.status;
    // Redirects (for example to a login page) are never taken as success.
    if (response.type === 'opaqueredirect')
      return { kind: 'failed', code: 'REDIRECT' };
    if (status >= 300 && status < 400)
      return { kind: 'failed', status, code: 'REDIRECT' };
    if (response.ok) return { kind: 'sent', status, code: 'SENT' };
    const failure = await failureCode(response);
    const inProgress =
      status === 409 &&
      (failure.code === 'OFFLINE_IN_PROGRESS' ||
        failure.reason === 'IDEMPOTENCY_IN_PROGRESS');
    return {
      kind: transientStatuses.has(status) || inProgress ? 'retry' : 'failed',
      status,
      code: failure.code ?? `HTTP_${String(status)}`,
    };
  }
  async function drain(): Promise<void> {
    while (!closed) {
      const head = load()[0];
      if (!head || head.state === 'failed') return;
      // Unknown on this page: keep it and keep the order; never guess a route.
      const action = actions.get(head.action);
      if (!action) return;
      const wait = (nextAttempt.get(head.id) ?? 0) - now();
      if (wait > 0) {
        schedule(wait);
        return;
      }
      if (win.navigator.onLine === false) return;
      transient.set(head.id, 'sending');
      emit({ type: 'change' });
      const result = await send(head, action);
      transient.delete(head.id);
      if (closed) return;
      const current = find(head.id);
      if (result.kind === 'sent') {
        remove(head.id);
        emit({ type: 'sent', entry: entryOf(current ?? head) });
        continue;
      }
      if (!current) continue;
      if (result.kind === 'retry') {
        const attempts = current.attempts + 1;
        write({ ...current, attempts });
        const delay = Math.min(maxMs, baseMs * 2 ** Math.min(attempts - 1, 20));
        nextAttempt.set(head.id, now() + delay);
        transient.set(head.id, 'retrying');
        emit({ type: 'change' });
        schedule(delay);
        return;
      }
      const failed: QueueRecord = {
        ...current,
        attempts: current.attempts + 1,
        state: 'failed',
        ...(result.status === undefined ? {} : { status: result.status }),
        code: result.code,
      };
      write(failed);
      nextAttempt.delete(head.id);
      emit({ type: 'failed', entry: entryOf(failed) });
      return;
    }
  }
  async function locked(run: () => Promise<void>): Promise<void> {
    const locks = Reflect.get(win.navigator, 'locks') as
      LockManager | undefined;
    if (!locks || typeof locks.request !== 'function') return run();
    // One tab replays at a time; the server dedupes request IDs regardless.
    let acquired = false;
    await locks.request(
      `${prefix}:replay:${scope}`,
      { ifAvailable: true },
      async (lock) => {
        if (!lock) return;
        acquired = true;
        await run();
      },
    );
    if (!acquired && !closed) schedule(baseMs);
  }
  function replay(): Promise<void> {
    if (closed) return Promise.resolve();
    if (running) {
      rerun = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          rerun = false;
          await locked(drain);
        } while (rerun && !closed);
      } catch (error) {
        report(error);
      } finally {
        running = undefined;
      }
    })();
    return running;
  }
  function stop(): void {
    closed = true;
    if (retryTimer !== undefined) win.clearTimeout(retryTimer);
    if (expiryTimer !== undefined) win.clearTimeout(expiryTimer);
    retryTimer = undefined;
    expiryTimer = undefined;
    transient.clear();
    nextAttempt.clear();
    win.removeEventListener('online', onOnline);
    win.removeEventListener('storage', onStorage);
    win.removeEventListener('nestvexa:logout', onLogout);
  }
  function clearOwn(): number {
    if (!storage) return 0;
    try {
      return removeMatching(storage, prefix, (key) => key.startsWith(own));
    } catch (error) {
      report(error);
      return 0;
    }
  }
  const onOnline = (): void => {
    nextAttempt.clear();
    transient.clear();
    void replay();
  };
  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key.startsWith(own))
      emit({ type: 'change' });
  };
  const onLogout = (): void => {
    clearOwn();
    stop();
    emit({ type: 'change' });
  };
  win.addEventListener('online', onOnline);
  win.addEventListener('storage', onStorage);
  win.addEventListener('nestvexa:logout', onLogout);
  // Another identity's entries on this device are never sent: purge them.
  if (storage)
    try {
      removeMatching(storage, prefix, (key) => !key.startsWith(own));
    } catch (error) {
      report(error);
    }
  load();
  const queue: OfflineQueue = Object.freeze({
    actions: Object.freeze([...actions.values()]),
    canQueue: (action: string) => !closed && actions.has(action),
    enqueue(action: string, fields: QueueFields): QueueEntry {
      if (closed)
        throw new OfflineQueueError('CLOSED', 'The offline queue is closed');
      if (typeof action !== 'string' || !actions.has(action))
        throw new OfflineQueueError(
          'NOT_ALLOWLISTED',
          'Only operations the server declared idempotent can be queued',
        );
      const copy = copyQueueFields(fields);
      if (!storage)
        throw new OfflineQueueError('STORAGE', 'Storage is unavailable');
      const records = load();
      if (records.length >= maxEntries)
        throw new OfflineQueueError('QUEUE_FULL', 'The offline queue is full');
      const createdAt = now();
      const record: QueueRecord = Object.freeze({
        id: requestId(win),
        action,
        order: records.reduce((max, item) => Math.max(max, item.order), 0) + 1,
        createdAt,
        expiresAt: createdAt + ttl,
        attempts: 0,
        state: 'pending',
        fields: copy,
      });
      const serialized = serialize(record);
      if (byteLength(serialized) > maxBytes)
        throw new OfflineQueueError(
          'TOO_LARGE',
          'The entry exceeds the configured size limit',
        );
      try {
        storage.setItem(`${own}${record.id}`, serialized);
      } catch (error) {
        report(error);
        throw new OfflineQueueError('STORAGE', 'The entry could not be stored');
      }
      armExpiry([...records, record]);
      const entry = entryOf(record);
      emit({ type: 'queued', entry });
      return entry;
    },
    list: () => Object.freeze(load().map(entryOf)),
    discard(id: string): boolean {
      if (transient.get(id) === 'sending') return false;
      const record = find(id);
      if (!record) return false;
      remove(id);
      emit({ type: 'discarded', entry: entryOf(record) });
      void replay();
      return true;
    },
    retry(id: string): boolean {
      const record = find(id);
      if (!record || record.state !== 'failed' || closed) return false;
      write({
        id: record.id,
        action: record.action,
        order: record.order,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        attempts: 0,
        state: 'pending',
        fields: record.fields,
      });
      emit({ type: 'change' });
      void replay();
      return true;
    },
    replay,
    clear(): number {
      const removed = clearOwn();
      transient.clear();
      nextAttempt.clear();
      emit({ type: 'change' });
      return removed;
    },
    subscribe(listener: (event: QueueEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose(): void {
      stop();
      listeners.clear();
    },
  });
  if (options.autoReplay !== false) void replay();
  return queue;
}

/* ------------------------------------------------------------------------ */
/* Queue status region and list                                             */
/* ------------------------------------------------------------------------ */

export interface QueueMessages {
  readonly pending?: string;
  readonly sending?: string;
  readonly failed?: string;
  readonly sent?: string;
  readonly expired?: string;
  readonly refused?: string;
  readonly discarded?: string;
}
export interface QueueLabels {
  readonly pending?: string;
  readonly sending?: string;
  readonly retrying?: string;
  readonly failed?: string;
  readonly discard?: string;
  readonly retry?: string;
}
export interface AttachQueueOptions {
  readonly queue: OfflineQueue;
  readonly messages?: QueueMessages;
  readonly labels?: QueueLabels;
}
const defaultQueueMessages = Object.freeze({
  pending: 'Saved on this device and waiting to be sent: {count}.',
  sending: 'Sending saved changes: {count} left.',
  failed:
    'A saved change could not be sent and the rest are on hold. Review it below.',
  sent: 'All saved changes were sent.',
  expired: 'Unsent changes expired and were removed from this device: {count}.',
  refused:
    'This form cannot be saved on this device for later, so it was submitted directly.',
  discarded: 'The saved change was discarded and will not be sent.',
});
const defaultQueueLabels = Object.freeze({
  pending: 'Waiting',
  sending: 'Sending',
  retrying: 'Waiting to retry',
  failed: 'Not sent',
  discard: 'Discard',
  retry: 'Try again',
});

/**
 * Form values for the queue. CSRF fields and `data-nv-queue-never` fields are
 * dropped (the current token is sent at replay time); a password, file,
 * payment, one-time-code, secret-named or `data-nv-sensitive` field with a
 * value refuses the whole form, because sending it without that field would
 * change its meaning.
 */
function queueFormFields(
  form: HTMLFormElement,
): Record<string, string | string[]> | null {
  const values = new Map<string, string[]>();
  for (const element of form.elements) {
    if (!isField(element) || !element.name || element.disabled) continue;
    if (
      element instanceof HTMLInputElement &&
      ['submit', 'button', 'reset', 'image'].includes(element.type)
    )
      continue;
    const name = element.name;
    if (csrfName(name) || element.hasAttribute('data-nv-queue-never')) continue;
    let collected: string[];
    let filled: boolean;
    if (element instanceof HTMLSelectElement) {
      collected = [...element.selectedOptions].map((option) => option.value);
      filled = collected.length > 0;
    } else if (
      element instanceof HTMLInputElement &&
      (element.type === 'checkbox' || element.type === 'radio')
    ) {
      collected = element.checked ? [element.value] : [];
      filled = element.checked;
    } else if (element instanceof HTMLInputElement && element.type === 'file') {
      collected = [];
      filled = (element.files?.length ?? 0) > 0;
    } else {
      collected = [element.value];
      filled = element.value !== '';
    }
    const sensitive =
      (element instanceof HTMLInputElement &&
        (element.type === 'password' || element.type === 'file')) ||
      element.hasAttribute('data-nv-sensitive') ||
      sensitiveAutocomplete.test(element.getAttribute('autocomplete') ?? '') ||
      secretName(name);
    if (sensitive) {
      if (filled) return null;
      continue;
    }
    if (!fieldPattern.test(name) || forbiddenNames.has(name)) return null;
    const existing = values.get(name);
    if (existing) existing.push(...collected);
    else if (collected.length) values.set(name, collected);
  }
  const fields = Object.create(null) as Record<string, string | string[]>;
  for (const [name, list] of values)
    fields[name] = list.length === 1 ? (list[0] ?? '') : list;
  return fields;
}

/**
 * Wire `form[data-nv-queue="<action>"]` submits into the queue and render the
 * queue into `[data-nv-queue-status]` (text only) and `[data-nv-queue-list]`
 * (one item per entry with a Discard button, and Try again when failed).
 */
export function attachOfflineQueue(
  root: Element | Document,
  options: AttachQueueOptions,
): OfflineController {
  const win = resolveWindow(root, undefined);
  const doc = root instanceof Document ? root : root.ownerDocument;
  const queue = options.queue;
  let notice: {
    kind: keyof typeof defaultQueueMessages;
    count: number;
  } | null = null;
  let disposed = false;
  const inRoot = (node: Node): boolean =>
    node.isConnected && (node === root || root.contains(node));

  function text(
    element: Element,
    kind: keyof typeof defaultQueueMessages,
    count: number,
  ): string {
    const template =
      (count === 1
        ? element.getAttribute(`data-nv-queue-message-${kind}-one`)
        : null) ??
      element.getAttribute(`data-nv-queue-message-${kind}`) ??
      options.messages?.[kind] ??
      defaultQueueMessages[kind];
    return template.replaceAll('{count}', String(count));
  }
  function label(
    element: Element,
    kind: keyof typeof defaultQueueLabels,
  ): string {
    return (
      element.getAttribute(`data-nv-queue-label-${kind}`) ??
      options.labels?.[kind] ??
      defaultQueueLabels[kind]
    );
  }
  function button(
    list: Element,
    kind: 'discard' | 'retry',
    entry: QueueEntry,
  ): HTMLButtonElement {
    const control = doc.createElement('button');
    control.type = 'button';
    control.setAttribute(`data-nv-queue-${kind}`, entry.id);
    const visible = label(list, kind);
    control.textContent = visible;
    // Starts with the visible text (WCAG 2.5.3) and names the entry.
    control.setAttribute('aria-label', `${visible}: ${entry.label}`);
    if (entry.state === 'sending') control.disabled = true;
    return control;
  }
  function renderList(list: Element, entries: readonly QueueEntry[]): void {
    const active = doc.activeElement;
    const focusKind =
      active && list.contains(active)
        ? active.hasAttribute('data-nv-queue-retry')
          ? 'retry'
          : 'discard'
        : undefined;
    const focusId =
      focusKind && active
        ? active.getAttribute(`data-nv-queue-${focusKind}`)
        : null;
    const focusIndex = [...list.children].findIndex(
      (item) => active !== null && item.contains(active),
    );
    const items = entries.map((entry) => {
      const item = doc.createElement('li');
      item.setAttribute('data-nv-queue-entry', entry.id);
      item.setAttribute('data-nv-queue-entry-state', entry.state);
      if (entry.code !== undefined)
        item.setAttribute('data-nv-queue-entry-code', entry.code);
      const name = doc.createElement('span');
      name.setAttribute('data-nv-queue-entry-label', '');
      name.textContent = entry.label;
      const state = doc.createElement('span');
      state.setAttribute('data-nv-queue-entry-status', '');
      state.textContent = label(list, entry.state);
      const created = new Date(entry.createdAt);
      const time = doc.createElement('time');
      time.dateTime = created.toISOString();
      time.textContent = created.toLocaleTimeString(
        doc.documentElement.lang || [],
      );
      item.append(name, ' ', state, ' ', time, ' ');
      if (entry.state === 'failed')
        item.append(button(list, 'retry', entry), ' ');
      item.append(button(list, 'discard', entry));
      return item;
    });
    list.replaceChildren(...items);
    if (focusKind === undefined) return;
    // Keep keyboard focus in the list across re-renders and removals.
    const same =
      focusId === null
        ? null
        : list.querySelector(`[data-nv-queue-${focusKind}="${focusId}"]`);
    const fallback =
      items[Math.min(Math.max(focusIndex, 0), items.length - 1)]?.querySelector(
        '[data-nv-queue-discard]',
      ) ?? null;
    const target = same ?? fallback;
    if (target instanceof HTMLElement) target.focus();
    else if (list instanceof HTMLElement) {
      if (!list.hasAttribute('tabindex')) list.setAttribute('tabindex', '-1');
      list.focus();
    }
  }
  function render(): void {
    if (disposed) return;
    const entries = queue.list();
    const failed = entries.some((entry) => entry.state === 'failed');
    const sending = entries.some((entry) => entry.state === 'sending');
    const state = failed
      ? 'failed'
      : sending
        ? 'sending'
        : entries.length
          ? 'pending'
          : 'idle';
    for (const status of root.querySelectorAll('[data-nv-queue-status]')) {
      if (!status.hasAttribute('role') && !status.hasAttribute('aria-live'))
        status.setAttribute('role', 'status');
      const parts: string[] = [];
      if (notice) parts.push(text(status, notice.kind, notice.count));
      if (state !== 'idle') parts.push(text(status, state, entries.length));
      const next = parts.join(' ');
      // Rewriting identical text would make some screen readers repeat it.
      if (status.textContent !== next) status.textContent = next;
      status.setAttribute('data-nv-queue-state', state);
      status.setAttribute('data-nv-queue-count', String(entries.length));
    }
    for (const list of root.querySelectorAll('[data-nv-queue-list]'))
      renderList(list, entries);
  }
  const unsubscribe = queue.subscribe((event) => {
    if (event.type === 'expired')
      notice = { kind: 'expired', count: event.entries.length };
    else if (event.type === 'discarded')
      notice = { kind: 'discarded', count: 1 };
    else if (event.type === 'sent')
      notice = queue.list().length ? null : { kind: 'sent', count: 0 };
    else if (event.type === 'queued') notice = null;
    render();
  });
  function refuse(form: HTMLFormElement): void {
    form.setAttribute('data-nv-queue-state', 'refused');
    notice = { kind: 'refused', count: 0 };
    render();
  }
  const onSubmit = (event: Event): void => {
    const form = event.target;
    if (
      disposed ||
      !(form instanceof HTMLFormElement) ||
      !form.hasAttribute('data-nv-queue') ||
      !inRoot(form)
    )
      return;
    const id = form.getAttribute('data-nv-queue') ?? '';
    const action = queue.actions.find((item) => item.id === id);
    // Anything the server did not allowlist submits natively, never queued.
    if (!action || !queue.canQueue(id)) {
      refuse(form);
      return;
    }
    // `form.action` can be shadowed by a field named "action"; read the attribute.
    const target = form.getAttribute('action');
    if (
      target !== null &&
      new URL(target, win.location.href).pathname !== action.path
    ) {
      refuse(form);
      return;
    }
    const fields = queueFormFields(form);
    if (!fields) {
      refuse(form);
      return;
    }
    try {
      queue.enqueue(id, fields);
    } catch {
      refuse(form);
      return;
    }
    event.preventDefault();
    form.reset();
    form.setAttribute('data-nv-queue-state', 'queued');
    void queue.replay();
  };
  const onClick = (event: Event): void => {
    const target = event.target;
    if (disposed || !(target instanceof Element)) return;
    const control = target.closest(
      '[data-nv-queue-discard], [data-nv-queue-retry]',
    );
    if (!control || !inRoot(control)) return;
    const discard = control.getAttribute('data-nv-queue-discard');
    const retry = control.getAttribute('data-nv-queue-retry');
    if (discard !== null) queue.discard(discard);
    else if (retry !== null) {
      notice = null;
      queue.retry(retry);
    }
  };
  root.addEventListener('submit', onSubmit, true);
  root.addEventListener('click', onClick);
  render();
  return Object.freeze({
    refresh: render,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      root.removeEventListener('submit', onSubmit, true);
      root.removeEventListener('click', onClick);
    },
  });
}
