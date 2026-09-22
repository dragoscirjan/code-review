import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/code-review.yml', import.meta.url), 'utf8');

describe('dogfood code review workflow', () => {
  test('uses the contract-tested Pi backend without changing the provider or security boundary', () => {
    expect(workflow).toContain('on:\n  pull_request_target:');
    expect(workflow).toContain('permissions: {}');
    expect(workflow).toContain('uses: dragoscirjan/code-review@f931037fb9dc59b9f989b500237fd5acd1f6930b');
    expect(workflow).toContain('          github-token: ${{ secrets.GH_TOKEN }}');
    expect(workflow).toContain('          container-engine: podman');
    expect(workflow).toMatch(/^\s*backend: pi\s*$/m);
    expect(workflow).not.toMatch(/^\s*backend: opencode\s*$/m);
    expect(workflow).toContain('"api": "openai-completions"');
    expect(workflow).toContain('"baseUrl": "https://openrouter.ai/api/v1"');
    expect(workflow).toContain('"id": "z-ai/glm-5.3-flash"');
    expect(workflow).toContain('model-credentials: ${{ secrets.REVIEW_MODEL_CREDENTIALS }}');
  });
});
