import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import {
  extractExplicitSameRepositoryIssueNumbers,
  findManagedComment,
  GitHubClient,
  parsePullRequestEvent,
  selectManagedComment,
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

test('extracts only explicit same-repository issue references in textual order', () => {
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
  const numbers = extractExplicitSameRepositoryIssueNumbers(
    context,
    'Fixes #23 and mentions #99',
    [
      'Closes owner/repository#24.',
      'https://github.com/owner/repository/issues/25',
      'https://github.com/owner/other/issues/26',
      'https://github.com/owner/repository/pull/27',
      'evilhttps://github.com/owner/repository/issues/31',
      '`fixes #28`',
      '```',
      'closes #29',
      '```',
      'resolves owner/other#30',
    ].join('\n'),
    5,
  );
  assert.deepEqual(numbers, [23, 24, 25]);
});

test('reads bounded regular guidance only after exact-commit tree proof and rejects symlinks', async () => {
  const requests: string[] = [];
  const revision = 'a'.repeat(40);
  const rootTree = 'b'.repeat(40);
  const docsTree = 'c'.repeat(40);
  const blobSha = 'd'.repeat(40);
  const linkSha = 'e'.repeat(40);
  const responses = [
    new Response(JSON.stringify({ sha: revision, tree: { sha: rootTree } }), { status: 200 }),
    new Response(
      JSON.stringify({
        sha: rootTree,
        truncated: false,
        tree: [{ path: 'docs', mode: '040000', type: 'tree', sha: docsTree }],
      }),
      { status: 200 },
    ),
    new Response(
      JSON.stringify({
        sha: docsTree,
        truncated: false,
        tree: [{ path: 'AGENTS.md', mode: '100644', type: 'blob', sha: blobSha }],
      }),
      { status: 200 },
    ),
    new Response(
      JSON.stringify({
        sha: blobSha,
        encoding: 'base64',
        content: Buffer.from('rules\n'.repeat(20)).toString('base64'),
      }),
      { status: 200 },
    ),
    new Response(JSON.stringify({ sha: revision, tree: { sha: rootTree } }), { status: 200 }),
    new Response(
      JSON.stringify({
        sha: rootTree,
        truncated: false,
        tree: [{ path: 'AGENTS.md', mode: '120000', type: 'blob', sha: linkSha }],
      }),
      { status: 200 },
    ),
  ];
  const client = new GitHubClient('token', 'https://api.example.test', async (url) => {
    requests.push(String(url));
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
    url: 'url',
    baseSha: revision,
    headSha: 'f'.repeat(40),
    author: 'author',
  };
  const guidance = await client.getRepositoryTextAtRevision(context, 'docs/AGENTS.md', revision, 25);
  assert.equal(guidance.status, 'found');
  assert.equal(guidance.truncated, true);
  assert.equal(guidance.blobSha, blobSha);
  assert.ok(Buffer.byteLength(guidance.text ?? '', 'utf8') <= 25);
  assert.match(requests[0] ?? '', new RegExp(`/git/commits/${revision}$`, 'u'));
  assert.match(requests[1] ?? '', new RegExp(`/git/trees/${rootTree}$`, 'u'));
  assert.match(requests[2] ?? '', new RegExp(`/git/trees/${docsTree}$`, 'u'));
  assert.match(requests[3] ?? '', new RegExp(`/git/blobs/${blobSha}$`, 'u'));
  const link = await client.getRepositoryTextAtRevision(context, 'AGENTS.md', revision, 25);
  assert.equal(link.status, 'unavailable');
  assert.equal(link.reason, 'not-a-regular-file');
  assert.equal(requests.length, 6);
});

test('exact-revision text distinguishes missing from forbidden and rejects unsafe tree metadata before blobs', async () => {
  const revision = 'a'.repeat(40);
  const rootTree = 'b'.repeat(40);
  const context: PullRequestContext = {
    owner: 'owner',
    repository: 'repository',
    number: 7,
    title: 'Change',
    body: '',
    url: 'url',
    baseSha: revision,
    headSha: 'f'.repeat(40),
    author: 'author',
  };
  for (const status of [403, 429]) {
    const unavailable = new GitHubClient(
      'token',
      'https://api.example.test',
      async () => new Response(null, { status }),
    );
    assert.deepEqual(await unavailable.getRepositoryTextAtRevision(context, 'AGENTS.md', revision, 25), {
      status: 'unavailable',
      bytes: 0,
      truncated: false,
      reason: 'fetch-error',
    });
  }
  const missing = new GitHubClient(
    'token',
    'https://api.example.test',
    async () => new Response(null, { status: 404 }),
  );
  assert.deepEqual(await missing.getRepositoryTextAtRevision(context, 'AGENTS.md', revision, 25), {
    status: 'not-found',
    bytes: 0,
    truncated: false,
    reason: 'not-found',
  });
  const absentResponses = [
    new Response(JSON.stringify({ sha: revision, tree: { sha: rootTree } }), { status: 200 }),
    new Response(JSON.stringify({ sha: rootTree, truncated: false, tree: [] }), { status: 200 }),
  ];
  const absent = new GitHubClient('token', 'https://api.example.test', async () => absentResponses.shift()!);
  assert.equal((await absent.getRepositoryTextAtRevision(context, 'AGENTS.md', revision, 25)).status, 'not-found');
  assert.equal(absentResponses.length, 0);

  for (const unsafe of [
    {
      sha: rootTree,
      truncated: true,
      tree: [{ path: 'AGENTS.md', mode: '100644', type: 'blob', sha: 'c'.repeat(40) }],
    },
    {
      sha: rootTree,
      truncated: false,
      tree: [
        { path: 'AGENTS.md', mode: '100644', type: 'blob', sha: 'c'.repeat(40) },
        { path: 'AGENTS.md', mode: '100644', type: 'blob', sha: 'd'.repeat(40) },
      ],
    },
    {
      sha: rootTree,
      truncated: false,
      tree: [{ path: 'malformed-entry' }, { path: 'AGENTS.md', mode: '100644', type: 'blob', sha: 'c'.repeat(40) }],
    },
    {
      sha: rootTree,
      truncated: false,
      tree: [{ path: 'AGENTS.md', mode: '160000', type: 'commit', sha: 'c'.repeat(40) }],
    },
    {
      sha: rootTree,
      truncated: false,
      tree: [{ path: 'AGENTS.md', mode: '040000', type: 'tree', sha: 'c'.repeat(40) }],
    },
  ]) {
    let calls = 0;
    const responses = [
      new Response(JSON.stringify({ sha: revision, tree: { sha: rootTree } }), { status: 200 }),
      new Response(JSON.stringify(unsafe), { status: 200 }),
    ];
    const client = new GitHubClient('token', 'https://api.example.test', async () => {
      calls += 1;
      return responses.shift()!;
    });
    const result = await client.getRepositoryTextAtRevision(context, 'AGENTS.md', revision, 25);
    assert.equal(result.status, 'unavailable');
    assert.equal(calls, 2, 'unsafe metadata must stop before blob acquisition');
  }
});

test('reads a bounded same-repository issue response and rejects oversized data', async () => {
  const issue = {
    id: 44,
    number: 23,
    title: 'Context',
    body: '## Acceptance criteria\n- bounded',
    html_url: 'https://github.com/owner/repository/issues/23',
    updated_at: '2026-09-20T00:00:00Z',
  };
  const responses = [
    new Response(JSON.stringify(issue), { status: 200 }),
    new Response(JSON.stringify({ ...issue, body: 'x'.repeat(1_000) }), { status: 200 }),
  ];
  const client = new GitHubClient('token', 'https://api.example.test', async () => {
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
    url: 'url',
    baseSha: 'base',
    headSha: 'head',
    author: 'author',
  };
  const result = await client.getIssueContext(context, 23, 10_000);
  assert.equal(result.number, 23);
  assert.equal(result.isPullRequest, false);
  await assert.rejects(client.getIssueContext(context, 23, 100), /response limit/);
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

test('aborts stalled guidance, issue, revision, diff, and archive requests', async () => {
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
  const client = new GitHubClient('token', 'https://api.example.test', async (_url, init) => {
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const directory = await mkdtemp(join(tmpdir(), 'code-review-stalled-'));
  try {
    const requests = [
      client.getRepositoryTextAtRevision(context, 'AGENTS.md', 'base', 1_000, AbortSignal.timeout(5)),
      client.getIssueContext(context, 23, 1_000, AbortSignal.timeout(5)),
      client.getPullRequestRevision(context, AbortSignal.timeout(5)),
      client.getPullRequestDiff(context, 1_000, AbortSignal.timeout(5)),
      client.downloadRepositoryArchive(context, 'base', join(directory, 'archive.tar'), 1_000, AbortSignal.timeout(5)),
    ];
    await Promise.all(requests.map(async (request) => assert.rejects(request, /timeout|aborted/iu)));
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
      new Response(
        JSON.stringify({
          base: { sha: 'base-now' },
          head: { sha: 'head-now' },
          changed_files: 2,
          title: 'Authoritative change',
          body: null,
          user: { login: 'api-contributor' },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
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
  assert.deepEqual(revision, {
    baseSha: 'base-now',
    headSha: 'head-now',
    changedFiles: 2,
    title: 'Authoritative change',
    body: '',
    author: 'api-contributor',
  });
});

test.each([
  ['missing title', { body: '', user: { login: 'api-contributor' } }, /pull_request.title/],
  ['non-null non-string body', { title: 'Change', body: 42, user: { login: 'api-contributor' } }, /body/],
  ['missing author', { title: 'Change', body: '', user: {} }, /user.login/],
] as const)('rejects non-authoritative pull request metadata: %s', async (_name, metadata, expected) => {
  const client = new GitHubClient(
    'token',
    'https://api.example.test',
    async () =>
      new Response(
        JSON.stringify({ base: { sha: 'base-now' }, head: { sha: 'head-now' }, changed_files: 2, ...metadata }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
  );
  await assert.rejects(
    client.getPullRequestRevision({
      owner: 'owner',
      repository: 'repository',
      number: 7,
      title: 'stale event title',
      body: 'stale event body',
      url: 'https://example.test/7',
      baseSha: 'base',
      headSha: 'head',
      author: 'stale-event-author',
    }),
    expected,
  );
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
    commit_id: 'head',
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

test('selects one actor-owned current summary and rejects ambiguous current state', () => {
  const current = '<!-- code-review:opencode:v5 -->';
  const legacy = '<!-- code-review:opencode:v4 -->';
  const currentComment: GitHubComment = {
    id: 11,
    body: `current\n${current}`,
    html_url: 'url',
    user: { id: 20, login: 'bot' },
  };
  const legacyComment: GitHubComment = {
    id: 12,
    body: `legacy\n${legacy}`,
    html_url: 'url',
    user: { id: 20, login: 'bot' },
  };
  assert.equal(selectManagedComment([legacyComment, currentComment], 20, [current, legacy]).kind, 'current');
  assert.equal(
    selectManagedComment([currentComment, { ...currentComment, id: 13 }], 20, [current, legacy]).kind,
    'ambiguous',
  );
  assert.equal(
    selectManagedComment([{ ...currentComment, user: { id: 99, login: 'other' } }], 20, [current, legacy]).kind,
    'none',
  );
});

test('acquires a bounded strict-descendant compare with matching JSON and diff identities', async () => {
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const diff = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-old', '+new'].join('\n');
  const responses = [
    new Response(
      JSON.stringify({
        status: 'ahead',
        ahead_by: 1,
        behind_by: 0,
        base_commit: { sha: base },
        head_commit: { sha: head },
        merge_base_commit: { sha: base },
        commits: [{ sha: head }],
        files: [{ filename: 'a.ts', status: 'modified' }],
      }),
      { status: 200 },
    ),
    new Response(diff, { status: 200 }),
  ];
  const requests: Array<{ url: string; accept: string }> = [];
  const client = new GitHubClient('token', 'https://api.example.test', async (url, init) => {
    requests.push({ url: String(url), accept: String((init?.headers as Record<string, string>).Accept) });
    const response = responses.shift();
    assert.ok(response);
    return response;
  });
  const result = await client.getCompare(
    {
      owner: 'owner',
      repository: 'repository',
      number: 7,
      title: 'Change',
      body: '',
      url: 'url',
      baseSha: 'base',
      headSha: head,
      author: 'author',
    },
    base,
    head,
  );
  assert.equal(result.status, 'ahead');
  assert.deepEqual(result.paths, ['a.ts']);
  assert.equal(result.diff.files[0]?.apiPath, 'a.ts');
  assert.match(requests[0]?.url ?? '', new RegExp(`/compare/${base}\\.\\.\\.${head}$`, 'u'));
  assert.equal(requests[0]?.accept, 'application/vnd.github+json');
  assert.equal(requests[1]?.accept, 'application/vnd.github.v3.diff');
});

test('rejects nonlinear, truncated, and inconsistent compare responses', async () => {
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const metadata = {
    status: 'diverged',
    ahead_by: 1,
    behind_by: 1,
    base_commit: { sha: base },
    head_commit: { sha: head },
    merge_base_commit: { sha: 'c'.repeat(40) },
    commits: [],
    files: [],
  };
  const client = new GitHubClient(
    'token',
    'https://api.example.test',
    async () => new Response(JSON.stringify(metadata), { status: 200 }),
  );
  await assert.rejects(
    client.getCompare(
      {
        owner: 'owner',
        repository: 'repository',
        number: 7,
        title: '',
        body: '',
        url: '',
        baseSha: base,
        headSha: head,
        author: '',
      },
      base,
      head,
    ),
    /not a strict descendant/,
  );
  const tooMany = new GitHubClient(
    'token',
    'https://api.example.test',
    async () =>
      new Response(
        JSON.stringify({
          ...metadata,
          status: 'ahead',
          behind_by: 0,
          merge_base_commit: { sha: base },
          files: Array.from({ length: 300 }, (_, index) => ({ filename: `f${index}.ts`, status: 'modified' })),
        }),
        { status: 200 },
      ),
  );
  await assert.rejects(
    tooMany.getCompare(
      {
        owner: 'owner',
        repository: 'repository',
        number: 7,
        title: '',
        body: '',
        url: '',
        baseSha: base,
        headSha: head,
        author: '',
      },
      base,
      head,
    ),
    /incomplete/,
  );
});

test('lists paginated review comments and guards managed summary leases', async () => {
  const current = '<!-- code-review:opencode:v5 -->';
  const body = `summary\n${current}`;
  const existing = { id: 11, body, html_url: 'url', user: { id: 20, login: 'bot' } };
  const responses = [
    new Response(JSON.stringify([{ ...existing, path: 'a.ts', line: 1, side: 'RIGHT' }]), { status: 200 }),
    new Response(JSON.stringify([existing]), { status: 200 }),
    new Response(JSON.stringify({ ...existing, body: `updated\n${current}` }), { status: 200 }),
  ];
  const requests: Array<{ url: string; method?: string }> = [];
  const client = new GitHubClient('token', 'https://api.example.test', async (url, init) => {
    requests.push({ url: String(url), method: init?.method });
    const response = responses.shift();
    assert.ok(response);
    return response;
  });
  const context: PullRequestContext = {
    owner: 'owner',
    repository: 'repository',
    number: 7,
    title: '',
    body: '',
    url: '',
    baseSha: 'base',
    headSha: 'head',
    author: '',
  };
  assert.equal((await client.listPullRequestReviewComments(context)).length, 1);
  const selection = selectManagedComment([existing], 20, [current]);
  assert.equal(selection.kind, 'current');
  if (selection.kind !== 'current') throw new Error('expected current');
  await client.upsertManagedComment(
    context,
    { id: 20, login: 'bot' },
    [current],
    `updated\n${current}`,
    selection.lease,
  );
  assert.match(requests[0]?.url ?? '', /pulls\/7\/comments/);
  assert.equal(requests[2]?.method, 'PATCH');
});
