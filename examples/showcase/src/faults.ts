import { Controller, Get, UseFilters } from '@nestjs/common';
import { ErrorPageFilter } from './pages.js';

/**
 * `SHOWCASE_TEST_FAULTS=1` only (see config.ts): a route that fails on
 * purpose so the browser tests can check the 500 page.
 */
@Controller('__faults')
@UseFilters(ErrorPageFilter)
export class FaultsController {
  @Get('error')
  error(): never {
    throw new Error('Simulated failure (SHOWCASE_TEST_FAULTS)');
  }
}
