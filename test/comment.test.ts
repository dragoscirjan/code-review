import assert from "node:assert/strict";
import test from "node:test";
import { renderComment } from "../src/comment";

for (const [backend, label] of [
  ["opencode", "OpenCode"],
  ["pi", "Pi"],
] as const) {
  test(`uses a generic ${backend} review title with the model name`, () => {
    const comment = renderComment({
      review: "No material findings.",
      backend,
      model: "z-ai/glm-5.3-flash",
      headSha: "1234567890abcdef",
      actor: "reviewer",
      diffTruncated: false,
      originalDiffBytes: 10,
      marker: `<!-- ${backend} -->`,
    });
    assert.match(
      comment,
      new RegExp(
        `^## Code Review \\(\\x60z-ai/glm-5\\.3-flash\\x60 via ${label}\\)`,
      ),
    );
    assert.doesNotMatch(comment, /^## OpenCode review/);
    assert.equal(comment.trimEnd().split(/\r?\n/).at(-1), `<!-- ${backend} -->`);
  });
}
