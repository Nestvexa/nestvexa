import { connect } from 'node:net';
import type { Readable } from 'node:stream';

/** Scanner verdict. Anything but `clean` blocks finalization. */
export type ScanVerdict =
  | { readonly status: 'clean' }
  | { readonly status: 'infected'; readonly signature?: string }
  | { readonly status: 'error'; readonly reason?: string };

/** Metadata and a fresh byte stream of the exact file being finalized. */
export interface ScanInput {
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
  readonly sha256: string;
  open(): Promise<Readable>;
}

/**
 * Malware scanning hook. Nestvexa does not include a malware engine: without a
 * configured scanner, finalization reports `scan: 'not-configured'` (or fails
 * for purposes with `requireScan: true`).
 */
export interface UploadScanner {
  readonly name: string;
  scan(file: ScanInput, signal: AbortSignal): Promise<ScanVerdict>;
}

export interface ClamdScannerOptions {
  readonly host?: string;
  readonly port?: number;
  /** Unix socket / Windows named pipe path instead of TCP. */
  readonly socketPath?: string;
  /** Default 30000ms. */
  readonly timeoutMs?: number;
}

/**
 * ClamAV `clamd` adapter using the documented INSTREAM protocol. Requires a
 * running clamd you operate and keep updated; its StreamMaxLength must be at
 * least your largest purpose's maxFileSize.
 */
export class ClamdScanner implements UploadScanner {
  readonly name = 'clamd';
  readonly #options: ClamdScannerOptions;
  constructor(options: ClamdScannerOptions = {}) {
    const timeout = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 600_000)
      throw new Error('Invalid clamd timeout');
    if (
      options.socketPath === undefined &&
      options.port !== undefined &&
      (!Number.isSafeInteger(options.port) ||
        options.port < 1 ||
        options.port > 65_535)
    )
      throw new Error('Invalid clamd port');
    this.#options = options;
  }
  async scan(file: ScanInput, signal: AbortSignal): Promise<ScanVerdict> {
    const source = await file.open();
    const socket =
      this.#options.socketPath === undefined
        ? connect({
            host: this.#options.host ?? '127.0.0.1',
            port: this.#options.port ?? 3310,
          })
        : connect({ path: this.#options.socketPath });
    const timeout = this.#options.timeoutMs ?? 30_000;
    return new Promise<ScanVerdict>((resolve) => {
      let reply = '';
      let settled = false;
      const finish = (verdict: ScanVerdict): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        source.destroy();
        socket.destroy();
        resolve(verdict);
      };
      const abort = (): void => finish({ status: 'error', reason: 'aborted' });
      const timer = setTimeout(
        () => finish({ status: 'error', reason: 'timeout' }),
        timeout,
      );
      timer.unref();
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
      socket.once('error', () =>
        finish({ status: 'error', reason: 'connection' }),
      );
      socket.on('data', (data: Buffer) => {
        reply += data.toString('utf8');
        if (reply.length > 4096) finish({ status: 'error', reason: 'reply' });
        if (!reply.includes('\u0000')) return;
        const text = reply.slice(0, reply.indexOf('\u0000')).trim();
        if (/^stream: OK$/.test(text)) finish({ status: 'clean' });
        else {
          const found = /^stream: (.{1,200}) FOUND$/.exec(text);
          finish(
            found?.[1]
              ? { status: 'infected', signature: found[1] }
              : { status: 'error', reason: 'clamd' },
          );
        }
      });
      socket.once('end', () => finish({ status: 'error', reason: 'closed' }));
      socket.once('connect', () => {
        socket.write('zINSTREAM\u0000');
        void (async () => {
          try {
            for await (const chunk of source) {
              const bytes = Buffer.isBuffer(chunk)
                ? chunk
                : Buffer.from(chunk as Uint8Array);
              for (
                let offset = 0;
                offset < bytes.byteLength;
                offset += 65_536
              ) {
                const part = bytes.subarray(offset, offset + 65_536);
                const length = Buffer.alloc(4);
                length.writeUInt32BE(part.byteLength);
                if (!socket.write(Buffer.concat([length, part])))
                  await new Promise<void>((done) => {
                    socket.once('drain', done);
                    socket.once('close', done);
                  });
                if (settled) return;
              }
            }
            socket.write(Buffer.alloc(4));
          } catch {
            finish({ status: 'error', reason: 'read' });
          }
        })();
      });
    });
  }
}
