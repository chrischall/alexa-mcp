import { describe, expect, it } from 'vitest';
import { encodeForPaste, parseLoginArgs } from '../src/login.js';
import { parseRegistration } from '../src/registration.js';
import { REGISTRATION } from './fakes.js';

describe('parseLoginArgs', () => {
  it('defaults to port 3456 on amazon.com without printing', () => {
    expect(parseLoginArgs([])).toEqual({ port: 3456, amazonPage: 'amazon.com', print: false });
  });

  it('reads --port, --amazon-page and --print', () => {
    expect(parseLoginArgs(['--port', '4000', '--amazon-page', 'amazon.co.uk', '--print'])).toEqual({ port: 4000, amazonPage: 'amazon.co.uk', print: true });
  });

  it('rejects unknown flags, bad ports and non-Amazon pages', () => {
    expect(() => parseLoginArgs(['--nope'])).toThrow(/Unknown option/);
    expect(() => parseLoginArgs(['--port', 'x'])).toThrow(/port/);
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
