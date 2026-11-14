import { createHmac } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../examples/auth-passport/dist/app.js';
import { MemoryMailTransport } from '../packages/mail/dist/index.js';
import {
  ExampleClient,
  inputValue,
  liveReference,
  nextReference,
} from './support/example-client.js';

/*
 * DATA-015/016: the optional Passport auth starter (examples/auth-passport),
 * booted in-process on port 4023 (4024 for the HTTPS-cookie variant) with an
 * in-memory mail transport and a controllable clock. Every flow has its
 * negative cases: wrong credentials, missing CSRF, reused/expired/revoked
 * tokens, role and verification guards, forged and stale JWTs.
 */

const port = 4023;
const base = `http://127.0.0.1:${port}`;
const jwtSecret = 'test-only-jwt-secret-0123456789abcdef';
const password = 'demo-password-2026';
const mail = new MemoryMailTransport();
let clock = Date.now();
let app: INestApplication;

beforeAll(async () => {
  app = await createApp({
    port,
    mail,
    now: () => clock,
    jwtSecret,
    logger: false,
  });
  await app.listen(port, '127.0.0.1');
}, 120_000);
afterAll(async () => {
  await app.close();
});

const flash = async (client: ExampleClient, path = '/') =>
  (await client.get(path)).text;

/** A signed-in browser session for one of the seeded accounts. */
async function signIn(email: string, secret = password) {
  const client = new ExampleClient(base);
  const page = await client.get('/login');
  const response = await client.form('/login', {
    _csrf: inputValue(page.text, '_csrf'),
    email,
    password: secret,
  });
  return { client, response };
}
/** The single link in the latest message to `address`. */
function mailedLink(address: string, path: string): string {
  const message = mail.to(address).at(-1);
  const match = new RegExp(`${base}${path}\\?token=([A-Za-z0-9_-]{43})`).exec(
    message?.text ?? '',
  );
  if (!match?.[1]) throw new Error(`No ${path} link mailed to ${address}`);
  return match[1];
}
/** HS256 JWT signed with the test secret (claims are under test control). */
function forgeJwt(
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' },
  key = jwtSecret,
) {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${encode(header)}.${encode(claims)}`;
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}

describe('auth starter: sign-in and sign-out', { timeout: 120_000 }, () => {
  it('rejects wrong and unknown credentials with one generic message', async () => {
    for (const [email, secret] of [
      ['max@example.test', 'wrong-password-123'],
      ['nobody@example.test', password],
    ] as const) {
      const { client, response } = await signIn(email, secret);
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('/login');
      const page = await flash(client, '/login');
      expect(page).toContain('The email or password is incorrect.');
      expect((await client.get('/account')).headers.get('location')).toBe(
        '/login',
      );
    }
  });

  it('refuses a sign-in without the CSRF token or from another origin', async () => {
    const client = new ExampleClient(base);
    const page = await client.get('/login');
    const missing = await client.form('/login', {
      email: 'max@example.test',
      password,
    });
    expect(missing.status).toBe(403);
    const foreign = await client.form(
      '/login',
      {
        _csrf: inputValue(page.text, '_csrf'),
        email: 'max@example.test',
        password,
      },
      { origin: 'https://evil.example' },
    );
    expect(foreign.status).toBe(403);
    expect((await client.get('/account')).status).toBe(303);
  });

  it('regenerates the session on sign-in and on sign-out', async () => {
    const client = new ExampleClient(base);
    const page = await client.get('/login');
    const before = client.cookie('auth.sid');
    expect(before).toBeDefined();
    const stale = new ExampleClient(base);
    stale.setCookie('auth.sid', before ?? '');
    const response = await client.form('/login', {
      _csrf: inputValue(page.text, '_csrf'),
      email: 'max@example.test',
      password,
    });
    expect(response.headers.get('location')).toBe('/account');
    const after = client.cookie('auth.sid');
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    // Session fixation: the pre-login session id is not signed in.
    expect((await stale.get('/account')).status).toBe(303);
    const account = await client.get('/account');
    expect(account.status).toBe(200);
    expect(account.text).toContain('Signed in as Max.');

    // Sign-out needs the (rotated) CSRF token, then issues a new session.
    expect((await client.form('/logout', {})).status).toBe(403);
    const out = await client.form('/logout', {
      _csrf: inputValue(account.text, '_csrf'),
    });
    expect(out.status).toBe(303);
    expect(client.cookie('auth.sid')).not.toBe(after);
    expect(await flash(client)).toContain('You have signed out.');
    expect((await client.get('/account')).headers.get('location')).toBe(
      '/login',
    );
    const replay = new ExampleClient(base);
    replay.setCookie('auth.sid', after ?? '');
    expect((await replay.get('/account')).status).toBe(303);
  });
});

describe(
  'auth starter: authorization guards and Live',
  { timeout: 120_000 },
  () => {
    it('redirects guests, refuses members on admin pages and allows admins', async () => {
      const guest = new ExampleClient(base);
      for (const path of ['/account', '/admin', '/reports'])
        expect((await guest.get(path)).headers.get('location')).toBe('/login');
      const max = (await signIn('max@example.test')).client;
      const denied = await max.get('/admin');
      expect(denied.status).toBe(403);
      expect(denied.text).toContain('Your role cannot do this');
      expect((await max.get('/reports')).status).toBe(200);
      const ada = (await signIn('ada@example.test')).client;
      expect((await ada.get('/admin')).status).toBe(200);
    });

    it('keeps the Live user context server-side and refuses replays', async () => {
      const max = (await signIn('max@example.test')).client;
      const page = await max.get('/account');
      expect(page.text).toContain('max@example.test');
      let panel = liveReference(page.text, 'account-panel');
      const renamed = await max.live('account-panel', 'rename', panel, {
        updates: { draft: 'Maxine' },
      });
      expect(renamed.status, renamed.text).toBeLessThan(300);
      expect(renamed.text).toContain('Your name is now Maxine.');
      panel = nextReference(panel, renamed);
      expect((await max.get('/account')).text).toContain('Maxine');

      // Another signed-in account cannot use Max's snapshot.
      const ada = (await signIn('ada@example.test')).client;
      const stolen = await ada.live('account-panel', 'rename', panel, {
        updates: { draft: 'Hijacked' },
      });
      expect(stolen.status).toBeGreaterThanOrEqual(400);
      // A wrong CSRF header is refused.
      const forged = await max.live(
        'account-panel',
        'rename',
        { ...panel, csrf: 'x'.repeat(43) },
        { updates: { draft: 'Forged' } },
      );
      expect(forged.status).toBe(403);
      // After sign-out the snapshot is dead.
      await max.form('/logout', {
        _csrf: inputValue((await max.get('/account')).text, '_csrf'),
      });
      const after = await max.live('account-panel', 'rename', panel, {
        updates: { draft: 'Ghost' },
      });
      expect(after.status).toBeGreaterThanOrEqual(400);
      expect((await ada.get('/account')).text).not.toContain('Hijacked');
      // Restore the seeded name for later tests.
      const again = (await signIn('max@example.test')).client;
      const reset = liveReference(
        (await again.get('/account')).text,
        'account-panel',
      );
      await again.live('account-panel', 'rename', reset, {
        updates: { draft: 'Max' },
      });
    });
  },
);

describe(
  'auth starter: registration and email verification',
  { timeout: 120_000 },
  () => {
    it('registers, mails a single-use link and unlocks verified pages', async () => {
      const client = new ExampleClient(base);
      const page = await client.get('/register');
      const csrf = inputValue(page.text, '_csrf');
      const weak = await client.form('/register', {
        _csrf: csrf,
        email: 'new@example.test',
        name: 'New',
        password: 'short',
      });
      expect(weak.headers.get('location')).toBe('/register');
      expect(await flash(client, '/register')).toContain(
        'Use at least 12 characters.',
      );
      const created = await client.form('/register', {
        _csrf: inputValue((await client.get('/register')).text, '_csrf'),
        email: 'New@Example.test',
        name: 'New Person',
        password: 'a-long-enough-password',
      });
      expect(created.headers.get('location')).toBe('/account');
      const account = await client.get('/account');
      expect(account.text).toContain(
        'Your email address is not confirmed yet.',
      );
      expect((await client.get('/reports')).status).toBe(403);

      const token = mailedLink('new@example.test', '/verify-email');
      // A GET shows a confirmation form and does not consume the token.
      const confirm = await client.get(`/verify-email?token=${token}`);
      expect(confirm.headers.get('referrer-policy')).toBe('no-referrer');
      expect(inputValue(confirm.text, 'token')).toBe(token);
      expect((await client.get(`/verify-email?token=${token}`)).text).toContain(
        'verify-form',
      );
      // CSRF is required to consume it.
      expect((await client.form('/verify-email', { token })).status).toBe(403);
      const verified = await client.form('/verify-email', {
        _csrf: inputValue(confirm.text, '_csrf'),
        token,
      });
      expect(verified.headers.get('location')).toBe('/account');
      expect((await client.get('/reports')).status).toBe(200);
      // Reused token.
      const reused = await client.get(`/verify-email?token=${token}`);
      expect(reused.text).toContain('link-invalid');
      const again = await client.form('/verify-email', {
        _csrf: inputValue(reused.text, '_csrf'),
        token,
      });
      expect(again.headers.get('location')).toBe('/');
      expect(await flash(client)).toContain('invalid or has expired');

      // Duplicate email: generic failure, no second account.
      const other = new ExampleClient(base);
      const duplicate = await other.form('/register', {
        _csrf: inputValue((await other.get('/register')).text, '_csrf'),
        email: 'new@example.test',
        name: 'Imposter',
        password: 'another-long-password',
      });
      expect(duplicate.headers.get('location')).toBe('/register');
      expect(await flash(other, '/register')).toContain(
        'We could not create an account with these details.',
      );
    });

    it('expires verification links and revokes older ones on resend', async () => {
      const client = new ExampleClient(base);
      await client.form('/register', {
        _csrf: inputValue((await client.get('/register')).text, '_csrf'),
        email: 'late@example.test',
        name: 'Late',
        password: 'a-long-enough-password',
      });
      const first = mailedLink('late@example.test', '/verify-email');
      const account = await client.get('/account');
      await client.form('/verify-email/resend', {
        _csrf: inputValue(account.text, '_csrf'),
      });
      const second = mailedLink('late@example.test', '/verify-email');
      expect(second).not.toBe(first);
      expect((await client.get(`/verify-email?token=${first}`)).text).toContain(
        'link-invalid',
      );
      clock += 24 * 60 * 60_000 + 1;
      try {
        expect(
          (await client.get(`/verify-email?token=${second}`)).text,
        ).toContain('link-invalid');
      } finally {
        clock -= 24 * 60 * 60_000 + 1;
      }
    });
  },
);

describe('auth starter: password reset', { timeout: 120_000 }, () => {
  it('answers identically for unknown accounts and mails nothing', async () => {
    const client = new ExampleClient(base);
    const before = mail.messages.length;
    const response = await client.form('/forgot-password', {
      _csrf: inputValue((await client.get('/forgot-password')).text, '_csrf'),
      email: 'nobody@example.test',
    });
    expect(response.headers.get('location')).toBe('/login');
    expect(await flash(client, '/login')).toContain(
      'If an account exists for that email',
    );
    expect(mail.messages.length).toBe(before);
    expect(
      (await client.form('/forgot-password', { email: 'max@example.test' }))
        .status,
    ).toBe(403);
  });

  it('resets once, revokes sessions and tokens, and refuses reused or expired links', async () => {
    const { client: otherDevice } = await signIn('max@example.test');
    const jwt = (
      await new ExampleClient(base).json('/api/token', {
        email: 'max@example.test',
        password,
      })
    ).json()['accessToken'];
    expect(typeof jwt).toBe('string');

    const client = new ExampleClient(base);
    const request = async () => {
      await client.form('/forgot-password', {
        _csrf: inputValue((await client.get('/forgot-password')).text, '_csrf'),
        email: 'max@example.test',
      });
      return mailedLink('max@example.test', '/reset-password');
    };
    // An expired link.
    const expired = await request();
    clock += 30 * 60_000 + 1;
    const late = await client.get(`/reset-password?token=${expired}`);
    clock -= 30 * 60_000 + 1;
    expect(late.text).toContain('link-invalid');
    // A newer request revokes the older link.
    const older = await request();
    const token = await request();
    expect((await client.get(`/reset-password?token=${older}`)).text).toContain(
      'link-invalid',
    );
    expect(
      (await client.get('/reset-password?token=not-a-real-token')).text,
    ).toContain('link-invalid');

    const form = await client.get(`/reset-password?token=${token}`);
    expect(form.headers.get('referrer-policy')).toBe('no-referrer');
    const csrf = inputValue(form.text, '_csrf');
    // Missing CSRF and mismatched confirmation leave the token usable.
    expect(
      (
        await client.form('/reset-password', {
          token,
          password: 'brand-new-password-1',
          confirmation: 'brand-new-password-1',
        })
      ).status,
    ).toBe(403);
    await client.form('/reset-password', {
      _csrf: csrf,
      token,
      password: 'brand-new-password-1',
      confirmation: 'something-else-entirely',
    });
    expect(await flash(client, `/reset-password?token=${token}`)).toContain(
      'The passwords differ.',
    );
    const done = await client.form('/reset-password', {
      _csrf: inputValue(
        (await client.get(`/reset-password?token=${token}`)).text,
        '_csrf',
      ),
      token,
      password: 'brand-new-password-1',
      confirmation: 'brand-new-password-1',
    });
    expect(done.headers.get('location')).toBe('/login');

    // Reused token.
    const reused = await client.form('/reset-password', {
      _csrf: inputValue((await client.get('/login')).text, '_csrf'),
      token,
      password: 'yet-another-password-2',
      confirmation: 'yet-another-password-2',
    });
    expect(reused.headers.get('location')).toContain('/reset-password');
    expect(await flash(client, `/reset-password?token=${token}`)).toContain(
      'link-invalid',
    );

    // Every earlier session and JWT is revoked; only the new password works.
    expect((await otherDevice.get('/account')).headers.get('location')).toBe(
      '/login',
    );
    expect(
      (
        await new ExampleClient(base).get('/api/me', {
          authorization: `Bearer ${String(jwt)}`,
        })
      ).status,
    ).toBe(401);
    expect(
      (await signIn('max@example.test')).response.headers.get('location'),
    ).toBe('/login');
    expect(
      (
        await signIn('max@example.test', 'brand-new-password-1')
      ).response.headers.get('location'),
    ).toBe('/account');
  });
});

describe('auth starter: JWT bearer API', { timeout: 120_000 }, () => {
  const api = new ExampleClient(base);
  const token = async (email: string, secret: string) =>
    api.json('/api/token', { email, password: secret });

  it('issues tokens for valid credentials only', async () => {
    expect((await token('ada@example.test', 'wrong-password-123')).status).toBe(
      401,
    );
    expect((await token('nobody@example.test', password)).status).toBe(401);
    const issued = await token('ada@example.test', password);
    expect(issued.status).toBe(200);
    expect(issued.headers.get('cache-control')).toBe('no-store');
    const accessToken = String(issued.json()['accessToken']);
    // No session cookie is created by the token endpoint.
    expect(issued.headers.getSetCookie()).toEqual([]);
    const me = await api.get('/api/me', {
      authorization: `Bearer ${accessToken}`,
    });
    expect(me.json()).toMatchObject({
      id: 'u-ada',
      role: 'admin',
      verified: true,
    });
    expect(
      (
        await api.get('/api/admin/stats', {
          authorization: `Bearer ${accessToken}`,
        })
      ).status,
    ).toBe(200);
  });

  it('refuses missing, tampered, unsigned, expired and foreign tokens and enforces roles', async () => {
    const claims = {
      sub: 'u-ada',
      ver: 1,
      iss: base,
      aud: `${base}/api`,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    };
    const valid = forgeJwt(claims);
    expect(
      (await api.get('/api/me', { authorization: `Bearer ${valid}` })).status,
    ).toBe(200);
    const bad = [
      '',
      `${valid.slice(0, -2)}xx`,
      forgeJwt(
        { ...claims, sub: 'u-max' },
        undefined,
        'another-secret-of-32-characters!!',
      ),
      `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`,
      forgeJwt({ ...claims, exp: Math.floor(Date.now() / 1000) - 10 }),
      forgeJwt({ ...claims, aud: 'https://other.example/api' }),
      forgeJwt({ ...claims, iss: 'https://other.example' }),
      forgeJwt({ ...claims, ver: 99 }),
      forgeJwt({ ...claims, sub: 'u-nobody' }),
    ];
    for (const candidate of bad)
      expect(
        (
          await api.get('/api/me', {
            ...(candidate ? { authorization: `Bearer ${candidate}` } : {}),
          })
        ).status,
        candidate,
      ).toBe(401);
    // A session cookie does not authenticate the bearer API.
    const { client } = await signIn('ada@example.test');
    expect((await client.get('/api/me')).status).toBe(401);

    const max = await token('max@example.test', 'brand-new-password-1');
    const memberToken = String(max.json()['accessToken']);
    expect(
      (
        await api.get('/api/admin/stats', {
          authorization: `Bearer ${memberToken}`,
        })
      ).status,
    ).toBe(403);
  });
});

// Last: Passport keeps strategies in a process-wide registry, so a second
// application in this process re-registers 'local' and 'jwt' for itself.
describe(
  'auth starter: production cookie settings',
  { timeout: 120_000 },
  () => {
    it('sets HttpOnly, SameSite=Lax, Secure __Host- cookies behind HTTPS', async () => {
      const secure = await createApp({
        port: 4024,
        origin: 'https://auth.example.test',
        trustProxy: true,
        mail: new MemoryMailTransport(),
        logger: false,
      });
      await secure.listen(4024, '127.0.0.1');
      try {
        const response = await fetch('http://127.0.0.1:4024/login', {
          headers: { 'x-forwarded-proto': 'https' },
        });
        const cookie = response.headers.getSetCookie().join('\n');
        expect(cookie).toMatch(/^__Host-auth\.sid=/);
        expect(cookie).toMatch(/; Path=\//);
        expect(cookie).toMatch(/; HttpOnly/);
        expect(cookie).toMatch(/; Secure/);
        expect(cookie).toMatch(/; SameSite=Lax/);
        expect(cookie).not.toMatch(/Domain=/i);
      } finally {
        await secure.close();
      }
    });
  },
);
