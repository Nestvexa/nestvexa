import { Controller, Get } from '@nestjs/common';
import { InertiaPage } from '@nestvexa/inertia';

@Controller('react')
export class ReactWelcomeController {
  @Get()
  @InertiaPage('Welcome', { app: 'react' })
  index() {
    return { title: 'Welcome' };
  }
}
