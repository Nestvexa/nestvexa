import type { INestApplication } from '@nestjs/common';
import { HbsEngine, RouteTable, routeHelpers } from 'nestvexa';
import { routes } from './routes.js';

/** Server-side links over the generated route map (`routeTable.url(name, params)`). */
export const routeTable = new RouteTable(
  Object.fromEntries(
    Object.entries(routes).map(([name, { path }]) => [name, path]),
  ),
);

/** Registers {{route "TaskController.list" page=2}} with Handlebars. Call before configureNestvexa(app). */
export function configureRouteHelpers(app: INestApplication): void {
  app.get(HbsEngine).registerHelpers(routeHelpers(routeTable));
}
