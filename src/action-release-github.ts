import type { ActionReleaseRecord } from './action-release';
import type { GitHubReleaseStore } from './action-release-publisher';

const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/;
const API_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RELEASE_PAGES = 10;
const RELEASES_PER_PAGE = 100;

function validateRepository(repository: string): void {
  if (!REPOSITORY_PATTERN.test(repository) || repository.includes('..') || repository.endsWith('.git')) {
    throw new Error('Action release failed: repository must be a canonical GitHub owner/name');
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    throw new Error('Action release failed: GitHub API response exceeded its limit');
  }
  if (!response.body) throw new Error('Action release failed: GitHub API returned no response body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.length;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('Action release failed: GitHub API response exceeded its limit');
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error('Action release failed: GitHub API returned malformed JSON');
  }
}

function normalizeRelease(value: unknown): ActionReleaseRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Action release failed: GitHub API returned a malformed release');
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.tag_name !== 'string' ||
    typeof record.draft !== 'boolean' ||
    typeof record.prerelease !== 'boolean'
  ) {
    throw new Error('Action release failed: GitHub API returned a malformed release');
  }
  return { tagName: record.tag_name, draft: record.draft, prerelease: record.prerelease };
}

export class GitHubActionReleaseStore implements GitHubReleaseStore {
  constructor(
    private readonly repository: string,
    private readonly token?: string,
    private readonly request: typeof fetch = fetch,
  ) {
    validateRepository(repository);
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'code-review-action-release',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  async list(): Promise<readonly ActionReleaseRecord[]> {
    const releases: ActionReleaseRecord[] = [];
    for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
      let response: Response;
      try {
        response = await this.request(
          `https://api.github.com/repos/${this.repository}/releases?per_page=${RELEASES_PER_PAGE}&page=${page}`,
          { headers: this.headers(), redirect: 'error', signal: AbortSignal.timeout(API_TIMEOUT_MS) },
        );
      } catch {
        throw new Error('Action release failed: GitHub API request was unavailable');
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Action release failed: GitHub API list request returned ${response.status}`);
      }
      const body = await readBoundedJson(response);
      if (!Array.isArray(body)) throw new Error('Action release failed: GitHub API returned a malformed release list');
      releases.push(...body.map(normalizeRelease));
      if (body.length < RELEASES_PER_PAGE) return releases;
    }
    throw new Error('Action release failed: GitHub Release listing exceeded its page limit');
  }

  async create(tagName: string, targetSha: string): Promise<void> {
    if (!this.token) throw new Error('Action release failed: publication token is required');
    let response: Response;
    try {
      response = await this.request(`https://api.github.com/repos/${this.repository}/releases`, {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tag_name: tagName,
          target_commitish: targetSha,
          name: tagName,
          draft: false,
          prerelease: false,
          generate_release_notes: true,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch {
      throw new Error('Action release failed: GitHub API request was unavailable');
    }
    if (response.status !== 201) {
      await response.body?.cancel();
      throw new Error(`Action release failed: GitHub API create request returned ${response.status}`);
    }
    await response.body?.cancel();
  }
}
