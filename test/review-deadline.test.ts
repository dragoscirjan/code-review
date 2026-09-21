import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { ModelConnection } from '../src/model';
import {
  runStructuredBackend,
  type BackendProcessOptions,
  type StructuredBackendRequest,
  type StructuredBackendRuntime,
} from '../src/review';

const connection: ModelConnection = {
  api: 'openai-completions',
  baseUrl: 'https://models.example.test/v1',
  network: 'remote',
  modelId: 'provider/model',
  contextWindow: 16_000,
  maxOutputTokens: 1_000,
};
const assistantOutput = `${JSON.stringify({ type: 'text', part: { text: 'accepted' } })}\n`;

function clock() {
  let value = 0;
  return {
    now: () => value,
    advance: (milliseconds: number) => {
      value += milliseconds;
    },
  };
}

function request(now: () => number, runtime: Partial<StructuredBackendRuntime>): StructuredBackendRequest<string> {
  return {
    backend: 'opencode',
    containerEngine: 'podman',
    connection,
    opencodeVersion: '1.18.31',
    piVersion: '0.85.1',
    timeoutMs: 100,
    deadline: { expiresAtMs: 100, now, cleanupReserveMs: 20 },
    environment: { RUNNER_TEMP: '/tmp' },
    prompt: 'Review this fixed test input.',
    parseAssistantText: (raw) => raw,
    runtime,
  };
}

function runtimeDefaults(events: string[]): StructuredBackendRuntime {
  return {
    validateEndpoint: async () => void events.push('endpoint'),
    createTemporaryRoot: async () => void events.push('root'),
    createWorkspace: async () => {
      events.push('workspace');
      return '/tmp/code-review-deadline';
    },
    removeWorkspace: async () => void events.push('workspace-cleanup'),
    runProcess: async () => {
      events.push('process');
      return { stdout: assistantOutput, stderr: '' };
    },
    removeContainer: async () => {
      events.push('container-cleanup');
      return { ok: true, details: '' };
    },
  };
}

test('production runner bounds slow endpoint resolution before setup starts', async () => {
  const time = clock();
  const events: string[] = [];
  const runtime = runtimeDefaults(events);
  runtime.validateEndpoint = async (_connection, timeoutMs) => {
    events.push(`endpoint:${timeoutMs}`);
    time.advance(101);
  };
  await assert.rejects(runStructuredBackend(request(time.now, runtime)), /aggregate deadline/u);
  assert.deepEqual(events, ['endpoint:100']);
});

test('production runner bounds slow setup and never starts a backend without cleanup reserve', async () => {
  const time = clock();
  const events: string[] = [];
  const runtime = runtimeDefaults(events);
  runtime.createWorkspace = async () => {
    events.push('workspace');
    time.advance(81);
    return '/tmp/code-review-deadline';
  };
  await assert.rejects(runStructuredBackend(request(time.now, runtime)), /deadline/u);
  assert.equal(events.includes('process'), false);
  assert.equal(events.includes('workspace-cleanup'), true);
});

test('production runner propagates one remaining budget through process, termination grace, and cleanup', async () => {
  const time = clock();
  const events: string[] = [];
  const runtime = runtimeDefaults(events);
  let processOptions: BackendProcessOptions | undefined;
  let cleanupTimeout = 0;
  runtime.validateEndpoint = async () => time.advance(5);
  runtime.createTemporaryRoot = async () => time.advance(5);
  runtime.createWorkspace = async () => {
    time.advance(5);
    return '/tmp/code-review-deadline';
  };
  runtime.runProcess = async (_command, _args, options) => {
    processOptions = options;
    time.advance(options.timeoutMs + options.killGraceMs);
    throw new Error('synthetic timeout');
  };
  runtime.removeContainer = async (_command, _name, _cwd, _env, timeoutMs) => {
    events.push('container-cleanup');
    cleanupTimeout = timeoutMs;
    time.advance(Math.max(1, timeoutMs - 1));
    return { ok: true, details: '' };
  };
  runtime.removeWorkspace = async () => void events.push('workspace-cleanup');

  await assert.rejects(runStructuredBackend(request(time.now, runtime)), /synthetic timeout/u);
  assert.ok(processOptions);
  assert.equal(processOptions.timeoutMs + processOptions.killGraceMs + 20, 85);
  assert.equal(cleanupTimeout, 15);
  assert.deepEqual(events, ['container-cleanup', 'workspace-cleanup']);
  assert.ok(time.now() <= 100);
});

test('production runner fails closed when successful output cannot finish cleanup in the aggregate deadline', async () => {
  const time = clock();
  const events: string[] = [];
  const runtime = runtimeDefaults(events);
  runtime.runProcess = async () => {
    events.push('process');
    time.advance(40);
    return { stdout: assistantOutput, stderr: '' };
  };
  runtime.removeWorkspace = async () => {
    events.push('workspace-cleanup');
    time.advance(61);
  };
  await assert.rejects(runStructuredBackend(request(time.now, runtime)), /workspace cleanup exceeded/u);
  assert.deepEqual(events, ['endpoint', 'root', 'workspace', 'process', 'workspace-cleanup']);
});
