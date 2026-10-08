import { describe, expect, it, vi } from 'vitest';
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

  it('rejects unknown flags and non-Amazon pages', () => {
    expect(() => parseLoginArgs(['--nope'])).toThrow(/Unknown option/);
    expect(() => parseLoginArgs(['--amazon-page', 'evil.example'])).toThrow(/amazon-page/);
  });

  it('accepts the retired --port <n> as a no-op with a one-line deprecation notice on stderr', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(parseLoginArgs(['--port', '3456', '--print'])).toEqual({ amazonPage: 'amazon.com', print: true });
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0][0])).toMatch(/--port.*(ignored|no longer)/i);
      expect(String(err.mock.calls[0][0])).not.toContain('\n');
    } finally {
      err.mockRestore();
    }
  });
});

describe('encodeForPaste', () => {
  it('round-trips through parseRegistration as one line', () => {
    const line = encodeForPaste(REGISTRATION);
    expect(line).not.toContain('\n');
    expect(parseRegistration(line, 'ALEXA_REGISTRATION')).toEqual(REGISTRATION);
  });
});
