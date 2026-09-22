import type { ModelConnection } from './model';
import type { ReviewBackend } from './review';

export function buildHarnessConfig(connection: ModelConnection, backend: ReviewBackend): object {
  if (backend === 'pi') {
    return {
      providers: {
        'review-provider': {
          api: connection.api,
          baseUrl: connection.baseUrl,
          // This fixed reference is resolved once by Pi, never taken from user input.
          apiKey: '$REVIEW_MODEL_TOKEN',
          models: [
            {
              id: connection.modelId,
              input: ['text'],
              reasoning: connection.reasoning === true,
              contextWindow: connection.contextWindow,
              maxTokens: connection.maxOutputTokens,
              ...(connection.api === 'openai-completions'
                ? {
                    compat: {
                      supportsDeveloperRole: false,
                      supportsReasoningEffort: false,
                      supportsStore: false,
                      maxTokensField: 'max_tokens',
                    },
                  }
                : {}),
            },
          ],
        },
      },
    };
  }
  const npm =
    connection.api === 'anthropic-messages'
      ? '@ai-sdk/anthropic'
      : connection.api === 'openai-responses'
        ? '@ai-sdk/openai'
        : '@ai-sdk/openai-compatible';
  return {
    permission: { '*': 'deny' },
    enabled_providers: ['review-provider'],
    model: 'review-provider/review-model',
    small_model: 'review-provider/review-model',
    share: 'disabled',
    provider: {
      'review-provider': {
        npm,
        options: { baseURL: connection.api === 'anthropic-messages' ? `${connection.baseUrl}/v1` : connection.baseUrl },
        models: {
          'review-model': {
            id: connection.modelId,
            name: 'Review model',
            limit: { context: connection.contextWindow, output: connection.maxOutputTokens },
            reasoning: connection.reasoning === true,
            tool_call: false,
          },
        },
      },
    },
  };
}

// Constant code, not a shell command assembled from configuration. The container
// writes native config into its own tmpfs; neither config nor secrets enter argv.
export const SANDBOX_BOOTSTRAP = `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
try {
  const config = JSON.parse(process.env.REVIEW_HARNESS_CONFIG);
  const command = JSON.parse(process.env.REVIEW_HARNESS_COMMAND);
  const backend = process.env.REVIEW_BACKEND;
  fs.mkdirSync('/tmp/home', { recursive: true, mode: 0o700 });
  fs.mkdirSync('/tmp/review-config', { recursive: true, mode: 0o700 });
  if (backend === 'pi') {
    process.env.PI_CODING_AGENT_DIR = '/tmp/review-config';
    process.env.REVIEW_MODEL_TOKEN ||= 'keyless-local-model';
    fs.writeFileSync('/tmp/review-config/models.json', JSON.stringify(config), { mode: 0o600 });
  } else {
    // The OpenAI Responses SDK also requires a key even for keyless servers.
    config.provider['review-provider'].options.apiKey = process.env.REVIEW_MODEL_TOKEN || 'keyless-local-model';
    // OpenCode expands {env:...} and {file:...} BEFORE parsing JSON. Escape
    // opening braces inside strings (including tokens), not object delimiters.
    const encoded = JSON.stringify(config).replace(/"(?:[^"\\\\]|\\\\.)*"/g,
      value => value.replaceAll('{', '\\\\u007b'));
    fs.writeFileSync('/tmp/review-config/opencode.json', encoded, { mode: 0o600 });
    process.env.OPENCODE_CONFIG = '/tmp/review-config/opencode.json';
    delete process.env.REVIEW_MODEL_TOKEN;
  }
  delete process.env.REVIEW_HARNESS_CONFIG;
  delete process.env.REVIEW_HARNESS_COMMAND;
  delete process.env.REVIEW_BACKEND;
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: process.env });
  child.on('error', () => { console.error('Unable to start review harness'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code === 0 ? 0 : 1; });
} catch {
  console.error('Unable to prepare review harness configuration');
  process.exitCode = 1;
}
`;
