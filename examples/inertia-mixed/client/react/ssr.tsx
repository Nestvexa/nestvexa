import { createReactSsrRender } from '@nestvexa/react/ssr';
import { layout, pages } from './setup';

export const render = createReactSsrRender({ pages, layout });
