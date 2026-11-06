import { Inject, Injectable, Module } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import {
  Action,
  Computed,
  LiveComponent,
  State,
  Url,
  paginate,
} from 'nestvexa';
import {
  UploadError,
  UploadsService,
  parseUploadReferences,
  uploadReferenceField,
} from '@nestvexa/uploads';
import type { FinalizedUpload } from '@nestvexa/uploads';
import { bindingOf } from './identity.js';

export interface Product {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly priceCents: number;
  readonly image: FinalizedUpload | undefined;
}

const seed: readonly Omit<Product, 'image'>[] = [
  ['Atlas desk', 'Furniture', 24900],
  ['Beacon lamp', 'Lighting', 4900],
  ['Cobalt chair', 'Furniture', 15900],
  ['Delta shelf', 'Storage', 8900],
  ['Ember heater', 'Climate', 6900],
  ['Fjord rug', 'Textiles', 11900],
  ['Granite tray', 'Storage', 2900],
].map(([name, category, priceCents], index) => ({
  id: `p${index + 1}`,
  name: String(name),
  category: String(category),
  priceCents: Number(priceCents),
}));

/**
 * Demonstration catalog: one copy per identity binding, in process memory and
 * bounded. A real host uses its database with tenant/ownership columns.
 */
@Injectable()
export class ProductRepository {
  readonly #catalogs = new Map<string, Product[]>();
  list(owner: string): readonly Product[] {
    let products = this.#catalogs.get(owner);
    if (!products) {
      if (this.#catalogs.size >= 1000) this.#catalogs.clear();
      products = seed.map((product) => ({ ...product, image: undefined }));
      this.#catalogs.set(owner, products);
    }
    return products;
  }
  add(owner: string, product: Omit<Product, 'id'>): Product {
    const products = this.list(owner);
    if (products.length >= 60) throw new UploadError(429, 'QUOTA_EXCEEDED');
    const created = { ...product, id: `p${products.length + 1}` };
    this.#catalogs.set(owner, [...products, created]);
    return created;
  }
  find(owner: string, id: string): Product | undefined {
    return this.list(owner).find((product) => product.id === id);
  }
}

@Module({ providers: [ProductRepository], exports: [ProductRepository] })
export class ProductsModule {}

export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** `/products`: searchable, sortable, paginated table with a validated create form and image upload. */
@LiveComponent({ name: 'product-table', view: 'product-table' })
export class ProductTable {
  constructor(
    @Inject(ProductRepository) private readonly products: ProductRepository,
    @Inject(UploadsService) private readonly uploads: UploadsService,
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
    validate: (value) => value === 'name' || value === 'price',
  })
  sort = 'name';
  @Url({ key: 'page', history: 'push', except: 1 })
  @State({
    writable: true,
    validate: (value) =>
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 1 &&
      value <= 1000,
  })
  page = 1;
  @State({
    writable: true,
    validate: (value) => typeof value === 'string' && value.length <= 80,
  })
  draftName = '';
  @State({
    writable: true,
    validate: (value) => typeof value === 'string' && value.length <= 12,
  })
  draftPrice = '';
  /** Server-validated temporary upload reference set by `nv:upload="image"`. */
  @State({ writable: true, validate: uploadReferenceField({ max: 1 }) })
  image = '';
  @State() errors: Record<string, string> = {};
  @State() message = '';

  private owner(): string {
    return bindingOf(this.request);
  }
  private visible(): Product[] {
    const query = this.query.trim().toLowerCase();
    return this.products
      .list(this.owner())
      .filter(
        (product) =>
          !query ||
          product.name.toLowerCase().includes(query) ||
          product.category.toLowerCase().includes(query),
      )
      .sort((left, right) =>
        this.sort === 'price'
          ? left.priceCents - right.priceCents ||
            left.name.localeCompare(right.name)
          : left.name.localeCompare(right.name),
      );
  }
  @Computed() get pagination() {
    return paginate({
      page: this.page,
      perPage: 4,
      total: this.visible().length,
    });
  }
  @Computed() get rows() {
    const page = this.pagination;
    return this.visible()
      .slice(page.offset, page.offset + page.perPage)
      .map((product) => ({
        id: product.id,
        name: product.name,
        category: product.category,
        price: formatPrice(product.priceCents),
        hasImage: product.image !== undefined,
      }));
  }
  @Computed() get sortByName(): string {
    return this.sort === 'name' ? 'ascending' : 'none';
  }
  @Computed() get sortByPrice(): string {
    return this.sort === 'price' ? 'ascending' : 'none';
  }
  /** Server-built links keep pagination working without JavaScript. */
  @Computed() get pageLinks() {
    return this.pagination.links.map((link) => {
      if (link.gap) return { gap: true, href: '', label: '…', current: false };
      const query = new URLSearchParams();
      if (this.query) query.set('q', this.query);
      if (this.sort !== 'name') query.set('sort', this.sort);
      if (link.page > 1) query.set('page', String(link.page));
      const search = query.toString();
      return {
        gap: false,
        href: '/products' + (search ? '?' + search : ''),
        label: String(link.page),
        current: link.current,
      };
    });
  }
  @Action() search(): void {
    this.page = 1;
  }
  @Action() sortBy(): void {
    this.sort = this.sort === 'name' ? 'price' : 'name';
    this.page = 1;
  }
  @Action() async create(): Promise<void> {
    const name = this.draftName.trim();
    const errors: Record<string, string> = {};
    if (name.length < 2) errors['name'] = 'Enter at least 2 characters.';
    else if (
      this.products
        .list(this.owner())
        .some((item) => item.name.toLowerCase() === name.toLowerCase())
    )
      errors['name'] = 'A product with this name already exists.';
    const price = this.draftPrice.trim();
    if (!/^\d{1,5}(\.\d{1,2})?$/.test(price))
      errors['price'] = 'Enter a price such as 19.99 (up to 99999.99).';
    this.errors = errors;
    if (Object.keys(errors).length) return;
    let image: FinalizedUpload | undefined;
    const [token] = parseUploadReferences(this.image, 1);
    if (token) {
      try {
        // Re-checks identity, purpose, expiry, size, hash and content type.
        image = await this.uploads.finalize(this.request, token, {
          purpose: 'product-table.image',
        });
      } catch (error) {
        this.image = '';
        if (!(error instanceof UploadError)) throw error;
        this.errors = { image: `The image was refused (${error.code}).` };
        return;
      }
    }
    this.products.add(this.owner(), {
      name,
      category: 'New',
      priceCents: Math.round(Number(price) * 100),
      image,
    });
    this.draftName = '';
    this.draftPrice = '';
    this.image = '';
    this.message = `${name} was added${image ? ' with an image' : ''}.`;
    // Jump to the page holding the new product in the current ordering.
    const index = this.visible().findIndex((item) => item.name === name);
    this.page = index < 0 ? 1 : Math.floor(index / 4) + 1;
  }
}
