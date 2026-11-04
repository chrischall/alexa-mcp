import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// alexa-cookie2 (latest 5.0.6) pins cookie@^0.6.0, which has GHSA-pxg6-pf52-xh8x
// (out-of-bounds characters in cookie name/path/domain). package.json `overrides`
// forces the patched line; this fails if the override is dropped or stops applying.
describe('dependency overrides', () => {
  it('alexa-cookie2 resolves a patched cookie (>= 0.7.0)', () => {
    const fromAlexaCookie = createRequire(createRequire(import.meta.url).resolve('alexa-cookie2'));
    const { version } = fromAlexaCookie('cookie/package.json') as { version: string };
    const [major, minor] = version.split('.').map(Number);
    expect(major > 0 || minor >= 7, `cookie ${version}`).toBe(true);
  });

  it('cookie.parse still reads an Amazon-style cookie header the way alexa-cookie2 uses it', () => {
    const fromAlexaCookie = createRequire(createRequire(import.meta.url).resolve('alexa-cookie2'));
    const cookie = fromAlexaCookie('cookie') as { parse: (s: string) => Record<string, string> };
    expect(cookie.parse('session-id=133-1234567-7654321; ubid-main=131-0000000-0000000; csrf=-12345')).toEqual({
      'session-id': '133-1234567-7654321',
      'ubid-main': '131-0000000-0000000',
      csrf: '-12345',
    });
  });
});
