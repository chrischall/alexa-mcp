import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { API_USER_AGENT_POSTFIX, toError } from '../src/remote.js';

describe('remote adapter', () => {
  it('API_USER_AGENT_POSTFIX tracks the installed alexa-remote2 version', () => {
    const require = createRequire(import.meta.url);
    const pkg = JSON.parse(readFileSync(require.resolve('alexa-remote2/package.json'), 'utf8')) as { version: string };
    expect(API_USER_AGENT_POSTFIX).toBe(`AlexaRemote/${pkg.version}`);
  });

  it('toError normalises the shapes the library calls back with', () => {
    expect(toError(new Error('a')).message).toBe('a');
    expect(toError(['x', 'y']).message).toBe('x; y');
    expect(toError({ message: 'm' }).message).toBe('m');
    expect(toError('s').message).toBe('s');
  });
});
