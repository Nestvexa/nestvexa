import { Controller, Get } from '@nestjs/common';
import { InertiaPage } from '@nestvexa/inertia';

// The shared @nestvexa/ui primitives rendered by the React wrappers
// (@nestvexa/ui/react, ADR 0033) with the same markup contract and keyboard
// module as the HBS helpers of examples/admin-i18n.

export interface KitProduct {
  readonly id: string;
  readonly name: string;
  readonly category: 'books' | 'tools';
}

const products: readonly KitProduct[] = [
  { id: 'p1', name: 'Atlas', category: 'books' },
  { id: 'p2', name: 'Hammer', category: 'tools' },
  { id: 'p3', name: 'Almanac', category: 'books' },
];

@Controller('kit')
export class KitController {
  @Get()
  @InertiaPage('Kit/Index')
  index() {
    return { products: () => products.map((product) => ({ ...product })) };
  }
}
