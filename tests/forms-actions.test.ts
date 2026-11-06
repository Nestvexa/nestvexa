import 'reflect-metadata';
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { IsInt, IsString, Max, Min, MinLength } from 'class-validator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ActionGroup,
  ActionInput,
  ActionsModule,
  ServerAction,
} from '../packages/actions/dist/index.js';
import {
  FormValidationPipe,
  actionSchema,
  classValidatorAdapter,
  zodAdapter,
} from '../packages/forms/dist/index.js';

const origin = 'http://forms-actions.test';
const csrf = 'forms-actions-csrf-token-0123456789';
const profile = zodAdapter(
  z.strictObject({
    name: z.string().trim().min(2, 'Enter at least 2 characters.'),
    address: z.strictObject({ city: z.string().min(1, 'Enter a city.') }),
  }),
);
class Quantity {
  @IsString()
  @MinLength(1)
  sku!: string;
  @IsInt()
  @Min(1)
  @Max(10)
  quantity!: number;
}
const received: unknown[] = [];

@ActionGroup('profile')
class ProfileActions {
  @ServerAction({ id: 'save', input: actionSchema(profile) })
  save(@ActionInput() input: { name: string; address: { city: string } }) {
    received.push(input);
    return { saved: input.name };
  }
  @ServerAction({ id: 'add' })
  add(
    @ActionInput(new FormValidationPipe(classValidatorAdapter(Quantity)))
    input: Quantity,
  ) {
    received.push(input);
    return { sku: input.sku, quantity: input.quantity };
  }
}
@Controller('plain')
class PlainController {
  @Post()
  @HttpCode(200)
  submit(@Body(new FormValidationPipe(profile)) body: { name: string }) {
    return { name: body.name };
  }
}

for (const platform of ['express', 'fastify'] as const)
  describe(`forms adapters on @nestvexa/actions inputs (${platform})`, () => {
    let app: INestApplication;
    let base: string;
    beforeAll(async () => {
      const module = await Test.createTestingModule({
        imports: [
          ActionsModule.register({
            groups: [ProfileActions],
            origin,
            resolveIdentity: () => ({ subject: 'user-1', csrfToken: csrf }),
            authorize: () => true,
          }),
        ],
        controllers: [PlainController],
      }).compile();
      app =
        platform === 'express'
          ? module.createNestApplication({ logger: false })
          : module.createNestApplication(new FastifyAdapter(), {
              logger: false,
            });
      await app.listen(0, '127.0.0.1');
      base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    });
    afterAll(async () => {
      await app.close();
    });
    const call = async (action: string, input: unknown) => {
      const response = await fetch(`${base}/_nestvexa/actions/${action}`, {
        method: 'POST',
        headers: {
          origin,
          'content-type': 'application/json',
          'x-nestvexa-csrf': csrf,
        },
        body: JSON.stringify({ input }),
      });
      return {
        status: response.status,
        body: (await response.json()) as {
          ok?: boolean;
          data?: unknown;
          error?: {
            code: string;
            issues?: { path: (string | number)[]; message: string }[];
          };
        },
      };
    };
    it('validates action input through actionSchema with field paths', async () => {
      received.length = 0;
      const ok = await call('profile/save', {
        name: '  Ada ',
        address: { city: 'Paris' },
      });
      expect(ok.status).toBe(200);
      expect(ok.body.data).toEqual({ saved: 'Ada' });
      expect(received).toEqual([{ name: 'Ada', address: { city: 'Paris' } }]);
      const invalid = await call('profile/save', {
        name: 'A',
        address: { city: '' },
      });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error?.code).toBe('VALIDATION');
      expect(invalid.body.error?.issues).toEqual([
        { path: ['name'], message: 'Enter at least 2 characters.' },
        { path: ['address', 'city'], message: 'Enter a city.' },
      ]);
      const hostile = await call(
        'profile/save',
        JSON.parse('{"name":"Ada","address":{"city":"x"},"role":"admin"}'),
      );
      expect(hostile.status).toBe(400);
      expect(received).toHaveLength(1);
    });
    it('validates through FormValidationPipe on @ActionInput and @Body', async () => {
      received.length = 0;
      const ok = await call('profile/add', { sku: 'A1', quantity: 2 });
      expect(ok.status).toBe(200);
      expect(ok.body.data).toEqual({ sku: 'A1', quantity: 2 });
      expect(received[0]).toBeInstanceOf(Quantity);
      const invalid = await call('profile/add', { sku: 'A1', quantity: '2' });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error?.code).toBe('VALIDATION');
      expect(invalid.body.error?.issues?.length).toBeGreaterThan(0);
      const extra = await call('profile/add', {
        sku: 'A1',
        quantity: 2,
        price: 0,
      });
      expect(extra.status).toBe(400);
      expect(received).toHaveLength(1);

      const plain = await fetch(`${base}/plain`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'A', address: { city: 'x' } }),
      });
      expect(plain.status).toBe(400);
      expect(await plain.json()).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: ['Enter at least 2 characters.'],
        errors: { name: ['Enter at least 2 characters.'] },
      });
      const prototype = await fetch(`${base}/plain`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"name":"Ada","address":{"city":"x"},"__proto__":{"admin":true}}',
      });
      expect(prototype.status).toBe(400);
    });
  });
