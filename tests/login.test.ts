import { describe, expect, it } from 'vitest';
import { encodeForPaste, parseLoginArgs } from '../src/login.js';
import { parseRegistration } from '../src/registration.js';
import { REGISTRATION } from './fakes.js';

describe('parseLoginArgs', () => {
  it('defaults to amazon.com without printing', () => {
    expect(parseLoginArgs([])).toEqual({ amazonPage: 'amazon.com', print: false });
  });

  it('reads --amazon-page and --print', () => {
    expect(parseLoginArgs(['--amazon-page', 'amazon.co.uk', '--print'])).toEqual({ amazonPage: 'amazon.co.uk', print: true });
  });

  it('rejects unknown flags (including the retired --port) and non-Amazon pages', () => {
    expect(() => parseLoginArgs(['--nope'])).toThrow(/Unknown option/);
    expect(() => parseLoginArgs(['--port', '3456'])).toThrow(/Unknown option/);
    expect(() => parseLoginArgs(['--amazon-page', 'evil.example'])).toThrow(/amazon-page/);
  });
});

describe('encodeForPaste', () => {
  it('round-trips through parseRegistration as one line', () => {
    const line = encodeForPaste(REGISTRATION);
    expect(line).not.toContain('\n');
    expect(parseRegistration(line, 'ALEXA_REGISTRATION')).toEqual(REGISTRATION);
  });
});
