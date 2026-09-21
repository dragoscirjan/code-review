import { describe, expect, test, vi } from 'vitest';
import { GitHubActionReleaseStore } from '../src/action-release-github';

function responseJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

describe('GitHubActionReleaseStore', () => {
  test('normalizes only bounded fields from release responses', async () => {
    const request = vi.fn(async () =>
      responseJson([{ tag_name: 'v1.0.0', draft: false, prerelease: false, body: 'untrusted' }]),
    ) as unknown as typeof fetch;
    const store = new GitHubActionReleaseStore('owner/repository', undefined, request);
    await expect(store.list()).resolves.toEqual([{ tagName: 'v1.0.0', draft: false, prerelease: false }]);
    expect(request).toHaveBeenCalledOnce();
    expect(String(vi.mocked(request).mock.calls[0]?.[0])).toBe(
      'https://api.github.com/repos/owner/repository/releases?per_page=100&page=1',
    );
  });

  test('creates an explicitly published stable release with a fixed request shape', async () => {
    const request = vi.fn(async () => new Response('', { status: 201 })) as unknown as typeof fetch;
    const store = new GitHubActionReleaseStore('owner/repository', 'test-token', request);
    await store.create('v1.0.0', '1'.repeat(40));
    const [url, init] = vi.mocked(request).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/owner/repository/releases');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-token' });
    expect(JSON.parse(String(init.body))).toEqual({
      tag_name: 'v1.0.0',
      target_commitish: '1'.repeat(40),
      name: 'v1.0.0',
      draft: false,
      prerelease: false,
      generate_release_notes: true,
    });
  });

  test('rejects malformed responses and suppresses error bodies', async () => {
    const malformed = new GitHubActionReleaseStore(
      'owner/repository',
      undefined,
      vi.fn(async () =>
        responseJson([{ tag_name: 'v1.0.0', draft: 'false', prerelease: false }]),
      ) as unknown as typeof fetch,
    );
    await expect(malformed.list()).rejects.toThrow('malformed release');

    const secret = 'never-print-this-token';
    const failed = new GitHubActionReleaseStore(
      'owner/repository',
      secret,
      vi.fn(async () => new Response(secret, { status: 403 })) as unknown as typeof fetch,
    );
    await expect(failed.create('v1.0.0', '1'.repeat(40))).rejects.not.toThrow(secret);
  });

  test('rejects noncanonical repository identities before requests', () => {
    expect(() => new GitHubActionReleaseStore('https://github.com/owner/repo')).toThrow('canonical GitHub owner/name');
    expect(() => new GitHubActionReleaseStore('owner/../repo')).toThrow('canonical GitHub owner/name');
  });
});
