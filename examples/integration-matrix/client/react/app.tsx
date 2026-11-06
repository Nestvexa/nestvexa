import '@vitejs/plugin-react/preamble';
import { mountReactInertiaApp } from '@nestvexa/react';
import { layout, pages } from './setup';

void mountReactInertiaApp({ pages, layout, progress: false });
