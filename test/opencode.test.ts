import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOpenCodeCommand,
  OPENCODE_CONFIG_CONTENT,
  parseOpenCodeJson,
} from "../src/opencode";

test("extracts text events from OpenCode JSON output", () => {
  const output = [
    JSON.stringify({ type: "step_start" }),
    JSON.stringify({ type: "text", part: { text: "First" } }),
    JSON.stringify({ type: "text", part: { text: "Second" } }),
  ].join("\n");
  assert.equal(parseOpenCodeJson(output), "First\n\nSecond");
});

test("rejects malformed OpenCode output", () => {
  assert.throws(() => parseOpenCodeJson("not json"), /invalid JSON/);
  assert.throws(
    () => parseOpenCodeJson(JSON.stringify({ type: "step_finish" })),
    /no review text/,
  );
});

test("builds a pure OpenCode OpenRouter command", () => {
  const command = buildOpenCodeCommand({
    version: "1.18.31",
    model: "z-ai/glm-5.3-flash",
  });
  assert.deepEqual(command.slice(0, 3), [
    "npx",
    "--yes",
    "opencode-ai@1.18.31",
  ]);
  assert.ok(command.includes("--pure"));
  assert.ok(command.includes("openrouter/z-ai/glm-5.3-flash"));
  assert.deepEqual(JSON.parse(OPENCODE_CONFIG_CONTENT), {
    permission: { "*": "deny" },
  });
});
