import 'reflect-metadata';
import {
  Controller,
  Get,
  Module,
  Render,
  UseInterceptors,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import {
  NestvexaModule,
  configureNestvexa,
} from '../packages/nestvexa/dist/index.js';
import {
  I18n,
  I18nError,
  I18nModule,
  LocaleViewInterceptor,
} from '../packages/i18n/dist/index.js';
import type { I18nOptions } from '../packages/i18n/dist/index.js';

const options: I18nOptions = {
  locales: ['en', 'ar'],
  defaultLocale: 'en',
  timeZone: 'Asia/Riyadh',
  catalogs: {
    en: {
      common: {
        title: 'Products',
        welcome: 'Welcome, <em>{name}</em>',
        count: '{count, plural, one {# product} other {# products}}',
      },
    },
    ar: {
      common: {
        title: 'المنتجات',
        welcome: 'أهلاً، <em>{name}</em>',
        count:
          '{count, plural, zero {لا منتجات} one {منتج واحد} two {منتجان} few {# منتجات} many {# منتجًا} other {# منتج}}',
      },
    },
  },
};
const attack = '<img src=x onerror=alert(1)>';
let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'nv-i18n-hbs-'));
  await writeFile(
    join(root, 'page.hbs'),
    [
      '<h1>{{t "title"}}</h1>',
      '<p id="count">{{t "count" count=count}}</p>',
      '<p id="t">{{t "welcome" name=name}}</p>',
      '<p id="html">{{tHtml "welcome" name=name}}</p>',
      '<p id="date">{{formatDate when dateStyle="long"}}</p>',
      '<p id="number">{{formatNumber ratio style="percent"}}</p>',
      '<p id="money">{{formatCurrency price "EUR"}}</p>',
      '<p id="relative">{{formatRelative when now=now}}</p>',
      '<p id="meta">{{lang}} {{dir}}</p>',
    ].join('\n'),
  );
  await writeFile(
    join(root, 'layout.hbs'),
    '<!doctype html><html lang="{{lang}}" dir="{{dir}}"><body>{{body}}</body></html>',
  );
  await writeFile(
    join(root, 'bad-option.hbs'),
    '{{formatNumber 1 localeMatcher="x"}}',
  );
  await writeFile(join(root, 'dynamic.hbs'), '{{t key}}');
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
const model = {
  count: 3,
  name: attack,
  when: '2024-01-01T22:30:00Z',
  now: '2024-01-04T22:30:00Z',
  ratio: 0.42,
  price: 9.5,
};

describe('HBS helpers through HbsEngine.registerHelpers', () => {
  it('renders translations and formats with the model locale; escapes every interpolation', async () => {
    const i18n = new I18n(options);
    const engine = new HbsEngine({ root });
    engine.registerHelpers(i18n.helpers());
    await engine.initialize();
    const english = await engine.render('page', {
      ...model,
      i18n: i18n.view('en'),
    });
    expect(english).toContain('<h1>Products</h1>');
    expect(english).toContain('<p id="count">3 products</p>');
    expect(english).toContain(
      '<p id="html">Welcome, <em>&lt;img src=x onerror=alert(1)&gt;</em></p>',
    );
    // {{t}} returns plain text, so Handlebars escapes the whole message.
    expect(english).toContain(
      '<p id="t">Welcome, &lt;em&gt;&lt;img src&#x3D;x onerror&#x3D;alert(1)&gt;&lt;/em&gt;</p>',
    );
    expect(english).not.toContain(attack);
    expect(english).toContain('<p id="date">January 2, 2024</p>');
    expect(english).toContain('<p id="number">42%</p>');
    expect(english).toContain('<p id="money">€9.50</p>');
    expect(english).toContain('<p id="relative">3 days ago</p>');
    expect(english).toContain('<p id="meta">en ltr</p>');
    const arabic = await engine.render('page', {
      ...model,
      i18n: i18n.view('ar'),
    });
    expect(arabic).toContain('<h1>المنتجات</h1>');
    expect(arabic).toContain('<p id="count">3 منتجات</p>');
    expect(arabic).toContain('<p id="meta">ar rtl</p>');
    expect(arabic).not.toContain(attack);
    await engine.dispose();
  });
  it('falls back to the default locale for missing, unlisted or hostile model locales', async () => {
    const i18n = new I18n(options);
    const engine = new HbsEngine({ root });
    engine.registerHelpers(i18n.helpers());
    for (const locale of ['__proto__', 'constructor', 'de', 'ar<script>', 42])
      expect(
        await engine.render('page', { ...model, i18n: { locale } }),
      ).toContain('<p id="meta">en ltr</p>');
    expect(await engine.render('page', model)).toContain('<h1>Products</h1>');
    await expect(engine.render('bad-option', {})).rejects.toThrow();
    await expect(engine.render('dynamic', { key: { a: 1 } })).rejects.toThrow();
  });
  it('rejects duplicate, reserved, accessor and late helper registration', async () => {
    const i18n = new I18n(options);
    const engine = new HbsEngine({ root, helpers: { t: () => 'x' } });
    expect(() => engine.registerHelpers(i18n.helpers())).toThrow(/Duplicate/);
    const fresh = new HbsEngine({ root });
    expect(() => fresh.registerHelpers({ nvChild: () => '' })).toThrow(
      /Reserved/,
    );
    expect(() =>
      fresh.registerHelpers(
        Object.defineProperty({}, 'x', {
          enumerable: true,
          get: () => () => '',
        }),
      ),
    ).toThrow();
    expect(() =>
      fresh.registerHelpers({ 'bad name': () => '' } as Record<
        string,
        () => string
      >),
    ).toThrow();
    fresh.registerHelpers(i18n.helpers());
    await fresh.initialize();
    expect(() => fresh.registerHelpers({ late: () => '' })).toThrow(
      /before initialize/,
    );
  });
});

function get(
  url: string,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 500,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    request.on('error', reject);
    request.end();
  });
}

describe('Nest integration with @Render and LocaleViewInterceptor', () => {
  let app: INestApplication;
  let base: string;
  beforeAll(async () => {
    @Controller()
    class Pages {
      @Get('products')
      @UseInterceptors(LocaleViewInterceptor)
      @Render('page')
      page() {
        return { ...model, name: 'Sara <b>' };
      }
      @Get('conflict')
      @UseInterceptors(LocaleViewInterceptor)
      @Render('page')
      conflict() {
        return { ...model, i18n: { locale: 'ar' } };
      }
      @Get('api')
      @UseInterceptors(LocaleViewInterceptor)
      api() {
        return { ok: true };
      }
    }
    @Module({
      imports: [
        NestvexaModule.forRoot({ views: { root, layout: 'layout' } }),
        I18nModule.forRoot(options),
      ],
      controllers: [Pages],
    })
    class AppModule {}
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.get(HbsEngine).registerHelpers(app.get(I18n).helpers());
    await configureNestvexa(app);
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    base = base.replace('[::1]', '127.0.0.1');
  });
  afterAll(async () => {
    await app.close();
  });
  it('negotiates per request and renders <html lang dir> with locale headers', async () => {
    const arabic = await get(`${base}/products`, {
      'accept-language': 'ar-SA,ar;q=0.9,en;q=0.5',
    });
    expect(arabic.status).toBe(200);
    expect(arabic.body).toContain('<html lang="ar" dir="rtl">');
    expect(arabic.body).toContain('<h1>المنتجات</h1>');
    expect(arabic.body).toContain('أهلاً، <em>Sara &lt;b&gt;</em>');
    expect(arabic.headers['content-language']).toBe('ar');
    expect(String(arabic.headers['vary'])).toMatch(/Accept-Language/);
    expect(String(arabic.headers['vary'])).toMatch(/Cookie/);
    const cookie = await get(`${base}/products`, {
      cookie: 'nv-locale=en',
      'accept-language': 'ar',
    });
    expect(cookie.body).toContain('<html lang="en" dir="ltr">');
    const query = await get(`${base}/products?lang=ar`, {
      cookie: 'nv-locale=en',
    });
    expect(query.body).toContain('<html lang="ar" dir="rtl">');
    const hostile = await get(`${base}/products?lang=%3Cscript%3E`);
    expect(hostile.body).toContain('<html lang="en" dir="ltr">');
    expect(hostile.headers['content-language']).toBe('en');
  });
  it('never overwrites a handler-provided i18n key and leaves non-render handlers untouched', async () => {
    expect((await get(`${base}/conflict`)).status).toBe(500);
    const api = await get(`${base}/api`, { 'accept-language': 'ar' });
    expect(JSON.parse(api.body)).toEqual({ ok: true });
    expect(api.headers['content-language']).toBeUndefined();
  });
  it('exports the I18n instance and rejects invalid factory options', async () => {
    expect(app.get(I18n).locales).toEqual(['en', 'ar']);
    const asyncModule = await Test.createTestingModule({
      imports: [
        I18nModule.forRootAsync({
          useFactory: async () => ({ ...options, defaultLocale: 'ar' }),
        }),
      ],
    }).compile();
    expect(asyncModule.get(I18n).defaultLocale).toBe('ar');
    await asyncModule.close();
    await expect(
      Test.createTestingModule({
        imports: [
          I18nModule.forRootAsync({
            useFactory: () => ({ ...options, defaultLocale: 'fr' }),
          }),
        ],
      }).compile(),
    ).rejects.toThrow(I18nError);
  });
});
