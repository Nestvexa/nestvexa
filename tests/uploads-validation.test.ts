import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FILE_TYPES,
  LocalStorage,
  TextValidator,
  contentDisposition,
  dangerousContent,
  defineFileType,
  inspectContent,
  isUploadToken,
  looksLikeMarkup,
  parseClientFilename,
  parseRange,
  parseUploadReferences,
  uploadReferenceField,
} from '../packages/uploads/dist/index.js';

const bytes = (...values: number[]) => new Uint8Array(values);
const ascii = (text: string) => new TextEncoder().encode(text);

describe('magic-byte detection', () => {
  it.each([
    ['png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)],
    ['jpeg', bytes(0xff, 0xd8, 0xff, 0xe0)],
    ['gif', ascii('GIF89a....')],
    ['gif', ascii('GIF87a....')],
    ['webp', ascii('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ')],
    ['pdf', ascii('%PDF-1.4')],
  ] as const)('recognizes %s', (name, head) => {
    expect(FILE_TYPES[name].detect?.(head)).toBe(true);
    for (const other of ['png', 'jpeg', 'gif', 'webp', 'pdf'] as const)
      if (other !== name) expect(FILE_TYPES[other].detect?.(head)).toBe(false);
  });
  it('refuses truncated signatures', () => {
    expect(FILE_TYPES.png.detect?.(bytes(0x89, 0x50))).toBe(false);
    expect(FILE_TYPES.webp.detect?.(ascii('RIFF1234WEB'))).toBe(false);
  });
  it.each([
    ['PE executable', ascii('MZ\u0090\u0000')],
    ['ELF', bytes(0x7f, 0x45, 0x4c, 0x46, 2)],
    ['Mach-O', bytes(0xcf, 0xfa, 0xed, 0xfe)],
    ['Java class / fat Mach-O', bytes(0xca, 0xfe, 0xba, 0xbe)],
    ['shebang script', ascii('#!/bin/sh\nrm -rf /')],
    ['WebAssembly', bytes(0x00, 0x61, 0x73, 0x6d)],
    ['HTML', ascii('  <!doctype html><p>')],
    ['SVG', ascii('<svg onload=alert(1)>')],
    ['XML', ascii('<?xml version="1.0"?>')],
    ['BOM + script', ascii('﻿<script>alert(1)</script>')],
    ['UTF-16 HTML', new Uint8Array(Buffer.from('<html>', 'utf16le'))],
  ])('denies %s content', (_label, head) => {
    expect(dangerousContent(head)).toBe(true);
  });
  it('does not flag ordinary text as markup', () => {
    expect(looksLikeMarkup(ascii('a < b and c > d'))).toBe(false);
    expect(dangerousContent(ascii('name,amount\nA,1'))).toBe(false);
  });
});

describe('UTF-8 text validation', () => {
  it('accepts multilingual text split across chunks', () => {
    const validator = new TextValidator();
    const data = Buffer.from('Grüße, مرحبا, 你好 😀\r\n\tend\f');
    for (let index = 0; index < data.byteLength; index++)
      validator.push(data.subarray(index, index + 1));
    expect(validator.finish()).toBe(true);
  });
  it.each([
    ['NUL', [0x61, 0x00]],
    ['escape', [0x1b, 0x5b]],
    ['DEL', [0x7f]],
    ['invalid continuation', [0xc3, 0x28]],
    ['overlong', [0xc0, 0xaf]],
    ['C1 control', [0xc2, 0x85]],
    ['truncated sequence', [0xe2, 0x82]],
  ])('rejects %s', (_label, values) => {
    const validator = new TextValidator();
    validator.push(Uint8Array.from(values));
    expect(validator.finish()).toBe(false);
  });
});

describe('content inspection', () => {
  const run = (
    chunks: Buffer[],
    type: keyof typeof FILE_TYPES,
    maxBytes = 1024,
    allowEmpty = false,
  ) =>
    inspectContent(Readable.from(chunks), FILE_TYPES[type], {
      maxBytes,
      allowEmpty,
    });
  it('hashes and sizes valid content', async () => {
    const result = await run([Buffer.from('%PDF-'), Buffer.from('1.7')], 'pdf');
    expect(result.size).toBe(8);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each([
    [[Buffer.alloc(0)], 'png', 'EMPTY_FILE'],
    [[Buffer.from('%PDF-1')], 'png', 'CONTENT_MISMATCH'],
    [[Buffer.from('MZ....')], 'pdf', 'DANGEROUS_CONTENT'],
    [[Buffer.alloc(2000, 0x41)], 'txt', 'FILE_TOO_LARGE'],
    [
      [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      'txt',
      'CONTENT_MISMATCH',
    ],
  ] as const)('refuses %#', async (chunks, type, code) => {
    await expect(run([...chunks], type)).rejects.toMatchObject({ code });
  });
  it('accepts empty text only when allowed', async () => {
    await expect(
      run([Buffer.alloc(0)], 'txt', 10, true),
    ).resolves.toMatchObject({ size: 0 });
    await expect(run([Buffer.alloc(0)], 'png', 10, true)).rejects.toMatchObject(
      { code: 'CONTENT_MISMATCH' },
    );
  });
});

describe('client filename policy', () => {
  it.each([
    ['photo.PNG', 'png'],
    ['report.final.pdf', 'pdf'],
    ['تقرير.pdf', 'pdf'],
    ['名前 (1).csv', 'csv'],
    ['Café.txt', 'txt'],
  ])('accepts %s', (name, extension) => {
    const parsed = parseClientFilename(name);
    expect(parsed.extension).toBe(extension);
    expect(parsed.name).toBe(name.normalize('NFC'));
  });
  it.each([
    ['../a.png', 'INVALID_FILENAME'],
    ['a\\b.png', 'INVALID_FILENAME'],
    ['a/b.png', 'INVALID_FILENAME'],
    ['a:b.png', 'INVALID_FILENAME'],
    ['a<b>.png', 'INVALID_FILENAME'],
    ['.env', 'INVALID_FILENAME'],
    ['name.', 'INVALID_FILENAME'],
    ['tab\t.png', 'INVALID_FILENAME'],
    ['nul\u0000.png', 'INVALID_FILENAME'],
    ['rlo‮gnp.exe', 'INVALID_FILENAME'],
    ['lri⁦x.png', 'INVALID_FILENAME'],
    ['c1\u0085.png', 'INVALID_FILENAME'],
    ['x'.repeat(300) + '.png', 'INVALID_FILENAME'],
    ['README', 'MISSING_EXTENSION'],
    ['shell.php.jpg', 'DANGEROUS_EXTENSION'],
    ['run.EXE', 'DANGEROUS_EXTENSION'],
    ['x.svg', 'DANGEROUS_EXTENSION'],
    ['x.HTML', 'DANGEROUS_EXTENSION'],
    ['archive.js.txt', 'DANGEROUS_EXTENSION'],
  ])('refuses %j', (name, code) => {
    expect(() => parseClientFilename(name)).toThrow(
      expect.objectContaining({ code }),
    );
  });
});

describe('Content-Disposition', () => {
  it('encodes UTF-8 with an ASCII fallback and no header injection', () => {
    expect(contentDisposition('a "b";\r\nX-Evil: 1.txt')).toBe(
      `attachment; filename="a _b__X-Evil: 1.txt"; filename*=UTF-8''a%20%22b%22%3BX-Evil%3A%201.txt`,
    );
    expect(contentDisposition("it's (1)*.pdf", 'inline')).toBe(
      `inline; filename="it's (1)*.pdf"; filename*=UTF-8''it%27s%20%281%29%2A.pdf`,
    );
    expect(contentDisposition('..\\..\\x.png')).toContain(
      'filename=".._.._x.png"',
    );
    expect(contentDisposition('‮')).toContain('filename="download"');
  });
});

describe('single Range parsing', () => {
  it.each([
    [undefined, 10, { kind: 'full' }],
    ['bytes=0-0', 10, { kind: 'partial', start: 0, end: 0 }],
    ['bytes=2-', 10, { kind: 'partial', start: 2, end: 9 }],
    ['bytes=-3', 10, { kind: 'partial', start: 7, end: 9 }],
    ['bytes=-30', 10, { kind: 'partial', start: 0, end: 9 }],
    ['bytes=5-100', 10, { kind: 'partial', start: 5, end: 9 }],
    ['BYTES = 1 - 2', 10, { kind: 'partial', start: 1, end: 2 }],
    ['bytes=10-', 10, { kind: 'unsatisfiable' }],
    ['bytes=-0', 10, { kind: 'unsatisfiable' }],
    ['bytes=0-', 0, { kind: 'unsatisfiable' }],
    ['bytes=-1', 0, { kind: 'unsatisfiable' }],
    ['bytes=5-2', 10, { kind: 'full' }],
    ['bytes=0-1,3-4', 10, { kind: 'full' }],
    ['bytes=-', 10, { kind: 'full' }],
    ['bytes=99999999999999999-', 10, { kind: 'full' }],
    ['lines=1-2', 10, { kind: 'full' }],
    ['bytes=1-2'.padEnd(300, ' '), 10, { kind: 'full' }],
  ])('%j of %d bytes', (header, size, expected) => {
    expect(parseRange(header, size)).toEqual(expected);
  });
});

describe('upload references and custom types', () => {
  const token = `nvu_${'A'.repeat(43)}`;
  const other = `nvu_${'B'.repeat(43)}`;
  it('parses Live field values strictly', () => {
    expect(isUploadToken(token)).toBe(true);
    expect(parseUploadReferences('')).toEqual([]);
    expect(parseUploadReferences(`${token},${other}`)).toEqual([token, other]);
    for (const bad of [
      `${token},${token}`,
      `${token}, ${other}`,
      'nvu_x',
      42,
      `${token},`,
    ])
      expect(() => parseUploadReferences(bad)).toThrow();
    expect(() => parseUploadReferences(`${token},${other}`, 1)).toThrow();
    const validate = uploadReferenceField({ max: 1 });
    expect(validate(token)).toBe(true);
    expect(validate(`${token},${other}`)).toBe(false);
    expect(validate({ token })).toBe(false);
  });
  it('defines custom types with detectors and refuses active content', () => {
    const zip = defineFileType({
      name: 'zip',
      extensions: ['zip'],
      mime: 'application/zip',
      detect: (head) => head[0] === 0x50 && head[1] === 0x4b,
    });
    expect(Object.isFrozen(zip)).toBe(true);
    expect(() =>
      defineFileType({
        name: 'page',
        extensions: ['htm2'],
        mime: 'text/html',
        text: true,
      }),
    ).toThrow(/active-content/);
    expect(() =>
      defineFileType({
        name: 'nodetect',
        extensions: ['bin2'],
        mime: 'application/x-thing',
      }),
    ).toThrow(/detector/);
    expect(() =>
      defineFileType({
        name: 'doc',
        extensions: ['doc'],
        mime: 'application/msword',
        detect: () => true,
        inline: true,
      }),
    ).toThrow(/inline/);
  });
});

describe('local storage canonicalization', () => {
  const storage = new LocalStorage({
    directory: join(tmpdir(), 'nestvexa-local-storage-test'),
  });
  it('maps generated keys inside the root and refuses everything else', () => {
    expect(
      storage.path(`ab/${'c'.repeat(43)}`).startsWith(storage.directory),
    ).toBe(true);
    for (const key of [
      '../x',
      `../${'c'.repeat(43)}`,
      `ab/../${'c'.repeat(41)}`,
      `/etc/${'c'.repeat(43)}`,
      `ab\\${'c'.repeat(43)}`,
      'ab/short',
      `a./${'c'.repeat(43)}`,
    ])
      expect(() => storage.path(key)).toThrow();
    expect(() => new LocalStorage({ directory: 'relative' })).toThrow();
  });
});
