// Hostile page props for the XSS regression suite
// (tests/browser/inertia-hostile-props.ts). Each payload would set
// `window.__nvXss` if it ever reached the DOM as markup, an event handler, a
// script or a template expression. Served only with --test-controls.

/** Rendered as text, as attribute values and as the document title. */
export const hostilePayloads: readonly string[] = [
  '<script>window.__nvXss = "script"</script>',
  '<img src="x" onerror="window.__nvXss = \'onerror\'">',
  '<svg onload="window.__nvXss = \'svg\'"></svg>',
  '" onmouseover="window.__nvXss = \'attribute\'" data-x="',
  "' autofocus onfocus='window.__nvXss = \"single-quote\"' '",
  '</script><script>window.__nvXss = "closing"</script>',
  '<!--<script>window.__nvXss = "comment"</script>-->',
  '{{ constructor.constructor("window.__nvXss = \'vue-template\'")() }}',
  '{constructor.constructor("window.__nvXss = \'svelte-template\'")()}',
  '${window.__nvXss = "template-literal"}',
  'line separator paragraph',
];

/** Bound to `href` through the page's scheme allowlist (client/safe-href.ts). */
export const hostileLinks: readonly string[] = [
  "javascript:window.__nvXss = 'javascript'",
  "JaVaScRiPt:window.__nvXss = 'mixed-case'",
  "java\tscript:window.__nvXss = 'tab'",
  " \njavascript:window.__nvXss = 'leading-space'",
  'data:text/html,<script>window.__nvXss = "data"</script>',
  'vbscript:msgbox(1)',
  '/users',
  'https://example.test/docs',
];
