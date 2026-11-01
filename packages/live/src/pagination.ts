/** Template-ready pagination metadata; contains no items and performs no queries. */
export interface Pagination {
  readonly page: number;
  readonly perPage: number;
  readonly total: number;
  readonly pages: number;
  /** Zero-based offset for the host query (`skip`/`OFFSET`). */
  readonly offset: number;
  readonly from: number;
  readonly to: number;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
  readonly previous: number | null;
  readonly next: number | null;
  /** Windowed page links; `gap` entries render as an ellipsis. */
  readonly links: readonly (
    | { readonly page: number; readonly current: boolean; readonly gap: false }
    | { readonly page: null; readonly current: false; readonly gap: true }
  )[];
}
export interface PaginateOptions {
  readonly page: number;
  readonly perPage: number;
  readonly total: number;
  /** Links shown on each side of the current page; default 2. */
  readonly window?: number;
}
function integer(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new RangeError(
      `${name} must be an integer from ${minimum} through ${maximum}`,
    );
  return value;
}
/**
 * Clamp an untrusted page number into range and describe the page. Out-of-range
 * pages (for example after deletions) resolve to the last available page.
 */
export function paginate(options: PaginateOptions): Pagination {
  const perPage = integer('perPage', options.perPage, 1, 1000);
  const total = integer('total', options.total, 0, Number.MAX_SAFE_INTEGER);
  const span = integer('window', options.window ?? 2, 0, 10);
  const pages = Math.max(1, Math.ceil(total / perPage));
  const requested = Number.isSafeInteger(options.page) ? options.page : 1;
  const page = Math.min(Math.max(1, requested), pages);
  const offset = (page - 1) * perPage;
  const links: Pagination['links'][number][] = [];
  const add = (number: number) =>
    links.push({ page: number, current: number === page, gap: false });
  const start = Math.max(2, page - span);
  const end = Math.min(pages - 1, page + span);
  add(1);
  if (start > 2) links.push({ page: null, current: false, gap: true });
  for (let number = start; number <= end; number++) add(number);
  if (end < pages - 1) links.push({ page: null, current: false, gap: true });
  if (pages > 1) add(pages);
  return Object.freeze({
    page,
    perPage,
    total,
    pages,
    offset,
    from: total === 0 ? 0 : offset + 1,
    to: Math.min(total, offset + perPage),
    hasPrevious: page > 1,
    hasNext: page < pages,
    previous: page > 1 ? page - 1 : null,
    next: page < pages ? page + 1 : null,
    links: Object.freeze(links.map((link) => Object.freeze(link))),
  });
}
