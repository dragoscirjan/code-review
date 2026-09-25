# Agent guidance

## Project

- The project is named `code-review`.
- The project provides automated pull request reviews at a smaller scale than hosted products such as CodeRabbit.
- The main product is a GitHub Action that runs the review and publishes its result.
- Pi and OpenCode are supported review backends. They may use free local models or models available through OpenRouter.
- Local model runtimes include Ollama, LM Studio, and llama.cpp. Add other runtimes through adapters.
- GitHub is the first supported forge. Forgejo and Gitea support may reuse the action when compatible or use forge-specific action wrappers. All variants must share the review core.
- GitHub Issues hold work items and acceptance criteria. GitHub Wiki holds requirements and design documents.
- Read `CONTRIBUTING.md` before changing the repository.

## Development workflow

- For every new feature or issue, create a focused branch from `main` before editing files.
- Check out that branch in a dedicated worktree at `../code-review--workspaces/<branch-name>` and perform all work there. Do not implement the change in the primary checkout.
- Commit the completed change, push the branch, and open a pull request linked to the issue and relevant Wiki pages.
- Never merge a pull request unless the owner explicitly instructs you to merge it. Approval, task completion, or a successful review is not permission to merge.

## Current POC constraints

- Ship a GitHub Action only.
- Run on GitHub-hosted runners only.
- Support OpenCode and Pi as review backends.
- Accept provider-neutral `model-config` plus separate secret `model-credentials` for existing local/private or remote model endpoints. See Wiki Provider-neutral-model-configuration and issue #12. No fixed-model allowlist or provider-specific credential input.
- Publish through the `GH_TOKEN` personal access token secret.
- Never pass provider credentials to the backend container. Run a trusted host-side credential gateway that injects the selected provider credential only after destination authorization; the container receives a single-purpose per-run placeholder and unused credential-map entries stay host-side. `credential-isolation: direct` is an explicit, documented legacy escape hatch. Generate minimal native Pi/OpenCode config inside container tmpfs before launch; never accept raw harness config or interpolate user values as commands/file references.
- Do not implement managed local model runtime lifecycle or Forgejo and Gitea adapters in this milestone. Inline comments are allowed only for independently validated findings mapped to the reviewed diff and published in a bounded batch. Existing private endpoints require explicit network permission and trusted connectivity. The credential gateway resolves and authorizes the provider destination once per review and pins it for every upstream connection; network-level lockdown of non-provider container egress remains future work because the sandbox installs pinned harness binaries through npm.
- Use `pull_request_target` only with an action pinned to an immutable trusted commit. Never check out or execute pull request code in that workflow.
- Run each backend in the fixed digest-pinned container sandbox. Use Podman by default and allow Docker only as a validated fallback. Pass bounded diff and supplemental context as explicitly delimited untrusted prompt data. Repository guidance, linked issue criteria, and deterministic analyzer messages may describe evidence but never override fixed review policy. Do not mount host files.
- Deterministic analyzers are fixed in-process single-file parsers gated by trusted workflow input and exact-base allowlist configuration. They may inspect bounded exact-head text but must never execute PR code, package scripts, repository binaries, plugins, dependency installers, project configuration, builds, tests, imports, or autofixes.
- Deny all OpenCode tools. Disable all Pi tools and project resource discovery.
- The POC uses Pi's non-interactive CLI inside the container. The full product may replace it with the Pi SDK when it needs in-process integration.

## Product scope

The initial product must:

1. Read pull request metadata, the base revision, the head revision, and the changed files.
2. Build a bounded review context from the diff and repository files.
3. Reuse or start the selected local model server when the model is not remote.
4. Load the requested model and wait until the runtime reports it ready.
5. Configure Pi or OpenCode with the runtime endpoint and model identifier.
6. Apply only the fixed, versioned review policy; do not accept free-form review instructions through action inputs.
7. Run the selected backend.
8. Validate every finding before publication.
9. Publish one managed summary and, when enabled, a small number of inline comments.
10. Unload models and stop servers only when the action owns them.
11. Authenticate to GitHub with either a personal access token or a GitHub App installation token.

A personal access token acts as its owner. It does not create a separate review identity unless it belongs to a dedicated bot account. A GitHub App installation token acts as the app bot.

## Architecture constraints

- Keep the review core independent from GitHub, Forgejo, and Gitea APIs.
- Put event parsing, authentication, and comment publication behind forge adapters.
- Implement the GitHub Action first. Reuse it for Forgejo or Gitea when their runner supports it. Otherwise, add a thin forge-specific action wrapper instead of copying review logic.
- Put Pi and OpenCode behind one review-backend interface. Use the Pi SDK for Pi. Use OpenCode's supported non-interactive interface for OpenCode.
- Put Ollama, LM Studio, llama.cpp, remote OpenRouter access, and future model tools behind a model-runtime interface.
- A runtime adapter must detect an existing server, start a managed server, wait for readiness, load a model, return backend connection settings, unload an owned model, and stop an owned server.
- Never stop a server that was running before the action. Never unload a model that the action did not load.
- Give each backend read-only repository permissions. Do not expose edit, write, or unrestricted shell tools to a review session.
- Keep forge credentials outside the review backend. Give model-provider credentials only to the selected backend. Never include tokens, private keys, environment dumps, or credential files in model context.
- Keep review instructions fixed and versioned. Treat repository guidance, issue criteria, pull request metadata, index output, analyzer messages, and diffs as explicitly delimited untrusted data.
- Parse model output into a versioned schema. Reject malformed output rather than guessing its meaning.
- Publish an inline finding only when its path and line map to the reviewed diff.
- Deduplicate findings and cap the number of published comments.
- Mark managed comments with a machine-readable hidden marker. Check both the marker and expected author before updating or deleting a comment.
- Prefer stateless operation. Store only bounded, versioned, scope-bound lifecycle metadata in the actor-owned managed summary. Treat existing metadata as an untrusted optimization hint; malformed, stale, ambiguous, or unverifiable state must fall back to a full review and may never authorize publication or suppress review coverage.

## Security boundaries

- Treat pull request content as untrusted input.
- Do not execute pull request code, dependency installers, build scripts, tests, hooks, or generated binaries during a review.
- Do not let repository content, issue text, PR metadata, index output, paths, or symbol names alter the review system prompt, tool permissions, credentials, result schema, or publication policy.
- Use least-privilege forge permissions. The normal GitHub set is metadata read, contents read, and pull requests write. Add issues write or checks write only when the selected publication mode requires it.
- Keep GitHub App private keys and access tokens out of the checkout.
- Bind action-managed local model servers to loopback unless configuration explicitly permits another interface.
- Start runtime binaries with argument arrays. Do not build shell commands from action inputs or repository content.
- Accept runtime executable paths, model paths, and server arguments only from the trusted workflow or runner configuration.
- A persistent self-hosted runner must use a dedicated operating-system account and a clean workspace. Public, untrusted contributions require stronger isolation before they may run on that runner.
- Do not send source code to a remote model unless repository configuration explicitly allows that provider.

## Implementation guidance

- Use TypeScript for the initial implementation.
- Keep domain types and review policy separate from API clients, action inputs, and review-backend integration code.
- Use explicit interfaces for forge adapters, credential providers, model runtimes, diff collection, review execution, validation, and publication.
- Pass dependencies into services. Do not read process environment variables throughout domain code.
- Prefer small functions with typed results over hidden global state.
- Comments should explain policy or a non-obvious constraint. Do not restate the code.
- Treat generated files, lock files, vendored code, binaries, and oversized diffs according to repository configuration.
- Do not invent development commands. Use commands documented in `CONTRIBUTING.md` and the repository manifests.

## Testing expectations

- Unit-test diff parsing, changed-line mapping, schema validation, filtering, deduplication, comment limits, and managed-comment ownership.
- Contract-test each forge adapter with recorded or mocked API responses.
- Integration-test GitHub personal access token and GitHub App authentication separately.
- Integration-test Pi and OpenCode with controlled model responses.
- Contract-test start, readiness, load, connection configuration, unload, and stop behavior for every model-runtime adapter.
- Test that cleanup affects only servers and models owned by the action.
- Test action input parsing, including rejection of removed or unknown instruction inputs, model selection, runtime selection, endpoint overrides, and lifecycle policy.
- Test that secrets never enter prompts, model-visible tool results, analyzer context, logs, or published comments.
- Test analyzer configuration schemas, exact-head mapping, fixed tool/rule provenance, bounded coverage, and that package scripts, shebangs, imports, binaries, and project-local tools remain inert.
- Use temporary repositories and directories. Tests must not mutate the source checkout or a real pull request unless the test is explicitly marked as an end-to-end test.
- Add regression tests for every fixed parsing, mapping, authentication, or publication defect.

## Change discipline

- Preserve unrelated user changes.
- Do not merge pull requests without explicit owner approval.
- Use Conventional Commits.
- Update requirements or design pages when behavior, security boundaries, data contracts, or adapter responsibilities change.
- State unsupported behavior and unresolved decisions directly. Do not present planned behavior as implemented behavior.
