import fc from 'fast-check';
import { propertyRuns } from './support/property-runs.js';
import { describe, expect, it } from 'vitest';
import {
  DANGEROUS_EXTENSIONS,
  TextValidator,
  UploadError,
  assertStorageKey,
  contentDisposition,
  parseClientFilename,
  parseRange,
  parseUploadReferences,
} from '../packages/uploads/src/index.js';
import { decodeFilenameHeader } from '../packages/uploads/src/filename.js';

/**
 * Property-based checks for the upload trust boundary: client filenames,
 * percent-encoded name headers, response filename encoding, HTTP Range and
 * upload references. Every input below is attacker-controlled.
 */
const runs = propertyRuns(400);
const loneSurrogate = fc
  .oneof(
    fc.integer({ min: 0xd800, max: 0xdbff }),
    fc.integer({ min: 0xdc00, max: 0xdfff }),
  )
  .map((code) => String.fromCharCode(code));
const hostileFragment = fc.constantFrom(
  '../',
  '..\\',
  '/',
  '\\',
  'C:\\',
  '\\\\?\\',
  ':Zone.Identifier',
  '\u0000',
  '\r\n',
  '\u202e',
  '\u200b',
  '\ufeff',
  '..',
  '.',
  ' ',
  '%2e%2e%2f',
  '"',
  '<',
  '|',
  '\u0085',
);
const nameText = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 40 }),
  fc
    .array(
      fc.oneof(fc.string({ maxLength: 6 }), hostileFragment, loneSurrogate),
      {
        maxLength: 8,
      },
    )
    .map((parts) => parts.join('')),
);
const safeName = fc
  .tuple(
    fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 _()-]{0,30}[A-Za-z0-9]$/),
    fc.constantFrom('pdf', 'png', 'txt', 'csv', 'JPEG'),
  )
  .map(([stem, extension]) => `${stem}.${extension}`);

function uploadCode(operation: () => unknown): string {
  try {
    operation();
    return 'ok';
  } catch (error) {
    if (!(error instanceof UploadError)) throw error;
    const body = error.getResponse() as { code?: string };
    return body.code ?? 'UNKNOWN';
  }
}
const wellFormed = (value: string) =>
  !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(
    value,
  );

describe('client filename properties', () => {
  it('returns only names that are safe metadata, or a 400 UploadError', () => {
    fc.assert(
      fc.property(nameText, (raw) => {
        const code = uploadCode(() => parseClientFilename(raw));
        if (code !== 'ok') {
          expect([
            'INVALID_FILENAME',
            'MISSING_EXTENSION',
            'DANGEROUS_EXTENSION',
          ]).toContain(code);
          return;
        }
        const { name, extension } = parseClientFilename(raw);
        expect(name).not.toMatch(/[/\\:*?"<>|]/);
        expect(name).not.toMatch(/\p{Cc}/u);
        expect(name).not.toMatch(
          /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/,
        );
        expect(name.startsWith('.')).toBe(false);
        expect(name.endsWith('.')).toBe(false);
        expect(name.trim()).toBe(name);
        expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255);
        // Names are re-encoded into UTF-8 headers and JSON; they must be well formed.
        expect(wellFormed(name)).toBe(true);
        expect(extension).toBe(extension.toLowerCase());
        expect(name.toLowerCase().endsWith(`.${extension}`)).toBe(true);
        for (const segment of name.split('.').slice(1))
          expect(DANGEROUS_EXTENSIONS.has(segment.trim().toLowerCase())).toBe(
            false,
          );
      }),
      runs,
    );
  });

  it('accepts ordinary names unchanged', () => {
    fc.assert(
      fc.property(safeName, (name) => {
        expect(parseClientFilename(name)).toEqual({
          name,
          extension: name.split('.').at(-1)?.toLowerCase(),
        });
      }),
      runs,
    );
  });

  it('refuses any name with a traversal, separator or lone surrogate inserted', () => {
    fc.assert(
      fc.property(
        safeName,
        fc.oneof(
          fc.constantFrom('../', '..\\', '/', '\\', 'C:', '\u0000', '\u202e'),
          loneSurrogate,
        ),
        fc.nat(),
        (name, fragment, position) => {
          const index = position % (name.length + 1);
          const hostile = name.slice(0, index) + fragment + name.slice(index);
          expect(uploadCode(() => parseClientFilename(hostile))).not.toBe('ok');
        },
      ),
      runs,
    );
  });

  it('refuses dangerous inner extensions regardless of case or padding', () => {
    fc.assert(
      fc.property(
        safeName,
        fc.constantFrom(...DANGEROUS_EXTENSIONS),
        fc.boolean(),
        (name, dangerous, upper) => {
          const inner = upper ? dangerous.toUpperCase() : dangerous;
          const [stem = 'a', extension = 'pdf'] = name.split('.');
          expect(
            uploadCode(() =>
              parseClientFilename(`${stem}.${inner}.${extension}`),
            ),
          ).toBe('DANGEROUS_EXTENSION');
        },
      ),
      runs,
    );
  });
});

describe('filename header properties', () => {
  it('decodes exactly what the browser client encodes', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (name) => {
        fc.pre(name.length > 0 && encodeURIComponent(name).length <= 3072);
        expect(decodeFilenameHeader(encodeURIComponent(name))).toBe(name);
      }),
      runs,
    );
  });

  it('rejects malformed percent-encoding with a 400 UploadError only', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 80 }), (header) => {
        const code = uploadCode(() => decodeFilenameHeader(header));
        expect(['ok', 'INVALID_FILENAME']).toContain(code);
      }),
      runs,
    );
  });
});

describe('Content-Disposition properties', () => {
  const headerPattern =
    /^(attachment|inline); filename="([\x20-\x21\x23-\x24\x26-\x3a\x3c-\x5b\x5d-\x7e]*)"; filename\*=UTF-8''([A-Za-z0-9%\-._~]*)$/;
  it('always produces a single valid ASCII header with a UTF-8 extended value', () => {
    fc.assert(
      fc.property(
        nameText,
        fc.constantFrom('attachment', 'inline'),
        (name, disposition) => {
          const value = contentDisposition(
            name,
            disposition as 'attachment' | 'inline',
          );
          const match = headerPattern.exec(value);
          expect(match, value).not.toBeNull();
          const encoded = match?.[3] ?? '';
          const decoded = decodeURIComponent(encoded);
          expect(decoded).not.toMatch(/[\p{Cc}/\\]/u);
          expect(decoded).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/);
          expect(decoded.length).toBeGreaterThan(0);
        },
      ),
      runs,
    );
  });

  it('preserves ordinary names exactly in the extended value', () => {
    fc.assert(
      fc.property(safeName, (name) => {
        const match = headerPattern.exec(contentDisposition(name));
        expect(decodeURIComponent(match?.[3] ?? '')).toBe(name);
      }),
      runs,
    );
  });
});

describe('Range header properties', () => {
  it('returns only in-bounds inclusive ranges for any header and size', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ unit: 'binary', maxLength: 60 }),
          fc
            .tuple(
              fc.option(fc.bigInt({ min: 0n, max: 10n ** 18n })),
              fc.option(fc.bigInt({ min: 0n, max: 10n ** 18n })),
              fc.constantFrom('', ' ', '  '),
              fc.constantFrom('bytes', 'BYTES', 'Bytes', 'items'),
            )
            .map(
              ([first, last, space, unit]) =>
                `${space}${unit}${space}=${first ?? ''}${space}-${space}${last ?? ''}`,
            ),
          fc.anything(),
        ),
        fc.nat({ max: 2 ** 40 }),
        (header, size) => {
          const result = parseRange(header, size);
          if (result.kind !== 'partial') return;
          expect(Number.isSafeInteger(result.start)).toBe(true);
          expect(Number.isSafeInteger(result.end)).toBe(true);
          expect(result.start).toBeGreaterThanOrEqual(0);
          expect(result.start).toBeLessThanOrEqual(result.end);
          expect(result.end).toBeLessThan(size);
        },
      ),
      runs,
    );
  });

  it('matches RFC 9110 single-range semantics for valid specs', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 10_000 }),
        fc.nat({ max: 12_000 }),
        fc.option(fc.nat({ max: 12_000 }), { nil: undefined }),
        (size, first, last) => {
          const result = parseRange(`bytes=${first}-${last ?? ''}`, size);
          if (last !== undefined && last < first)
            expect(result).toEqual({ kind: 'full' });
          else if (first >= size)
            expect(result).toEqual({ kind: 'unsatisfiable' });
          else
            expect(result).toEqual({
              kind: 'partial',
              start: first,
              end: Math.min(last ?? size - 1, size - 1),
            });
          const suffix = parseRange(`bytes=-${first}`, size);
          if (first === 0 || size === 0)
            expect(suffix).toEqual({ kind: 'unsatisfiable' });
          else
            expect(suffix).toEqual({
              kind: 'partial',
              start: Math.max(0, size - first),
              end: size - 1,
            });
        },
      ),
      runs,
    );
  });

  it('ignores multi-range and oversized headers', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat(100), fc.nat(100)), {
          minLength: 2,
          maxLength: 5,
        }),
        (ranges) => {
          const header = `bytes=${ranges.map(([a, b]) => `${a}-${a + b}`).join(',')}`;
          expect(parseRange(header, 1000)).toEqual({ kind: 'full' });
        },
      ),
      runs,
    );
    expect(parseRange(`bytes=0-${'0'.repeat(200)}`, 10)).toEqual({
      kind: 'full',
    });
  });
});

describe('upload reference and storage key properties', () => {
  const uploadToken = fc
    .uint8Array({ minLength: 32, maxLength: 32 })
    .map((bytes) => `nvu_${Buffer.from(bytes).toString('base64url')}`);
  it('round-trips unique token lists and rejects duplicates or excess', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(uploadToken, { minLength: 1, maxLength: 12 }),
        fc.integer({ min: 1, max: 12 }),
        (tokens, max) => {
          const code = uploadCode(() =>
            parseUploadReferences(tokens.join(','), max),
          );
          if (tokens.length <= max) {
            expect(code).toBe('ok');
            expect(parseUploadReferences(tokens.join(','), max)).toEqual(
              tokens,
            );
          } else expect(code).toBe('INVALID_UPLOAD_TOKEN');
          const first = tokens[0] ?? '';
          expect(
            uploadCode(() =>
              parseUploadReferences([...tokens, first].join(','), 100),
            ),
          ).toBe('INVALID_UPLOAD_TOKEN');
        },
      ),
      runs,
    );
  });

  it('rejects arbitrary values with INVALID_UPLOAD_TOKEN only', () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        expect(['ok', 'INVALID_UPLOAD_TOKEN']).toContain(
          uploadCode(() => parseUploadReferences(value, 10)),
        );
      }),
      runs,
    );
  });

  it('accepts only shard/object storage keys without traversal', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ unit: 'binary', maxLength: 60 }),
          fc
            .array(fc.oneof(fc.string({ maxLength: 4 }), hostileFragment), {
              maxLength: 6,
            })
            .map((parts) => parts.join('')),
        ),
        (key) => {
          let accepted = true;
          try {
            assertStorageKey(key);
          } catch {
            accepted = false;
          }
          if (accepted) {
            expect(key).toMatch(/^[A-Za-z0-9_-]{2}\/[A-Za-z0-9_-]{43}$/);
            expect(key).not.toContain('..');
          }
        },
      ),
      runs,
    );
  });
});

describe('text validator properties', () => {
  const reference = (bytes: Uint8Array): boolean => {
    for (const byte of bytes)
      if (
        (byte < 0x20 && ![0x09, 0x0a, 0x0c, 0x0d].includes(byte)) ||
        byte === 0x7f
      )
        return false;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return !/[\u0080-\u009f]/.test(text);
    } catch {
      return false;
    }
  };
  it('gives the same verdict for every chunking of the same bytes', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.uint8Array({ maxLength: 64 }),
          fc
            .string({ unit: 'binary', maxLength: 32 })
            .map((text) => new Uint8Array(Buffer.from(text, 'utf8'))),
        ),
        fc.array(fc.nat(64), { maxLength: 6 }),
        (bytes, cuts) => {
          const points = [
            ...new Set(cuts.map((cut) => cut % (bytes.length + 1))),
          ].sort((a, b) => a - b);
          const validator = new TextValidator();
          let start = 0;
          for (const point of [...points, bytes.length]) {
            validator.push(bytes.subarray(start, point));
            start = point;
          }
          expect(validator.finish()).toBe(reference(bytes));
        },
      ),
      runs,
    );
  });
});

describe('regressions found by the property suite (2026-11)', () => {
  it('refuses client filenames containing unpaired surrogates', () => {
    for (const name of ['a\ud800.pdf', '\udc00x.pdf', 'report.pd\udbff'])
      expect(uploadCode(() => parseClientFilename(name))).toBe(
        'INVALID_FILENAME',
      );
    expect(parseClientFilename('emoji-😀.pdf').name).toBe('emoji-😀.pdf');
  });
  it('encodes unpaired surrogates and truncation boundaries without throwing', () => {
    expect(contentDisposition('\udc00')).toBe(
      `attachment; filename="_"; filename*=UTF-8''%EF%BF%BD`,
    );
    // 254 ASCII characters followed by an astral character used to be cut mid-pair.
    const long = `${'a'.repeat(254)}😀b`;
    const encoded = /filename\*=UTF-8''(.*)$/.exec(contentDisposition(long));
    expect(decodeURIComponent(encoded?.[1] ?? '')).toBe(`${'a'.repeat(254)}😀`);
  });
});
