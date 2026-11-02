import {
  BadRequestException,
  Inject,
  Injectable,
  Module,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type {
  CanActivate,
  ExecutionContext,
  PipeTransform,
} from '@nestjs/common';
import {
  ActionContext,
  ActionError,
  ActionGroup,
  ActionInput,
  ServerAction,
  withNotifications,
} from '@nestvexa/actions';

export interface SessionState {
  csrf?: string;
  userId?: string;
}
interface SessionRequest {
  session?: SessionState;
}

export interface AddItemInput {
  productId: string;
  quantity: number;
}
export interface CartLine {
  productId: string;
  name: string;
  quantity: number;
  unitCents: number;
}
export interface CartSummary {
  owner: string;
  lines: CartLine[];
  totalCents: number;
  updatedAt: Date;
}

const catalog: Readonly<Record<string, { name: string; unitCents: number }>> =
  Object.freeze({
    'nest-mug': { name: 'Nest mug', unitCents: 1200 },
    'vexa-shirt': { name: 'Vexa shirt', unitCents: 2500 },
  });

/** Business service: plain Nest provider, unaware of HTTP or actions. */
@Injectable()
export class CartService {
  // Demonstration storage, bounded and process-local.
  readonly #carts = new Map<string, Map<string, number>>();

  add(owner: string, input: AddItemInput): CartSummary {
    if (!Object.hasOwn(catalog, input.productId))
      throw ActionError.notFound('Unknown product');
    let cart = this.#carts.get(owner);
    if (!cart) {
      if (this.#carts.size >= 1000) throw ActionError.rateLimited();
      cart = new Map();
      this.#carts.set(owner, cart);
    }
    const quantity = (cart.get(input.productId) ?? 0) + input.quantity;
    if (quantity > 20)
      throw new ActionError('CONFLICT', 'At most 20 of one product per cart', {
        reason: 'QUANTITY_LIMIT',
      });
    cart.set(input.productId, quantity);
    return this.summary(owner);
  }

  clear(owner: string): void {
    this.#carts.delete(owner);
  }

  summary(owner: string): CartSummary {
    const lines: CartLine[] = [];
    for (const [productId, quantity] of this.#carts.get(owner) ?? []) {
      const product = catalog[productId];
      if (product)
        lines.push({
          productId,
          name: product.name,
          quantity,
          unitCents: product.unitCents,
        });
    }
    return {
      owner,
      lines,
      totalCents: lines.reduce(
        (total, line) => total + line.quantity * line.unitCents,
        0,
      ),
      updatedAt: new Date(),
    };
  }
}

/** Requires a signed-in session; guest sessions only receive a CSRF token. */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<SessionRequest>();
    if (!request.session?.userId)
      throw new UnauthorizedException('Sign in to use the cart');
    return true;
  }
}

/** DTO validation through a normal Nest pipe; unknown fields are dropped. */
@Injectable()
export class AddItemPipe implements PipeTransform<unknown, AddItemInput> {
  transform(value: unknown): AddItemInput {
    const record =
      typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)
        : {};
    const productId = record['productId'];
    const quantity = record['quantity'];
    const problems: string[] = [];
    if (typeof productId !== 'string' || !/^[a-z-]{1,40}$/.test(productId))
      problems.push('productId must be a catalog slug');
    if (
      typeof quantity !== 'number' ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 5
    )
      problems.push('quantity must be an integer from 1 to 5');
    if (problems.length > 0 || typeof productId !== 'string')
      throw new BadRequestException(problems);
    return { productId, quantity: Number(quantity) };
  }
}

@Module({
  providers: [CartService, SessionAuthGuard, AddItemPipe],
  exports: [CartService, SessionAuthGuard, AddItemPipe],
})
export class CartModule {}

@Injectable()
@ActionGroup('cart')
@UseGuards(SessionAuthGuard)
export class CartActions {
  constructor(@Inject(CartService) private readonly cart: CartService) {}

  @ServerAction({ id: 'add-item', idempotent: true, concurrency: 'serial' })
  add(
    @ActionInput(AddItemPipe) input: AddItemInput,
    @ActionContext() context: ActionContext,
  ): CartSummary {
    // The owner always comes from the host-resolved identity, never the body.
    return this.cart.add(context.identity.subject, input);
  }

  @ServerAction({ id: 'summary' })
  summary(@ActionContext() context: ActionContext): CartSummary {
    return this.cart.summary(context.identity.subject);
  }

  @ServerAction({ id: 'clear' })
  clear(@ActionContext() context: ActionContext) {
    this.cart.clear(context.identity.subject);
    return withNotifications(this.cart.summary(context.identity.subject), {
      level: 'info',
      message: 'Cart cleared',
    });
  }
}
