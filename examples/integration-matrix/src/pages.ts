import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Post,
  Render,
  Req,
  Res,
} from '@nestjs/common';
import { LiveRuntime } from 'nestvexa';
import { UploadsService } from '@nestvexa/uploads';
import { RealtimeService } from '@nestvexa/realtime';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Counter } from './counter.js';
import { Notifications, hybridIslands } from './hybrid.js';
import type { SessionRequest } from './identity.js';
import { bindingOf, ensureCsrf, origin, sameToken } from './identity.js';
import { ProductRepository, ProductTable } from './products.js';
import { RealtimePanel } from './realtime.js';

const publicDirectory = fileURLToPath(new URL('./public/', import.meta.url));
const baseCsp =
  "default-src 'self'; script-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
/** Svelte islands inject component styles at runtime. */
const hybridCsp = `${baseCsp}; style-src 'self' 'unsafe-inline'`;

const featured = [
  { name: 'Atlas desk', priceCents: 24900, tags: ['oak', 'adjustable'] },
  { name: 'Beacon lamp', priceCents: 4900, tags: ['led'] },
  { name: 'Cobalt chair', priceCents: 15900, tags: [] },
];

interface RedirectResponse {
  redirect(status: number, url: string): void;
}

@Controller()
export class PagesController {
  constructor(
    @Inject(LiveRuntime) private readonly live: LiveRuntime,
    @Inject(UploadsService) private readonly uploads: UploadsService,
    @Inject(ProductRepository) private readonly products: ProductRepository,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
  ) {}

  /** `/`: plain HBS with layout, helpers, escaped interpolation and SEO metadata. */
  @Get()
  @Header('Content-Security-Policy', baseCsp)
  @Render('home')
  home() {
    return {
      title: 'Nestvexa integration matrix',
      description:
        'One NestJS server running HBS, Live, Inertia React/Vue/Svelte, islands, actions and realtime side by side.',
      canonical: `${origin}/`,
      untrusted: '<script>alert("escaped")</script>',
      featured: featured.map((item) => ({ ...item, tags: [...item.tags] })),
    };
  }

  @Get('counter')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', baseCsp)
  @Render('live-page')
  async counter(@Req() request: SessionRequest) {
    ensureCsrf(request);
    return {
      title: 'Live counter',
      canonical: `${origin}/counter`,
      lead: 'Server-side state, validated input and actions without a page reload.',
      widget: await this.live.mount(Counter, request),
    };
  }

  @Get('products')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', baseCsp)
  @Render('live-page')
  async productsPage(@Req() request: SessionRequest) {
    ensureCsrf(request);
    return {
      title: 'Products',
      canonical: `${origin}/products`,
      lead: 'Search, sort and page through the catalog, then add a product with an image.',
      widget: await this.live.mount(ProductTable, request),
    };
  }

  /** Authorized image download: only the identity that uploaded it can read it. */
  @Get('products/:id/image')
  async image(
    @Req() request: SessionRequest,
    @Res() response: object,
    @Param('id') id: string,
  ) {
    const product = this.products.find(bindingOf(request), String(id));
    if (!product?.image) throw new NotFoundException();
    await this.uploads.download(request, response, product.image, {
      disposition: 'inline',
    });
  }

  @Get('hybrid')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', hybridCsp)
  @Render('hybrid')
  async hybrid(@Req() request: SessionRequest) {
    const csrf = ensureCsrf(request);
    return {
      title: 'Hybrid dashboard',
      canonical: `${origin}/hybrid`,
      csrf,
      islands: true,
      notifications: await this.live.mount(Notifications, request),
      ...hybridIslands(),
    };
  }

  @Get('realtime')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', baseCsp)
  @Render('realtime')
  async realtimePage(@Req() request: SessionRequest) {
    const csrf = ensureCsrf(request);
    return {
      title: 'Realtime',
      canonical: `${origin}/realtime`,
      csrf,
      operator: request.session.role === 'operator',
      widget: await this.live.mount(RealtimePanel, request),
    };
  }

  /**
   * Demonstration "operator" sign-in: a CSRF-checked POST that regenerates the
   * session (fixation protection), changes the identity binding and revokes
   * realtime connections of the previous binding.
   */
  @Post('realtime/role')
  async role(
    @Req() request: SessionRequest,
    @Body() body: { _csrf?: unknown; role?: unknown },
    @Res() response: RedirectResponse,
  ): Promise<void> {
    if (!sameToken(body._csrf, request.session.csrf))
      throw new ForbiddenException('Invalid form token');
    this.realtime.revoke(bindingOf(request));
    const role = body.role === 'operator' ? 'operator' : 'guest';
    await new Promise<void>((resolve, reject) =>
      request.session.regenerate((error: unknown) =>
        error
          ? reject(error instanceof Error ? error : new Error('Session error'))
          : resolve(),
      ),
    );
    request.session.role = role;
    request.session.csrf = randomBytes(32).toString('base64url');
    response.redirect(303, '/realtime');
  }

  @Get('islands/:file')
  @Header('Cache-Control', 'no-cache')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  async islandsEntry(@Param('file') file: string): Promise<string> {
    if (file !== 'islands.js') throw new NotFoundException();
    return readFile(publicDirectory + file, 'utf8');
  }

  @Get('islands/chunks/:file')
  @Header('Cache-Control', 'public, max-age=31536000, immutable')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  async islandsChunk(@Param('file') file: string): Promise<string> {
    // Only content-hashed chunk names produced by the build are served.
    if (!/^[A-Za-z0-9_-]+-[A-Z0-9]{8}\.js$/.test(file))
      throw new NotFoundException();
    return readFile(`${publicDirectory}chunks/${file}`, 'utf8').catch(() => {
      throw new NotFoundException();
    });
  }

  @Get('assets/site.css')
  @Header('Content-Type', 'text/css; charset=utf-8')
  @Header('Cache-Control', 'no-cache')
  styles(): string {
    return 'body{font-family:system-ui,sans-serif;line-height:1.5;margin:0 auto;max-width:64rem;padding:1rem;color:#1a1a1a;background:#fff}nav a{margin-inline-end:.75rem}button,input{font:inherit;min-height:2.5rem}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #999;padding:.4rem;text-align:start}[role=alert]{color:#8a1010}[nv\\:cloak]{display:none}';
  }
}
