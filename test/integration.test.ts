import assert from "node:assert/strict";
import test from "node:test";
import { runReview, type ReviewBackend } from "../src/review";

const enabled = process.env.RUN_LLM_INTEGRATION === "1";
const openRouterApiKey = process.env.OPENROUTER_API_KEY ?? "";

for (const backend of ["opencode", "pi"] as const) {
  test(
    `${backend} reviews a diff through OpenRouter`,
    { skip: !enabled },
    async () => {
      assert.ok(openRouterApiKey, "OPENROUTER_API_KEY is required");
      const review = await runReview({
        backend: backend as ReviewBackend,
        containerEngine:
          process.env.CONTAINER_ENGINE === "docker" ? "docker" : "podman",
        model: "z-ai/glm-5.3-flash",
        openRouterApiKey,
        opencodeVersion: "1.18.31",
        piVersion: "0.85.1",
        customPrompt: "Identify the concrete regression.",
        timeoutMs: 240_000,
        pullRequest: {
          owner: "example",
          repository: "repository",
          number: 1,
          title: "Change addition",
          body: "",
          baseSha: "base",
          headSha: "head",
          author: "tester",
          url: "https://example.test/pull/1",
        },
        diff: {
          text: [
            "diff --git a/math.ts b/math.ts",
            "--- a/math.ts",
            "+++ b/math.ts",
            "@@ -1 +1 @@",
            "-export const add = (a: number, b: number) => a + b;",
            "+export const add = (a: number, b: number) => a - b;",
          ].join("\n"),
          originalBytes: 190,
          truncated: false,
        },
      });
      assert.match(review, /subtract|subtraction/i);
    },
  );
}
