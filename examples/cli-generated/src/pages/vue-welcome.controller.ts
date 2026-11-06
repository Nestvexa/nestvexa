import { Controller, Get } from '@nestjs/common';
import { InertiaPage } from '@nestvexa/inertia';

@Controller('vue')
export class VueWelcomeController {
  @Get()
  @InertiaPage('Welcome', { app: 'vue' })
  index() {
    return { title: 'Welcome' };
  }
}
