import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

// These only fail once a tag exists (npm provenance validates repository.url,
// the registry validates the scoped name), so assert them up front.
describe('packaging', () => {
  const pkg = read('package.json');

  it('publishes under the @chrischall scope, publicly, with a provenance-checkable repository.url', () => {
    expect(pkg.name).toBe('@chrischall/alexa-mcp');
    expect(pkg.publishConfig?.access).toBe('public');
    expect(pkg.repository?.url).toBe('git+https://github.com/chrischall/alexa-mcp.git');
  });

  it('ships dist, skills, the plugin and mint.yaml in the published tarball', () => {
    for (const f of ['dist', 'skills', '.claude-plugin', 'mint.yaml']) expect(pkg.files).toContain(f);
  });

  it('exposes a single unscoped bin', () => {
    expect(pkg.bin).toEqual({ 'alexa-mcp': 'dist/index.js' });
  });

  it('the Claude plugin launches the published package, not the gitignored dist/', () => {
    const server = read('.mcp.json').mcpServers.alexa;
    expect(server.command).toBe('npx');
    expect(server.args).toEqual(['-y', pkg.name]);
    expect(JSON.stringify(server)).not.toMatch(/dist\//);
  });

  it('plugin.json points Claude Code at the MCP config under mcpServers, the key it reads', () => {
    // `mcp` is not a plugin.json field: Claude Code ignores it (`claude plugin validate`
    // warns "Unknown field 'mcp'"), so a non-default path under it silently loads no server.
    const plugin = read('.claude-plugin/plugin.json');
    expect(plugin).not.toHaveProperty('mcp');
    expect(plugin.mcpServers).toBe('./.mcp.json');
    expect(existsSync(join(ROOT, plugin.mcpServers))).toBe(true);
  });

  it('the ESM bundle defines __dirname/__filename/require for the CommonJS Alexa libraries', () => {
    // Without these the bundle boots and lists tools fine, then every Alexa call fails with
    // "__dirname is not defined" — caught only by a live call on 2026-10-07, never by a unit test.
    const bundle = pkg.scripts.bundle as string;
    expect(bundle).toContain('const __dirname');
    expect(bundle).toContain('const __filename');
    expect(bundle).toContain('const require');
  });

  it('server.json description is within the 100-char registry limit', () => {
    expect(read('server.json').description.length).toBeLessThanOrEqual(100);
  });

  it('server.json and release-please name the scoped package', () => {
    expect(read('server.json').packages[0].identifier).toBe(pkg.name);
    expect(read('release-please-config.json').packages['.']['package-name']).toBe(pkg.name);
  });

  it('a brand-new package starts at 0.1.0, not 1.0.0, and stays 0.x on breaking changes', () => {
    // Config only — never pin the manifest version here: release PRs bump it,
    // and a pinned 0.0.0 failed the very first release PR's CI.
    const cfg = read('release-please-config.json').packages['.'];
    expect(cfg['initial-version']).toBe('0.1.0');
    expect(cfg['bump-minor-pre-major']).toBe(true);
  });

  it('all version-bearing manifests agree with package.json', () => {
    const v = pkg.version;
    expect(read('manifest.json').version).toBe(v);
    expect(read('server.json').version).toBe(v);
    expect(read('server.json').packages[0].version).toBe(v);
    expect(read('.claude-plugin/plugin.json').version).toBe(v);
    expect(read('.claude-plugin/marketplace.json').metadata.version).toBe(v);
    expect(read('.claude-plugin/marketplace.json').plugins[0].version).toBe(v);
    expect(read('.release-please-manifest.json')['.']).toBe(v);
  });

  it('mint.yaml signs each user in through their own browser, never a shared credential', () => {
    const mint = readFileSync(join(ROOT, 'mint.yaml'), 'utf8');
    expect(mint).toMatch(/perUserChild:\s*true/);
    expect(mint).toMatch(/- tool: alexa_begin_login/);
    expect(mint).toMatch(/- tool: alexa_finish_login/);
    expect(mint).toMatch(/from: signInUrl/);
    expect(mint).toMatch(/hosts: \[www\.amazon\.com\]/);
    expect(mint).not.toMatch(/name: ALEXA_PASSWORD|name: ALEXA_EMAIL/);
    expect(mint).toMatch(/dataDir:\s*true/);
  });

  it('mint.yaml egress covers the alarms API host as well as the web API', () => {
    const mint = readFileSync(join(ROOT, 'mint.yaml'), 'utf8');
    for (const host of ['alexa.amazon.com', 'na-api-alexa.amazon.com', 'api.amazon.com', 'www.amazon.com', 'api.amazonalexa.com']) {
      expect(mint, host).toMatch(new RegExp(`- ${host.replace(/\./g, '\\.')}\\n`));
    }
  });
});
