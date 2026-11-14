import { usePage } from '@inertiajs/vue3';
import { createClientI18n } from '@nestvexa/i18n/client';
import type { ClientI18n } from '@nestvexa/i18n/client';
import { computed } from 'vue';
import type { SharedProps } from './types';

type Params = Parameters<ClientI18n['t']>[1];

/**
 * Translator over the explicit message subset the server shares with every
 * Inertia response (`i18n` prop). The same function runs during SSR and in
 * the browser, so both render the same text.
 */
export function useTranslate(): (key: string, params?: Params) => string {
  const page = usePage<SharedProps>();
  const client = computed(() => createClientI18n(page.props.i18n));
  return (key, params) => client.value.t(key, params);
}
