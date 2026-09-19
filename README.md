# OpenCode pull request review action

This repository contains a minimal GitHub Action that reviews a pull request with OpenCode and posts one managed review comment.

## POC scope

- GitHub Actions on GitHub-hosted runners.
- OpenCode as the only review backend.
- `opencode/big-pickle` as the only supported model.
- A personal access token supplied through `secrets.GH_TOKEN`.
- One summary comment. Repeated runs update the same comment.

The POC does not execute code from the pull request on the runner. It fetches a bounded diff through the GitHub API and includes it as untrusted prompt data inside a disposable container. The container has no host mounts. OpenCode cannot access the checkout, PAT, GitHub Actions environment, or host filesystem.

## Usage

Pin the action to an immutable commit from a trusted branch:

```yaml
name: OpenCode review

on:
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  review:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: dragoscirjan/code-review@REPLACE_WITH_COMMIT_SHA
        with:
          github-token: ${{ secrets.GH_TOKEN }}
          model: opencode/big-pickle
          prompt: |
            Focus on correctness, security, regressions, and missing tests.
```

Do not add `actions/checkout` to this `pull_request_target` job. Do not reference the pull request branch as the action revision. Both changes would give untrusted pull request code access to the personal access token.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `github-token` | Required | PAT used to read the pull request and publish the review. |
| `container-engine` | `podman` | Sandbox engine. Only `podman` and `docker` are accepted. |
| `model` | `opencode/big-pickle` | The only model accepted by the POC. |
| `prompt` | Correctness and security review | Trusted guidance added to the fixed review prompt. |
| `opencode-version` | `1.18.31` | Exact `opencode-ai` npm version run through `npx`. |
| `max-diff-bytes` | `120000` | Maximum UTF-8 diff bytes sent to OpenCode. |
| `timeout-seconds` | `600` | OpenCode process timeout. |

## Security model

- The workflow uses a trusted action commit and never checks out pull request code.
- The action accepts executable settings only from workflow inputs.
- The OpenCode package name is fixed. The version input must be an exact semantic version.
- OpenCode receives no GitHub token or GitHub Actions environment variables.
- OpenCode runs in a fixed digest-pinned container with a read-only root, no Linux capabilities, no added privileges, bounded processes, bounded memory, and no host mounts.
- Podman is the default because GitHub-hosted Ubuntu runners include it and it can run rootless. Docker is an allowlisted fallback.
- The free OpenCode model rejects custom permission configuration. Container isolation limits tool execution to a disposable environment with no host secrets or checkout.
- Pull request titles, bodies, and diffs are untrusted data.
- The action updates a comment only when its hidden marker and PAT actor ID both match.

The PAT determines the visible GitHub identity. The managed comment heading and hidden marker distinguish an automated review from a human comment made by the same account.

## Development

```bash
npm ci
npm run validate
```

`npm run validate` type-checks the source, runs tests, and rebuilds `dist/index.js`. Commit the bundled file with source changes.

See `CONTRIBUTING.md` for the development workflow.
