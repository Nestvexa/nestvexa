import {
  Catch,
  Controller,
  Get,
  HttpException,
  Injectable,
  Param,
  ParseIntPipe,
  UnauthorizedException,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type {
  ArgumentsHost,
  CallHandler,
  CanActivate,
  ExceptionFilter,
  ExecutionContext,
  NestInterceptor,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { map } from 'rxjs';
import type { Observable } from 'rxjs';

/*
 * `/api/health`: an ordinary Nest REST controller with its own guard, pipe,
 * interceptor and exception filter. Nestvexa renders nothing here and replaces
 * none of these enhancers.
 */

/** Demonstration API key; a real deployment reads a secret from its config. */
export const demoApiKey = 'matrix-demo-key';

@Injectable()
class ApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    const sent = request.headers['x-api-key'];
    const actual = Buffer.from(typeof sent === 'string' ? sent : '');
    const expected = Buffer.from(demoApiKey);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new UnauthorizedException('A valid x-api-key header is required');
    return true;
  }
}

/** Adds a response envelope marker so tests can see the interceptor ran. */
@Injectable()
class EnvelopeInterceptor implements NestInterceptor {
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next
      .handle()
      .pipe(map((data: unknown) => ({ data, intercepted: true })));
  }
}

/** Formats HTTP errors as a small JSON problem object. */
@Catch(HttpException)
class ProblemFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{
      status(code: number): { json(body: unknown): void };
    }>();
    response.status(exception.getStatus()).json({
      problem: {
        status: exception.getStatus(),
        title: exception.message,
      },
    });
  }
}

@Controller('api/health')
@UseFilters(ProblemFilter)
@UseInterceptors(EnvelopeInterceptor)
export class HealthController {
  @Get()
  health() {
    return {
      status: 'ok',
      routes: [
        '/',
        '/counter',
        '/products',
        '/admin/react',
        '/admin/vue',
        '/admin/svelte',
        '/hybrid',
        '/realtime',
      ],
    };
  }
  @Get('secure')
  @UseGuards(ApiKeyGuard)
  secure() {
    return { status: 'ok', guarded: true };
  }
  @Get('square/:value')
  square(@Param('value', ParseIntPipe) value: number) {
    return { value, square: value * value };
  }
}
