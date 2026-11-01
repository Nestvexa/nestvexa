import { LiveClientError, parseIdentifier } from './grammar.js';

/** Trusted static same-origin upload API prefix, e.g. `/_nestvexa/uploads`. */
export interface UploadEndpoint {
  readonly endpoint: string;
}
/** `nv:upload="field"` on a file input; `.progress`, `.status`, `.cancel` name the same field. */
export interface UploadDirective {
  readonly kind: 'upload';
  readonly role: 'input' | 'progress' | 'status' | 'cancel';
  readonly field: string;
}
export interface UploadComponent {
  readonly root: Element;
  readonly name: string;
  readonly csrf: string;
}
export interface UploadControllerOptions {
  readonly root: Document | Element;
  readonly window: Window & typeof globalThis;
  readonly endpoint: string | undefined;
  readonly component: (element: Element) => UploadComponent | undefined;
  readonly set: (element: Element, field: string, value: string) => void;
  readonly onError: (error: unknown, element: Element) => void;
}
export interface UploadController {
  start(input: Element): Promise<readonly string[]>;
  cancel(element: Element): void;
  dispose(): void;
}

const roles = {
  'nv:upload': 'input',
  'nv:upload.progress': 'progress',
  'nv:upload.status': 'status',
  'nv:upload.cancel': 'cancel',
} as const;
const tags = {
  input: 'INPUT',
  progress: 'PROGRESS',
  cancel: 'BUTTON',
} as const;
const sessionPattern = /^nvs_[A-Za-z0-9_-]{43}$/;
const tokenPattern = /^nvu_[A-Za-z0-9_-]{43}$/;
const messages: Record<string, string> = {
  FILE_TOO_LARGE: 'The file is too large.',
  EMPTY_FILE: 'The file is empty.',
  QUOTA_EXCEEDED: 'Upload limit reached.',
  TOO_MANY_FILES: 'Upload limit reached.',
  INVALID_FILENAME: 'The file name is not allowed.',
  MISSING_EXTENSION: 'The file name is not allowed.',
};

function invalid(message: string): never {
  throw new LiveClientError('DIRECTIVE', message);
}
/** Closed grammar: a field name, never a URL, purpose, expression or action. */
export function parseUploadDirective(
  name: string,
  value: string,
): UploadDirective {
  const role = Object.hasOwn(roles, name)
    ? roles[name as keyof typeof roles]
    : undefined;
  if (!role) invalid('Unsupported upload directive or modifier');
  return { kind: 'upload', role, field: parseIdentifier(value) };
}
function declaration(element: Element): UploadDirective | undefined {
  const attributes = [...element.attributes].filter((attribute) =>
    /^nv:upload(?:\.|$)/.test(attribute.name),
  );
  const first = attributes[0];
  if (!first) return undefined;
  if (attributes.length !== 1) invalid('An element takes one upload directive');
  return parseUploadDirective(first.name, first.value);
}
/** Detach a trusted `{ endpoint }` option. */
export function copyUploadEndpoint(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const plain =
    !!value &&
    typeof value === 'object' &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === 1;
  const descriptor = plain
    ? Object.getOwnPropertyDescriptor(value, 'endpoint')
    : undefined;
  const endpoint: unknown =
    descriptor && 'value' in descriptor ? descriptor.value : undefined;
  if (
    typeof endpoint !== 'string' ||
    !/^\/[A-Za-z0-9_\-/]{0,255}$/.test(endpoint) ||
    endpoint.includes('//')
  )
    invalid('Uploads require a same-origin { endpoint: "/path" } option');
  return endpoint.replace(/\/$/, '');
}
function scoped(root: Element, element: Element): boolean {
  return element.closest('[data-nv-component]') === root;
}
/** Validate owned upload markup without network activity. */
export function validateUploads(root: Element, configured: boolean): void {
  const inputs = new Set<string>();
  for (const element of [root, ...root.querySelectorAll('*')]) {
    if (!scoped(root, element)) continue;
    const directive = declaration(element);
    if (!directive) continue;
    if (!configured)
      invalid('nv:upload requires a configured uploads endpoint');
    const role = directive.role;
    if (
      element === root ||
      (role !== 'status' && element.tagName !== tags[role]) ||
      (role === 'input' &&
        ((element as HTMLInputElement).type !== 'file' ||
          inputs.has(directive.field) ||
          [...element.attributes].some((attribute) =>
            attribute.name.startsWith('nv:model'),
          ))) ||
      (role === 'cancel' && (element as HTMLButtonElement).type !== 'button') ||
      (role === 'status' &&
        (element.children.length > 0 ||
          [
            'INPUT',
            'TEXTAREA',
            'SELECT',
            'BUTTON',
            'A',
            'SCRIPT',
            'STYLE',
          ].includes(element.tagName)))
    )
      invalid(
        'nv:upload needs one owned file input per field, a <progress>, a type="button" cancel and a text-only status',
      );
    if (role === 'input') inputs.add(directive.field);
  }
}

class UploadFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
interface Batch {
  aborted: boolean;
  xhr?: XMLHttpRequest;
  /** Rejects the in-flight request even if the browser never fires `abort`. */
  stop?: () => void;
  session?: string | undefined;
  readonly tokens: string[];
}
interface Response {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

export function createUploadController(
  options: UploadControllerOptions,
): UploadController {
  const { window, endpoint } = options;
  const active = new Map<Element, Batch>();
  const completed = new Map<Element, readonly string[]>();
  let disposed = false;
  function fieldOf(element: Element, role: UploadDirective['role']): string {
    const directive = declaration(element);
    if (!directive || directive.role !== role)
      invalid('Element has no matching upload directive');
    return directive.field;
  }
  function elements(
    root: Element,
    field: string,
    role: UploadDirective['role'],
  ): Element[] {
    return [...root.querySelectorAll('*')].filter((element) => {
      const directive = scoped(root, element)
        ? declaration(element)
        : undefined;
      return directive?.role === role && directive.field === field;
    });
  }
  function report(
    root: Element,
    field: string,
    message: string,
    loaded?: number,
    total?: number,
  ): void {
    for (const element of elements(root, field, 'status'))
      element.textContent = message;
    if (total === undefined || loaded === undefined) return;
    for (const element of elements(root, field, 'progress')) {
      const progress = element as HTMLProgressElement;
      progress.max = Math.max(total, 1);
      progress.value = Math.min(loaded, progress.max);
    }
  }
  function send(
    batch: Batch,
    component: UploadComponent,
    method: string,
    url: string,
    headers: Readonly<Record<string, string>>,
    body: Document | XMLHttpRequestBodyInit | null,
    progress?: (loaded: number) => void,
    sameOrigin = true,
  ): Promise<Response> {
    return new Promise((resolve, reject) => {
      if (batch.aborted || disposed)
        return reject(new UploadFailure('ABORTED'));
      const xhr = new window.XMLHttpRequest();
      batch.xhr = xhr;
      batch.stop = () => reject(new UploadFailure('ABORTED'));
      xhr.open(method, url);
      xhr.timeout = 120_000;
      if (sameOrigin) xhr.setRequestHeader('x-nestvexa-csrf', component.csrf);
      for (const [name, value] of Object.entries(headers))
        xhr.setRequestHeader(name, value);
      if (progress) xhr.upload.onprogress = (event) => progress(event.loaded);
      xhr.onload = () => {
        let parsed: unknown;
        try {
          parsed = xhr.responseText ? JSON.parse(xhr.responseText) : {};
        } catch {
          parsed = {};
        }
        const record =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
        if (xhr.status >= 200 && xhr.status < 300)
          resolve({ status: xhr.status, body: record });
        else
          reject(
            new UploadFailure(
              sameOrigin &&
                typeof record['code'] === 'string' &&
                /^[A-Z_]{1,40}$/.test(record['code'])
                ? record['code']
                : `HTTP_${xhr.status}`,
            ),
          );
      };
      xhr.onerror = xhr.ontimeout = () => reject(new UploadFailure('NETWORK'));
      xhr.onabort = () => reject(new UploadFailure('ABORTED'));
      xhr.send(body);
    });
  }
  async function digest(data: Blob | Uint8Array): Promise<string | undefined> {
    const subtle = window.crypto?.subtle;
    if (!subtle) return undefined;
    const bytes =
      data instanceof Uint8Array
        ? data
        : new Uint8Array(await data.arrayBuffer());
    const hash = new Uint8Array(
      await subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>),
    );
    return [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  function session(body: Record<string, unknown>): {
    id: string;
    chunkSize: number;
    received: number;
    nextIndex: number;
    direct?: { url: string; headers: Record<string, string> };
  } {
    const id = body['session'];
    const chunkSize = body['chunkSize'];
    const received = body['received'];
    const nextIndex = body['nextIndex'];
    if (
      typeof id !== 'string' ||
      !sessionPattern.test(id) ||
      !Number.isSafeInteger(chunkSize) ||
      !Number.isSafeInteger(received) ||
      !Number.isSafeInteger(nextIndex) ||
      (chunkSize as number) < 1
    )
      throw new UploadFailure('RESPONSE');
    const result = {
      id,
      chunkSize: chunkSize as number,
      received: received as number,
      nextIndex: nextIndex as number,
    };
    if (body['mode'] !== 'direct') return result;
    const url = new URL(String(body['url']));
    const headers = body['headers'];
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      !headers ||
      typeof headers !== 'object' ||
      Object.entries(headers).some(
        ([name, value]) =>
          !/^[a-z0-9-]{1,64}$/.test(name) || typeof value !== 'string',
      )
    )
      throw new UploadFailure('RESPONSE');
    return {
      ...result,
      direct: { url: url.href, headers: headers as Record<string, string> },
    };
  }
  async function upload(
    batch: Batch,
    component: UploadComponent,
    field: string,
    file: File,
    progress: (loaded: number) => void,
  ): Promise<string> {
    const base = new URL(endpoint ?? '', window.location.href).href;
    const json = async (method: string, path: string, body?: unknown) =>
      (
        await send(
          batch,
          component,
          method,
          base + path,
          body === undefined ? {} : { 'content-type': 'application/json' },
          body === undefined ? null : JSON.stringify(body),
        )
      ).body;
    const started = session(
      await json('POST', '/sessions', {
        purpose: `${component.name}.${field}`,
        name: file.name,
        type: file.type,
        size: file.size,
      }),
    );
    batch.session = started.id;
    const path = `/sessions/${started.id}`;
    let digests: (string | undefined)[] | undefined =
      started.received === 0 ? [] : undefined;
    if (started.direct) {
      await send(
        batch,
        component,
        'PUT',
        started.direct.url,
        started.direct.headers,
        file,
        progress,
        false,
      );
    } else {
      let state = started;
      for (let retries = 0; state.received < file.size;) {
        const chunk = file.slice(
          state.received,
          state.received + state.chunkSize,
        );
        const hash = await digest(chunk);
        try {
          const offset = state.received;
          state = session(
            (
              await send(
                batch,
                component,
                'PUT',
                `${base}${path}/chunks/${state.nextIndex}`,
                {
                  'content-type': 'application/octet-stream',
                  'x-nestvexa-chunk-offset': String(offset),
                  ...(hash === undefined
                    ? {}
                    : { 'x-nestvexa-chunk-sha256': hash }),
                },
                chunk,
                (loaded) => progress(offset + loaded),
              )
            ).body,
          );
          if (digests) digests[state.nextIndex - 1] = hash;
        } catch (error) {
          const code = error instanceof UploadFailure ? error.code : 'NETWORK';
          if (
            batch.aborted ||
            ++retries > 3 ||
            !/^(?:NETWORK|HTTP_5\d\d|CHUNK_ALREADY_RECEIVED|UPLOAD_BUSY)$/.test(
              code,
            )
          )
            throw error;
          digests = undefined;
          await new Promise((resolve) =>
            window.setTimeout(resolve, 250 * retries),
          );
          state = session(await json('GET', path));
        }
      }
    }
    let combined: string | undefined;
    if (
      digests &&
      !started.direct &&
      digests.every((value) => value !== undefined) &&
      digests.length
    ) {
      const bytes = new Uint8Array(digests.length * 32);
      digests.forEach((value, index) => {
        for (let offset = 0; offset < 32; offset++)
          bytes[index * 32 + offset] = parseInt(
            (value ?? '').slice(offset * 2, offset * 2 + 2),
            16,
          );
      });
      combined = await digest(bytes);
    }
    const done = await json(
      'POST',
      `${path}/complete`,
      combined === undefined ? {} : { digest: combined },
    );
    batch.session = undefined;
    const token = done['token'];
    if (typeof token !== 'string' || !tokenPattern.test(token))
      throw new UploadFailure('RESPONSE');
    return token;
  }
  function discard(component: UploadComponent, path: string): void {
    const throwaway: Batch = { aborted: false, tokens: [] };
    void send(
      throwaway,
      component,
      'DELETE',
      new URL((endpoint ?? '') + path, window.location.href).href,
      {},
      null,
    ).catch(() => undefined);
  }
  async function start(input: Element): Promise<readonly string[]> {
    const field = fieldOf(input, 'input');
    const component = options.component(input);
    if (!component || !endpoint)
      invalid('Upload input is not owned by a usable Live component');
    const files = [...((input as HTMLInputElement).files ?? [])];
    cancel(input);
    if (!files.length) return [];
    const batch: Batch = { aborted: false, tokens: [] };
    active.set(input, batch);
    const total = files.reduce((sum, file) => sum + file.size, 0);
    let done = 0;
    input.setAttribute('aria-busy', 'true');
    input.removeAttribute('aria-invalid');
    report(component.root, field, 'Uploading 0%', 0, total);
    try {
      for (const file of files) {
        const token = await upload(batch, component, field, file, (loaded) =>
          report(
            component.root,
            field,
            `Uploading ${Math.floor(((done + loaded) / Math.max(total, 1)) * 100)}%`,
            done + loaded,
            total,
          ),
        );
        batch.tokens.push(token);
        done += file.size;
      }
      options.set(component.root, field, batch.tokens.join(','));
      completed.set(input, [...batch.tokens]);
      report(
        component.root,
        field,
        `Uploaded ${files.length} file${files.length === 1 ? '' : 's'}`,
        total,
        total,
      );
      input.dispatchEvent(
        new window.CustomEvent('nestvexa:upload', {
          bubbles: true,
          detail: { field, count: files.length },
        }),
      );
      return Object.freeze([...batch.tokens]);
    } catch (error) {
      const code = error instanceof UploadFailure ? error.code : 'NETWORK';
      for (const token of batch.tokens) discard(component, `/files/${token}`);
      if (batch.session) discard(component, `/sessions/${batch.session}`);
      if (batch.aborted || code === 'ABORTED') {
        report(component.root, field, 'Upload cancelled', 0, total);
        throw new LiveClientError('ABORTED', 'Upload cancelled');
      }
      input.setAttribute('aria-invalid', 'true');
      report(
        component.root,
        field,
        `Upload failed: ${messages[code] ?? (/TYPE|MIME|CONTENT|EXTENSION/.test(code) ? 'This file type is not allowed.' : 'Please try again.')}`,
        0,
        total,
      );
      input.dispatchEvent(
        new window.CustomEvent('nestvexa:upload-error', {
          bubbles: true,
          detail: { field, code },
        }),
      );
      throw new LiveClientError('HTTP', `Upload failed (${code})`);
    } finally {
      if (active.get(input) === batch) active.delete(input);
      input.removeAttribute('aria-busy');
    }
  }
  function inputFor(element: Element): Element | undefined {
    const directive = declaration(element);
    const component = options.component(element);
    if (!directive || !component) return undefined;
    if (directive.role === 'input') return element;
    return elements(component.root, directive.field, 'input')[0];
  }
  function cancel(element: Element): void {
    const input = inputFor(element);
    if (!input) return;
    const batch = active.get(input);
    const component = options.component(input);
    if (batch) {
      batch.aborted = true;
      active.delete(input);
      batch.xhr?.abort();
      batch.stop?.();
      // Discard server state now; the unwinding upload may never see a reply.
      if (component && batch.session)
        discard(component, `/sessions/${batch.session}`);
      batch.session = undefined;
    }
    const tokens = completed.get(input);
    if (tokens && component) {
      completed.delete(input);
      for (const token of tokens) discard(component, `/files/${token}`);
      options.set(component.root, fieldOf(input, 'input'), '');
    }
  }
  const change = (event: Event): void => {
    const target = event.target;
    if (
      !(target instanceof window.Element) ||
      !target.hasAttribute('nv:upload')
    )
      return;
    start(target).catch((error: unknown) => {
      if (!(error instanceof LiveClientError && error.code === 'ABORTED'))
        options.onError(error, target);
    });
  };
  const click = (event: Event): void => {
    const target =
      event.target instanceof window.Element
        ? event.target.closest('[nv\\:upload\\.cancel]')
        : null;
    if (!target) return;
    const input = inputFor(target);
    if (input && options.component(input)) {
      cancel(target);
      const component = options.component(input);
      if (component)
        report(
          component.root,
          fieldOf(input, 'input'),
          'Upload cancelled',
          0,
          1,
        );
      (input as HTMLInputElement).value = '';
    }
  };
  options.root.addEventListener('change', change);
  options.root.addEventListener('click', click);
  return {
    start,
    cancel,
    dispose(): void {
      disposed = true;
      options.root.removeEventListener('change', change);
      options.root.removeEventListener('click', click);
      for (const batch of active.values()) {
        batch.aborted = true;
        batch.xhr?.abort();
        batch.stop?.();
      }
      active.clear();
      completed.clear();
    },
  };
}
