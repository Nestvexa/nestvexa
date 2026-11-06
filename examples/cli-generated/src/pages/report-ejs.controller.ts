import { Controller, Get, Render } from '@nestjs/common';

@Controller('report-ejs')
export class ReportEjsController {
  @Get()
  @Render('pages/report-ejs.ejs')
  index() {
    return { title: 'ReportEjs' };
  }
}
