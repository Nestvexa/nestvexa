import 'reflect-metadata';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import {
  ConsoleMailTransport,
  MailError,
  Mailer,
  MemoryMailTransport,
  formatMailbox,
  isMailAddress,
  normalizeMailMessage,
} from '../packages/mail/dist/index.js';
import type { MailMessage } from '../packages/mail/dist/index.js';

const base: MailMessage = {
  from: 'noreply@example.test',
  to: 'ada@example.test',
  subject: 'Hello',
  text: 'Body',
};
function code(
  message: { readonly [K in keyof MailMessage]?: MailMessage[K] | undefined },
  limits = {},
): string | undefined {
  try {
    normalizeMailMessage({ ...base, ...message } as MailMessage, {}, limits);
    return undefined;
  } catch (error) {
    if (error instanceof MailError) return error.code;
    throw error;
  }
}
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const LS = String.fromCharCode(0x2028);
const NUL = String.fromCharCode(0);

describe('header injection', () => {
  it('rejects CR, LF, NUL and Unicode line separators in every header field', () => {
    for (const separator of [CR, LF, `${CR}${LF}`, NUL, LS]) {
      const injected = `Hi${separator}Bcc: victim@evil.test`;
      expect(code({ subject: injected }), 'subject').toBe('INVALID_HEADER');
      expect(code({ headers: { 'X-Tag': injected } }), 'header').toBe(
        'INVALID_HEADER',
      );
      expect(
        code({ to: { address: 'ada@example.test', name: injected } }),
        'name',
      ).toBe('INVALID_ADDRESS');
      expect(code({ to: `ada@example.test${separator}` }), 'to').toBe(
        'INVALID_ADDRESS',
      );
      expect(code({ replyTo: `a${separator}@example.test` }), 'reply-to').toBe(
        'INVALID_ADDRESS',
      );
      expect(
        code({ from: { address: 'noreply@example.test', name: injected } }),
      ).toBe('INVALID_ADDRESS');
    }
  });

  it('reserves address and MIME headers for the typed fields', () => {
    for (const name of [
      'Bcc',
      'to',
      'FROM',
      'Reply-To',
      'Content-Type',
      'Subject',
      'Sender',
    ])
      expect(code({ headers: { [name]: 'x' } }), name).toBe('INVALID_HEADER');
    for (const name of ['X Tag', 'X:Tag', '', '-x', 'é'])
      expect(code({ headers: { [name]: 'x' } }), name).toBe('INVALID_HEADER');
    expect(code({ headers: { 'X-A': '1', 'x-a': '2' } })).toBe(
      'INVALID_HEADER',
    );
    expect(code({ headers: { 'X-Long': 'x'.repeat(999) } })).toBe(
      'INVALID_HEADER',
    );
    expect(
      code({ headers: { 'X-Ok': 'value', 'List-Id': '<a.example.test>' } }),
    ).toBeUndefined();
  });

  it('folds templated subjects to one line so model values cannot add headers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nestvexa-mail-sec-'));
    try {
      await mkdir(join(root, 'emails'));
      await writeFile(join(root, 'emails/hi.subject.hbs'), 'Hi {{name}}');
      await writeFile(join(root, 'emails/hi.html.hbs'), '<p>{{name}}</p>');
      await writeFile(join(root, 'emails/hi.text.hbs'), '{{name}}');
      const engine = new HbsEngine({ root });
      await engine.initialize();
      const transport = new MemoryMailTransport();
      const mailer = new Mailer({
        transport,
        from: 'noreply@example.test',
        templates: { renderer: engine },
      });
      await mailer.sendTemplate('hi', {
        to: 'ada@example.test',
        model: { name: `Eve${CR}${LF}Bcc: victim@evil.test${LS}X` },
      });
      expect(transport.last()?.subject).toBe('Hi Eve Bcc: victim@evil.test X');
      expect(transport.last()?.bcc).toEqual([]);
      // A control character that is not whitespace is rejected, not folded.
      await expect(
        mailer.sendTemplate('hi', {
          to: 'ada@example.test',
          model: { name: `a${NUL}b` },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_HEADER' });
      await engine.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('addresses and limits', () => {
  it('accepts ordinary addresses and rejects malformed ones', () => {
    for (const address of [
      'ada@example.test',
      'first.last+tag@sub.example.co',
      "o'brien@example.org",
    ])
      expect(isMailAddress(address), address).toBe(true);
    for (const address of [
      'plain',
      '@example.test',
      'a@',
      'a@b',
      'a@@example.test',
      'a@exa mple.test',
      '"quoted"@example.test',
      'a..b@example.test',
      '.a@example.test',
      'a@-example.test',
      'a@example.123',
      'a@[127.0.0.1]',
      'Ada <ada@example.test>',
      'a,b@example.test',
      `${'a'.repeat(65)}@example.test`,
      `a@${'b'.repeat(250)}.test`,
      42,
      null,
    ])
      expect(isMailAddress(address), String(address)).toBe(false);
  });

  it('bounds recipients, headers and body size', () => {
    const many = Array.from(
      { length: 51 },
      (_, index) => `u${index}@example.test`,
    );
    expect(code({ to: many })).toBe('TOO_MANY_RECIPIENTS');
    expect(
      code({
        to: many.slice(0, 20),
        cc: many.slice(20, 40),
        bcc: many.slice(40),
      }),
    ).toBe('TOO_MANY_RECIPIENTS');
    expect(code({ to: many.slice(0, 3) }, { maxRecipients: 2 })).toBe(
      'TOO_MANY_RECIPIENTS',
    );
    expect(code({ to: [] })).toBe('INVALID_ADDRESS');
    expect(code({ text: 'x'.repeat(11) }, { maxBodyBytes: 10 })).toBe(
      'INVALID_MESSAGE',
    );
    // The size check runs before the HTML is converted to text.
    expect(
      code(
        { text: undefined, html: '<p>x</p>'.repeat(10) },
        { maxBodyBytes: 20 },
      ),
    ).toBe('INVALID_MESSAGE');
    const headers = Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => [`X-H${index}`, 'v']),
    );
    expect(code({ headers })).toBe('INVALID_HEADER');
    expect(code({ text: undefined })).toBe('INVALID_MESSAGE');
    expect(code({ subject: '   ' })).toBe('INVALID_HEADER');
    expect(code({ from: undefined })).toBe('INVALID_ADDRESS');
    expect(code({}, { maxRecipients: 0 })).toBe('INVALID_MESSAGE');
  });

  it('quotes display names so they cannot change the address', () => {
    const message = normalizeMailMessage({
      ...base,
      to: { address: 'ada@example.test', name: 'Eve" <evil@evil.test>, "x' },
    });
    expect(
      formatMailbox(message.to[0] ?? { address: 'missing@example.test' }),
    ).toBe('"Eve\\" <evil@evil.test>, \\"x" <ada@example.test>');
    expect(Object.isFrozen(message)).toBe(true);
    expect(Object.isFrozen(message.to)).toBe(true);
  });
});

describe('production safety of non-delivering transports', () => {
  const previous = process.env['NODE_ENV'];
  afterEach(() => {
    if (previous === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = previous;
  });
  beforeAll(() => undefined);
  afterAll(() => undefined);

  it('refuses the console and memory transports in production unless allowed', () => {
    process.env['NODE_ENV'] = 'production';
    expect(() => new ConsoleMailTransport()).toThrow(
      expect.objectContaining({ code: 'UNSAFE_ENVIRONMENT' }),
    );
    expect(() => new MemoryMailTransport()).toThrow(
      expect.objectContaining({ code: 'UNSAFE_ENVIRONMENT' }),
    );
    expect(
      () =>
        new ConsoleMailTransport({
          allowProduction: true,
          logger: { log: () => undefined },
        }),
    ).not.toThrow();
    expect(
      () => new MemoryMailTransport({ allowProduction: true }),
    ).not.toThrow();
  });
});
