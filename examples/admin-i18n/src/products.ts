import { BadRequestException, Inject } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { I18n } from '@nestvexa/i18n';
import type { I18nView } from '@nestvexa/i18n';
import {
  Action,
  ActionInput,
  Computed,
  LiveComponent,
  OnEvent,
  State,
  Url,
  dispatchLiveEvent,
  paginate,
} from 'nestvexa';
import { Catalog, categories, validateProduct } from './catalog.js';
import type { Product, ProductErrors } from './catalog.js';
import { binding, sessionCsrfOrEmpty } from './identity.js';

const sorts = ['name', 'price', 'updated'] as const;
const directions = ['asc', 'desc'] as const;

/** Event payloads are untrusted browser data: accept only `{ id }`. */
class ProductEventPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    const id: unknown =
      value && typeof value === 'object' && !Array.isArray(value)
        ? Reflect.get(value, 'id')
        : undefined;
    if (
      Object.keys(value ?? {}).length !== 1 ||
      typeof id !== 'string' ||
      !/^[a-z0-9-]{1,32}$/.test(id)
    )
      throw new BadRequestException('Expected a product reference');
    return id;
  }
}

/**
 * Sortable, searchable, paginated catalog table. The locale is a per-request
 * computed value: it is never stored in the snapshot, never client-writable and
 * never part of authorization.
 */
@LiveComponent({ name: 'product-table', view: 'product-table' })
export class ProductTable {
  constructor(
    @Inject(Catalog) private readonly catalog: Catalog,
    @Inject(I18n) private readonly translations: I18n,
    @Inject(REQUEST) private readonly request: object,
  ) {}
  @Url({ key: 'q', history: 'replace', except: '' })
  @State({
    writable: true,
    validate: (value) => typeof value === 'string' && value.length <= 40,
  })
  query = '';
  @Url({ key: 'sort', history: 'replace', except: 'name' })
  @State({
    writable: true,
    validate: (value) => sorts.some((sort) => sort === value),
  })
  sort = 'name';
  @Url({ key: 'dir', history: 'replace', except: 'asc' })
  @State({
    writable: true,
    validate: (value) => directions.some((direction) => direction === value),
  })
  direction = 'asc';
  @Url({ key: 'page', history: 'push', except: 1 })
  @State({
    writable: true,
    validate: (value) =>
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 1 &&
      value <= 100,
  })
  page = 1;
  /** Bumped by events so a re-render is observable; not otherwise used. */
  @State() revision = 0;

  @Computed() get i18n(): I18nView {
    return this.translations.forRequest(this.request).view;
  }
  private visible(): Product[] {
    const context = this.translations.forRequest(this.request);
    const query = this.query.trim().toLocaleLowerCase(context.locale);
    const factor = this.direction === 'desc' ? -1 : 1;
    return this.catalog
      .list(binding(this.request))
      .filter(
        (product) =>
          !query ||
          product.name.toLocaleLowerCase(context.locale).includes(query) ||
          context
            .t(`products:categories.${product.category}`)
            .toLocaleLowerCase(context.locale)
            .includes(query),
      )
      .sort((left, right) => {
        const order =
          this.sort === 'price'
            ? left.price - right.price
            : this.sort === 'updated'
              ? left.updatedAt.localeCompare(right.updatedAt)
              : left.name.localeCompare(right.name, context.locale);
        return order * factor || left.id.localeCompare(right.id);
      });
  }
  @Computed() get pagination() {
    return paginate({
      page: this.page,
      perPage: 5,
      total: this.visible().length,
    });
  }
  @Computed() get rows() {
    const context = this.translations.forRequest(this.request);
    const page = this.pagination;
    return this.visible()
      .slice(page.offset, page.offset + page.perPage)
      .map((product) => ({
        id: product.id,
        name: product.name,
        categoryLabel: context.t(`products:categories.${product.category}`),
        price: product.price,
        updatedAt: product.updatedAt,
        statusLabel: context.t(`products:status.${product.status}`),
        archived: product.status === 'archived',
      }));
  }
  @Computed() get summary(): string {
    const page = this.pagination;
    return this.translations.forRequest(this.request).t('products:summary', {
      total: page.total,
      page: page.page,
      pages: page.pages,
    });
  }
  /** Server-built links keep pagination working without JavaScript. */
  @Computed() get pageHref(): string {
    const query = new URLSearchParams();
    if (this.query) query.set('q', this.query);
    if (this.sort !== 'name') query.set('sort', this.sort);
    if (this.direction !== 'asc') query.set('dir', this.direction);
    const search = query.toString();
    return `/admin?${search ? search + '&' : ''}page=`;
  }
  private sortBy(sort: (typeof sorts)[number]): void {
    this.direction =
      this.sort === sort && this.direction === 'asc' ? 'desc' : 'asc';
    this.sort = sort;
    this.page = 1;
  }
  @Action() sortByName(): void {
    this.sortBy('name');
  }
  @Action() sortByPrice(): void {
    this.sortBy('price');
  }
  @Action() sortByUpdated(): void {
    this.sortBy('updated');
  }
  @Action() search(): void {
    this.page = 1;
  }
  @Action()
  @OnEvent('product-created')
  @OnEvent('product-archived')
  changed(@ActionInput(ProductEventPipe) id: string): void {
    // Only re-render; the repository, not the payload, is authoritative.
    if (this.catalog.find(binding(this.request), id)) this.revision++;
  }
}

/** Translated validation messages for one render. */
function translate(
  errors: ProductErrors,
  t: (key: string) => string,
): Record<string, string> {
  const messages: Record<string, string> = {};
  for (const [field, key] of Object.entries(errors))
    if (typeof key === 'string') messages[field] = t(key);
  return messages;
}

/**
 * Product form shown in the dialog and on the plain fallback page. Errors are
 * stored as translation keys so a locale switch re-renders them correctly.
 */
@LiveComponent({ name: 'product-form', view: 'product-form' })
export class ProductForm {
  constructor(
    @Inject(Catalog) private readonly catalog: Catalog,
    @Inject(I18n) private readonly translations: I18n,
    @Inject(REQUEST) private readonly request: object,
  ) {}
  @State({
    writable: true,
    validate: (value) => typeof value === 'string' && value.length <= 80,
  })
  name = '';
  @State({
    writable: true,
    validate: (value) =>
      value === '' || categories.some((category) => category === value),
  })
  category = '';
  @State({
    writable: true,
    validate: (value) => typeof value === 'string' && value.length <= 16,
  })
  price = '';
  @State({
    writable: true,
    validate: (value) => typeof value === 'string' && value.length <= 500,
  })
  notes = '';
  @State() errors: ProductErrors = {};
  /** Epoch milliseconds of the last accepted save; clears the local draft. */
  @State() committedAt = 0;

  @Computed() get i18n(): I18nView {
    return this.translations.forRequest(this.request).view;
  }
  @Computed() get messages(): Record<string, string> {
    const context = this.translations.forRequest(this.request);
    return translate(this.errors, (key) => context.t(key));
  }
  @Computed() get invalid() {
    return {
      any: Object.keys(this.errors).length > 0,
      name: this.errors.name !== undefined,
      category: this.errors.category !== undefined,
      price: this.errors.price !== undefined,
    };
  }
  @Computed() get categoryOptions() {
    const context = this.translations.forRequest(this.request);
    return categories.map((value) => ({
      value,
      label: context.t(`products:categories.${value}`),
    }));
  }
  /** Session token for the no-JavaScript POST fallback of this same form. */
  @Computed() get csrf(): string {
    return sessionCsrfOrEmpty(this.request);
  }
  @Action() save(): void {
    const owner = binding(this.request);
    const input = {
      name: this.name,
      category: this.category,
      price: this.price,
    };
    this.errors = validateProduct(input, this.catalog.list(owner));
    if (Object.keys(this.errors).length) return;
    const product = this.catalog.add(owner, input);
    const context = this.translations.forRequest(this.request);
    this.name = '';
    this.category = '';
    this.price = '';
    this.notes = '';
    this.committedAt = Date.now();
    dispatchLiveEvent(this, 'product-created', { id: product.id });
    dispatchLiveEvent(this, 'toast', {
      message: context.t('products:created', { name: product.name }),
      tone: 'success',
    });
  }
}
