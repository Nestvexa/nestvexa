import 'reflect-metadata';
import { Inject, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import { I18n } from '../packages/i18n/dist/index.js';
import {
  ConsoleMailTransport,
  MailError,
  MailModule,
  MailTemplates,
  Mailer,
  MemoryMailTransport,
  NotificationBridge,
  htmlToText,
  mailChannel,
  nestMailerTransport,
  nodemailerTransport,
  realtimeChannel,
} from '../packages/mail/dist/index.js';
import type {
  MailDeliveryEvent,
  SendMailOptions,
} from '../packages/mail/dist/index.js';

let root = '';
let engine: HbsEngine;

async function view(path: string, content: string): Promise<void> {
  const file = join(root, path);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, content);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'nestvexa-mail-'));
  // The application's page layout must never wrap mail.
  await view('layout.hbs', '<html><body class="site">{{{body}}}</body></html>');
  await view(
    'emails/layout.hbs',
    '<html lang="{{locale}}"><body class="mail">{{{body}}}</body></html>',
  );
  await view('emails/welcome.subject.hbs', 'Welcome, {{name}} & friends\n');
  await view(
    'emails/welcome.html.hbs',
    '<h1>Hello {{name}}</h1>\n<p>Confirm: <a href="{{url}}">your account</a></p>\n',
  );
  await view('emails/welcome.text.hbs', 'Hello {{name}}\nConfirm: {{url}}\n');
  await view('emails/invoice/paid.subject.hbs', '{{t "mail.paid"}}');
  await view(
    'emails/invoice/paid.html.hbs',
    '<p>{{t "mail.amount" amount=amount}}</p>',
  );
  await view(
    'emails/invoice/paid.text.hbs',
    '{{t "mail.amount" amount=amount}}',
  );
  engine = new HbsEngine({ root, defaultLayout: 'layout' });
  await engine.initialize();
});
afterAll(async () => {
  await engine.dispose();
  await rm(root, { recursive: true, force: true });
});

describe('MailTemplates', () => {
  it('renders subject, html and text through the real HBS engine', async () => {
    const templates = new MailTemplates({ renderer: engine });
    const mail = await templates.render('welcome', {
      name: 'Ada <b>',
      url: 'https://example.test/confirm?a=1&b=2',
    });
    expect(mail.subject).toBe('Welcome, Ada <b> & friends');
    // HTML keeps the engine's escaping; the page layout is not applied.
    expect(mail.html).toBe(
      '<h1>Hello Ada &lt;b&gt;</h1>\n<p>Confirm: <a href="https://example.test/confirm?a&#x3D;1&amp;b&#x3D;2">your account</a></p>\n',
    );
    expect(mail.html).not.toContain('class="site"');
    // Text is plain text: no HTML entities shown to the reader.
    expect(mail.text).toBe(
      'Hello Ada <b>\nConfirm: https://example.test/confirm?a=1&b=2',
    );
  });

  it('applies a mail layout and derives text when asked', async () => {
    const templates = new MailTemplates({
      renderer: engine,
      layout: 'emails/layout',
      text: 'derive',
    });
    const mail = await templates.render(
      'welcome',
      { name: 'Grace', url: 'https://example.test/c' },
      { locale: 'en-GB' },
    );
    expect(mail.html).toContain(
      '<html lang="en-GB"><body class="mail"><h1>Hello Grace</h1>',
    );
    expect(mail.text).toBe(
      'Hello Grace\n\nConfirm: your account (https://example.test/c)',
    );
  });

  it('localizes with @nestvexa/i18n helpers per render', async () => {
    const i18n = new I18n({
      locales: ['en', 'ar'],
      defaultLocale: 'en',
      timeZone: 'UTC',
      catalogs: {
        en: {
          common: {
            mail: { paid: 'Invoice paid', amount: 'Amount: {amount, number}' },
          },
        },
        ar: {
          common: {
            mail: {
              paid: 'تم دفع الفاتورة',
              amount: 'المبلغ: {amount, number}',
            },
          },
        },
      },
    });
    const templates = new MailTemplates({ renderer: engine });
    const helpers = i18n.helpers();
    const english = await templates.render(
      'invoice/paid',
      { amount: 1234.5 },
      { locale: 'en', helpers },
    );
    expect(english).toMatchObject({
      subject: 'Invoice paid',
      text: 'Amount: 1,234.5',
    });
    const arabic = await templates.render(
      'invoice/paid',
      { amount: 1234.5 },
      { locale: 'ar', helpers },
    );
    expect(arabic.subject).toBe('تم دفع الفاتورة');
    // A model-supplied i18n view (lang/dir for the layout) selects the locale too.
    const viewed = await templates.render(
      'invoice/paid',
      { amount: 1, i18n: i18n.view('ar') },
      { helpers },
    );
    expect(viewed.subject).toBe('تم دفع الفاتورة');
    expect(arabic.text).toBe(
      `المبلغ: ${new Intl.NumberFormat('ar').format(1234.5)}`,
    );
  });

  it('wraps engine failures and rejects unsafe template names', async () => {
    const templates = new MailTemplates({ renderer: engine });
    await expect(templates.render('missing')).rejects.toMatchObject({
      code: 'TEMPLATE_FAILED',
    });
    for (const name of [
      '../layout',
      'Welcome',
      'a//b',
      '/abs',
      'a\\b',
      'x.html',
    ])
      await expect(templates.render(name)).rejects.toMatchObject({
        code: 'TEMPLATE_FAILED',
        message: 'Invalid mail template name',
      });
    await expect(
      templates.render('welcome', {}, { locale: 'en\nX' }),
    ).rejects.toMatchObject({
      code: 'TEMPLATE_FAILED',
    });
    expect(
      () => new MailTemplates({ renderer: engine, directory: '../x' }),
    ).toThrow(MailError);
  });

  it('derives readable text from HTML without executing anything', () => {
    expect(
      htmlToText(
        '<head><title>T</title><style>p{}</style></head><!-- c --><script>x()</script>' +
          '<h1>Title</h1><p>One &amp; two<br>three</p><ul><li>a</li><li>b</li></ul>' +
          '<a href="https://x.test/?a=1&amp;b=2">https://x.test/?a=1&b=2</a> <a href=\'/y\'><b>Y</b></a>',
      ),
    ).toBe(
      'Title\n\nOne & two\nthree\n\n- a\n- b\n\nhttps://x.test/?a=1&b=2 Y (/y)',
    );
    // Unterminated markup is kept as text, and a long hostile input stays linear.
    expect(htmlToText('a < b')).toBe('a < b');
    const started = performance.now();
    htmlToText('<a'.repeat(200_000));
    htmlToText('<a href="x">'.repeat(50_000));
    htmlToText('<style'.repeat(100_000));
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

// Nest module compilation is slow on loaded hosts.
describe('Mailer and MailModule', { timeout: 60_000 }, () => {
  it('sends templated mail through the module with the default sender', async () => {
    const transport = new MemoryMailTransport();
    const events: MailDeliveryEvent[] = [];
    const moduleRef = await Test.createTestingModule({
      imports: [
        MailModule.forRoot({
          transport,
          from: { address: 'noreply@example.test', name: 'Example' },
          templates: { renderer: engine },
          onDelivery: (event) => events.push(event),
        }),
      ],
    }).compile();
    const mailer = moduleRef.get(Mailer);
    expect(mailer.transport).toBe('memory (test transport)');
    const delivery = await mailer.sendTemplate('welcome', {
      to: 'ada@example.test',
      bcc: ['audit@example.test'],
      model: { name: 'Ada', url: 'https://example.test/c' },
      headers: { 'List-Unsubscribe': '<https://example.test/u>' },
    });
    expect(delivery.id).toMatch(/^memory-/);
    expect(transport.byId(delivery.id)).toBe(delivery.message);
    expect(transport.last()).toMatchObject({
      from: { address: 'noreply@example.test', name: 'Example' },
      to: [{ address: 'ada@example.test' }],
      bcc: [{ address: 'audit@example.test' }],
      subject: 'Welcome, Ada & friends',
      text: 'Hello Ada\nConfirm: https://example.test/c',
      headers: { 'List-Unsubscribe': '<https://example.test/u>' },
    });
    expect(transport.to('AUDIT@example.test')).toHaveLength(1);
    expect(events).toEqual([
      {
        id: delivery.id,
        transport: 'memory (test transport)',
        template: 'welcome',
        recipients: 2,
        ok: true,
      },
    ]);
    // Events carry no content.
    expect(JSON.stringify(events)).not.toContain('ada@example.test');
    await moduleRef.close();
  });

  it('builds options asynchronously from injected providers (the app HbsEngine)', async () => {
    const transport = new MemoryMailTransport();
    @Module({
      providers: [{ provide: HbsEngine, useValue: engine }],
      exports: [HbsEngine],
    })
    class ViewsModule {}
    @Injectable()
    class Signup {
      constructor(@Inject(Mailer) private readonly mailer: Mailer) {}
      welcome(email: string) {
        return this.mailer.sendTemplate('welcome', {
          to: email,
          model: { name: 'Lin', url: 'https://example.test/w' },
        });
      }
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        MailModule.forRootAsync({
          global: true,
          imports: [ViewsModule],
          inject: [HbsEngine],
          useFactory: (views: HbsEngine) => ({
            transport,
            from: 'noreply@example.test',
            templates: { renderer: views },
          }),
        }),
      ],
      providers: [Signup],
    }).compile();
    await moduleRef.get(Signup).welcome('lin@example.test');
    expect(transport.last()?.subject).toBe('Welcome, Lin & friends');
    await moduleRef.close();
  });

  it('reports transport failures with a closed code and no recipient in the message', async () => {
    const events: MailDeliveryEvent[] = [];
    const mailer = new Mailer({
      transport: {
        name: 'broken',
        send: () =>
          Promise.reject(new Error('smtp down for secret@example.test')),
      },
      from: 'noreply@example.test',
      onDelivery: (event) => {
        events.push(event);
        throw new Error('hook failures are ignored');
      },
    });
    const failure = await mailer
      .send({ to: 'secret@example.test', subject: 'Hi', text: 'x' })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MailError);
    expect(failure).toMatchObject({
      code: 'TRANSPORT_FAILED',
      message: 'Mail transport broken failed',
    });
    expect(events).toEqual([
      {
        transport: 'broken',
        recipients: 1,
        ok: false,
        error: 'TRANSPORT_FAILED',
      },
    ]);
    await expect(
      new Mailer({ transport: new MemoryMailTransport() }).sendTemplate(
        'welcome',
        {
          to: 'a@example.test',
        },
      ),
    ).rejects.toMatchObject({ code: 'TEMPLATE_FAILED' });
    expect(
      () =>
        new Mailer({
          transport: new MemoryMailTransport(),
          from: 'not an address',
        }),
    ).toThrow(MailError);
  });
});

describe('transports', () => {
  it('maps messages to nodemailer and @nestjs-modules/mailer sendMail options', async () => {
    const sent: SendMailOptions[] = [];
    const transporter = {
      sendMail: (options: SendMailOptions) => {
        sent.push(options);
        return Promise.resolve({ messageId: '<abc@smtp.example.test>' });
      },
    };
    const mailer = new Mailer({
      transport: nodemailerTransport(transporter),
      from: { address: 'noreply@example.test', name: 'Billing "Team"' },
    });
    const delivery = await mailer.send({
      to: [{ address: 'ada@example.test', name: 'Ada L.' }],
      cc: 'cc@example.test',
      replyTo: 'support@example.test',
      subject: 'Receipt',
      html: '<p>Paid</p>',
    });
    expect(delivery).toMatchObject({
      id: '<abc@smtp.example.test>',
      transport: 'nodemailer',
    });
    expect(sent).toEqual([
      {
        from: '"Billing \\"Team\\"" <noreply@example.test>',
        to: ['"Ada L." <ada@example.test>'],
        cc: ['cc@example.test'],
        replyTo: 'support@example.test',
        subject: 'Receipt',
        html: '<p>Paid</p>',
        text: 'Paid',
        headers: {},
      },
    ]);
    const nest = nestMailerTransport({
      sendMail: () => Promise.resolve(undefined),
    });
    expect(nest.name).toBe('@nestjs-modules/mailer');
    const generated = await new Mailer({
      transport: nest,
      from: 'a@example.test',
    }).send({
      to: 'b@example.test',
      subject: 'S',
      text: 'T',
    });
    expect(generated.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(() => nodemailerTransport({} as never)).toThrow(MailError);
  });

  it('logs development mail through the logger, never bcc addresses or HTML', async () => {
    const lines: string[] = [];
    const transport = new ConsoleMailTransport({
      logger: { log: (line) => lines.push(line) },
    });
    await new Mailer({ transport, from: 'noreply@example.test' }).send({
      to: 'ada@example.test',
      bcc: ['hidden@example.test'],
      subject: 'Reset',
      html: '<p>Reset: <a href="https://example.test/r/token">link</a></p>',
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('(not sent)');
    expect(lines[0]).toContain('To: ada@example.test');
    expect(lines[0]).toContain('Bcc: 1 recipient(s)');
    expect(lines[0]).toContain('Reset: link (https://example.test/r/token)');
    expect(lines[0]).not.toContain('hidden@example.test');
    expect(lines[0]).not.toContain('<p>');
    const quiet: string[] = [];
    await new ConsoleMailTransport({
      logger: { log: (line) => quiet.push(line) },
      includeText: false,
    }).send(
      (
        await new Mailer({
          transport: new MemoryMailTransport(),
          from: 'a@example.test',
        }).send({
          to: 'b@example.test',
          subject: 'S',
          text: 'secret-link',
        })
      ).message,
    );
    expect(quiet[0]).not.toContain('secret-link');
  });

  it('bounds the memory transport', async () => {
    const transport = new MemoryMailTransport({ maxMessages: 2 });
    const mailer = new Mailer({ transport, from: 'a@example.test' });
    for (const subject of ['one', 'two', 'three'])
      await mailer.send({ to: 'b@example.test', subject, text: subject });
    expect(transport.messages.map((message) => message.subject)).toEqual([
      'two',
      'three',
    ]);
    transport.clear();
    expect(transport.messages).toEqual([]);
    expect(() => new MemoryMailTransport({ maxMessages: 0 })).toThrow(
      MailError,
    );
  });
});

describe('NotificationBridge', () => {
  it('fans out to mail and realtime channels independently', async () => {
    const transport = new MemoryMailTransport();
    const mailer = new Mailer({
      transport,
      from: 'noreply@example.test',
      templates: { renderer: engine },
    });
    const published: { channel: string; data: unknown }[] = [];
    interface User {
      readonly id: number;
      readonly email?: string;
      readonly locale: string;
    }
    const bridge = new NotificationBridge<User>([
      mailChannel<User>(mailer, {
        address: (user) => user.email,
        locale: (user) => user.locale,
        template: () => 'welcome',
      }),
      realtimeChannel<User>(
        {
          publish: (channel, data) => {
            published.push({ channel, data });
            return Promise.resolve({});
          },
        },
        { channel: (user) => `user:${user.id}:notifications` },
      ),
    ]);
    const results = await bridge.notify(
      { id: 7, email: 'ada@example.test', locale: 'en' },
      {
        type: 'account.welcome',
        data: { name: 'Ada', url: 'https://example.test/c' },
      },
    );
    expect(results).toEqual([
      { channel: 'mail', status: 'delivered' },
      { channel: 'realtime', status: 'delivered' },
    ]);
    expect(transport.last()?.subject).toBe('Welcome, Ada & friends');
    // Realtime payloads default to the type only.
    expect(published).toEqual([
      { channel: 'user:7:notifications', data: { type: 'account.welcome' } },
    ]);
    const skipped = await bridge.notify(
      { id: 8, locale: 'en' },
      { type: 'account.welcome' },
    );
    expect(skipped[0]).toEqual({ channel: 'mail', status: 'skipped' });
    // A failing mail channel does not stop the realtime update.
    const failed = await bridge.notify(
      { id: 9, email: 'bad address', locale: 'en' },
      { type: 'account.welcome', data: { name: 'X', url: 'u' } },
    );
    expect(failed).toEqual([
      { channel: 'mail', status: 'failed', error: 'INVALID_ADDRESS' },
      { channel: 'realtime', status: 'delivered' },
    ]);
    expect(
      await bridge.notify(
        { id: 1, locale: 'en' },
        { type: 'x' },
        { channels: ['realtime'] },
      ),
    ).toEqual([{ channel: 'realtime', status: 'delivered' }]);
    await expect(
      bridge.notify(
        { id: 1, locale: 'en' },
        { type: 'x' },
        { channels: ['sms'] },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_MESSAGE' });
    await expect(
      bridge.notify({ id: 1, locale: 'en' }, { type: 'Bad Type' }),
    ).rejects.toMatchObject({ code: 'INVALID_MESSAGE' });
    expect(
      () =>
        new NotificationBridge([
          { name: 'mail', deliver: () => Promise.resolve() },
          { name: 'mail', deliver: () => Promise.resolve() },
        ]),
    ).toThrow(MailError);
  });
});
