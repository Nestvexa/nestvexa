import 'reflect-metadata';
import assert from 'node:assert/strict';
import { Module, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestvexaAssetsModule, NestvexaAssetsService } from 'nestvexa/assets';

@Module({ imports: [NestvexaAssetsModule.register({ basePath: '/host' })] })
class Host {}

const app = await NestFactory.create(Host, { logger: false });
try {
  app.setGlobalPrefix('host');
  app.enableVersioning({
    type: VersioningType.HEADER,
    header: 'x-api-version',
    defaultVersion: '1',
  });
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const manifest = app.get(NestvexaAssetsService).getManifest();
  assert.match(manifest.version, /^[a-f0-9]{64}$/);
  assert.equal(Object.keys(manifest.files).length, 15);
  for (const [name, url] of Object.entries(manifest.files)) {
    const response = await fetch(`${base}${url}`);
    assert.equal(response.status, 200, name);
    assert.match(
      response.headers.get('content-type') ?? '',
      /^text\/javascript/,
    );
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const text = await response.text();
    assert.ok(text.length > 0, name);
    const etag = response.headers.get('etag');
    assert.ok(etag);
    const cached = await fetch(`${base}${url}`, {
      headers: { 'if-none-match': `W/${etag}` },
    });
    assert.equal(cached.status, 304, name);
    assert.equal(await cached.text(), '');
  }
  const unknown = await fetch(`${base}${manifest.entries.live}.map`);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.headers.get('cache-control'), 'no-store');
  assert.equal(
    (await fetch(`${base}${manifest.entries.live}`, { method: 'HEAD' })).status,
    200,
  );
  console.log(
    'Minimal umbrella-only install served all 15 version-neutral client/Alpine assets with validated cache behavior.',
  );
} finally {
  await app.close();
}
