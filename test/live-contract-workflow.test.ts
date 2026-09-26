import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/live-contract.yml', import.meta.url), 'utf8');
const triggerBlock = workflow.slice(0, workflow.indexOf('jobs:'));
const liveJobStart = workflow.indexOf('  live-provider:');
const liveJob = workflow.slice(liveJobStart, workflow.indexOf('  triage:'));
const otherJobs = workflow.slice(0, liveJobStart);

describe('live contract drift workflow', () => {
  test('never runs for pull requests or untrusted revisions', () => {
    expect(triggerBlock).toContain('schedule:');
    expect(triggerBlock).toContain('workflow_dispatch:');
    expect(triggerBlock).not.toContain('pull_request');
    expect(triggerBlock).not.toContain('push:');
    expect(workflow).toMatch(/github\.event_name == 'workflow_dispatch'/);
  });

  test('exposes the provider credential only inside the bounded live provider job', () => {
    expect(workflow).toContain('permissions: {}');
    expect(workflow).not.toContain('${{ secrets.GH_TOKEN }}');
    expect(liveJob).toContain('REVIEW_EVALUATION_MODEL_CREDENTIALS: ${{ secrets.REVIEW_MODEL_CREDENTIALS }}');
    expect(otherJobs).not.toContain('REVIEW_MODEL_CREDENTIALS');
  });

  test('bounds every dimension with timeouts, pinned checkouts, and a strict concurrency group', () => {
    expect(workflow).toContain('group: live-contract-drift');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow.match(/timeout-minutes:/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(workflow.match(/persist-credentials: false/g)?.length ?? 0).toBe(3);
  });

  test('covers every supported backend, engine, and indexer dimension', () => {
    expect(workflow).toContain('backend: [opencode, pi]');
    expect(workflow).toContain('engine: [podman, docker]');
    expect(workflow).toContain('indexer: [cgc, gitnexus]');
    expect(workflow).toContain('npm run test:models');
    expect(workflow).toContain('npm run test:indexers');
    expect(workflow).toContain('npm run evaluation:live');
  });

  test('publishes only bounded aggregate diagnostics and an actionable triage summary', () => {
    expect(workflow).toContain('review-evaluation.json');
    expect(workflow).toContain('retention-days: 14');
    expect(workflow).toContain('Likely product regression');
    expect(workflow).toContain('Likely provider-side drift or outage');
    expect(workflow).toContain('Indexer tool drift');
    expect(workflow).toContain('GITHUB_STEP_SUMMARY');
    // Live evaluation runs with a fixed bounded budget: single pass, hard timeout.
    expect(workflow).toContain('REVIEW_EVALUATION_STRATEGY: single-pass');
    expect(workflow).toContain("REVIEW_EVALUATION_TIMEOUT_SECONDS: '600'");
  });
});
