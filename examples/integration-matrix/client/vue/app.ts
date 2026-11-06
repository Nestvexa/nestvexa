import { mountVueInertiaApp } from '@nestvexa/vue';
import { layout, pages } from './setup';

void mountVueInertiaApp({ pages, layout, progress: false });
