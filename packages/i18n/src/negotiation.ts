import { own } from './errors.js';

const maxHeaderLength = 4096;
const maxEntries = 32;
const qualityPattern = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

function header(request: object, name: string): string | undefined {
  const headers: unknown = Reflect.get(request, 'headers');
  if (!headers || typeof headers !== 'object') return undefined;
  const value = own(headers, name);
  return typeof value === 'string' ? value : undefined;
}

/** A single string query value; arrays, objects and duplicates are ignored. */
export function queryValue(request: object, name: string): string | undefined {
  const query: unknown = Reflect.get(request, 'query');
  if (query && typeof query === 'object') {
    const value = own(query, name);
    return typeof value === 'string' ? value : undefined;
  }
  const url: unknown = Reflect.get(request, 'url');
  if (typeof url !== 'string' || url.length > 8192) return undefined;
  const mark = url.indexOf('?');
  if (mark < 0) return undefined;
  try {
    const values = new URLSearchParams(url.slice(mark + 1)).getAll(name);
    return values.length === 1 ? values[0] : undefined;
  } catch {
    return undefined;
  }
}

/** Cookie value from a cookie parser's object or the bounded raw header. */
export function cookieValue(request: object, name: string): string | undefined {
  const cookies: unknown = Reflect.get(request, 'cookies');
  if (cookies && typeof cookies === 'object') {
    const value = own(cookies, name);
    if (typeof value === 'string') return value;
  }
  const raw = header(request, 'cookie');
  if (raw === undefined || raw.length > maxHeaderLength) return undefined;
  const pairs = raw.split(';', 64);
  let found: string | undefined;
  for (const pair of pairs) {
    const separator = pair.indexOf('=');
    if (separator < 0 || pair.slice(0, separator).trim() !== name) continue;
    // Duplicate cookie names are ambiguous; ignore them all.
    if (found !== undefined) return undefined;
    let value = pair.slice(separator + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
      value = value.slice(1, -1);
    try {
      found = decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return found;
}

/** Accept-Language ranges ordered by quality; malformed or q=0 entries are skipped. */
export function acceptLanguages(request: object): readonly string[] {
  const raw = header(request, 'accept-language');
  if (raw === undefined || raw.length > maxHeaderLength) return [];
  const ranges: { tag: string; quality: number; order: number }[] = [];
  const parts = raw.split(',', maxEntries);
  parts.forEach((part, order) => {
    const [tag = '', ...parameters] = part.trim().split(';');
    let quality = 1;
    for (const parameter of parameters) {
      const [key = '', value = ''] = parameter.trim().split('=');
      if (key.trim().toLowerCase() !== 'q') continue;
      if (!qualityPattern.test(value.trim())) return;
      quality = Number(value.trim());
    }
    const trimmed = tag.trim();
    if (!trimmed || trimmed === '*' || quality <= 0) return;
    ranges.push({ tag: trimmed, quality, order });
  });
  return ranges
    .sort((a, b) => b.quality - a.quality || a.order - b.order)
    .map((range) => range.tag);
}
