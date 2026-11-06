import { Controller, Get } from '@nestjs/common';
import { InertiaPage } from '@nestvexa/inertia';

@Controller('react-dashboard')
export class ReactDashboardController {
  @Get()
  @InertiaPage('ReactDashboard', { app: 'react' })
  index() {
    return { title: 'ReactDashboard' };
  }
}
