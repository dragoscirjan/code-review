import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

describe('release workflow', () => {
  test('separates validated preflight from serialized least-privilege publication', async () => {
    const workflow = await readFile('.github/workflows/release.yml', 'utf8');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toContain('inputs:');
    expect(workflow).not.toContain('${{ inputs.');
    expect(workflow).not.toContain('--bump');
    expect(workflow).toContain('version: ${{ steps.plan.outputs.version }}');
    expect(workflow).toContain('permissions: {}');
    expect(workflow).toContain(
      "if: github.ref == 'refs/heads/main' && github.event.repository.default_branch == 'main'",
    );
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('environment: release');
    expect(workflow).toContain('contents: write');
    expect(workflow).toContain('mise run validate');
    expect(workflow).toContain('git status --porcelain=v1 --untracked-files=all -- dist');
    expect(workflow).toContain('dist/action-release.js publish');
    const actionUses = [...workflow.matchAll(/uses: ([^\s]+)@([^\s]+)/g)];
    expect(actionUses.length).toBeGreaterThan(0);
    for (const match of actionUses) expect(match[2]).toMatch(/^[0-9a-f]{40}$/);

    const preflight = workflow.slice(workflow.indexOf('  preflight:'), workflow.indexOf('  publish:'));
    expect(preflight).toContain('dist/action-release.js plan');
    expect(preflight).not.toContain('--version');

    const publish = workflow.slice(workflow.indexOf('  publish:'));
    expect(publish).not.toContain('npm ');
    expect(publish).not.toContain('mise ');
    expect(publish).not.toContain('src/');
    expect(publish).toContain('RELEASE_VERSION: ${{ needs.preflight.outputs.version }}');
    expect(publish).toContain('--version "$RELEASE_VERSION"');
    expect(publish).toContain('sparse-checkout: dist/action-release.js');
  });
});
