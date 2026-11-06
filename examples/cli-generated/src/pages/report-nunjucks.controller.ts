import { Controller, Get, Render } from '@nestjs/common';

@Controller('report-nunjucks')
export class ReportNunjucksController {
  @Get()
  @Render('pages/report-nunjucks.njk')
  index() {
    return { title: 'ReportNunjucks' };
  }
}
