import { createVueSsrRender } from '@nestvexa/vue/ssr';
import { layout, pages } from './setup';

export const render = createVueSsrRender({ pages, layout });
