import { open, readFile, rm } from 'node:fs/promises';
import { prepareReviewedDiff, type UnifiedDiff } from './unified-diff';

export interface PullRequestContext {
  owner: string;
  repository: string;
  number: number;
  title: string;
  body: string;
  baseSha: string;
  headSha: string;
  author: string;
  url: string;
}

export interface AuthenticatedActor {
  id: number;
  login: string;
}

export interface PullRequestDiff {
  text: string;
  originalBytes: number;
  truncated: boolean;
  totalFiles?: number;
  parsed?: UnifiedDiff;
}

export interface PullRequestRevision {
  baseSha: string;
  headSha: string;
  changedFiles: number;
  title: string;
  body: string;
  author: string;
}

export interface RepositoryTextResult {
  status: 'found' | 'not-found' | 'unavailable';
  text?: string;
  bytes: number;
  truncated: boolean;
  blobSha?: string;
  reason?: 'not-found-or-forbidden' | 'not-a-regular-file' | 'invalid-utf8' | 'too-large' | 'fetch-error';
}

export interface GitHubIssueContext {
  id: number;
  number: number;
  title: string;
  body: string;
  htmlUrl: string;
  updatedAt: string;
  isPullRequest: boolean;
}

export interface GitHubComment {
  id: number;
  body: string | null;
  html_url: string;
  user: {
    id: number;
    login: string;
  } | null;
}

export interface GitHubReview extends GitHubComment {
  commit_id?: string;
}

export interface GitHubInlineCommentInput {
  path: string;
  side: 'LEFT' | 'RIGHT';
  line: number;
  body: string;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${name} must be a string`);
  }
  return value;
}

function integer(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value as number;
}

function nonnegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a nonnegative integer`);
  }
  return value as number;
}

function utf8Prefix(bytes: Buffer, maximumBytes: number): string {
  let end = Math.min(bytes.length, maximumBytes);
  while (end >= 0) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return '';
}

async function readBoundedJsonResponse(response: Response, maximumBytes: number, label: string): Promise<unknown> {
  if (!response.body) throw new Error(`${label} response has no body`);
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    await response.body.cancel().catch(() => undefined);
    throw new Error(`${label} exceeds response limit`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) throw new Error(`${label} exceeds response limit`);
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} is malformed`);
  }
}

export function parsePullRequestEvent(payload: unknown): PullRequestContext {
  const root = record(payload, 'event payload');
  const pullRequest = record(root.pull_request, 'pull_request');
  const repository = record(root.repository, 'repository');
  const base = record(pullRequest.base, 'pull_request.base');
  const head = record(pullRequest.head, 'pull_request.head');
  const user = record(pullRequest.user, 'pull_request.user');
  const fullName = text(repository.full_name, 'repository.full_name');
  const separator = fullName.indexOf('/');
  if (separator <= 0 || separator === fullName.length - 1) {
    throw new Error('repository.full_name must contain owner and repository');
  }

  return {
    owner: fullName.slice(0, separator),
    repository: fullName.slice(separator + 1),
    number: integer(pullRequest.number ?? root.number, 'pull_request.number'),
    title: text(pullRequest.title, 'pull_request.title'),
    body: typeof pullRequest.body === 'string' ? pullRequest.body : '',
    baseSha: text(base.sha, 'pull_request.base.sha'),
    headSha: text(head.sha, 'pull_request.head.sha'),
    author: text(user.login, 'pull_request.user.login'),
    url: text(pullRequest.html_url, 'pull_request.html_url'),
  };
}

export async function loadPullRequestEvent(eventPath: string): Promise<PullRequestContext> {
  const content = await readFile(eventPath, 'utf8');
  return parsePullRequestEvent(JSON.parse(content) as unknown);
}

function hasFinalMarker(comment: GitHubComment, marker: string): boolean {
  if (typeof comment.body !== 'string') {
    return false;
  }
  return comment.body.trimEnd().split(/\r?\n/).at(-1) === marker;
}

export function extractExplicitSameRepositoryIssueNumbers(
  context: Pick<PullRequestContext, 'owner' | 'repository' | 'number'>,
  title: string,
  body: string,
  maximum: number,
): number[] {
  const withoutCode = `${title}\n${body}`
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/~~~[\s\S]*?~~~/gu, ' ')
    .replace(/`[^`\r\n]*`/gu, ' ');
  const matches: Array<{ index: number; number: number }> = [];
  const escapedOwner = context.owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedRepository = context.repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const urlPattern = new RegExp(
    `(?<![A-Za-z0-9])https://github\\.com/${escapedOwner}/${escapedRepository}/issues/(\\d+)(?=$|[\\s),.;:!?])`,
    'giu',
  );
  const closingPattern = new RegExp(
    `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+(?:(?:${escapedOwner}/${escapedRepository})?)(#\\d+)`,
    'giu',
  );
  for (const match of withoutCode.matchAll(urlPattern)) {
    const number = Number(match[1]);
    if (Number.isSafeInteger(number) && number > 0 && number !== context.number) {
      matches.push({ index: match.index, number });
    }
  }
  for (const match of withoutCode.matchAll(closingPattern)) {
    const number = Number(match[1]?.slice(1));
    if (Number.isSafeInteger(number) && number > 0 && number !== context.number) {
      matches.push({ index: match.index, number });
    }
  }
  matches.sort((left, right) => left.index - right.index || left.number - right.number);
  const selected: number[] = [];
  for (const match of matches) {
    if (!selected.includes(match.number)) selected.push(match.number);
    if (selected.length >= maximum) break;
  }
  return selected;
}

export function findManagedComment(
  comments: GitHubComment[],
  actorId: number,
  markers: string | readonly string[],
): GitHubComment | undefined {
  const acceptedMarkers = typeof markers === 'string' ? [markers] : markers;
  for (const marker of acceptedMarkers) {
    const match = comments.find((comment) => comment.user?.id === actorId && hasFinalMarker(comment, marker));
    if (match) {
      return match;
    }
  }
  return undefined;
}

export class GitHubClient {
  constructor(
    private readonly token: string,
    private readonly apiUrl = 'https://api.github.com',
    private readonly fetchImplementation: FetchLike = fetch,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}, accept = 'application/vnd.github+json'): Promise<T> {
    const response = await this.fetchImplementation(`${this.apiUrl}${path}`, {
      ...init,
      headers: {
        Accept: accept,
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'code-review-action',
        ...init.headers,
      },
    });

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`GitHub API ${init.method ?? 'GET'} ${path} failed with ${response.status}`);
    }

    return (await response.json()) as T;
  }

  async getAuthenticatedActor(): Promise<AuthenticatedActor> {
    const actor = await this.request<{ id: number; login: string }>('/user');
    return { id: actor.id, login: actor.login };
  }

  async getPullRequestRevision(context: PullRequestContext, signal?: AbortSignal): Promise<PullRequestRevision> {
    const path = `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repository)}/pulls/${context.number}`;
    const pullRequest = await this.request<{
      base: { sha: string };
      head: { sha: string };
      changed_files: number;
      title?: unknown;
      body?: unknown;
      user?: unknown;
    }>(path, { signal });
    const body = pullRequest.body;
    if (body !== null && typeof body !== 'string') throw new Error('pull_request.body must be a string or null');
    return {
      baseSha: text(record(pullRequest.base, 'pull_request.base').sha, 'pull_request.base.sha'),
      headSha: text(record(pullRequest.head, 'pull_request.head').sha, 'pull_request.head.sha'),
      changedFiles: nonnegativeInteger(pullRequest.changed_files, 'pull_request.changed_files'),
      title: text(pullRequest.title, 'pull_request.title'),
      body: body ?? '',
      author: text(record(pullRequest.user, 'pull_request.user').login, 'pull_request.user.login'),
    };
  }

  async getRepositoryTextAtRevision(
    context: PullRequestContext,
    repositoryPath: string,
    revision: string,
    maximumBytes: number,
    signal?: AbortSignal,
  ): Promise<RepositoryTextResult> {
    const segments = repositoryPath.split('/');
    if (
      !segments.length ||
      segments.some((segment) => !segment || segment === '.' || segment === '..' || /[\\\0\r\n]/u.test(segment))
    ) {
      throw new Error('Repository context path is unsafe');
    }
    const encodedPath = segments.map((segment) => encodeURIComponent(segment)).join('/');
    const path = `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repository)}/contents/${encodedPath}?ref=${encodeURIComponent(revision)}`;
    const response = await this.fetchImplementation(`${this.apiUrl}${path}`, {
      signal,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'code-review-action',
      },
    });
    if (response.status === 403 || response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return { status: 'not-found', bytes: 0, truncated: false, reason: 'not-found-or-forbidden' };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { status: 'unavailable', bytes: 0, truncated: false, reason: 'fetch-error' };
    }
    let value: unknown;
    try {
      value = await readBoundedJsonResponse(
        response,
        Math.min(2_000_000, maximumBytes * 2 + 16_384),
        'GitHub repository content',
      );
    } catch {
      return { status: 'unavailable', bytes: 0, truncated: false, reason: 'fetch-error' };
    }
    let entry: Record<string, unknown>;
    try {
      entry = record(value, 'repository content');
    } catch {
      return { status: 'unavailable', bytes: 0, truncated: false, reason: 'fetch-error' };
    }
    if (entry.type !== 'file' || entry.target !== undefined || entry.submodule_git_url !== undefined) {
      return { status: 'unavailable', bytes: 0, truncated: false, reason: 'not-a-regular-file' };
    }
    if (entry.encoding !== 'base64' || typeof entry.content !== 'string' || typeof entry.sha !== 'string') {
      return { status: 'unavailable', bytes: 0, truncated: false, reason: 'fetch-error' };
    }
    const encodedContent = entry.content.replaceAll(/\s/gu, '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encodedContent)) {
      return { status: 'unavailable', bytes: 0, truncated: false, reason: 'fetch-error' };
    }
    const bytes = Buffer.from(encodedContent, 'base64');
    let decoded: string;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return { status: 'unavailable', bytes: bytes.length, truncated: false, reason: 'invalid-utf8' };
    }
    if (bytes.length <= maximumBytes) {
      return { status: 'found', text: decoded, bytes: bytes.length, truncated: false, blobSha: entry.sha };
    }
    const textPrefix = utf8Prefix(bytes, maximumBytes);
    return {
      status: 'found',
      text: textPrefix,
      bytes: bytes.length,
      truncated: true,
      blobSha: entry.sha,
      reason: 'too-large',
    };
  }

  async getIssueContext(
    context: PullRequestContext,
    number: number,
    maximumResponseBytes: number,
    signal?: AbortSignal,
  ): Promise<GitHubIssueContext> {
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error('Issue number must be a positive integer');
    const path = `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repository)}/issues/${number}`;
    const response = await this.fetchImplementation(`${this.apiUrl}${path}`, {
      signal,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'code-review-action',
      },
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`GitHub issue context request failed with ${response.status}`);
    }
    const value = await readBoundedJsonResponse(response, maximumResponseBytes, 'GitHub issue context');
    const issue = record(value, 'issue context');
    const issueNumber = integer(issue.number, 'issue.number');
    if (issueNumber !== number) throw new Error('GitHub issue context number mismatch');
    return {
      id: integer(issue.id, 'issue.id'),
      number: issueNumber,
      title: text(issue.title, 'issue.title'),
      body: typeof issue.body === 'string' ? issue.body : '',
      htmlUrl: text(issue.html_url, 'issue.html_url'),
      updatedAt: text(issue.updated_at, 'issue.updated_at'),
      isPullRequest: issue.pull_request !== undefined,
    };
  }

  async downloadRepositoryArchive(
    context: PullRequestContext,
    reference: string,
    destination: string,
    maximumBytes = 1_000_000_000,
    signal?: AbortSignal,
  ): Promise<number> {
    const path = `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repository)}/tarball/${encodeURIComponent(reference)}`;
    const response = await this.fetchImplementation(`${this.apiUrl}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'code-review-action',
      },
      redirect: 'follow',
      signal,
    });
    if (!response.ok || !response.body) {
      const message = (await response.text()).slice(0, 2_000);
      throw new Error(`GitHub archive request failed with ${response.status}: ${message}`);
    }

    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
      throw new Error(`GitHub archive exceeds ${maximumBytes} bytes`);
    }

    const file = await open(destination, 'wx', 0o600);
    const reader = response.body.getReader();
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        bytes += chunk.value.byteLength;
        if (bytes > maximumBytes) {
          throw new Error(`GitHub archive exceeds ${maximumBytes} bytes`);
        }
        await file.write(chunk.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      await file.close();
      await rm(destination, { force: true });
      throw error;
    }
    await file.close();
    return bytes;
  }

  async getPullRequestDiff(
    context: PullRequestContext,
    maximumBytes: number,
    signal?: AbortSignal,
  ): Promise<PullRequestDiff> {
    const path = `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repository)}/pulls/${context.number}`;
    const response = await this.fetchImplementation(`${this.apiUrl}${path}`, {
      signal,
      headers: {
        Accept: 'application/vnd.github.v3.diff',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'code-review-action',
      },
    });

    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`GitHub diff request failed with ${response.status}`);
    }
    const acquisitionLimit = 10_000_000;
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > acquisitionLimit) {
      await response.body.cancel().catch(() => undefined);
      throw new Error(`GitHub diff exceeds ${acquisitionLimit} acquisition bytes`);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > acquisitionLimit) throw new Error(`GitHub diff exceeds ${acquisitionLimit} acquisition bytes`);
        chunks.push(chunk.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
    const encoded = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    let raw: string;
    try {
      raw = new TextDecoder('utf-8', { fatal: true }).decode(encoded);
    } catch {
      throw new Error('GitHub diff is not valid UTF-8');
    }
    return prepareReviewedDiff(raw, maximumBytes);
  }

  async listComments(context: PullRequestContext): Promise<GitHubComment[]> {
    const comments: GitHubComment[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const path = `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repository)}/issues/${context.number}/comments?per_page=100&page=${page}`;
      const response = await this.request<GitHubComment[]>(path);
      comments.push(...response);
      if (response.length < 100) {
        return comments;
      }
    }
    throw new Error('Pull request has more than 2000 comments');
  }

  async listPullRequestReviews(context: PullRequestContext): Promise<GitHubReview[]> {
    const reviews: GitHubReview[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const path = `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repository)}/pulls/${context.number}/reviews?per_page=100&page=${page}`;
      const response = await this.request<GitHubReview[]>(path);
      reviews.push(...response);
      if (response.length < 100) return reviews;
    }
    throw new Error('Pull request has more than 2000 reviews');
  }

  async createOrReuseInlineReview(
    context: PullRequestContext,
    actor: AuthenticatedActor,
    headSha: string,
    marker: string,
    comments: readonly GitHubInlineCommentInput[],
  ): Promise<GitHubReview> {
    if (comments.length === 0) throw new Error('Inline review requires at least one comment');
    const existing = findManagedComment(await this.listPullRequestReviews(context), actor.id, marker);
    if (existing) return existing;
    return this.request<GitHubReview>(
      `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repository)}/pulls/${context.number}/reviews`,
      {
        method: 'POST',
        body: JSON.stringify({
          commit_id: headSha,
          event: 'COMMENT',
          body: `Validated inline findings from code-review.\n\n${marker}`,
          comments,
        }),
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  async upsertManagedComment(
    context: PullRequestContext,
    actor: AuthenticatedActor,
    markers: string | readonly string[],
    body: string,
  ): Promise<GitHubComment> {
    const comments = await this.listComments(context);
    const existing = findManagedComment(comments, actor.id, markers);
    if (existing) {
      return this.request<GitHubComment>(
        `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repository)}/issues/comments/${existing.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ body }),
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    return this.request<GitHubComment>(
      `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repository)}/issues/${context.number}/comments`,
      {
        method: 'POST',
        body: JSON.stringify({ body }),
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }
}
