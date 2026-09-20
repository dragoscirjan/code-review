# Pull request code review action

This repository contains a GitHub Action that reviews a pull request with OpenCode or Pi and posts a managed review comment.

## POC scope

- GitHub-hosted runners.
- OpenCode and Pi review backends.
- OpenRouter with `z-ai/glm-5.3-flash` as the only supported model.
- A personal access token supplied through `secrets.GH_TOKEN`.
- An OpenRouter key supplied through `secrets.OPENROUTER_API_KEY`.
- Optional CodeGraphContext or GitNexus indexing of the pull request base revision.
- One managed comment per backend. Repeated runs update that backend's comment.

The action does not execute pull request code. It fetches a bounded diff through the GitHub API and sends the diff as untrusted prompt data to the selected backend. When code indexing is enabled, the action downloads the exact base revision, removes symlinks and unsupported file types, installs the selected indexer, and passes bounded query results to the reviewer. It never indexes the pull request head.

The disposable model container has no host mounts. The review backend cannot access the source snapshot, index database, PAT, GitHub Actions environment, or host filesystem.

## Usage

Pin the action to an immutable commit from a trusted branch. This matrix runs both POC backends and produces two managed comments.

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
          openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
          backend: ${{ matrix.backend }}
          model: z-ai/glm-5.3-flash
          code-indexer: gitnexus
          code-index-cache-key: code-review-index-v1
          code-index-cache-ttl: 24h
          prompt: |
            Focus on correctness, security, regressions, and missing tests.
```

Do not add `actions/checkout` to this `pull_request_target` job. Do not reference the pull request branch as the action revision. Either change would give untrusted pull request code access to the PAT and model-provider credential.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `github-token` | Required | PAT used to read the pull request and publish the review. |
| `openrouter-api-key` | Required | OpenRouter key passed only to the selected backend container. |
| `backend` | `opencode` | Review backend. Accepted values are `opencode` and `pi`. |
| `container-engine` | `podman` | Sandbox engine. Accepted values are `podman` and `docker`. |
| `model` | `z-ai/glm-5.3-flash` | The only model accepted by the POC. |
| `prompt` | Correctness and security review | Trusted guidance added to the fixed review prompt. |
| `opencode-version` | `1.18.31` | Exact `opencode-ai` npm version. |
| `pi-version` | `0.85.1` | Exact `@earendil-works/pi-coding-agent` npm version. |
| `code-indexer` | `none` | Base-revision indexer. Accepted values are `none`, `cgc`, and `gitnexus`. |
| `code-index-cache-key` | `code-review-index-v1` | GitHub Actions cache key prefix for the index database. |
| `code-index-cache-ttl` | `24h` | Maximum cache age. Accepted units are `ms`, `s`, `m`, `h`, and `d`. |
| `max-diff-bytes` | `120000` | Maximum UTF-8 diff bytes sent to the backend. |
| `timeout-seconds` | `600` | Backend process timeout. |

## Security model

- The workflow uses a trusted action commit and never checks out pull request code.
- The action accepts executable settings only from trusted workflow inputs.
- Backend package names are fixed. Version inputs must use exact semantic versions.
- The GitHub PAT never enters the review container.
- The OpenRouter key enters the selected container through its environment. The action does not place it in process arguments, prompts, logs, or comments.
- OpenCode runs with `--pure` and a wildcard permission denial.
- Pi runs with all tools, extensions, skills, prompt templates, context files, and sessions disabled.
- Both backends run in a digest-pinned container with a read-only root, no Linux capabilities, no added privileges, resource limits, and no host mounts.
- Pull request titles, bodies, diffs, and index query results are untrusted data.
- CGC and GitNexus index only the exact base SHA. The action does not index the pull request head.
- Indexer processes receive a small environment allowlist without GitHub or model-provider credentials.
- Cache entries include the cache schema, repository, base SHA, indexer version, operating system, architecture, and creation time. The action deletes stale or mismatched restores. Successful hits are not re-saved, so cache reads cannot renew the TTL. It retries once with an empty database if a restored index cannot be queried, then saves the rebuild under a new generation key.
- Each backend uses a separate hidden marker. The action also checks the PAT actor ID before updating a comment.
- The first OpenCode run after an upgrade recognizes the previous POC marker and updates that comment to the new format.

The PAT determines the visible GitHub identity. The heading identifies the model and backend, for example `Code Review (z-ai/glm-5.3-flash via Pi)`.

## Development

```bash
npm ci
npm run validate
```

`npm run validate` type-checks the source, runs unit tests, and rebuilds `dist/index.js`. Commit the bundled file with source changes.

Run the two live OpenRouter checks only when the provider key is available:

```bash
OPENROUTER_API_KEY=... npm run test:integration
```

The integration suite runs one review through OpenCode and one through Pi. Run live indexer checks with:

```bash
GITHUB_TOKEN=... CODE_INDEXER=cgc npm run test:indexers
GITHUB_TOKEN=... CODE_INDEXER=gitnexus npm run test:indexers
```

These checks install the pinned indexer and index a real repository archive. See `CONTRIBUTING.md` for the development workflow.
