import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// follow-redirects 1.16.0–1.16.1 has GHSA-mrwp-f3q8-3g9p (high): custom credentials
// can follow cross-origin redirects. It reaches the bundle via alexa-cookie2 →
// http-proxy-middleware → http-proxy. The fix is in range (http-proxy wants ^1.0.0),
// so the lockfile carries it; this fails if a lockfile regeneration rolls it back.
describe('follow-redirects (via alexa-cookie2 → http-proxy)', () => {
  it('resolves a patched version (>= 1.16.2)', () => {
    const req = createRequire(import.meta.url);
    const fromCookie2 = createRequire(req.resolve('alexa-cookie2'));
    const fromHpm = createRequire(fromCookie2.resolve('http-proxy-middleware'));
    const fromHttpProxy = createRequire(fromHpm.resolve('http-proxy'));
    const { version } = fromHttpProxy('follow-redirects/package.json') as { version: string };
    const [major, minor, patch] = version.split('.').map(Number);
    const patched = major > 1 || (major === 1 && (minor > 16 || (minor === 16 && patch >= 2)));
    expect(patched, `follow-redirects ${version}`).toBe(true);
  });
});
