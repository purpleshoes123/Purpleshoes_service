import { describe, it, expect, vi } from 'vitest';
import { databaseUrlWithSecret, createDatabaseCredentialResolver } from './managed-database.mjs';
const url = 'postgresql://app:old@db.example:5432/shop?sslmode=require&schema=public';
const secret = (password = 'new') => JSON.stringify({ username: 'app', password });
describe('managed database credential rotation', () => {
  it('preserves destination/options and encodes reserved password characters once', () => {
    const next = new URL(databaseUrlWithSecret(url, secret('p@ss:/%?# &')));
    expect(decodeURIComponent(next.password)).toBe('p@ss:/%?# &');
    expect(next.hostname).toBe('db.example');
    expect(next.pathname).toBe('/shop');
    expect(next.search).toBe('?sslmode=require&schema=public');
  });
  it.each([{ username: 'other', password: 'private' }, { username: 'app', password: '' },
    { username: 'app', password: 'private', host: 'evil.example' },
    { username: 'app', password: 'private', port: 999 },
    { username: 'app', password: 'private', dbname: 'other' }])('rejects mismatched secrets without leaking them', value => {
    expect(() => databaseUrlWithSecret(url, JSON.stringify(value))).toThrow('does not match');
    try { databaseUrlWithSecret(url, JSON.stringify(value)); } catch (e) {
      expect(String(e)).not.toContain('private');
    }
  });
  it('does not contact AWS or DB when not opted in', async () => {
    const readSecret = vi.fn(); const probe = vi.fn();
    const refresh = createDatabaseCredentialResolver({ databaseUrl: url, readSecret, probe });
    expect(await refresh()).toEqual({ url, changed: false });
    expect(readSecret).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
  });
  it('coalesces refreshes, probes changes, and retries a failed new credential', async () => {
    let password = 'one';
    const readSecret = vi.fn(async () => ({ SecretString: secret(password) }));
    const probe = vi.fn(async () => {});
    const refresh = createDatabaseCredentialResolver({ databaseUrl: url, secretId: 'arn', readSecret, probe });
    const first = await Promise.all([refresh(), refresh()]);
    expect(readSecret).toHaveBeenCalledTimes(1);
    expect(first[0].changed).toBe(false);
    await refresh(); expect(probe).toHaveBeenCalledTimes(1);
    password = 'two'; probe.mockRejectedValueOnce(new Error('unavailable'));
    await expect(refresh()).rejects.toThrow();
    expect((await refresh()).changed).toBe(true);
    expect((await refresh()).changed).toBe(false);
  });
});
