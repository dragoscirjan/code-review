import { createHash } from 'node:crypto';
import { open, readFile, rm } from 'node:fs/promises';
import { parseUnifiedDiff, prepareReviewedDiff, type UnifiedDiff } from './unified-diff';

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
  completeParsed?: UnifiedDiff;
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
  reason?:
    | 'not-found'
    | 'not-a-regular-file'
    | 'ambiguous-tree-entry'
    | 'truncated-tree'
    | 'invalid-utf8'
    | 'too-large'
    | 'fetch-error';
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

export interface GitHubReviewComment extends GitHubComment {
  path?: string;
  line?: number | null;
  side?: 'LEFT' | 'RIGHT';
  in_reply_to_id?: number;
}

export interface GitHubCompareResult {
  status: 'ahead' | 'identical';
  baseSha: string;
  headSha: string;
  mergeBaseSha: string;
  aheadBy: number;
  behindBy: number;
  paths: string[];
  diff: UnifiedDiff;
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

async function readBoundedTextResponse(response: Response, maximumBytes: number, label: string): Promise<string> {
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
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

async function readBoundedJsonResponse(response: Response, maximumBytes: number, label: string): Promise<unknown> {
  const raw = await readBoundedTextResponse(response, maximumBytes, label);
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
    if (match) return match;
  }
  return undefined;
}

export interface ManagedCommentLease {
  id: number;
  bodyDigest: string;
  marker: string;
}

export type ManagedCommentSelection =
  | { kind: 'none' }
  | { kind: 'current' | 'legacy'; comment: GitHubComment; lease: ManagedCommentLease }
  | { kind: 'ambiguous' };

/** Lease digest of a managed-comment body; progressive edits chain leases through this digest. */
export function commentDigest(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

export function selectManagedComment(
  comments: readonly GitHubComment[],
  actorId: number,
  markers: readonly string[],
): ManagedCommentSelection {
  const current = markers[0];
  if (!current) return { kind: 'none' };
  const owned = comments.filter((comment) => comment.user?.id === actorId && typeof comment.body === 'string');
  const currentMatches = owned.filter((comment) => hasFinalMarker(comment, current));
  if (currentMatches.length > 1) return { kind: 'ambiguous' };
  if (currentMatches.length === 1) {
    const comment = currentMatches[0] as GitHubComment & { body: string };
    return {
      kind: 'current',
      comment,
      lease: { id: comment.id, bodyDigest: commentDigest(comment.body), marker: current },
    };
  }
  const legacyMatches = owned.filter((comment) => markers.slice(1).some((marker) => hasFinalMarker(comment, marker)));
  if (legacyMatches.length > 1) return { kind: 'ambiguous' };
  if (legacyMatches.length === 1) {
    const comment = legacyMatches[0] as GitHubComment & { body: string };
    const marker = markers.slice(1).find((candidate) => hasFinalMarker(comment, candidate)) as string;
    return {
      kind: 'legacy',
      comment,
      lease: { id: comment.id, bodyDigest: commentDigest(comment.body), marker },
    };
  }
  return { kind: 'none' };
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
    return { id: integer(actor.id, 'actor.id'), login: text(actor.login, 'actor.login') };
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
      segments.length > 64 ||
      segments.some((segment) => !segment || segment === '.' || segment === '..' || /[\\\0\r\n]/u.test(segment))
    ) {
      throw new Error('Repository context path is unsafe');
    }
    const repositoryPrefix = `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repository)}`;
    const getGitJson = async (path: string, label: string): Promise<{ status: number; value?: unknown }> => {
      const response = await this.fetchImplementation(`${this.apiUrl}${path}`, {
        signal,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'code-review-action',
        },
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { status: response.status };
      }
      try {
        return { status: response.status, value: await readBoundedJsonResponse(response, 2_000_000, label) };
      } catch {
        return { status: 0 };
      }
    };
    const unavailable = (reason: RepositoryTextResult['reason'] = 'fetch-error'): RepositoryTextResult => ({
      status: 'unavailable',
      bytes: 0,
      truncated: false,
      reason,
    });
    const missing = (): RepositoryTextResult => ({
      status: 'not-found',
      bytes: 0,
      truncated: false,
      reason: 'not-found',
    });

    const commitResponse = await getGitJson(
      `${repositoryPrefix}/git/commits/${encodeURIComponent(revision)}`,
      'GitHub repository commit',
    );
    if (commitResponse.status === 404) return missing();
    if (commitResponse.status !== 200) return unavailable();
    let currentTreeSha: string;
    try {
      const commit = record(commitResponse.value, 'repository commit');
      const commitSha = text(commit.sha, 'repository commit.sha');
      const tree = record(commit.tree, 'repository commit.tree');
      currentTreeSha = text(tree.sha, 'repository commit.tree.sha');
      if (commitSha !== revision || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(currentTreeSha)) return unavailable();
    } catch {
      return unavailable();
    }

    let blobSha: string | undefined;
    for (let index = 0; index < segments.length; index += 1) {
      const treeResponse = await getGitJson(
        `${repositoryPrefix}/git/trees/${encodeURIComponent(currentTreeSha)}`,
        'GitHub repository tree',
      );
      if (treeResponse.status === 404) return missing();
      if (treeResponse.status !== 200) return unavailable();
      let tree: Record<string, unknown>;
      try {
        tree = record(treeResponse.value, 'repository tree');
      } catch {
        return unavailable();
      }
      if (tree.sha !== currentTreeSha || tree.truncated !== false || !Array.isArray(tree.tree)) {
        return unavailable(tree.truncated === true ? 'truncated-tree' : 'fetch-error');
      }
      const entries: Record<string, unknown>[] = [];
      try {
        for (const value of tree.tree) {
          const entry = record(value, 'repository tree entry');
          if (
            typeof entry.path !== 'string' ||
            typeof entry.mode !== 'string' ||
            typeof entry.type !== 'string' ||
            typeof entry.sha !== 'string' ||
            !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(entry.sha)
          )
            return unavailable();
          entries.push(entry);
        }
      } catch {
        return unavailable();
      }
      const matches = entries.filter((entry) => entry.path === segments[index]);
      if (matches.length === 0) return missing();
      if (matches.length !== 1) return unavailable('ambiguous-tree-entry');
      const entry = matches[0] as Record<string, unknown> & { sha: string };
      const last = index === segments.length - 1;
      const entrySha = entry.sha;
      if (!last) {
        if (entry.type !== 'tree' || entry.mode !== '040000') return unavailable('not-a-regular-file');
        currentTreeSha = entrySha;
      } else {
        if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')) {
          return unavailable('not-a-regular-file');
        }
        blobSha = entrySha;
      }
    }
    if (!blobSha) return unavailable();

    const blobResponse = await getGitJson(
      `${repositoryPrefix}/git/blobs/${encodeURIComponent(blobSha)}`,
      'GitHub repository blob',
    );
    if (blobResponse.status === 404) return missing();
    if (blobResponse.status !== 200) return unavailable();
    let blob: Record<string, unknown>;
    try {
      blob = record(blobResponse.value, 'repository blob');
    } catch {
      return unavailable();
    }
    if (blob.sha !== blobSha || blob.encoding !== 'base64' || typeof blob.content !== 'string') return unavailable();
    const encodedContent = blob.content.replaceAll(/\s/gu, '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encodedContent)) {
      return unavailable();
    }
    const bytes = Buffer.from(encodedContent, 'base64');
    let decoded: string;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return { status: 'unavailable', bytes: bytes.length, truncated: false, reason: 'invalid-utf8' };
    }
    if (bytes.length <= maximumBytes) {
      return { status: 'found', text: decoded, bytes: bytes.length, truncated: false, blobSha };
    }
    return {
      status: 'found',
      text: utf8Prefix(bytes, maximumBytes),
      bytes: bytes.length,
      truncated: true,
      blobSha,
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

  async getCompare(
    context: PullRequestContext,
    baseSha: string,
    headSha: string,
    signal?: AbortSignal,
  ): Promise<GitHubCompareResult> {
    if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/u.test(baseSha) || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/u.test(headSha)) {
      throw new Error('Compare revisions must be full lowercase hexadecimal SHAs');
    }
    const path = `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repository)}/compare/${baseSha}...${headSha}`;
    const jsonResponse = await this.fetchImplementation(`${this.apiUrl}${path}`, {
      signal,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'code-review-action',
      },
    });
    if (!jsonResponse.ok) {
      await jsonResponse.body?.cancel().catch(() => undefined);
      throw new Error(`GitHub compare metadata request failed with ${jsonResponse.status}`);
    }
    const value = record(await readBoundedJsonResponse(jsonResponse, 1_000_000, 'GitHub compare metadata'), 'compare');
    if (value.status !== 'ahead' && value.status !== 'identical')
      throw new Error('GitHub compare is not a strict descendant');
    const baseCommit = record(value.base_commit, 'compare.base_commit');
    const headCommit = record(value.head_commit, 'compare.head_commit');
    const mergeBase = record(value.merge_base_commit, 'compare.merge_base_commit');
    const commits = Array.isArray(value.commits) ? value.commits : undefined;
    const files = Array.isArray(value.files) ? value.files : undefined;
    if (!commits || !files || files.length >= 300) throw new Error('GitHub compare metadata is incomplete');
    const aheadBy = nonnegativeInteger(value.ahead_by, 'compare.ahead_by');
    const behindBy = nonnegativeInteger(value.behind_by, 'compare.behind_by');
    const echoedBase = text(baseCommit.sha, 'compare.base_commit.sha');
    const echoedHead = text(headCommit.sha, 'compare.head_commit.sha');
    const mergeBaseSha = text(mergeBase.sha, 'compare.merge_base_commit.sha');
    if (echoedBase !== baseSha || echoedHead !== headSha || mergeBaseSha !== baseSha || behindBy !== 0) {
      throw new Error('GitHub compare ancestry mismatch');
    }
    if (
      (value.status === 'ahead' && (aheadBy < 1 || files.length === 0 || commits.length !== aheadBy)) ||
      (value.status === 'identical' &&
        (aheadBy !== 0 || headSha !== baseSha || files.length !== 0 || commits.length !== 0))
    ) {
      throw new Error('GitHub compare status is inconsistent');
    }
    const paths = files.map((entry, index) => {
      const file = record(entry, `compare.files[${index}]`);
      const filename = text(file.filename, `compare.files[${index}].filename`);
      if (
        !filename ||
        /[\0\r\n\\]/u.test(filename) ||
        filename.startsWith('/') ||
        filename.split('/').some((segment) => !segment || segment === '.' || segment === '..')
      ) {
        throw new Error('GitHub compare contains an unsafe path');
      }
      if (!['added', 'removed', 'modified', 'renamed', 'copied', 'changed'].includes(String(file.status))) {
        throw new Error('GitHub compare contains an unsupported file status');
      }
      return filename;
    });
    const diffResponse = await this.fetchImplementation(`${this.apiUrl}${path}`, {
      signal,
      headers: {
        Accept: 'application/vnd.github.v3.diff',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'code-review-action',
      },
    });
    if (!diffResponse.ok) {
      await diffResponse.body?.cancel().catch(() => undefined);
      throw new Error(`GitHub compare diff request failed with ${diffResponse.status}`);
    }
    const raw = await readBoundedTextResponse(diffResponse, 10_000_000, 'GitHub compare diff');
    const diff = parseUnifiedDiff(raw.replaceAll('\r\n', '\n').replace(/\n$/u, ''));
    if (diff.files.length !== files.length) throw new Error('GitHub compare diff file count mismatch');
    const diffPaths = diff.files.map((file) => file.apiPath);
    if (diffPaths.some((pathValue, index) => pathValue !== paths[index]))
      throw new Error('GitHub compare path identity mismatch');
    return { status: value.status, baseSha: echoedBase, headSha, mergeBaseSha, aheadBy, behindBy, paths, diff };
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

  async listPullRequestReviewComments(context: PullRequestContext): Promise<GitHubReviewComment[]> {
    const comments: GitHubReviewComment[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const path = `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repository)}/pulls/${context.number}/comments?per_page=100&page=${page}`;
      const response = await this.request<GitHubReviewComment[]>(path);
      comments.push(...response);
      if (response.length < 100) return comments;
    }
    throw new Error('Pull request has more than 2000 review comments');
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

  async getPullRequestReviewComment(context: PullRequestContext, commentId: number): Promise<GitHubReviewComment> {
    return this.request<GitHubReviewComment>(
      `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repository)}/pulls/comments/${commentId}`,
    );
  }

  /** Asserts the comment belongs to the expected actor and carries the expected trailing marker. */
  private async assertInlineCommentOwnership(
    context: PullRequestContext,
    actor: AuthenticatedActor,
    commentId: number,
    expectedMarker: string,
  ): Promise<void> {
    const comment = await this.getPullRequestReviewComment(context, commentId);
    if (comment.user?.id !== actor.id || !hasFinalMarker(comment, expectedMarker)) {
      throw new Error('Inline review comment ownership check failed');
    }
  }

  /**
   * Creates one standalone pull request review comment without wrapping it in a review
   * submission; progressive publication uses this to emit provisional per-file findings per shard.
   */
  async createPullRequestReviewComment(
    context: PullRequestContext,
    input: { path: string; side: 'LEFT' | 'RIGHT'; line: number; body: string },
  ): Promise<GitHubReviewComment> {
    return this.request<GitHubReviewComment>(
      `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repository)}/pulls/${context.number}/comments`,
      {
        method: 'POST',
        body: JSON.stringify({
          body: input.body,
          path: input.path,
          side: input.side,
          line: input.line,
          commit_id: context.headSha,
        }),
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  /** Updates one review comment after an ownership check against the expected trailing marker. */
  async updatePullRequestReviewComment(
    context: PullRequestContext,
    actor: AuthenticatedActor,
    commentId: number,
    expectedMarker: string,
    body: string,
  ): Promise<GitHubReviewComment> {
    await this.assertInlineCommentOwnership(context, actor, commentId, expectedMarker);
    return this.request<GitHubReviewComment>(
      `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repository)}/pulls/comments/${commentId}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ body }),
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  /** Deletes one review comment after an ownership check against the expected trailing marker. */
  async deletePullRequestReviewComment(
    context: PullRequestContext,
    actor: AuthenticatedActor,
    commentId: number,
    expectedMarker: string,
  ): Promise<void> {
    await this.assertInlineCommentOwnership(context, actor, commentId, expectedMarker);
    const response = await this.fetchImplementation(
      `${this.apiUrl}/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repository)}/pulls/comments/${commentId}`,
      {
        method: 'DELETE',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'code-review-action',
        },
      },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`GitHub API DELETE pulls/comments/${commentId} failed with ${response.status}`);
    }
    await response.body?.cancel().catch(() => undefined);
  }

  async createOrReuseInlineReview(
    context: PullRequestContext,
    actor: AuthenticatedActor,
    headSha: string,
    marker: string,
    comments: readonly GitHubInlineCommentInput[],
  ): Promise<GitHubReview> {
    if (comments.length === 0) throw new Error('Inline review requires at least one comment');
    const findExisting = async (): Promise<GitHubReview | undefined> => {
      const matches = (await this.listPullRequestReviews(context)).filter(
        (review) => review.user?.id === actor.id && review.commit_id === headSha && hasFinalMarker(review, marker),
      );
      if (matches.length > 1) throw new Error('Inline review operation is ambiguous');
      return matches[0];
    };
    const existing = await findExisting();
    if (existing) return existing;
    try {
      return await this.request<GitHubReview>(
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
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('GitHub API ')) throw error;
      const reconciled = await findExisting();
      if (reconciled) return reconciled;
      throw error;
    }
  }

  async assertManagedCommentLease(
    context: PullRequestContext,
    actor: AuthenticatedActor,
    lease: ManagedCommentLease | null,
    markers: readonly string[],
  ): Promise<void> {
    const selection = selectManagedComment(await this.listComments(context), actor.id, markers);
    if (selection.kind === 'ambiguous') throw new Error('Managed review comment ownership is ambiguous');
    if (lease === null) {
      if (selection.kind !== 'none') throw new Error('Managed review comment changed during review');
      return;
    }
    if (
      (selection.kind !== 'current' && selection.kind !== 'legacy') ||
      selection.lease.id !== lease.id ||
      selection.lease.bodyDigest !== lease.bodyDigest ||
      selection.lease.marker !== lease.marker
    ) {
      throw new Error('Managed review comment changed during review');
    }
  }

  async upsertManagedComment(
    context: PullRequestContext,
    actor: AuthenticatedActor,
    markers: string | readonly string[],
    body: string,
    lease?: ManagedCommentLease | null,
  ): Promise<GitHubComment> {
    const acceptedMarkers = typeof markers === 'string' ? [markers] : markers;
    if (lease !== undefined) {
      await this.assertManagedCommentLease(context, actor, lease, acceptedMarkers);
      if (lease) {
        return this.request<GitHubComment>(
          `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repository)}/issues/comments/${lease.id}`,
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
    const comments = await this.listComments(context);
    const existing = findManagedComment(comments, actor.id, acceptedMarkers);
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
