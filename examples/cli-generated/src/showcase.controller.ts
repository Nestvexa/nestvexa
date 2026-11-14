import { Controller, Get, Header, Inject, Render, Req } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { LiveRuntime } from 'nestvexa';
import { islands } from './nestvexa/islands.js';
import { ContactForm } from './nestvexa/forms/contact.form.js';
import { TaskTableComponent } from './task/task-table.component.js';

/**
 * The only hand-written file of this example: mounts the components generated
 * by make:form, make:resource and make:island on one page, as an application
 * would in its own controllers.
 */
@Controller('showcase')
export class ShowcaseController {
  constructor(@Inject(LiveRuntime) private readonly live: LiveRuntime) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @Render('showcase')
  async index(@Req() request: { session: Record<string, unknown> }) {
    request.session['csrf'] ??= randomBytes(32).toString('base64url');
    return {
      title: 'Showcase',
      contact: await this.live.mount(ContactForm, request),
      tasks: await this.live.mount(TaskTableComponent, request),
      clicker: islands.render(
        'clicker',
        { label: 'Clicks' },
        { key: 'clicker', label: 'Click counter' },
      ),
      feed: islands.render(
        'feed',
        { label: 'Feed' },
        { key: 'feed', label: 'Vue counter' },
      ),
      status: islands.render(
        'status',
        { label: 'Status' },
        { key: 'status', label: 'Svelte counter' },
      ),
    };
  }
}
