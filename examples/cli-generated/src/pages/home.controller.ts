import { Controller, Get, Render } from '@nestjs/common';

@Controller('home')
export class HomeController {
  @Get()
  @Render('pages/home')
  index() {
    return { title: 'Home' };
  }
}
