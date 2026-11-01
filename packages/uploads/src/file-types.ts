/**
 * File type registry. Acceptance always needs all three: an allowlisted
 * extension, a compatible declared MIME type (or none) and matching content.
 * The stored content type is the canonical registry value, never the client's.
 */
export interface FileTypeDefinition {
  /** Registry name used in purpose allowlists, for example `png`. */
  readonly name: string;
  /** Lower-case extensions without dots. The first is canonical. */
  readonly extensions: readonly string[];
  /** Canonical media type sent on download. */
  readonly mime: string;
  /** Additional declared browser media types accepted for this type. */
  readonly aliases?: readonly string[];
  /** Validate the full byte stream as UTF-8 text without control characters or markup. */
  readonly text?: boolean;
  /** Magic-byte detector over at most the first 4096 bytes. Required unless `text`. */
  readonly detect?: (head: Uint8Array) => boolean;
  /** Raster images may be served inline; everything else is forced to attachment. */
  readonly inline?: boolean;
}

export type BuiltInFileType =
  'png' | 'jpeg' | 'gif' | 'webp' | 'pdf' | 'txt' | 'csv';

function starts(head: Uint8Array, bytes: readonly number[], at = 0): boolean {
  if (head.byteLength < at + bytes.length) return false;
  return bytes.every((byte, index) => head[at + index] === byte);
}
function ascii(text: string): number[] {
  return [...text].map((character) => character.charCodeAt(0));
}

export const FILE_TYPES: Readonly<Record<BuiltInFileType, FileTypeDefinition>> =
  Object.freeze({
    png: Object.freeze({
      name: 'png',
      extensions: Object.freeze(['png']),
      mime: 'image/png',
      inline: true,
      detect: (head: Uint8Array) =>
        starts(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    }),
    jpeg: Object.freeze({
      name: 'jpeg',
      extensions: Object.freeze(['jpg', 'jpeg']),
      mime: 'image/jpeg',
      aliases: Object.freeze(['image/jpg', 'image/pjpeg']),
      inline: true,
      detect: (head: Uint8Array) => starts(head, [0xff, 0xd8, 0xff]),
    }),
    gif: Object.freeze({
      name: 'gif',
      extensions: Object.freeze(['gif']),
      mime: 'image/gif',
      inline: true,
      detect: (head: Uint8Array) =>
        starts(head, ascii('GIF87a')) || starts(head, ascii('GIF89a')),
    }),
    webp: Object.freeze({
      name: 'webp',
      extensions: Object.freeze(['webp']),
      mime: 'image/webp',
      inline: true,
      detect: (head: Uint8Array) =>
        starts(head, ascii('RIFF')) && starts(head, ascii('WEBP'), 8),
    }),
    pdf: Object.freeze({
      name: 'pdf',
      extensions: Object.freeze(['pdf']),
      mime: 'application/pdf',
      aliases: Object.freeze(['application/x-pdf']),
      detect: (head: Uint8Array) => starts(head, ascii('%PDF-')),
    }),
    txt: Object.freeze({
      name: 'txt',
      extensions: Object.freeze(['txt']),
      mime: 'text/plain',
      text: true,
    }),
    csv: Object.freeze({
      name: 'csv',
      extensions: Object.freeze(['csv']),
      mime: 'text/csv',
      // Windows browsers commonly report spreadsheet MIME types for .csv files.
      aliases: Object.freeze([
        'application/csv',
        'application/vnd.ms-excel',
        'text/plain',
        'text/x-csv',
      ]),
      text: true,
    }),
  });

/**
 * Extensions refused anywhere in a filename (also as an inner segment such as
 * `photo.php.png`), even when a custom type tries to allow them.
 */
export const DANGEROUS_EXTENSIONS: ReadonlySet<string> = new Set([
  'exe',
  'dll',
  'com',
  'scr',
  'msi',
  'msp',
  'bat',
  'cmd',
  'ps1',
  'psm1',
  'vbs',
  'vbe',
  'js',
  'jse',
  'mjs',
  'cjs',
  'wsf',
  'wsh',
  'hta',
  'cpl',
  'jar',
  'class',
  'sh',
  'bash',
  'zsh',
  'csh',
  'ksh',
  'command',
  'app',
  'dmg',
  'pkg',
  'deb',
  'rpm',
  'apk',
  'elf',
  'so',
  'dylib',
  'bin',
  'run',
  'php',
  'php3',
  'php4',
  'php5',
  'phtml',
  'phar',
  'asp',
  'aspx',
  'ashx',
  'asmx',
  'jsp',
  'jspx',
  'cgi',
  'pl',
  'py',
  'pyc',
  'rb',
  'lnk',
  'url',
  'reg',
  'inf',
  'html',
  'htm',
  'xhtml',
  'shtml',
  'svg',
  'svgz',
  'xml',
  'xsl',
  'xslt',
  'htaccess',
  'swf',
  'iso',
  'img',
  'vhd',
  'vhdx',
  'docm',
  'xlsm',
  'pptm',
]);

const dangerousMimes =
  /^(?:text\/html|application\/xhtml\+xml|image\/svg\+xml|(?:text|application)\/(?:x-)?(?:javascript|ecmascript)|text\/xml|application\/xml|application\/x-(?:msdownload|msdos-program|executable|sh|httpd-php)|application\/java-archive)$/;

/** Executables and active documents identified from their first bytes. */
export function dangerousContent(head: Uint8Array): boolean {
  if (
    starts(head, ascii('MZ')) ||
    starts(head, [0x7f, 0x45, 0x4c, 0x46]) ||
    starts(head, [0xfe, 0xed, 0xfa, 0xce]) ||
    starts(head, [0xfe, 0xed, 0xfa, 0xcf]) ||
    starts(head, [0xce, 0xfa, 0xed, 0xfe]) ||
    starts(head, [0xcf, 0xfa, 0xed, 0xfe]) ||
    starts(head, [0xca, 0xfe, 0xba, 0xbe]) ||
    starts(head, ascii('#!')) ||
    starts(head, [0x00, 0x61, 0x73, 0x6d])
  )
    return true;
  return looksLikeMarkup(head);
}

/** HTML, SVG and XML documents are refused even if renamed to .txt or .csv. */
export function looksLikeMarkup(head: Uint8Array): boolean {
  let text = new TextDecoder('utf-8', { fatal: false })
    .decode(head.subarray(0, 1024))
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase();
  // UTF-16 encoded markup decodes with NULs between characters.
  text = text.replaceAll('\u0000', '');
  return /^<(?:!doctype\s+html|html|head|body|script|svg|iframe|object|embed|\?xml|!--|meta|a\s|img\s|style)/.test(
    text,
  );
}

/** Binary signature of any built-in type, used to refuse binary data posing as text. */
export function knownBinarySignature(head: Uint8Array): boolean {
  return Object.values(FILE_TYPES).some(
    (type) => type.detect !== undefined && type.detect(head),
  );
}

/** Incremental UTF-8 text check: no NUL/C0/DEL/C1 controls except tab, LF, CR and form feed. */
export class TextValidator {
  readonly #decoder = new TextDecoder('utf-8', { fatal: true });
  #valid = true;
  push(chunk: Uint8Array): void {
    if (!this.#valid) return;
    for (const byte of chunk)
      if (
        (byte < 0x20 &&
          byte !== 0x09 &&
          byte !== 0x0a &&
          byte !== 0x0d &&
          byte !== 0x0c) ||
        byte === 0x7f
      ) {
        this.#valid = false;
        return;
      }
    try {
      const text = this.#decoder.decode(chunk, { stream: true });
      if (/[\u0080-\u009f]/.test(text)) this.#valid = false;
    } catch {
      this.#valid = false;
    }
  }
  finish(): boolean {
    if (!this.#valid) return false;
    try {
      this.#decoder.decode();
    } catch {
      return false;
    }
    return true;
  }
}

const mimePattern =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;
const namePattern = /^[a-z][a-z0-9-]{0,31}$/;
const extensionPattern = /^[a-z0-9]{1,16}$/;

/** Validate and freeze an application-defined type. Dangerous extensions/MIME types are refused. */
export function defineFileType(
  definition: FileTypeDefinition,
): FileTypeDefinition {
  if (
    !definition ||
    typeof definition !== 'object' ||
    typeof definition.name !== 'string' ||
    !namePattern.test(definition.name) ||
    !Array.isArray(definition.extensions) ||
    definition.extensions.length < 1 ||
    definition.extensions.length > 8 ||
    !definition.extensions.every(
      (extension: unknown) =>
        typeof extension === 'string' && extensionPattern.test(extension),
    ) ||
    typeof definition.mime !== 'string' ||
    !mimePattern.test(definition.mime) ||
    (definition.aliases !== undefined &&
      (!Array.isArray(definition.aliases) ||
        definition.aliases.length > 8 ||
        !definition.aliases.every(
          (alias: unknown) =>
            typeof alias === 'string' && mimePattern.test(alias),
        ))) ||
    (definition.text !== undefined && typeof definition.text !== 'boolean') ||
    (definition.detect !== undefined &&
      typeof definition.detect !== 'function') ||
    (definition.inline !== undefined &&
      typeof definition.inline !== 'boolean') ||
    (definition.text !== true && typeof definition.detect !== 'function')
  )
    throw new Error(
      'Invalid file type definition: name, extensions, MIME type and a detector (or text: true) are required',
    );
  if (
    definition.extensions.some((extension) =>
      DANGEROUS_EXTENSIONS.has(extension),
    )
  )
    throw new Error(`File type ${definition.name} uses a refused extension`);
  if (
    [definition.mime, ...(definition.aliases ?? [])].some((mime) =>
      dangerousMimes.test(mime),
    )
  )
    throw new Error(
      `File type ${definition.name} uses an active-content MIME type`,
    );
  if (definition.inline === true && !definition.mime.startsWith('image/'))
    throw new Error('Only raster image types may be served inline');
  return Object.freeze({
    name: definition.name,
    extensions: Object.freeze([...definition.extensions]),
    mime: definition.mime,
    ...(definition.aliases === undefined
      ? {}
      : { aliases: Object.freeze([...definition.aliases]) }),
    ...(definition.text === undefined ? {} : { text: definition.text }),
    ...(definition.detect === undefined ? {} : { detect: definition.detect }),
    ...(definition.inline === undefined ? {} : { inline: definition.inline }),
  });
}

/** Normalize a declared header value: lower case, parameters removed; empty means undeclared. */
export function declaredMime(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 255) return '\u0000invalid';
  const mime = value.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!mime || mime === 'application/octet-stream') return undefined;
  return mime;
}

/** True when a declared type is absent or compatible with the registry type. */
export function mimeCompatible(
  type: FileTypeDefinition,
  declared: string | undefined,
): boolean {
  return (
    declared === undefined ||
    declared === type.mime ||
    (type.aliases ?? []).includes(declared)
  );
}
