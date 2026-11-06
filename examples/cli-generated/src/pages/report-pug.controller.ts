import { Controller, Get, Render } from '@nestjs/common';

@Controller('report-pug')
export class ReportPugController {
  @Get()
  @Render('pages/report-pug.pug')
  index() {
    return { title: 'ReportPug' };
  }
}
