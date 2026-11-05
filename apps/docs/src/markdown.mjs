// Markdown parsing helpers shared by the checks and the renderer.
import { Lexer, Marked } from 'marked';

/** Flattens inline tokens to the plain text GitHub uses for heading anchors. */
export function plainText(tokens) {
  let text = '';
  for (const token of tokens ?? []) {
    if (token.tokens) text += plainText(token.tokens);
    else if (token.type === 'codespan' || token.type === 'text')
      text += decodeEntities(token.text);
    else if (token.type === 'escape') text += token.text;
  }
  return text;
}

function decodeEntities(value) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

/** GitHub-compatible heading slug: lowercase, punctuation removed, spaces to hyphens. */
export function slug(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replaceAll(' ', '-');
}

/** Creates a per-document slugger that de-duplicates like GitHub (`x`, `x-1`, ...). */
export function createSlugger() {
  const seen = new Map();
  return (text) => {
    const base = slug(text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };
}

/** Lexes a document once and collects headings, links, anchors and snippet markers. */
export function analyse(markdown) {
  const tokens = Lexer.lex(markdown, { gfm: true });
  const headings = [];
  const links = [];
  const anchors = new Set();
  const snippets = [];
  const nextSlug = createSlugger();
  const visit = (list) => {
    let pendingSnippet;
    for (const token of list) {
      if (token.type === 'space') continue;
      if (pendingSnippet) {
        snippets.push({
          source: pendingSnippet,
          code: token.type === 'code' ? token.text : undefined,
        });
        pendingSnippet = undefined;
      }
      if (token.type === 'heading') {
        const text = plainText(token.tokens);
        const id = nextSlug(text);
        headings.push({ depth: token.depth, text, id });
        anchors.add(id);
      }
      if (token.type === 'html') {
        const marker = /<!--\s*snippet:\s*(\S+)\s*-->/.exec(token.raw);
        if (marker?.[1]) pendingSnippet = marker[1];
        for (const match of token.raw.matchAll(/\s(?:id|name)="([^"]+)"/g))
          if (match[1]) anchors.add(match[1]);
      }
      if (token.type === 'link' || token.type === 'image')
        links.push({ href: token.href, text: token.text });
      if (token.type === 'html' && token.raw.includes('href="'))
        for (const match of token.raw.matchAll(/href="([^"]+)"/g))
          if (match[1]) links.push({ href: match[1], text: '' });
      if (token.tokens) visit(token.tokens);
      if (token.items) for (const item of token.items) visit(item.tokens);
      if (token.type === 'table') {
        for (const cell of token.header) visit(cell.tokens);
        for (const row of token.rows)
          for (const cell of row) visit(cell.tokens);
      }
    }
    if (pendingSnippet)
      snippets.push({ source: pendingSnippet, code: undefined });
  };
  visit(tokens);
  return { tokens, headings, links, anchors, snippets };
}

const escapeHtml = (value) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

export { escapeHtml };

/**
 * Renders trusted repository Markdown to HTML. `resolveHref` maps a source link
 * to its published form; headings receive the same ids the link checker uses.
 */
export function render(markdown, resolveHref) {
  const nextSlug = createSlugger();
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading(token) {
        const text = plainText(token.tokens);
        const id = nextSlug(text);
        const inner = this.parser.parseInline(token.tokens);
        return `<h${token.depth} id="${escapeHtml(id)}"><a class="anchor" href="#${escapeHtml(id)}" aria-hidden="true">#</a>${inner}</h${token.depth}>\n`;
      },
      link(token) {
        const inner = this.parser.parseInline(token.tokens);
        const href = resolveHref(token.href);
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
        const external = /^https?:/.test(href) ? ' rel="noopener"' : '';
        return `<a href="${escapeHtml(href)}"${title}${external}>${inner}</a>`;
      },
      image(token) {
        return `<img src="${escapeHtml(resolveHref(token.href))}" alt="${escapeHtml(token.text)}">`;
      },
      code(token) {
        const language = (token.lang ?? '').split(/\s/)[0] ?? '';
        const label = language
          ? ` data-language="${escapeHtml(language)}"`
          : '';
        const className =
          language === 'mermaid' ? ' class="diagram-source"' : '';
        return `<pre${className}${label}><code>${escapeHtml(token.text)}</code></pre>\n`;
      },
    },
  });
  return marked.parse(markdown, { async: false });
}
