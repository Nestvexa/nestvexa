import { LiveClientError, parseIdentifier } from './grammar.js';

const protocol = 'nestvexa-stream/1';
const maximumBytes = 1_048_576;
const maximumRecordBytes = 8192;
const maximumChunks = 4096;
export interface StreamEndpoint {
  readonly endpoint: string;
}
export interface StreamComponent {
  readonly root: Element;
  readonly id: string;
  readonly name: string;
  readonly snapshot: string;
  readonly revision: number;
  readonly csrf: string;
}
export interface StreamDirective {
  readonly kind: 'stream';
  readonly id: string;
  readonly append: boolean;
}
/** A target name, never a URL, expression, action or HTML instruction. */
export function parseStreamDirective(
  name: string,
  value: string,
): StreamDirective {
  if (name !== 'nv:stream' && name !== 'nv:stream.append')
    throw new LiveClientError(
      'DIRECTIVE',
      'Unsupported stream directive or modifier',
    );
  return {
    kind: 'stream',
    id: parseIdentifier(value),
    append: name.endsWith('.append'),
  };
}
function invalid(message: string): never {
  throw new LiveClientError('DIRECTIVE', message);
}
function owns(root: Element, target: Element): boolean {
  if (target.closest('[data-nv-component]') !== root) return false;
  for (
    let element: Element | null = target;
    element;
    element = element.parentElement
  ) {
    if (
      element.hasAttribute('nv:ignore') ||
      element.hasAttribute('data-nv-island')
    )
      return false;
    if (element === root) return true;
  }
  return false;
}
function declaration(target: Element): StreamDirective | undefined {
  const attributes = [...target.attributes].filter((attribute) =>
    /^nv:stream(?:\.|$)/.test(attribute.name),
  );
  if (!attributes.length) return undefined;
  const entry = attributes[0];
  if (attributes.length !== 1 || !entry)
    invalid('A stream target requires exactly one stream declaration');
  const directive = parseStreamDirective(entry.name, entry.value);
  if (
    target.namespaceURI !== 'http://www.w3.org/1999/xhtml' ||
    target.children.length ||
    [
      'SCRIPT',
      'STYLE',
      'INPUT',
      'TEXTAREA',
      'SELECT',
      'OPTION',
      'BUTTON',
      'A',
      'IFRAME',
      'OBJECT',
      'EMBED',
      'TEMPLATE',
    ].includes(target.tagName) ||
    target.hasAttribute('contenteditable') ||
    target.closest('[contenteditable]') ||
    [...target.attributes].some((attribute) =>
      /^nv:(text|model|show|dirty|bind|transition)(\.|$)/.test(attribute.name),
    )
  )
    invalid(
      'Streams require an exclusive noninteractive HTML text-only target',
    );
  return directive;
}
/** Check a trusted static map and return detached same-origin POST endpoints. */
export function copyStreamEndpoints(
  streams: unknown,
): Readonly<Record<string, StreamEndpoint>> {
  const plain = (value: object): boolean =>
    Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null;
  if (
    !streams ||
    typeof streams !== 'object' ||
    !plain(streams) ||
    Reflect.ownKeys(streams).length > 64
  )
    invalid('Invalid stream endpoint map');
  const result: Record<string, StreamEndpoint> = Object.create(null) as Record<
    string,
    StreamEndpoint
  >;
  for (const key of Reflect.ownKeys(streams)) {
    if (typeof key !== 'string') invalid('Invalid stream identifier');
    parseIdentifier(key);
    const descriptor = Object.getOwnPropertyDescriptor(streams, key);
    if (!descriptor?.enumerable || !('value' in descriptor))
      invalid('Stream endpoints must be plain data');
    const entry: unknown = descriptor.value;
    if (
      !entry ||
      typeof entry !== 'object' ||
      !plain(entry) ||
      Reflect.ownKeys(entry).length !== 1
    )
      invalid('Invalid registered stream endpoint');
    const endpoint = Object.getOwnPropertyDescriptor(entry, 'endpoint');
    if (
      !endpoint?.enumerable ||
      !('value' in endpoint) ||
      typeof endpoint.value !== 'string'
    )
      invalid('Stream endpoint must be a string data property');
    result[key] = Object.freeze({ endpoint: endpoint.value });
  }
  return Object.freeze(result);
}
function endpoints(
  streams: Readonly<Record<string, StreamEndpoint>>,
  view: Window,
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const [id, entry] of Object.entries(streams)) {
    parseIdentifier(id);
    if (
      !entry ||
      typeof entry.endpoint !== 'string' ||
      /[\r\n]/.test(entry.endpoint)
    )
      invalid('Invalid registered stream endpoint');
    let url: URL;
    try {
      url = new URL(entry.endpoint, view.location.href);
    } catch {
      return invalid('Invalid registered stream endpoint URL');
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.origin !== view.location.origin ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      invalid(
        'Stream endpoints require same-origin HTTP(S) without credentials, query or fragment',
      );
    result.set(id, url.href);
  }
  if (result.size > 64)
    invalid('An app supports at most 64 registered stream endpoints');
  return result;
}
/** Validate all owned targets without changing DOM or initiating network activity. */
export function validateStreams(
  root: Element,
  streams: Readonly<Record<string, StreamEndpoint>>,
): void {
  const view = root.ownerDocument.defaultView;
  if (!view) invalid('Stream validation requires a browser window');
  const registered = endpoints(streams, view);
  for (const target of [root, ...root.querySelectorAll('*')]) {
    if (!owns(root, target)) continue;
    const entry = declaration(target);
    if (entry && (target === root || !registered.has(entry.id)))
      invalid('Unknown stream or component root used as stream target');
  }
}
interface Active {
  readonly root: Element;
  readonly snapshot: string;
  readonly revision: number;
  readonly directive: StreamDirective;
  readonly controller: AbortController;
  readonly requestId: string;
  readonly text: Text;
  cancel(): void;
}
export interface StreamResult {
  readonly bytes: number;
  readonly chunks: number;
}
export interface StreamController {
  refresh(root: Element): void;
  start(target: Element): Promise<StreamResult>;
  cancel(target: Element): void;
  remove(node: Element): void;
  dispose(): void;
}
export interface StreamControllerOptions {
  readonly window: Window;
  readonly streams: Readonly<Record<string, StreamEndpoint>>;
  readonly fetch?: typeof fetch;
  readonly component: (target: Element) => StreamComponent | undefined;
  readonly onError: (error: unknown, target: Element) => void;
}
type RecordValue =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'done' }
  | { readonly type: 'error'; readonly code: string };
function record(
  line: string,
  requestId: string,
  sequence: number,
): RecordValue {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new LiveClientError('RESPONSE', 'Malformed stream JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new LiveClientError('RESPONSE', 'Invalid stream record');
  const keys = Object.keys(value);
  const field = (key: string): unknown => Reflect.get(value, key);
  if (
    field('protocol') !== protocol ||
    field('requestId') !== requestId ||
    field('seq') !== sequence
  )
    throw new LiveClientError(
      'RESPONSE',
      'Mismatched stream sequence or request',
    );
  const type = field('type');
  const allowed =
    type === 'text'
      ? ['protocol', 'requestId', 'seq', 'type', 'text']
      : type === 'error'
        ? ['protocol', 'requestId', 'seq', 'type', 'code']
        : ['protocol', 'requestId', 'seq', 'type'];
  if (
    keys.length !== allowed.length ||
    keys.some((key) => !allowed.includes(key))
  )
    throw new LiveClientError('RESPONSE', 'Unknown stream record fields');
  if (type === 'text' && typeof field('text') === 'string')
    return { type, text: String(field('text')) };
  if (type === 'done') return { type };
  if (
    type === 'error' &&
    ['STREAM_FAILED', 'STREAM_EXPIRED', 'STREAM_LIMIT'].includes(
      String(field('code')),
    )
  )
    return { type, code: String(field('code')) };
  throw new LiveClientError('RESPONSE', 'Invalid stream record type');
}

/** A bounded, text-only consumer. One reader operation and one frame commit at a time provide browser backpressure. */
export function createStreamController(
  options: StreamControllerOptions,
): StreamController {
  const view = options.window;
  const streams = copyStreamEndpoints(options.streams);
  const registered = endpoints(streams, view);
  const transport = options.fetch ?? view.fetch.bind(view);
  const active = new Map<Element, Active>();
  let disposed = false;
  function live(target: Element, entry: Active): boolean {
    const component = options.component(target);
    const next = declaration(target);
    return (
      !disposed &&
      target.isConnected &&
      owns(entry.root, target) &&
      component?.root === entry.root &&
      component.snapshot === entry.snapshot &&
      component.revision === entry.revision &&
      next?.id === entry.directive.id &&
      next.append === entry.directive.append &&
      entry.text.parentNode === target &&
      target.childNodes.length === 1
    );
  }
  return {
    refresh(root): void {
      for (const [target, entry] of active) {
        try {
          if (!live(target, entry)) entry.cancel();
        } catch {
          entry.cancel();
        }
      }
      validateStreams(root, streams);
    },
    async start(target): Promise<StreamResult> {
      if (disposed) return invalid('The stream controller is disposed');
      const component = options.component(target);
      const directive = declaration(target);
      if (
        !component ||
        !directive ||
        !target.isConnected ||
        !owns(component.root, target) ||
        target === component.root
      )
        return invalid('Stream target is not registered and owned');
      const endpoint = registered.get(directive.id);
      if (!endpoint) return invalid('Stream ID is not allowlisted');
      if (active.has(target))
        return invalid('A stream is already running on this target');
      if (
        active.size >= 8 ||
        [...active.values()].filter((entry) => entry.root === component.root)
          .length >= 2
      )
        return invalid('Stream concurrency limit reached');
      const controller = new AbortController();
      const requestId = view.crypto.randomUUID();
      const text = view.document.createTextNode(
        directive.append ? (target.textContent ?? '') : '',
      );
      target.replaceChildren(text);
      let failure: LiveClientError | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let frame = 0;
      let idle = 0;
      let stop: (error: LiveClientError) => void = () => undefined;
      const stopped = new Promise<never>((_resolve, reject) => {
        stop = reject;
      });
      const cancel = (
        error = new LiveClientError('ABORTED', 'Stream cancelled'),
      ): void => {
        if (controller.signal.aborted) return;
        failure = error;
        controller.abort();
        stop(error);
        if (reader) void reader.cancel().catch(() => undefined);
        view.cancelAnimationFrame(frame);
      };
      const entry: Active = {
        root: component.root,
        snapshot: component.snapshot,
        revision: component.revision,
        directive,
        controller,
        requestId,
        text,
        cancel: () => cancel(),
      };
      active.set(target, entry);
      const resetIdle = (): void => {
        view.clearTimeout(idle);
        idle = view.setTimeout(
          () =>
            cancel(
              new LiveClientError('TIMEOUT', 'Stream idle deadline exceeded'),
            ),
          10_000,
        );
      };
      const total = view.setTimeout(
        () =>
          cancel(
            new LiveClientError('TIMEOUT', 'Stream total deadline exceeded'),
          ),
        30_000,
      );
      resetIdle();
      const wait = <T>(operation: Promise<T>): Promise<T> =>
        Promise.race([operation, stopped]);
      let bytes = 0;
      let chunks = 0;
      let sequence = 0;
      let terminal = false;
      let pending = '';
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const encoder = new TextEncoder();
      try {
        let response: Response;
        try {
          response = await wait(
            transport(endpoint, {
              method: 'POST',
              credentials: 'same-origin',
              redirect: 'error',
              headers: {
                'Content-Type': 'application/json',
                Accept: 'application/x-ndjson',
                'X-Nestvexa-CSRF': component.csrf,
              },
              body: JSON.stringify({
                protocol,
                requestId,
                snapshot: component.snapshot,
                revision: component.revision,
              }),
              signal: controller.signal,
            }),
          );
        } catch (error) {
          if (failure) throw failure;
          if (error instanceof LiveClientError) throw error;
          throw new LiveClientError('NETWORK', 'Stream request failed');
        }
        if (
          !response.ok ||
          response.headers
            .get('content-type')
            ?.split(';')[0]
            ?.trim()
            .toLowerCase() !== 'application/x-ndjson' ||
          !response.body
        )
          throw new LiveClientError(
            'RESPONSE',
            'Expected a successful NDJSON stream response',
          );
        reader = response.body.getReader();
        for (;;) {
          const item = await wait(reader.read());
          if (!live(target, entry))
            throw new LiveClientError('ABORTED', 'Stream ownership changed');
          if (item.done) {
            try {
              pending += decoder.decode();
            } catch {
              throw new LiveClientError('RESPONSE', 'Invalid stream UTF-8');
            }
            if (pending || !terminal)
              throw new LiveClientError(
                'RESPONSE',
                'Stream ended without a complete terminal record',
              );
            return Object.freeze({ bytes, chunks });
          }
          bytes += item.value.byteLength;
          if (bytes > maximumBytes)
            throw new LiveClientError('RESPONSE', 'Stream exceeds byte limit');
          resetIdle();
          try {
            pending += decoder.decode(item.value, { stream: true });
          } catch {
            throw new LiveClientError('RESPONSE', 'Invalid stream UTF-8');
          }
          for (;;) {
            const newline = pending.indexOf('\n');
            if (newline < 0) {
              if (encoder.encode(pending).byteLength > maximumRecordBytes)
                throw new LiveClientError(
                  'RESPONSE',
                  'Stream record exceeds byte limit',
                );
              break;
            }
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            if (
              terminal ||
              encoder.encode(line).byteLength + 1 > maximumRecordBytes
            )
              throw new LiveClientError(
                'RESPONSE',
                'Trailing or oversized stream record',
              );
            const message = record(line, requestId, sequence++);
            if (message.type === 'error')
              throw new LiveClientError(
                'RESPONSE',
                `Stream stopped (${message.code})`,
              );
            if (message.type === 'done') {
              terminal = true;
              continue;
            }
            if (++chunks > maximumChunks)
              throw new LiveClientError(
                'RESPONSE',
                'Stream exceeds chunk limit',
              );
            await wait(
              new Promise<void>((resolve) => {
                frame = view.requestAnimationFrame(() => {
                  frame = 0;
                  if (live(target, entry)) text.appendData(message.text);
                  resolve();
                });
              }),
            );
            if (!live(target, entry))
              throw new LiveClientError('ABORTED', 'Stream ownership changed');
          }
        }
      } catch (error) {
        const safe =
          failure ??
          (error instanceof LiveClientError
            ? error
            : new LiveClientError('RESPONSE', 'Stream could not be consumed'));
        if (safe.code !== 'ABORTED') options.onError(safe, target);
        throw safe;
      } finally {
        controller.abort();
        view.clearTimeout(total);
        view.clearTimeout(idle);
        view.cancelAnimationFrame(frame);
        if (reader) {
          void reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
        if (active.get(target) === entry) active.delete(target);
      }
    },
    cancel(target): void {
      active.get(target)?.cancel();
    },
    remove(node): void {
      for (const [target, entry] of active)
        if (
          node === target ||
          node.contains(target) ||
          node === entry.root ||
          node.contains(entry.root)
        )
          entry.cancel();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const entry of active.values()) entry.cancel();
    },
  };
}
