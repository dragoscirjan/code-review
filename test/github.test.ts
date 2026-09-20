import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import {
  findManagedComment,
  GitHubClient,
  parsePullRequestEvent,
  type GitHubComment,
  type PullRequestContext,
} from '../src/github';

const marker = '<!-- marker -->';
const comments: GitHubComment[] = [
  {
    id: 1,
    body: `human copy ${marker}`,
    html_url: 'https://example.test/1',
    user: { id: 10, login: 'human' },
  },
  {
    id: 2,
    body: `managed\n\n${marker}`,
    html_url: 'https://example.test/2',
    user: { id: 20, login: 'bot' },
  },
];

test('finds a managed comment by final marker line and actor', () => {
  assert.equal(findManagedComment(comments, 20, marker)?.id, 2);
  assert.equal(findManagedComment(comments, 10, marker), undefined);
  assert.equal(findManagedComment(comments, 30, marker), undefined);
});

test('matches an exact legacy marker during migration', () => {
  const legacy = '<!-- code-review:opencode-poc:v1 -->';
  const current = '<!-- code-review:opencode:openrouter-poc:v2 -->';
  const comment: GitHubComment = {
    id: 5,
    body: `Legacy review\n\n${legacy}`,
    html_url: 'https://example.test/5',
    user: { id: 20, login: 'bot' },
  };
  assert.equal(findManagedComment([comment], 20, [current, legacy])?.id, 5);
});

test('prefers the current marker over an older matching comment', () => {
  const legacy = '<!-- code-review:opencode-poc:v1 -->';
  const current = '<!-- code-review:opencode:openrouter-poc:v2 -->';
  const candidates: GitHubComment[] = [
    {
      id: 5,
      body: `Legacy review\n\n${legacy}`,
      html_url: 'https://example.test/5',
      user: { id: 20, login: 'bot' },
    },
    {
      id: 6,
      body: `Current review\n\n${current}`,
      html_url: 'https://example.test/6',
      user: { id: 20, login: 'bot' },
    },
  ];
  assert.equal(findManagedComment(candidates, 20, [current, legacy])?.id, 6);
});

test('does not match a backend marker copied into review text', () => {
  const opencodeMarker = '<!-- code-review:opencode -->';
  const piMarker = '<!-- code-review:pi -->';
  const comment: GitHubComment = {
    id: 4,
    body: `Untrusted output copied ${piMarker}\n\n${opencodeMarker}`,
    html_url: 'https://example.test/4',
    user: { id: 20, login: 'bot' },
  };
  assert.equal(findManagedComment([comment], 20, piMarker), undefined);
  assert.equal(findManagedComment([comment], 20, opencodeMarker)?.id, 4);
});

test('downloads, fatally decodes, parses, and safely packs the pull request diff', async () => {
  const first = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-old', '+new'].join('\n');
  const second = first.replaceAll('a.ts', 'b.ts').replace('+new', `+${'x'.repeat(2_000)}`);
  const client = new GitHubClient(
    'token',
    'https://api.example.test',
    async () => new Response(`${first}\n${second}`, { status: 200 }),
  );
  const result = await client.getPullRequestDiff(
    {
      owner: 'owner',
      repository: 'repository',
      number: 7,
      title: 'Change',
      body: '',
      url: 'https://example.test/7',
      baseSha: 'base',
      headSha: 'head',
      author: 'contributor',
    },
    Buffer.byteLength(first, 'utf8') + 1,
  );
  assert.equal(result.text, first);
  assert.equal(result.truncated, true);
  assert.equal(result.parsed?.files[0]?.apiPath, 'a.ts');
});

test('rejects invalid UTF-8 diff bytes instead of inserting replacement characters', async () => {
  const client = new GitHubClient(
    'token',
    'https://api.example.test',
    async () => new Response(Uint8Array.from([0xc3]), { status: 200 }),
  );
  await assert.rejects(
    client.getPullRequestDiff(
      {
        owner: 'owner',
        repository: 'repository',
        number: 7,
        title: 'Change',
        body: '',
        url: 'https://example.test/7',
        baseSha: 'base',
        headSha: 'head',
        author: 'contributor',
      },
      1_000,
    ),
    /not valid UTF-8/,
  );
});

test('downloads the exact base-revision archive with a size bound', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'code-review-archive-'));
  const destination = join(directory, 'base.tar.gz');
  const client = new GitHubClient('token', 'https://api.example.test', async (input, init) => {
    assert.match(String(input), /tarball\/base-sha$/);
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer token');
    return new Response('archive-bytes', { status: 200 });
  });
  try {
    const bytes = await client.downloadRepositoryArchive(
      {
        owner: 'owner',
        repository: 'repository',
        number: 7,
        title: 'Change',
        body: '',
        url: 'https://example.test/7',
        baseSha: 'base-sha',
        headSha: 'head-sha',
        author: 'contributor',
      },
      'base-sha',
      destination,
      100,
    );
    assert.equal(bytes, 13);
    assert.equal(await readFile(destination, 'utf8'), 'archive-bytes');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('updates only the managed comment owned by the PAT actor', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const responses = [
    new Response(JSON.stringify(comments), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
    new Response(JSON.stringify({ ...comments[1], body: `updated ${marker}` }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  ];
  const client = new GitHubClient('token', 'https://api.example.test', async (input, init) => {
    requests.push({ url: String(input), init });
    const response = responses.shift();
    assert.ok(response);
    return response;
  });
  const context = parsePullRequestEvent({
    number: 7,
    repository: { full_name: 'owner/repository' },
    pull_request: {
      number: 7,
      title: 'Change',
      body: '',
      html_url: 'https://github.com/owner/repository/pull/7',
      base: { sha: 'base' },
      head: { sha: 'head' },
      user: { login: 'contributor' },
    },
  });

  const updated = await client.upsertManagedComment(context, { id: 20, login: 'bot' }, marker, `updated ${marker}`);

  assert.equal(updated.id, 2);
  assert.equal(requests[1]?.init?.method, 'PATCH');
  assert.match(requests[1]?.url ?? '', /issues\/comments\/2$/);
});

test('creates a managed comment when none exists', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const created: GitHubComment = {
    id: 3,
    body: `new ${marker}`,
    html_url: 'https://example.test/3',
    user: { id: 20, login: 'bot' },
  };
  const responses = [
    new Response('[]', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
    new Response(JSON.stringify(created), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    }),
  ];
  const client = new GitHubClient('token', 'https://api.example.test', async (input, init) => {
    requests.push({ url: String(input), init });
    const response = responses.shift();
    assert.ok(response);
    return response;
  });
  const context = parsePullRequestEvent({
    number: 7,
    repository: { full_name: 'owner/repository' },
    pull_request: {
      number: 7,
      title: 'Change',
      body: '',
      html_url: 'https://github.com/owner/repository/pull/7',
      base: { sha: 'base' },
      head: { sha: 'head' },
      user: { login: 'contributor' },
    },
  });

  const result = await client.upsertManagedComment(context, { id: 20, login: 'bot' }, marker, `new ${marker}`);

  assert.equal(result.id, 3);
  assert.equal(requests[1]?.init?.method, 'POST');
  assert.match(requests[1]?.url ?? '', /issues\/7\/comments$/);
  assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), {
    body: `new ${marker}`,
  });
});

test('reads the current pull request base and head revision', async () => {
  const client = new GitHubClient(
    'token',
    'https://api.example.test',
    async () =>
      new Response(JSON.stringify({ base: { sha: 'base-now' }, head: { sha: 'head-now' }, changed_files: 2 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  const revision = await client.getPullRequestRevision({
    owner: 'owner',
    repository: 'repository',
    number: 7,
    title: 'Change',
    body: '',
    url: 'https://example.test/7',
    baseSha: 'base',
    headSha: 'head',
    author: 'contributor',
  });
  assert.deepEqual(revision, { baseSha: 'base-now', headSha: 'head-now', changedFiles: 2 });
});

test('creates one inline review batch with commit_id and line/side coordinates', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const responses = [
    new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    new Response(
      JSON.stringify({ id: 9, body: 'review', html_url: 'https://example.test/review/9', user: { id: 20 } }),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    ),
  ];
  const client = new GitHubClient('token', 'https://api.example.test', async (url, init) => {
    requests.push({ url: String(url), init });
    const response = responses.shift();
    assert.ok(response);
    return response;
  });
  const context: PullRequestContext = {
    owner: 'owner',
    repository: 'repository',
    number: 7,
    title: 'Change',
    body: '',
    url: 'https://example.test/7',
    baseSha: 'base',
    headSha: 'head',
    author: 'contributor',
  };
  await client.createOrReuseInlineReview(context, { id: 20, login: 'bot' }, 'head', marker, [
    { path: 'src/a.ts', line: 3, side: 'RIGHT', body: `finding\n${marker}` },
    { path: 'src/b.ts', line: 4, side: 'LEFT', body: `finding\n${marker}` },
  ]);
  const payload = JSON.parse(String(requests[1]?.init?.body)) as Record<string, unknown>;
  assert.equal(payload.commit_id, 'head');
  assert.equal(payload.event, 'COMMENT');
  assert.deepEqual(payload.comments, [
    { path: 'src/a.ts', line: 3, side: 'RIGHT', body: `finding\n${marker}` },
    { path: 'src/b.ts', line: 4, side: 'LEFT', body: `finding\n${marker}` },
  ]);
  assert.equal(Object.hasOwn((payload.comments as Record<string, unknown>[])[0] ?? {}, 'position'), false);
  assert.equal(requests[1]?.init?.method, 'POST');
});

test('suppresses GitHub write error bodies that could echo submitted secrets', async () => {
  const responses = [
    new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    new Response('provider-secret echoed by API', { status: 422 }),
  ];
  const client = new GitHubClient('token', 'https://api.example.test', async () => {
    const response = responses.shift();
    assert.ok(response);
    return response;
  });
  await assert.rejects(
    client.createOrReuseInlineReview(
      {
        owner: 'owner',
        repository: 'repository',
        number: 7,
        title: 'Change',
        body: '',
        url: 'https://example.test/7',
        baseSha: 'base',
        headSha: 'head',
        author: 'contributor',
      },
      { id: 20, login: 'bot' },
      'head',
      marker,
      [{ path: 'a.ts', line: 1, side: 'RIGHT', body: marker }],
    ),
    (error: unknown) => error instanceof Error && /422/.test(error.message) && !/provider-secret/.test(error.message),
  );
});

test('reuses only an owned inline review with the exact final marker', async () => {
  let calls = 0;
  const existing = {
    id: 9,
    body: `review\n\n${marker}`,
    html_url: 'https://example.test/review/9',
    user: { id: 20, login: 'bot' },
  };
  const client = new GitHubClient('token', 'https://api.example.test', async () => {
    calls += 1;
    return new Response(JSON.stringify([existing]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  const result = await client.createOrReuseInlineReview(
    {
      owner: 'owner',
      repository: 'repository',
      number: 7,
      title: 'Change',
      body: '',
      url: 'https://example.test/7',
      baseSha: 'base',
      headSha: 'head',
      author: 'contributor',
    },
    { id: 20, login: 'bot' },
    'head',
    marker,
    [{ path: 'a.ts', line: 1, side: 'RIGHT', body: marker }],
  );
  assert.equal(result.id, 9);
  assert.equal(calls, 1);
});

test('parses a pull request event', () => {
  const context = parsePullRequestEvent({
    number: 7,
    repository: { full_name: 'owner/repository' },
    pull_request: {
      number: 7,
      title: 'Change',
      body: null,
      html_url: 'https://github.com/owner/repository/pull/7',
      base: { sha: 'base' },
      head: { sha: 'head' },
      user: { login: 'contributor' },
    },
  });

  assert.deepEqual(context, {
    owner: 'owner',
    repository: 'repository',
    number: 7,
    title: 'Change',
    body: '',
    baseSha: 'base',
    headSha: 'head',
    author: 'contributor',
    url: 'https://github.com/owner/repository/pull/7',
  });
});
