import { Controller, Get, Header, Inject, Render, Req } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { LiveRuntime } from 'nestvexa';
import { CounterComponent } from './components/counter.component.js';

/** Generated welcome page at /nestvexa; existing routes are left untouched. */
@Controller('nestvexa')
export class NestvexaWelcomeController {
  constructor(@Inject(LiveRuntime) private readonly live: LiveRuntime) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @Render('welcome')
  async index(@Req() request: { session: Record<string, unknown> }) {
    request.session['csrf'] ??= randomBytes(32).toString('base64url');
    return {
      title: 'Nestvexa is ready',
      counter: await this.live.mount(CounterComponent, request),
    };
  }
}
