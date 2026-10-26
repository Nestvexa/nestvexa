import { describe, it, expect } from 'vitest';
import { normalizeOptions } from '../packages/core/dist/index.js';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';

describe('configuration and view trust boundaries', () => {
  it('rejects unknown and polluted configuration without executing accessors', () => {
    expect(() =>
      normalizeOptions(JSON.parse('{"__proto__":{"polluted":true}}')),
    ).toThrow();
    let accessed = false;
    expect(() =>
      normalizeOptions({
        get views() {
          accessed = true;
          return {};
        },
      }),
    ).toThrow();
    expect(accessed).toBe(false);
    expect(Object.hasOwn({}, 'polluted')).toBe(false);
  });
  it('rejects browser-selected traversal and absolute template paths', async () => {
    const engine = new HbsEngine({ root: 'examples/starter-hbs/views' });
    await engine.initialize();
    for (const path of [
      '../package',
      '..\\package',
      '/etc/passwd',
      'C:\\Windows\\win.ini',
    ]) {
      await expect(engine.render(path, {})).rejects.toThrow();
    }
    await engine.dispose();
  });
});
