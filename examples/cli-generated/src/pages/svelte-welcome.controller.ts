import { Controller, Get } from '@nestjs/common';
import { InertiaPage } from '@nestvexa/inertia';

@Controller('svelte')
export class SvelteWelcomeController {
  @Get()
  @InertiaPage('Welcome', { app: 'svelte' })
  index() {
    return { title: 'Welcome' };
  }
}
