# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

An AWS CDK construct library that provides `SecretWatcher`: a custom resource that reads the version of an SSM parameter or Secrets Manager secret at deploy time and exposes a hash of it, so that a resource taking the hash is updated only when the version changes. See `README.md` for usage and caveats.

- `src/secret-watcher.ts` — `WatchTarget`, `SecretWatcherProps` and `SecretWatcher`, the whole public API
- `src/handler/secret-watcher.ts` — the custom resource handler. projen's `bundle` task builds it into `assets/handler/secret-watcher/` with esbuild, and the construct loads it with `lambda.Code.fromAsset`. `@aws-sdk/*` stays external; the Lambda Node.js runtime provides it, so the SDK clients are dev dependencies for types only

## Language

**Everything committed to this repository is written in English**: code, comments, documentation, commit messages, issue and pull request titles and bodies.

The one exception is `docs/ai-output/` (see below), which is not committed and may be in Japanese.

## Research notes and drafts

Put investigation notes, research summaries, and scratch drafts under **`docs/ai-output/`**. That directory is gitignored, so anything there stays local. Japanese is fine there — it is working material, not a deliverable.

Do not commit research output to `docs/` or anywhere else in the tree. If a finding matters to someone reading the repository, distill it into `README.md`, a code comment, or an issue, in English.

## Project configuration

This project is managed by [projen](https://github.com/projen/projen). **Edit `.projenrc.ts`, never the generated files.** `package.json`, `tsconfig.json`, `.github/workflows/`, `.gitignore`, `mise.toml`, and others are regenerated on every synth and your edits will be lost. `.gitattributes` lists every generated file as `linguist-generated`.

`vite.config.ts` is not generated; edit it directly. It configures Vite+ (`vp`), which runs formatting (Oxfmt), linting (Oxlint + oxlint-plugin-awscdk), type checking (TypeScript 7 via tsgolint) and tests (Vitest). It reads `.gitattributes` to keep formatting and linting off projen's generated files.

Node.js and pnpm come from mise (`mise.toml`), not from `vp env`. Their versions are set in `.projenrc.ts`, so the workflows use the same ones.

```sh
mise install              # install Node.js and pnpm
pnpm install              # install dependencies
npx projen                # synthesize generated files from .projenrc.ts
npx projen bundle         # bundle the handler into assets/ (tests need it)
npx projen build          # bundle -> compile (jsii) -> docgen -> test -> package
npx projen test           # vp test run, then vp check
npx projen integ          # deploy test/integ.*.ts to AWS, assert, destroy
npx projen integ:destroy  # tear down a stack an interrupted integ run left behind
```

Run `npx projen build` before committing. It is the same pipeline CI runs. The unit tests synthesize the handler asset, so run `npx projen bundle` once before `vp test` on a fresh checkout.

CI installs with `--frozen-lockfile`, so commit `pnpm-lock.yaml` together with any dependency change. `pnpm-workspace.yaml` sets `minimumReleaseAge` to one day: a version published less than 24 hours ago cannot be installed. Wait it out rather than adding an exclusion.

## Verification

Cheapest first. Catch what you can before reaching a slower layer.

1. **`pnpm exec vp check`** (no AWS) — format, lint, type check. The oxlint-plugin-awscdk rules run in their `strict` form on `src/` and `test/`; `prevent-construct-id-collision` and `no-variable-construct-id` catch logical-ID breakage that compiles and synthesizes fine but replaces resources on deploy.
2. **`pnpm exec vp test run`** (no AWS) — unit tests. Write assertions only for what types, lint and synth cannot catch; do not re-assert configuration values the implementation already states.
3. **`npx projen integ`** (AWS) — deploys `test/integ.*.ts` in ap-northeast-1 with `--force`, runs the assertions, compares the template with the committed snapshot in `test/*.snapshot/`, and destroys the stack. It needs credentials for a sandbox account (for example `AWS_PROFILE=sandbox`); if they are missing or expired, stop and ask rather than logging in. Before a pull request, run it through `node .claude/review/review.mjs integ` (see below).

Layers 1 and 2 also run automatically. When a turn ends with uncommitted changes, the Stop hook in `.claude/settings.json` (`.claude/hooks/verify.mjs`) formats the changed files, lints the whole project, and runs the tests related to the changed files (all tests when a file outside `src/` and `test/` changed, or when nothing imports the changed source). On failure it sends the errors back and you keep fixing. It gives up after 3 retries, or as soon as the same errors (compared by `file:line:rule`) come back twice in a row; then stop and report what is left.

**Never update snapshots on your own** (`vp test -u`, integ-runner `--update-on-failed`, deleting a `test/*.snapshot/` directory). Report the diff instead; an agent that can update snapshots has switched the net off. A new integ test has no snapshot yet; integ-runner writes it on the first successful run, and that snapshot is committed, bundled assets included.

Integration test stacks must not set physical names, and must set `RemovalPolicy.DESTROY` explicitly.

## Pull requests

Open pull requests through the `review-pr` skill. It runs the integration test, then reviewer subagents (`general`, `cdk`, `security`, `script`) in a loop driven by `.claude/review/review.mjs`, which picks the reviewers from the changed paths and lines and decides when the loop ends. A PreToolUse hook blocks `gh pr create` (and its alias `gh pr new`, with flags anywhere in between) until the review has passed, the reviewed files are committed and pushed to `origin/<branch>`, and the last `review.mjs integ` run passed on exactly those files.

`review.mjs integ` records the result with the git tree of the working copy after the run, so any later change to a file invalidates it. A run that changes files outside `test/*.snapshot/` is recorded as failed.

The hook's `if` rules let Claude Code's own command parser decide which Bash calls reach the gate, so chained commands, `VAR=value` prefixes and wrappers such as `timeout` are covered. It is a guardrail against skipping the review or the integration test by accident, not a security boundary: `/usr/bin/gh pr create`, `bash -c '...'` and `gh api` calls that create a pull request are not caught, and pull requests opened outside Claude Code are not gated at all.

- Only findings at `medium` severity or above with `likely` confidence or above have to be fixed or disputed.
- A dispute needs evidence the reviewer can check. Only the reviewer can withdraw a finding.
- The loop aborts and hands the decision to you after 3 rounds, when the same file, reviewer and category come back in consecutive rounds, or when a maintained finding is disputed twice for the same reason. Do not restart an aborted review on your own.

Tests for the controller are in `test/harness/`.

## Version constraints

Two pins in `.projenrc.ts` are deliberate and load-bearing. Read this section before changing either. The weekly upgrade workflow excludes both, along with the packages that must move with them.

- **`typescriptVersion: '~6.0.0'`** — jsii 6 requires `typescript ~6.0`. Letting projen resolve `latest` breaks the compile. `jsii` and `jsii-rosetta` are held on the same line.
- **`cdkVersion: '2.224.0'`** — the handler runs on `Runtime.NODEJS_24_X`, which first shipped in aws-cdk-lib 2.224.0. This is the minimum the peer dependency accepts. `@aws-cdk/integ-tests-alpha` is released in lockstep with aws-cdk-lib and must stay on `2.224.0-alpha.0`.

## Comments

Keep comments short and few. The reference is [go-to-k/ecr-scan-verifier](https://github.com/go-to-k/ecr-scan-verifier).

- **Comment only what the code cannot say.** Examples: a service needs a permission, a value must match another value, a tool crashes on some input. Do not restate what a name, option or value already says.
- **One line, rarely two.** State the fact. Leave out the reasoning chain, the consequences and the alternatives you considered. Longer reasoning belongs in this file, the pull request, or an issue.
- **No comments on routine configuration.** In `.projenrc.ts` and `vite.config.ts`, an option such as `eslint: false` or `minimumReleaseAge: 1440` needs no comment. Comment a value only when it is a pin or a workaround that someone could reasonably "fix" back.
- **Short labels are fine for sections of a long function.** Examples: `// ECR permissions`, `// 1. Evaluate findings`.
- **Public API JSDoc is the exception.** jsii turns it into `API.md` and the docs for every language. Document every exported member, with `@default` for every optional prop, and add a `**Note**:` paragraph for behavior a user would not expect.

## jsii constraints

This library is compiled with jsii so it can be published to multiple languages. That rules out several TypeScript features in the public API:

- No literal types, union types, or tuples — use enums and plain arrays
- No mapped types with union keys — use struct interfaces or arrays
- No type derivation (`typeof x`, conditional types)
- CommonJS output only — no ESM, no `.ts` extensions in import paths, no `import.meta`
- Props interfaces (structs) must have all members `readonly`, and cannot hold methods or function-typed properties

Members marked `@internal` with a leading underscore (such as `WatchTarget._bind`) are outside the jsii API and may use any TypeScript type. When in doubt, check whether an equivalent shape exists in `aws-cdk-lib` itself.
