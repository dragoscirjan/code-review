# Pull request code review action

This repository contains a GitHub Action that reviews a pull request with OpenCode or Pi and posts a managed review comment.

## POC scope

- GitHub-hosted runners.
- OpenCode and Pi review backends.
- OpenRouter with `z-ai/glm-5.3-flash` as the only supported model.
- A personal access token supplied through `secrets.GH_TOKEN`.
- An OpenRouter key supplied through `secrets.OPENROUTER_API_KEY`.
- One managed comment per backend. Repeated runs update that backend's comment.

The action does not execute pull request code. It fetches a bounded diff through the GitHub API and sends the diff as untrusted prompt data to the selected backend. The disposable container has no host mounts. The review backend cannot access the checkout, PAT, GitHub Actions environment, or host filesystem.

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
    timeout-minutes: 15
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
- Pull request titles, bodies, and diffs are untrusted data.
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

The integration suite runs one review through OpenCode and one through Pi. See `CONTRIBUTING.md` for the development workflow.
