/**
 * EXT-029: `nodemailerTransport` against a real SMTP conversation. A real
 * nodemailer SMTP transporter delivers to an in-process `smtp-server` on
 * loopback; delivery, recipient rejection, an unreachable server, a server
 * that never greets (timeout) and header injection are covered end to end.
 */
import 'reflect-metadata';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import nodemailer from 'nodemailer';
import { SMTPServer } from 'smtp-server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  MailError,
  Mailer,
  nodemailerTransport,
} from '../packages/mail/dist/index.js';
import type { MailDeliveryEvent } from '../packages/mail/dist/index.js';

const smtpPort = 4246;
const closedPort = 4247;
const silentPort = 4248;

interface Received {
  readonly from: string;
  readonly to: readonly string[];
  readonly raw: string;
}
const received: Received[] = [];
let connections = 0;

const server = new SMTPServer({
  // Loopback test server: no TLS, no authentication.
  disabledCommands: ['STARTTLS', 'AUTH'],
  logger: false,
  onConnect(_session, callback) {
    connections++;
    callback();
  },
  onRcptTo(address, _session, callback) {
    if (address.address.endsWith('@rejected.test')) {
      const error = new Error('Mailbox unavailable') as Error & {
        responseCode: number;
      };
      error.responseCode = 550;
      callback(error);
      return;
    }
    callback();
  },
  onData(stream, session, callback) {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      const from = session.envelope.mailFrom;
      received.push({
        from: from === false ? '' : from.address,
        to: session.envelope.rcptTo.map((rcpt) => rcpt.address),
        raw: Buffer.concat(chunks).toString('utf8'),
      });
      callback();
    });
  },
});
/** Accepts TCP connections and never sends the SMTP greeting. */
const silent: Server = createServer((socket: Socket) => {
  silentSockets.add(socket);
  socket.on('close', () => silentSockets.delete(socket));
});
const silentSockets = new Set<Socket>();

const transporter = (port: number, timeouts: Record<string, number> = {}) =>
  nodemailer.createTransport({
    host: '127.0.0.1',
    port,
    secure: false,
    ignoreTLS: true,
    ...timeouts,
  });

beforeAll(async () => {
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(smtpPort, '127.0.0.1', () => done());
  });
  await new Promise<void>((done, fail) => {
    silent.once('error', fail);
    silent.listen(silentPort, '127.0.0.1', () => done());
  });
});
afterAll(async () => {
  for (const socket of silentSockets) socket.destroy();
  await new Promise<void>((done) => silent.close(() => done()));
  await new Promise<void>((done) => server.close(() => done()));
});
afterEach(() => {
  received.length = 0;
  connections = 0;
});

/** Unfolded header value from a raw RFC 5322 message. */
function header(raw: string, name: string): string | undefined {
  const head = raw.split('\r\n\r\n')[0] ?? '';
  const unfolded = head.replace(/\r\n[ \t]+/g, ' ');
  const line = unfolded
    .split('\r\n')
    .find((entry) => entry.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line?.slice(name.length + 1).trim();
}

describe('nodemailerTransport over real SMTP (EXT-029)', () => {
  it('delivers the rendered message with envelope, headers and both parts', async () => {
    const events: MailDeliveryEvent[] = [];
    const mailer = new Mailer({
      transport: nodemailerTransport(transporter(smtpPort)),
      from: { address: 'noreply@example.test', name: 'Billing "Team"' },
      onDelivery: (event) => events.push(event),
    });
    const delivery = await mailer.send({
      to: [{ address: 'ada@example.test', name: 'Ada L.' }],
      cc: 'cc@example.test',
      bcc: 'audit@example.test',
      replyTo: 'support@example.test',
      subject: 'Receipt 42',
      html: '<p>Paid <b>42</b> EUR</p>',
      headers: { 'List-Unsubscribe': '<https://example.test/unsubscribe>' },
    });
    expect(delivery.transport).toBe('nodemailer');
    expect(received).toHaveLength(1);
    const [message] = received;
    if (!message) throw new Error('No message received');
    expect(message.from).toBe('noreply@example.test');
    expect([...message.to].sort()).toEqual([
      'ada@example.test',
      'audit@example.test',
      'cc@example.test',
    ]);
    const { raw } = message;
    expect(header(raw, 'From')).toBe(
      '"Billing \\"Team\\"" <noreply@example.test>',
    );
    expect(header(raw, 'To')).toBe('"Ada L." <ada@example.test>');
    expect(header(raw, 'Cc')).toBe('cc@example.test');
    expect(header(raw, 'Reply-To')).toBe('support@example.test');
    expect(header(raw, 'Subject')).toBe('Receipt 42');
    expect(header(raw, 'List-Unsubscribe')).toBe(
      '<https://example.test/unsubscribe>',
    );
    // Bcc recipients get the mail through the envelope only.
    expect(header(raw, 'Bcc')).toBeUndefined();
    expect(raw).not.toContain('audit@example.test');
    expect(header(raw, 'Message-ID')).toBe(delivery.id);
    expect(header(raw, 'Content-Type')).toMatch(/^multipart\/alternative/);
    expect(raw).toContain('Content-Type: text/plain');
    expect(raw).toContain('Paid 42 EUR');
    expect(raw).toContain('Content-Type: text/html');
    expect(raw).toContain('<p>Paid <b>42</b> EUR</p>');
    expect(events).toEqual([
      {
        transport: 'nodemailer',
        recipients: 3,
        id: delivery.id,
        ok: true,
      },
    ]);
  });

  it('reports a rejected recipient as TRANSPORT_FAILED with the SMTP error as cause', async () => {
    const events: MailDeliveryEvent[] = [];
    const mailer = new Mailer({
      transport: nodemailerTransport(transporter(smtpPort)),
      from: 'noreply@example.test',
      onDelivery: (event) => events.push(event),
    });
    const failure = await mailer
      .send({ to: 'ghost@rejected.test', subject: 'Hi', text: 'Hello' })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(MailError);
    expect(failure).toMatchObject({ code: 'TRANSPORT_FAILED' });
    // The message names the transport, never the recipient.
    expect(String((failure as Error).message)).not.toContain('ghost');
    const cause: unknown = (failure as Error).cause;
    expect(cause).toMatchObject({ responseCode: 550 });
    expect(received).toEqual([]);
    expect(events).toEqual([
      {
        transport: 'nodemailer',
        recipients: 1,
        ok: false,
        error: 'TRANSPORT_FAILED',
      },
    ]);
  });

  it('fails with TRANSPORT_FAILED when the SMTP server is unreachable', async () => {
    const mailer = new Mailer({
      transport: nodemailerTransport(
        transporter(closedPort, { connectionTimeout: 2000 }),
      ),
      from: 'noreply@example.test',
    });
    const failure = await mailer
      .send({ to: 'ada@example.test', subject: 'Hi', text: 'Hello' })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toMatchObject({ code: 'TRANSPORT_FAILED' });
    expect((failure as Error).cause).toMatchObject({ code: 'ESOCKET' });
    expect(String((failure as Error).cause)).toContain('ECONNREFUSED');
  });

  it('times out against a server that never greets', async () => {
    const mailer = new Mailer({
      transport: nodemailerTransport(
        transporter(silentPort, { greetingTimeout: 300, socketTimeout: 1000 }),
      ),
      from: 'noreply@example.test',
    });
    const started = Date.now();
    const failure = await mailer
      .send({ to: 'ada@example.test', subject: 'Hi', text: 'Hello' })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toMatchObject({ code: 'TRANSPORT_FAILED' });
    expect((failure as Error).cause).toMatchObject({ code: 'ETIMEDOUT' });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('refuses header injection before any SMTP connection is opened', async () => {
    const mailer = new Mailer({
      transport: nodemailerTransport(transporter(smtpPort)),
      from: 'noreply@example.test',
    });
    const attempts = [
      {
        to: 'ada@example.test',
        subject: 'Hi\r\nBcc: victim@example.test',
        text: 'x',
      },
      { to: 'ada@example.test', subject: 'Hi\nX-Evil: 1', text: 'x' },
      { to: 'ada@example.test', subject: 'Hi X-Evil: 1', text: 'x' },
      {
        to: 'ada@example.test\r\nBcc: victim@example.test',
        subject: 'Hi',
        text: 'x',
      },
      {
        to: [{ address: 'ada@example.test', name: 'Ada\r\nBcc: v@x.test' }],
        subject: 'Hi',
        text: 'x',
      },
      {
        to: 'ada@example.test',
        subject: 'Hi',
        text: 'x',
        headers: { 'X-Campaign': 'a\r\nBcc: victim@example.test' },
      },
      {
        to: 'ada@example.test',
        subject: 'Hi',
        text: 'x',
        headers: { 'X-Bad\r\nBcc': 'victim@example.test' },
      },
      {
        to: 'ada@example.test',
        subject: 'Hi',
        text: 'x',
        headers: { Bcc: 'victim@example.test' },
      },
    ];
    for (const attempt of attempts)
      await expect(mailer.send(attempt)).rejects.toBeInstanceOf(MailError);
    expect(connections).toBe(0);
    expect(received).toEqual([]);
    // The same mailer still delivers a clean message afterwards.
    await mailer.send({ to: 'ada@example.test', subject: 'Hi', text: 'x' });
    expect(received).toHaveLength(1);
    expect(received[0]?.raw).not.toContain('victim');
  });
});
