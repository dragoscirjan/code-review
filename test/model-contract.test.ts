import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'vitest';
import type { ModelApi } from '../src/model';
import { runReview } from '../src/review';

const enabled = process.env.RUN_MODEL_CONTRACT === '1';
const answer = '{"version":1,"outcome":"clean","findings":[]}';

function stream(api: ModelApi): string {
  if (api === 'openai-completions') {
    return (
      [
        {
          id: 'chatcmpl-review',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'contract-model',
          choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }],
        },
        {
          id: 'chatcmpl-review',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'contract-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join('') + 'data: [DONE]\n\n'
    );
  }
  if (api === 'anthropic-messages') {
    return [
      {
        type: 'message_start',
        message: {
          id: 'msg_review',
          type: 'message',
          role: 'assistant',
          model: 'contract-model',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join('');
  }
  const item = {
    id: 'msg_review',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: answer, annotations: [] }],
  };
  const response = {
    id: 'resp_review',
    object: 'response',
    created_at: 1,
    model: 'contract-model',
    status: 'completed',
    output: [item],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
  return [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    {
      type: 'response.content_part.added',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: answer },
    { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: answer },
    { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ]
    .map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`)
    .join('');
}

for (const backend of ['opencode', 'pi'] as const) {
  for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages'] as const) {
    test(
      `${backend} uses native ${api} configuration against a controlled model in the production sandbox`,
      {
        skip: !enabled || Boolean(process.env.REVIEW_TEST_BACKEND && process.env.REVIEW_TEST_BACKEND !== backend),
        timeout: 600_000,
      },
      async () => {
        const credential = 'contract-token{file:/never-read}{env:GH_TOKEN}$NOT_EXPANDED';
        const received: {
          url: string;
          authorization: string | undefined;
          apiKey: string | string[] | undefined;
          body: string;
        }[] = [];
        const server = createServer(async (request, response) => {
          let body = '';
          for await (const chunk of request) body += String(chunk);
          received.push({
            url: request.url ?? '',
            authorization: request.headers.authorization,
            apiKey: request.headers['x-api-key'],
            body,
          });
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(stream(api));
        });
        await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
        try {
          const address = server.address();
          assert.ok(address && typeof address !== 'string');
          const engine = process.env.CONTAINER_ENGINE === 'docker' ? 'docker' : 'podman';
          const host = engine === 'docker' ? 'host.docker.internal' : 'host.containers.internal';
          const review = await runReview({
            backend,
            containerEngine: engine,
            connection: {
              api,
              baseUrl: `http://${host}:${address.port}${api === 'anthropic-messages' ? '' : '/v1'}`,
              network: 'private',
              modelId: 'contract-model',
              reasoning: true,
              contextWindow: 128000,
              maxOutputTokens: 8192,
              credential: { type: api === 'anthropic-messages' ? 'api-key' : 'bearer', value: credential },
            },
            credentialIsolation: 'gateway',
            opencodeVersion: '1.18.31',
            piVersion: '0.85.1',
            timeoutMs: 540_000,
            environment: { PATH: process.env.PATH, HOME: process.env.HOME, GH_TOKEN: 'forge-sentinel-never-send' },
            pullRequest: {
              owner: 'test',
              repository: 'test',
              number: 1,
              title: 'Test',
              body: '',
              author: 'test',
              baseSha: 'a',
              headSha: 'b',
              url: 'https://example.test/pr/1',
            },
            diff: { text: '+const value = 1;', originalBytes: 17, truncated: false },
          });
          assert.deepEqual(review, { version: 1, outcome: 'clean', findings: [] });
          assert.ok(received.length > 0);
          const endpoint =
            api === 'anthropic-messages'
              ? '/v1/messages'
              : api === 'openai-responses'
                ? '/v1/responses'
                : '/v1/chat/completions';
          for (const request of received) {
            assert.equal(request.url.split('?')[0], endpoint);
            assert.equal(JSON.parse(request.body).model, 'contract-model');
            assert.ok(!request.body.includes(credential));
            assert.ok(!request.body.includes('forge-sentinel-never-send'));
            if (api === 'anthropic-messages') assert.equal(request.apiKey, credential);
            else assert.equal(request.authorization, `Bearer ${credential}`);
          }
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        }
      },
    );
  }
}
