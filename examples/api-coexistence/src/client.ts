import { ClientProxyFactory, Transport } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import type { Item } from './contract.js';

/** Narrow TCP client of the hybrid application's message patterns. */
export interface ItemsClient {
  count(): Promise<number>;
  add(name: string): Promise<Item>;
  close(): Promise<void>;
}

export async function connectItemsClient(port: number): Promise<ItemsClient> {
  const client = ClientProxyFactory.create({
    transport: Transport.TCP,
    options: { host: '127.0.0.1', port },
  });
  await client.connect();
  return {
    count: () =>
      firstValueFrom(client.send<number>({ cmd: 'items.count' }, {})),
    add: (name) =>
      firstValueFrom(client.send<Item>({ cmd: 'items.add' }, name)),
    close: async () => {
      await client.close();
    },
  };
}
