import { open, readFile, rm } from "node:fs/promises";

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

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  return value;
}

function integer(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value as number;
}

export function parsePullRequestEvent(payload: unknown): PullRequestContext {
  const root = record(payload, "event payload");
  const pullRequest = record(root.pull_request, "pull_request");
  const repository = record(root.repository, "repository");
  const base = record(pullRequest.base, "pull_request.base");
  const head = record(pullRequest.head, "pull_request.head");
  const user = record(pullRequest.user, "pull_request.user");
  const fullName = text(repository.full_name, "repository.full_name");
  const separator = fullName.indexOf("/");
  if (separator <= 0 || separator === fullName.length - 1) {
    throw new Error("repository.full_name must contain owner and repository");
  }

  return {
    owner: fullName.slice(0, separator),
    repository: fullName.slice(separator + 1),
    number: integer(pullRequest.number ?? root.number, "pull_request.number"),
    title: text(pullRequest.title, "pull_request.title"),
    body: typeof pullRequest.body === "string" ? pullRequest.body : "",
    baseSha: text(base.sha, "pull_request.base.sha"),
    headSha: text(head.sha, "pull_request.head.sha"),
    author: text(user.login, "pull_request.user.login"),
    url: text(pullRequest.html_url, "pull_request.html_url"),
  };
}

export async function loadPullRequestEvent(
  eventPath: string,
): Promise<PullRequestContext> {
  const content = await readFile(eventPath, "utf8");
  return parsePullRequestEvent(JSON.parse(content) as unknown);
}

export function truncateUtf8(value: string, maximumBytes: number): PullRequestDiff {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) {
    return { text: value, originalBytes: bytes.length, truncated: false };
  }

  const trailer = Buffer.from(
    "\n\n[diff truncated by code-review action]",
    "utf8",
  );
  if (maximumBytes <= trailer.length) {
    return {
      text: trailer.subarray(0, maximumBytes).toString("utf8"),
      originalBytes: bytes.length,
      truncated: true,
    };
  }

  const decoder = new TextDecoder("utf-8", { fatal: false });
  let content = decoder.decode(
    bytes.subarray(0, maximumBytes - trailer.length),
  );
  while (
    content.length > 0 &&
    Buffer.byteLength(content, "utf8") + trailer.length > maximumBytes
  ) {
    content = content.slice(0, -1);
  }
  return {
    text: `${content}${trailer.toString("utf8")}`,
    originalBytes: bytes.length,
    truncated: true,
  };
}

function hasFinalMarker(comment: GitHubComment, marker: string): boolean {
  if (typeof comment.body !== "string") {
    return false;
  }
  return comment.body.trimEnd().split(/\r?\n/).at(-1) === marker;
}

export function findManagedComment(
  comments: GitHubComment[],
  actorId: number,
  markers: string | readonly string[],
): GitHubComment | undefined {
  const acceptedMarkers = typeof markers === "string" ? [markers] : markers;
  for (const marker of acceptedMarkers) {
    const match = comments.find(
      (comment) =>
        comment.user?.id === actorId && hasFinalMarker(comment, marker),
    );
    if (match) {
      return match;
    }
  }
  return undefined;
}

export class GitHubClient {
  constructor(
    private readonly token: string,
    private readonly apiUrl = "https://api.github.com",
    private readonly fetchImplementation: FetchLike = fetch,
  ) {}

  private async request<T>(
    path: string,
    init: RequestInit = {},
    accept = "application/vnd.github+json",
  ): Promise<T> {
    const response = await this.fetchImplementation(`${this.apiUrl}${path}`, {
      ...init,
      headers: {
        Accept: accept,
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "code-review-action",
        ...init.headers,
      },
    });

    if (!response.ok) {
      const message = (await response.text()).slice(0, 2_000);
      throw new Error(
        `GitHub API ${init.method ?? "GET"} ${path} failed with ${response.status}: ${message}`,
      );
    }

    return (await response.json()) as T;
  }

  async getAuthenticatedActor(): Promise<AuthenticatedActor> {
    const actor = await this.request<{ id: number; login: string }>("/user");
    return { id: actor.id, login: actor.login };
  }

  async downloadRepositoryArchive(
    context: PullRequestContext,
    reference: string,
    destination: string,
    maximumBytes = 1_000_000_000,
  ): Promise<number> {
    const path = `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repository)}/tarball/${encodeURIComponent(reference)}`;
    const response = await this.fetchImplementation(`${this.apiUrl}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "code-review-action",
      },
      redirect: "follow",
    });
    if (!response.ok || !response.body) {
      const message = (await response.text()).slice(0, 2_000);
      throw new Error(
        `GitHub archive request failed with ${response.status}: ${message}`,
      );
    }

    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
      throw new Error(`GitHub archive exceeds ${maximumBytes} bytes`);
    }

    const file = await open(destination, "wx", 0o600);
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
  ): Promise<PullRequestDiff> {
    const path = `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repository)}/pulls/${context.number}`;
    const response = await this.fetchImplementation(`${this.apiUrl}${path}`, {
      headers: {
        Accept: "application/vnd.github.v3.diff",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "code-review-action",
      },
    });

    if (!response.ok) {
      const message = (await response.text()).slice(0, 2_000);
      throw new Error(
        `GitHub diff request failed with ${response.status}: ${message}`,
      );
    }

    return truncateUtf8(await response.text(), maximumBytes);
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
    throw new Error("Pull request has more than 2000 comments");
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
          method: "PATCH",
          body: JSON.stringify({ body }),
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    return this.request<GitHubComment>(
      `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repository)}/issues/${context.number}/comments`,
      {
        method: "POST",
        body: JSON.stringify({ body }),
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
