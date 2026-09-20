# Pull request code review action

A GitHub Action that reviews pull requests with **OpenCode or Pi**, using a configured local/private or remote model endpoint, and publishes one managed summary per backend.

## OpenRouter setup / migration

The provider-specific `openrouter-api-key` and `model` inputs have been removed. There is no default provider, free-model fallback, or fixed-model allowlist.

1. Keep your existing **`GH_TOKEN`** GitHub Actions secret (the PAT used to publish comments).
2. Create a GitHub Actions repository secret named **`REVIEW_MODEL_CREDENTIALS`**. Its value is this JSON, replacing the placeholder with your existing OpenRouter API key:

   ```json
   { "review-provider": { "type": "bearer", "value": "YOUR_OPENROUTER_API_KEY" } }
   ```

   You can reuse the key currently stored in `OPENROUTER_API_KEY`; you do not need a new OpenRouter account or key. Never commit this JSON with a real token.

3. Use the workflow below, replacing `REPLACE_WITH_COMMIT_SHA` with an immutable trusted commit **containing this change**. Do not pass the new inputs to an older action revision.

```yaml
name: Code review
on:
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review]
permissions: {}
jobs:
  review:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    strategy:
      fail-fast: false
      matrix:
        backend: [opencode, pi]
    concurrency:
      group: code-review-${{ matrix.backend }}-${{ github.event.pull_request.number }}
      cancel-in-progress: true
    steps:
      - uses: dragoscirjan/code-review@REPLACE_WITH_COMMIT_SHA
        with:
          github-token: ${{ secrets.GH_TOKEN }}
          backend: ${{ matrix.backend }}
          model-config: |
            {
              "version": 1,
              "provider": {
                "api": "openai-completions",
                "baseUrl": "https://openrouter.ai/api/v1",
                "network": "remote",
                "credential": "review-provider"
              },
              "model": {
                "id": "z-ai/glm-5.3-flash",
                "contextWindow": 131072,
                "maxOutputTokens": 8192
              }
            }
          model-credentials: ${{ secrets.REVIEW_MODEL_CREDENTIALS }}
          prompt: Focus on correctness, security, regressions, and missing tests.
```

Do not add checkout or execute PR code in this `pull_request_target` job. Never reference the PR branch as the action revision or obtain configuration from PR-controlled content. The repository's own `.github/workflows/code-review.yml` remains pinned to its older trusted commit; update that pin and its inputs together after publishing a reviewed implementation commit. This change does not automatically deploy itself.

## Provider and model configuration

`model-config` is **our strict versioned schema**, not native Pi/OpenCode configuration. The action translates it into the selected harness's native configuration inside its disposable container, before launching the harness. Host/user configuration is never modified.

One invocation selects one provider/model. Use workflow matrices or separate invocations for more. Non-secret configuration can be inline workflow JSON or `${{ vars.REVIEW_MODEL_CONFIG }}`. Secrets belong only in `model-credentials`.

| Field                   | Meaning                                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`               | Required; `1`.                                                                                                                                           |
| `provider.api`          | Required; one of the protocols below.                                                                                                                    |
| `provider.baseUrl`      | Required API base URL; no URL credentials, query, fragment, or interpolation.                                                                            |
| `provider.network`      | Required; `remote` explicitly permits sending source to a public HTTPS provider; `private` explicitly permits a private-network endpoint (HTTP allowed). |
| `provider.credential`   | Optional reference into `model-credentials`; never an environment variable or token.                                                                     |
| `model.id`              | Required exact provider model ID, not a Pi/OpenCode selector.                                                                                            |
| `model.contextWindow`   | Positive integer, default `128000`, maximum `2000000`. Set to the model's actual capability.                                                             |
| `model.maxOutputTokens` | Positive integer, default `8192`, strictly below `contextWindow`.                                                                                        |

Unknown fields are rejected. Each JSON input is capped at 32,000 UTF-8 bytes; at most 16 credentials, with tokens limited to 8,192 printable non-whitespace ASCII characters. References/model IDs use letters, digits, `.`, `_`, `:`, `/`, `-` (maximum 200 characters, starting with a letter/digit).

### Protocols and authentication

| API                  | Base URL example                                                      | Credential type                                  |
| -------------------- | --------------------------------------------------------------------- | ------------------------------------------------ |
| `openai-completions` | `https://openrouter.ai/api/v1` or an OpenAI-compatible `/v1` endpoint | `bearer`, or omit credential for keyless servers |
| `openai-responses`   | `https://api.openai.com/v1`                                           | `bearer`, or keyless compatible server           |
| `anthropic-messages` | `https://api.anthropic.com` (**without `/v1`**)                       | Required `api-key` (Anthropic `x-api-key`)       |

For Anthropic, use `{"review-provider":{"type":"api-key","value":"YOUR_ANTHROPIC_API_KEY"}}` as the secret. The adapter accounts for the harnesses' different Anthropic base URL conventions. A bearer credential may be an API key or an already-issued access token; the action does not log in, refresh OAuth tokens, or run credential commands. Anthropic OAuth tokens containing `sk-ant-oat` are rejected because Pi would reinterpret them as OAuth rather than `x-api-key` authentication.

Support means the configured endpoint must implement the selected protocol. It does not imply support for every vendor's native authentication, reasoning options, or proprietary extensions. Google/Azure/Bedrock-specific protocols, arbitrary headers, plugins, shell commands, environment forwarding, raw harness config, and `model-config-file` are not supported in this milestone. Add explicit adapters rather than passing through arbitrary harness settings.

### Existing local/private models

For example, an existing Ollama server exposing its OpenAI-compatible endpoint:

```yaml
with:
  github-token: ${{ secrets.GH_TOKEN }}
  backend: pi
  model-config: |
    {
      "version": 1,
      "provider": {
        "api": "openai-completions",
        "baseUrl": "http://192.168.10.20:11434/v1",
        "network": "private"
      },
      "model": {"id": "qwen2.5-coder:7b", "contextWindow": 32768, "maxOutputTokens": 4096}
    }
```

Omit `model-credentials` for keyless servers. The harness adapters use a non-secret placeholder key for keyless endpoints because Pi and some SDKs require authentication configuration; the server must tolerate that placeholder Authorization header. No models are installed, downloaded, loaded, unloaded, or stopped by the action.

**Networking must already exist.** A GitHub-hosted runner cannot automatically reach your laptop or LAN. Configure trusted private connectivity first. Container `localhost` is not the runner host and is rejected. Podman supports `host.containers.internal`; Docker's `host.docker.internal` receives a host-gateway mapping only when explicitly selected with `network: private`. The server must listen on an address reachable from the container, with appropriate firewall/access controls. Host networking is never enabled. Self-hosted runner support and public-fork isolation remain out of scope.

## Inputs

| Input                  | Default                         | Description                                                                  |
| ---------------------- | ------------------------------- | ---------------------------------------------------------------------------- |
| `github-token`         | Required                        | PAT for PR API access and publication.                                       |
| `model-config`         | Required                        | Provider/model JSON above.                                                   |
| `model-credentials`    | `{}`                            | Secret JSON credential map; only the selected credential enters the backend. |
| `backend`              | `opencode`                      | `opencode` or `pi`.                                                          |
| `container-engine`     | `podman`                        | `podman` or validated `docker` fallback.                                     |
| `prompt`               | Correctness and security review | Additional trusted review guidance.                                          |
| `opencode-version`     | `1.18.31`                       | Exact npm package version.                                                   |
| `pi-version`           | `0.85.1`                        | Exact npm package version.                                                   |
| `code-indexer`         | `none`                          | `none`, `cgc` or `gitnexus`; exact base revision only.                       |
| `code-index-cache-key` | `code-review-index-v1`          | Cache key prefix.                                                            |
| `code-index-cache-ttl` | `24h`                           | Maximum cache age (`ms`, `s`, `m`, `h`, `d`).                                |
| `max-diff-bytes`       | `120000`                        | Maximum UTF-8 diff bytes.                                                    |
| `timeout-seconds`      | `600`                           | Backend timeout.                                                             |

Outputs: `comment-url`, `diff-truncated`, `code-indexer`, `code-index-cache-hit`.

## Security and limitations

- GitHub-hosted runners, GitHub PAT publication, summary comments only. Pi still uses its CLI for this milestone.
- No PR code execution. The diff and optional bounded base-index context are untrusted prompt data.
- The backend container is digest-pinned, mount-free, non-root, read-only, capability-dropped, resource-limited and denies added privileges. OpenCode denies all tools; Pi disables tools and resource discovery.
- Native harness configuration is generated in container tmpfs with restrictive permissions. Fixed provider naming avoids built-in provider auto-configuration. Native interpolation syntax in credentials is handled without executing commands or loading referenced files.
- GitHub credentials never enter the model container. Only the selected model credential is passed through environment—not arguments or prompt. Output is bounded, selected credentials are redacted, and raw provider errors are suppressed.
- `network` permission and DNS/address preflight checks are **not an egress firewall**. DNS can change after checking; harness SDKs control redirects. Trust the endpoint and its redirect behavior. npm/package code also has container network access and the selected credential. A credential-isolating model gateway with enforced egress is future work.
- Private HTTP is not encrypted. Prefer TLS and authenticated private endpoints.
- The POC still publishes Markdown rather than schema-validated structured findings. Tool denial does not eliminate prompt injection or guarantee finding correctness. Inline validation and a full result schema remain future work.
- Managed comments require both a backend-specific hidden marker and the authenticated PAT actor. Legacy OpenRouter markers migrate to provider-neutral markers without creating a new comment. PAT comments appear as the token's owner.

Optional indexing downloads only the base SHA archive and removes symlinks/non-regular files. CGC/GitNexus run on the host with a credential-stripped environment, which is **not OS isolation**. Archive size checks after extraction and transitive package dependencies retain the documented POC limitations. Index context is capped at 50 KB. Cache identity includes repository, base SHA, pinned indexer, platform and age; successful reads do not renew TTL. An unusable restore gets one clean rebuild. Cache service failures warn; explicitly selected indexer failures stop the review.

Design: [Provider-neutral configuration](https://github.com/dragoscirjan/code-review/wiki/Provider-neutral-model-configuration). Work item: [#12](https://github.com/dragoscirjan/code-review/issues/12).

## Development

```bash
npm ci
npm run validate
```

Validation type-checks, runs tests, and rebuilds the committed `dist/index.js`. Unit tests exercise schema/network policy, credential boundaries, both native config translations and the actual bootstrap code using controlled dependencies. Live checks are opt-in:

```bash
# Controlled model responses through real pinned harness containers; no provider secret:
CONTAINER_ENGINE=podman npm run test:models
CONTAINER_ENGINE=docker npm run test:models

# Live provider smoke test (optional, may incur provider charges):
OPENROUTER_API_KEY=... npm run test:integration
GITHUB_TOKEN=... CODE_INDEXER=cgc npm run test:indexers
GITHUB_TOKEN=... CODE_INDEXER=gitnexus npm run test:indexers
```

The live test environment variable is only a test convenience, not a restored action input. See `CONTRIBUTING.md`.
