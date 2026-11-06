import { Controller, Get } from '@nestjs/common';
import { InertiaPage } from '@nestvexa/inertia';

@Controller('vue-dashboard')
export class VueDashboardController {
  @Get()
  @InertiaPage('VueDashboard', { app: 'vue' })
  index() {
    return { title: 'VueDashboard' };
  }
}
