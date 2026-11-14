<script setup lang="ts">
import { Link, usePage } from '@inertiajs/vue3';
import { computed, onMounted } from 'vue';
import { useTranslate } from './i18n';
import type { SharedProps } from './types';

const page = usePage<SharedProps>();
const t = useTranslate();
const success = computed(() => {
  const value = page.flash['success'];
  return typeof value === 'string' ? value : undefined;
});
/** The switch returns to this section's page (the server allowlists it). */
const returnTo = computed(() =>
  page.url.startsWith('/insights/goals') ? '/insights/goals' : '/insights',
);
onMounted(() => {
  document.documentElement.dataset['hydrated'] = 'vue';
});
</script>

<template>
  <header class="site-header">
    <p class="brand">{{ page.props.appName }} · {{ page.props.workspace }}</p>
    <nav :aria-label="t('common:site.mainNav')">
      <a href="/app">{{ t('common:nav.dashboard') }}</a>
      <a href="/app/tasks">{{ t('common:nav.tasks') }}</a>
      <a href="/app/profile">{{ t('common:nav.profile') }}</a>
      <Link href="/insights">{{ t('common:nav.analytics') }}</Link>
      <Link href="/insights/goals">{{ t('common:nav.goals') }}</Link>
      <a href="/app/outbox">{{ t('common:nav.outbox') }}</a>
    </nav>
    <p class="who">
      {{
        t('insights:signedInAs', {
          name: page.props.userName,
          role: page.props.roleLabel,
        })
      }}
    </p>
    <!-- A native form post (full page load): the new direction applies to the whole document. -->
    <form method="post" action="/locale" class="locale-switch">
      <input type="hidden" name="_csrf" :value="page.props.csrf" />
      <input type="hidden" name="return" :value="returnTo" />
      <fieldset>
        <legend>{{ t('common:site.language') }}</legend>
        <button
          v-for="locale in page.props.locales"
          :key="locale.code"
          type="submit"
          name="locale"
          :value="locale.code"
          :lang="locale.code"
          :dir="locale.dir"
          :aria-pressed="locale.pressed"
        >
          {{ locale.label }}
        </button>
      </fieldset>
    </form>
  </header>
  <main id="main">
    <p v-if="success" role="status" class="notice" data-testid="flash">
      {{ success }}
    </p>
    <slot />
  </main>
</template>
