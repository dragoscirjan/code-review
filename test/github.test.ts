import assert from "node:assert/strict";
import test from "node:test";
import {
  findManagedComment,
  GitHubClient,
  parsePullRequestEvent,
  truncateUtf8,
  type GitHubComment,
} from "../src/github";

const marker = "<!-- marker -->";
const comments: GitHubComment[] = [
  {
    id: 1,
    body: `human copy ${marker}`,
    html_url: "https://example.test/1",
    user: { id: 10, login: "human" },
  },
  {
    id: 2,
    body: `managed ${marker}`,
    html_url: "https://example.test/2",
    user: { id: 20, login: "bot" },
  },
];

test("finds a managed comment by marker and actor", () => {
  assert.equal(findManagedComment(comments, 20, marker)?.id, 2);
  assert.equal(findManagedComment(comments, 10, marker)?.id, 1);
  assert.equal(findManagedComment(comments, 30, marker), undefined);
});

test("truncates by UTF-8 byte length", () => {
  const source = "a😀b".repeat(20);
  const result = truncateUtf8(source, 50);
  assert.equal(result.truncated, true);
  assert.equal(result.originalBytes, 120);
  assert.ok(Buffer.byteLength(result.text, "utf8") <= 50);
  assert.match(result.text, /diff truncated/);
});

test("updates only the managed comment owned by the PAT actor", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const responses = [
    new Response(JSON.stringify(comments), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
    new Response(
      JSON.stringify({ ...comments[1], body: `updated ${marker}` }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    ),
  ];
  const client = new GitHubClient(
    "token",
    "https://api.example.test",
    async (input, init) => {
      requests.push({ url: String(input), init });
      const response = responses.shift();
      assert.ok(response);
      return response;
    },
  );
  const context = parsePullRequestEvent({
    number: 7,
    repository: { full_name: "owner/repository" },
    pull_request: {
      number: 7,
      title: "Change",
      body: "",
      html_url: "https://github.com/owner/repository/pull/7",
      base: { sha: "base" },
      head: { sha: "head" },
      user: { login: "contributor" },
    },
  });

  const updated = await client.upsertManagedComment(
    context,
    { id: 20, login: "bot" },
    marker,
    `updated ${marker}`,
  );

  assert.equal(updated.id, 2);
  assert.equal(requests[1]?.init?.method, "PATCH");
  assert.match(requests[1]?.url ?? "", /issues\/comments\/2$/);
});

test("parses a pull request event", () => {
  const context = parsePullRequestEvent({
    number: 7,
    repository: { full_name: "owner/repository" },
    pull_request: {
      number: 7,
      title: "Change",
      body: null,
      html_url: "https://github.com/owner/repository/pull/7",
      base: { sha: "base" },
      head: { sha: "head" },
      user: { login: "contributor" },
    },
  });

  assert.deepEqual(context, {
    owner: "owner",
    repository: "repository",
    number: 7,
    title: "Change",
    body: "",
    baseSha: "base",
    headSha: "head",
    author: "contributor",
    url: "https://github.com/owner/repository/pull/7",
  });
});
