import { BadRequestException, Injectable, Module } from '@nestjs/common';

export const categories = [
  'lighting',
  'furniture',
  'office',
  'kitchen',
  'outdoor',
] as const;
export type Category = (typeof categories)[number];
export interface Product {
  readonly id: string;
  readonly name: string;
  readonly category: Category;
  readonly price: number;
  readonly status: 'active' | 'archived';
  readonly updatedAt: string;
}
export interface Activity {
  readonly kind: 'created' | 'archived';
  readonly productId: string;
  readonly name: string;
  readonly at: string;
}

const seed: readonly Product[] = [
  ['lamp', 'Desk lamp', 'lighting', 39.9, '2026-10-28T09:30:00.000Z'],
  ['chair', 'Oak chair', 'furniture', 129, '2026-10-20T14:00:00.000Z'],
  ['notebook', 'Dot-grid notebook', 'office', 8.5, '2026-10-30T08:15:00.000Z'],
  ['kettle', 'Steel kettle', 'kitchen', 45, '2026-09-15T11:45:00.000Z'],
  ['lantern', 'Garden lantern', 'outdoor', 24.99, '2026-10-02T17:20:00.000Z'],
  ['shelf', 'Wall shelf', 'furniture', 59, '2026-08-11T10:00:00.000Z'],
  ['mug', 'Stoneware mug', 'kitchen', 12, '2026-10-31T16:05:00.000Z'],
].map(([id, name, category, price, updatedAt]) => ({
  id: String(id),
  name: String(name),
  category: categories.find((item) => item === category) ?? 'office',
  price: Number(price),
  status: 'active' as const,
  updatedAt: String(updatedAt),
}));
/** Display names of the seeded products for tool-approval summaries. */
export function seedName(id: string): string {
  return seed.find((product) => product.id === id)?.name ?? id;
}

export interface ProductInput {
  readonly name: string;
  readonly category: string;
  readonly price: string;
}
export type ProductErrors = Partial<
  Record<'name' | 'category' | 'price', string>
>;
/** Arabic-Indic and Eastern Arabic-Indic digits and separators become ASCII. */
export function normalizeDigits(value: string): string {
  return value
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[٫,]/g, '.')
    .trim();
}
export function parsePrice(value: string): number | undefined {
  const normalized = normalizeDigits(value);
  if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(normalized)) return undefined;
  const price = Number(normalized);
  return price >= 0.01 && price <= 100_000 ? price : undefined;
}

/**
 * Shared server validation for the Live form and the no-JavaScript POST route.
 * Returns translation keys, so messages follow the locale of each render.
 */
export function validateProduct(
  input: ProductInput,
  existing: readonly Product[],
): ProductErrors {
  const errors: ProductErrors = {};
  const name = input.name.trim();
  if (name.length < 2) errors.name = 'products:errors.nameShort';
  else if (name.length > 60) errors.name = 'products:errors.nameLong';
  else if (
    existing.some(
      (product) => product.name.toLowerCase() === name.toLowerCase(),
    )
  )
    errors.name = 'products:errors.nameTaken';
  if (!categories.some((category) => category === input.category))
    errors.category = 'products:errors.category';
  if (parsePrice(input.price) === undefined)
    errors.price = 'products:errors.price';
  return errors;
}

/**
 * Demonstration repository: per guest identity, in process memory. A real host
 * uses its database and resource-level authorization here.
 */
@Injectable()
export class Catalog {
  readonly #products = new Map<string, Product[]>();
  readonly #activity = new Map<string, Activity[]>();
  list(owner: string): readonly Product[] {
    let products = this.#products.get(owner);
    if (!products) {
      if (this.#products.size >= 1000) {
        this.#products.clear();
        this.#activity.clear();
      }
      products = seed.map((product) => ({ ...product }));
      this.#products.set(owner, products);
    }
    return products;
  }
  find(owner: string, id: string): Product | undefined {
    return this.list(owner).find((product) => product.id === id);
  }
  add(owner: string, input: ProductInput): Product {
    const products = [...this.list(owner)];
    if (products.length >= 100)
      throw new BadRequestException('Product limit reached');
    const errors = validateProduct(input, products);
    if (Object.keys(errors).length)
      throw new BadRequestException('Invalid product');
    const name = input.name.trim();
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 24) || 'product';
    let id = base;
    for (let suffix = 2; products.some((item) => item.id === id); suffix++)
      id = `${base}-${suffix}`;
    const product: Product = {
      id,
      name,
      category: categories.find((item) => item === input.category) ?? 'office',
      price: parsePrice(input.price) ?? 0,
      status: 'active',
      updatedAt: new Date().toISOString(),
    };
    this.#products.set(owner, [...products, product]);
    this.#record(owner, 'created', product);
    return product;
  }
  archive(owner: string, id: string): Product {
    const product = this.find(owner, id);
    if (!product || product.status !== 'active')
      throw new BadRequestException('Product is not active');
    const archived: Product = {
      ...product,
      status: 'archived',
      updatedAt: new Date().toISOString(),
    };
    this.#products.set(
      owner,
      this.list(owner).map((item) => (item.id === id ? archived : item)),
    );
    this.#record(owner, 'archived', archived);
    return archived;
  }
  activity(owner: string): readonly Activity[] {
    return this.#activity.get(owner) ?? [];
  }
  clear(owner: string): void {
    this.#products.delete(owner);
    this.#activity.delete(owner);
  }
  #record(owner: string, kind: Activity['kind'], product: Product): void {
    const entries = [
      {
        kind,
        productId: product.id,
        name: product.name,
        at: product.updatedAt,
      },
      ...this.activity(owner),
    ].slice(0, 10);
    this.#activity.set(owner, entries);
  }
}

@Module({ providers: [Catalog], exports: [Catalog] })
export class CatalogModule {}
