// HTML page shell for the static documentation site. No external scripts,
// fonts or analytics: the site works offline and under a strict CSP.
import { escapeHtml } from './markdown.mjs';

/** Relative URL from one published page to another (both site-root relative). */
export function relativeUrl(from, to) {
  const fromParts = from.split('/').slice(0, -1);
  const toParts = to.split('/');
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length - 1 &&
    fromParts[common] === toParts[common]
  )
    common++;
  const up = fromParts.length - common;
  return '../'.repeat(up) + toParts.slice(common).join('/') || './';
}

function navigation(site, current) {
  return site.sections
    .map((section) => {
      const items = section.items
        .map((item) => {
          const active = item.output === current ? ' aria-current="page"' : '';
          return `<li><a href="${escapeHtml(relativeUrl(current, item.output))}"${active}>${escapeHtml(item.title)}</a></li>`;
        })
        .join('');
      const open = section.items.some((item) => item.output === current)
        ? ' open'
        : '';
      return `<details${open}><summary>${escapeHtml(section.title)}</summary><ul>${items}</ul></details>`;
    })
    .join('');
}

/** Wraps rendered content in the site shell. */
export function page(site, { output, title, body, source, toc }) {
  const stylesheet = relativeUrl(output, 'assets/site.css');
  const script = relativeUrl(output, 'assets/site.js');
  const home = relativeUrl(output, 'index.html');
  const sourceLink = source
    ? `<p class="source"><a href="${escapeHtml(`${site.repository}/blob/${site.branch}/${source}`)}" rel="noopener">View source: ${escapeHtml(source)}</a></p>`
    : '';
  const contents =
    toc && toc.length > 1
      ? `<nav class="toc" aria-label="On this page"><p>On this page</p><ul>${toc
          .map(
            (heading) =>
              `<li class="depth-${heading.depth}"><a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a></li>`,
          )
          .join('')}</ul></nav>`
      : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(title)} | ${escapeHtml(site.title)}</title>
<link rel="stylesheet" href="${escapeHtml(stylesheet)}">
<script src="${escapeHtml(script)}" defer></script>
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<header class="masthead"><a class="brand" href="${escapeHtml(home)}">${escapeHtml(site.title)}</a><span class="tagline">${escapeHtml(site.tagline)}</span><span class="status">${escapeHtml(site.status)}</span></header>
<div class="layout">
<nav class="sidebar" aria-label="Documentation">
<label class="filter"><span>Filter pages</span><input type="search" id="nav-filter" autocomplete="off"></label>
${navigation(site, output)}
</nav>
<main id="content">
<article>
${body}
</article>
${sourceLink}
</main>
${contents}
</div>
</body>
</html>
`;
}
