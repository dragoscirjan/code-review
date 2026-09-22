import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/code-review.yml', import.meta.url), 'utf8');

describe('dogfood code review workflow', () => {
  test('uses the contract-tested Pi backend without changing the provider or security boundary', () => {
    expect(workflow).toContain('on:\n  pull_request_target:');
    expect(workflow).toContain('permissions: {}');
    expect(workflow).toContain('uses: dragoscirjan/code-review@e3eaaef3c50fa96bcafdca898a9ec264979eb825');
    expect(workflow).toContain('          github-token: ${{ secrets.GH_TOKEN }}');
    expect(workflow).toContain('          container-engine: podman');
    expect(workflow).toMatch(/^\s*backend: pi\s*$/m);
    expect(workflow).not.toMatch(/^\s*backend: opencode\s*$/m);
    expect(workflow).toMatch(/^\s*reasoning: true\s*$/m);
    expect(workflow).toMatch(/^\s*specialist-token-budget: 2000000\s*$/m);
    expect(workflow).toContain('"api": "openai-completions"');
    expect(workflow).toContain('"baseUrl": "https://openrouter.ai/api/v1"');
    expect(workflow).toContain('"id": "z-ai/glm-5.3-flash"');
    expect(workflow).toContain('"contextWindow": 1048576');
    expect(workflow).toContain('"maxOutputTokens": 943718');
    expect(workflow).toContain('model-credentials: ${{ secrets.REVIEW_MODEL_CREDENTIALS }}');
  });
});
