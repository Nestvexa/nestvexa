import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EjsEngine } from '../packages/engine-ejs/dist/index.js';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import { NunjucksEngine } from '../packages/engine-nunjucks/dist/index.js';
import { PugEngine } from '../packages/engine-pug/dist/index.js';
import {
  FORM_ERROR,
  defineForm,
  errorSummary,
  fieldView,
} from '../packages/forms/dist/index.js';
import type { ViewEngineAdapter } from '../packages/views/dist/index.js';

/**
 * FORM-012: the form view helpers (`defineForm().view()`, `fieldView`,
 * `errorSummary`) are plain-text JSON, so every engine adapter must escape
 * them itself. The same form, with hostile messages, labels and values, is
 * rendered through Handlebars, EJS, Pug and Nunjucks; each output must
 * tokenize to the same elements, attributes and text (after decoding
 * entities), contain no live markup from the data, and wire `aria-invalid`,
 * `aria-describedby`, error ids and summary links correctly.
 */

const HOSTILE = `"><script>alert('x')</script><img src=x onerror=alert(1)>`;

const templates = {
  hbs: `{{#if summary.hasErrors}}<div class="summary" role="group" aria-labelledby="summary-title"><h2 id="summary-title">{{summary.title}}</h2><ul>{{#each summary.items}}<li>{{#if href}}<a href="{{href}}">{{label}}: {{message}}</a>{{else}}<span>{{message}}</span>{{/if}}</li>{{/each}}</ul></div>{{/if}}<form>{{#each controls}}<label for="{{view.id}}">{{label}}</label><input id="{{view.id}}" name="{{name}}" value="{{value}}" aria-invalid="{{view.ariaInvalid}}"{{#if view.describedBy}} aria-describedby="{{view.describedBy}}"{{/if}}>{{#if view.invalid}}<p class="error" id="{{view.errorId}}">{{view.message}}</p>{{/if}}{{/each}}<label for="{{city.id}}">City</label><input id="{{city.id}}" name="address[city]" aria-invalid="{{city.ariaInvalid}}" aria-describedby="{{city.describedBy}}"><p id="city-hint">Your town</p><p class="error" id="{{city.errorId}}">{{#each city.messages}}<span>{{this}}</span>{{/each}}</p></form>`,
  ejs: `<% if (summary.hasErrors) { %><div class="summary" role="group" aria-labelledby="summary-title"><h2 id="summary-title"><%= summary.title %></h2><ul><% summary.items.forEach(function (item) { %><li><% if (item.href) { %><a href="<%= item.href %>"><%= item.label %>: <%= item.message %></a><% } else { %><span><%= item.message %></span><% } %></li><% }) %></ul></div><% } %><form><% controls.forEach(function (control) { %><label for="<%= control.view.id %>"><%= control.label %></label><input id="<%= control.view.id %>" name="<%= control.name %>" value="<%= control.value %>" aria-invalid="<%= control.view.ariaInvalid %>"<% if (control.view.describedBy) { %> aria-describedby="<%= control.view.describedBy %>"<% } %>><% if (control.view.invalid) { %><p class="error" id="<%= control.view.errorId %>"><%= control.view.message %></p><% } %><% }) %><label for="<%= city.id %>">City</label><input id="<%= city.id %>" name="address[city]" aria-invalid="<%= city.ariaInvalid %>" aria-describedby="<%= city.describedBy %>"><p id="city-hint">Your town</p><p class="error" id="<%= city.errorId %>"><% city.messages.forEach(function (message) { %><span><%= message %></span><% }) %></p></form>`,
  pug: [
    'if summary.hasErrors',
    '  div.summary(role="group" aria-labelledby="summary-title")',
    '    h2#summary-title= summary.title',
    '    ul',
    '      each item in summary.items',
    '        li',
    '          if item.href',
    '            a(href=item.href) #{item.label}: #{item.message}',
    '          else',
    '            span= item.message',
    'form',
    '  each control in controls',
    '    label(for=control.view.id)= control.label',
    '    input(id=control.view.id name=control.name value=control.value aria-invalid=control.view.ariaInvalid aria-describedby=control.view.describedBy || undefined)',
    '    if control.view.invalid',
    '      p.error(id=control.view.errorId)= control.view.message',
    '  label(for=city.id) City',
    '  input(id=city.id name="address[city]" aria-invalid=city.ariaInvalid aria-describedby=city.describedBy)',
    '  p#city-hint Your town',
    '  p.error(id=city.errorId)',
    '    each message in city.messages',
    '      span= message',
  ].join('\n'),
  njk: `{% if summary.hasErrors %}<div class="summary" role="group" aria-labelledby="summary-title"><h2 id="summary-title">{{ summary.title }}</h2><ul>{% for item in summary.items %}<li>{% if item.href %}<a href="{{ item.href }}">{{ item.label }}: {{ item.message }}</a>{% else %}<span>{{ item.message }}</span>{% endif %}</li>{% endfor %}</ul></div>{% endif %}<form>{% for control in controls %}<label for="{{ control.view.id }}">{{ control.label }}</label><input id="{{ control.view.id }}" name="{{ control.name }}" value="{{ control.value }}" aria-invalid="{{ control.view.ariaInvalid }}"{% if control.view.describedBy %} aria-describedby="{{ control.view.describedBy }}"{% endif %}>{% if control.view.invalid %}<p class="error" id="{{ control.view.errorId }}">{{ control.view.message }}</p>{% endif %}{% endfor %}<label for="{{ city.id }}">City</label><input id="{{ city.id }}" name="address[city]" aria-invalid="{{ city.ariaInvalid }}" aria-describedby="{{ city.describedBy }}"><p id="city-hint">Your town</p><p class="error" id="{{ city.errorId }}">{% for message in city.messages %}<span>{{ message }}</span>{% endfor %}</p></form>`,
} as const;

type Token =
  | { readonly tag: string; readonly attributes: readonly string[] }
  | { readonly text: string };

const entities: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decode(value: string): string {
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (whole, name: string) => {
      if (name.startsWith('#x') || name.startsWith('#X'))
        return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
      if (name.startsWith('#'))
        return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
      return entities[name.toLowerCase()] ?? whole;
    },
  );
}

/**
 * Tokenizes escaped HTML: data can never contain a raw `<`, so every `<`
 * starts a tag the template wrote. Attributes are decoded and sorted, so
 * engines that quote or order differently still compare equal, while an
 * unescaped quote in a value changes the attribute list.
 */
function tokens(html: string): Token[] {
  const result: Token[] = [];
  for (const [part] of html.matchAll(/<[^>]*>|[^<]+/g)) {
    if (part.startsWith('<')) {
      const name = /^<\/?([a-z0-9]+)/i.exec(part)?.[0] ?? part;
      const attributes = [
        ...part.matchAll(/\s([a-z][a-z0-9-]*)(?:="([^"]*)")?/gi),
      ]
        .map(([, key, value]) => `${key ?? ''}=${decode(value ?? '')}`)
        .sort();
      result.push({ tag: name.toLowerCase(), attributes });
    } else {
      const text = decode(part);
      if (text.trim()) result.push({ text });
    }
  }
  return result;
}

function model() {
  const profile = defineForm({
    fields: { displayName: '', email: '', bio: '' },
  });
  let state = profile.create({ displayName: HOSTILE, email: 'a@b' });
  state = profile.begin(state);
  state = profile.finish(state, {
    errors: {
      displayName: [`Name ${HOSTILE} is reserved`, 'second message'],
      email: ['Email & "address" <required>'],
      [FORM_ERROR]: [`Form ${HOSTILE}`],
    },
  });
  const view = profile.view(state, { idPrefix: 'profile-' });
  const labels: Record<string, string> = {
    displayName: `Display <name>`,
    email: 'Email',
    bio: 'Bio',
  };
  const summary = errorSummary(state.errors, {
    idPrefix: 'profile-',
    labels,
    order: profile.fields,
  });
  const city = fieldView(
    { 'address.city': [`City ${HOSTILE}`, 'Pick one'] },
    'address.city',
    { idPrefix: 'profile-', hints: { 'address.city': 'city-hint' } },
  );
  return {
    summary,
    city,
    controls: profile.fields.map((name) => ({
      name,
      label: labels[name] ?? name,
      value: String(view.values[name] ?? ''),
      view: view.fields[name],
    })),
    viewSummary: view.summary,
  };
}

let root: string;
const engines: Record<string, ViewEngineAdapter> = {};
const rendered: Record<string, string> = {};

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'nestvexa-form-views-'));
  await writeFile(path.join(root, 'form.hbs'), templates.hbs);
  await writeFile(path.join(root, 'form.ejs'), templates.ejs);
  await writeFile(path.join(root, 'form.pug'), templates.pug);
  await writeFile(path.join(root, 'form.njk'), templates.njk);
  engines['hbs'] = new HbsEngine({ root });
  engines['ejs'] = new EjsEngine({ root });
  engines['pug'] = new PugEngine({ root, doctype: 'html' });
  engines['nunjucks'] = new NunjucksEngine({ root });
  const data = model();
  for (const [name, engine] of Object.entries(engines)) {
    await engine.initialize?.();
    rendered[name] = await engine.render('form', data);
  }
});

afterAll(async () => {
  for (const engine of Object.values(engines)) await engine.dispose?.();
  await rm(root, { recursive: true, force: true });
});

describe('form view helpers through every engine adapter', () => {
  it('view() summary matches errorSummary() with the same prefix and order', () => {
    const data = model();
    expect(data.viewSummary.items.map((item) => item.href)).toEqual(
      data.summary.items.map((item) => item.href),
    );
  });

  it.each(['ejs', 'pug', 'nunjucks'])(
    '%s renders the same elements, attributes and text as Handlebars',
    (name) => {
      expect(tokens(rendered[name] ?? '')).toStrictEqual(
        tokens(rendered['hbs'] ?? ''),
      );
    },
  );

  it.each(['hbs', 'ejs', 'pug', 'nunjucks'])(
    '%s escapes hostile messages, labels and values (no live markup)',
    (name) => {
      const html = rendered[name] ?? '';
      expect(html).not.toContain('<script');
      expect(html).not.toContain('<img');
      // Escaped quotes keep hostile text inside attribute values: no element
      // gains an attribute the template did not write (onerror, src, ...).
      const names = new Set(
        tokens(html).flatMap((token) =>
          'tag' in token
            ? token.attributes.map((entry) =>
                entry.slice(0, entry.indexOf('=')),
              )
            : [],
        ),
      );
      expect([...names].sort()).toEqual(
        [
          'aria-describedby',
          'aria-invalid',
          'aria-labelledby',
          'class',
          'for',
          'href',
          'id',
          'name',
          'role',
          'value',
        ].sort(),
      );
      // The only elements present are the ones the template wrote.
      const tags = new Set(
        tokens(html).flatMap((token) => ('tag' in token ? [token.tag] : [])),
      );
      expect([...tags].sort()).toEqual(
        [
          '<a',
          '</a',
          '<div',
          '</div',
          '<form',
          '</form',
          '<h2',
          '</h2',
          '<input',
          '<label',
          '</label',
          '<li',
          '</li',
          '<p',
          '</p',
          '<span',
          '</span',
          '<ul',
          '</ul',
        ].sort(),
      );
    },
  );

  it.each(['hbs', 'ejs', 'pug', 'nunjucks'])(
    '%s wires ids, aria-invalid, aria-describedby and summary links',
    (name) => {
      const list = tokens(rendered[name] ?? '');
      const inputs = list.filter(
        (token): token is Extract<Token, { tag: string }> =>
          'tag' in token && token.tag === '<input',
      );
      const attrs = (index: number) =>
        Object.fromEntries(
          (inputs[index]?.attributes ?? []).map((entry) => {
            const at = entry.indexOf('=');
            return [entry.slice(0, at), entry.slice(at + 1)];
          }),
        );
      expect(attrs(0)).toStrictEqual({
        id: 'profile-displayName',
        name: 'displayName',
        value: HOSTILE,
        'aria-invalid': 'true',
        'aria-describedby': 'profile-displayName-error',
      });
      expect(attrs(1)).toMatchObject({
        id: 'profile-email',
        'aria-invalid': 'true',
        'aria-describedby': 'profile-email-error',
      });
      // A valid field has no aria-describedby at all, never an empty one.
      expect(attrs(2)).toStrictEqual({
        id: 'profile-bio',
        name: 'bio',
        value: '',
        'aria-invalid': 'false',
      });
      // Nested path: dots become dashes and the hint id comes first.
      expect(attrs(3)).toStrictEqual({
        id: 'profile-address-city',
        name: 'address[city]',
        'aria-invalid': 'true',
        'aria-describedby': 'city-hint profile-address-city-error',
      });
      const links = list.flatMap((token) =>
        'tag' in token && token.tag === '<a' ? token.attributes : [],
      );
      expect(links).toEqual([
        'href=#profile-displayName',
        'href=#profile-email',
      ]);
      const text = list
        .flatMap((token) => ('text' in token ? [token.text] : []))
        .join('|');
      expect(text).toContain('There are 3 problems');
      expect(text).toContain(`Form ${HOSTILE}`);
      expect(text).toContain(`Display <name>: Name ${HOSTILE} is reserved`);
      expect(text).toContain('Email & "address" <required>');
      expect(text).toContain(`City ${HOSTILE}|Pick one`);
      expect(text).not.toContain('second message');
    },
  );
});
