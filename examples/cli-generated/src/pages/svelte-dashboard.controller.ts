import { Controller, Get } from '@nestjs/common';
import { InertiaPage } from '@nestvexa/inertia';

@Controller('svelte-dashboard')
export class SvelteDashboardController {
  @Get()
  @InertiaPage('SvelteDashboard', { app: 'svelte' })
  index() {
    return { title: 'SvelteDashboard' };
  }
}
