# ci-assistant-action

[![GitHub license](https://img.shields.io/badge/license-Apache%20License%202.0-blue.svg?style=flat)](https://www.apache.org/licenses/LICENSE-2.0)
[![codecov](https://codecov.io/gh/phorus-group/ci-assistant-action/branch/main/graph/badge.svg)](https://codecov.io/gh/phorus-group/ci-assistant-action)

GitHub Action that watches your CI/CD pipelines and uses [Claude Code](https://docs.anthropic.com/en/docs/build-with-claude/claude-code)
to analyze failures, suggest fixes via PR comments, and post summaries to Slack. Also works as
on-demand code assistance on any PR via `/ci-assistant suggest`, even without pipeline failures.
Interact through PR comment commands to accept, refine, or request alternative fixes.

### Notes

> The project runs a vulnerability analysis pipeline regularly,
> any found vulnerabilities will be fixed as soon as possible.

> The project dependencies are regularly updated by [Renovate](https://github.com/phorus-group/renovate).

## Table of contents

- [Getting started](#getting-started)
  - [Usage overview](#usage-overview)
  - [Prerequisites](#prerequisites)
  - [Quick start with the reusable workflow](#quick-start-with-the-reusable-workflow)
  - [Quick start standalone](#quick-start-standalone)
  - [Custom bot identity](#custom-bot-identity)
- [Features](#features)
- [Modes](#modes)
- [How it works](#how-it-works)
  - [PR branch failure (auto-fix)](#pr-branch-failure-auto-fix)
  - [Branch failure without a PR](#branch-failure-without-a-pr)
  - [Tag failure](#tag-failure)
  - [On-demand assistance (suggest)](#on-demand-assistance-suggest)
  - [Manual trigger (workflow_dispatch)](#manual-trigger-workflow_dispatch)
  - [Cleanup](#cleanup)
- [Retry loop and fix selection](#retry-loop-and-fix-selection)
  - [Retry behavior](#retry-behavior)
  - [Fix selection ranking](#fix-selection-ranking)
- [Confidence scoring](#confidence-scoring)
  - [Status categories](#status-categories)
  - [How confidence is parsed](#how-confidence-is-parsed)
  - [Non-code detection](#non-code-detection)
- [Commands reference](#commands-reference)
  - [User commands](#user-commands)
  - [Admin commands](#admin-commands)
  - [Unknown and invalid commands](#unknown-and-invalid-commands)
- [State machine](#state-machine)
  - [States](#states)
  - [Transitions](#transitions)
  - [State reset on new commit](#state-reset-on-new-commit)
- [Command limits](#command-limits)
  - [Default limits](#default-limits)
  - [Limit values](#limit-values)
  - [Limit reset behavior](#limit-reset-behavior)
  - [Admin limit overrides](#admin-limit-overrides)
- [Authentication](#authentication)
  - [Claude Code (OAuth vs API key)](#claude-code-oauth-vs-api-key)
  - [GitHub token](#github-token)
- [Customizing prompts](#customizing-prompts)
  - [Prompt templates](#prompt-templates)
  - [Built-in defaults](#built-in-defaults)
  - [Available placeholders](#available-placeholders)
- [Inputs reference](#inputs-reference)
- [Outputs reference](#outputs-reference)
- [Environment variables](#environment-variables)
- [Slack integration](#slack-integration)
  - [Message types](#message-types)
  - [Block truncation](#block-truncation)
- [Security](#security)
  - [Prompt injection protection](#prompt-injection-protection)
  - [Meta comment integrity](#meta-comment-integrity)
  - [User banning](#user-banning)
  - [Fork safety and bot filtering](#fork-safety-and-bot-filtering)
- [Git ref storage](#git-ref-storage)
  - [How refs work](#how-refs-work)
  - [First fix on ci-assistant PRs](#first-fix-on-ci-assistant-prs)
  - [Accept flow (cherry-pick)](#accept-flow-cherry-pick)
  - [Ref cleanup](#ref-cleanup)
- [PR comment format](#pr-comment-format)
  - [Suggestion comment](#suggestion-comment)
  - [Non-code comment](#non-code-comment)
  - [Gave-up comment](#gave-up-comment)
  - [Tag failure note](#tag-failure-note)
  - [Pushed-directly note](#pushed-directly-note)
- [Failure log handling](#failure-log-handling)
- [Non-code failures](#non-code-failures)
- [Fix ID format](#fix-id-format)
- [GitHub permissions](#github-permissions)
- [Concurrency](#concurrency)
- [Examples](#examples)
  - [Gradle project](#gradle-project)
  - [Node project](#node-project)
  - [Custom workflow (no reusable workflow)](#custom-workflow-no-reusable-workflow)
- [Building and contributing](#building-and-contributing)
- [Authors and acknowledgment](#authors-and-acknowledgment)

***

## Getting started

### Usage overview

A quick walkthrough of what CI Assistant can do. Each scenario links to a deeper section for full details.

- **Your pipeline fails.** CI Assistant automatically reads the logs, reproduces the error, and posts a fix suggestion on your PR. See [How it works](#how-it-works).
- **Accept the fix.** Post `/ci-assistant accept` to cherry-pick the suggestion onto your branch.
- **Ask for an alternative.** Post `/ci-assistant alternative` and Claude tries a fundamentally different approach.
- **Ask for an explanation.** Post `/ci-assistant explain` for a walkthrough of the fix, or `/ci-assistant explain -p "your question"` to ask anything about the code. Works on any PR, even without a prior failure.
- **Request changes on demand.** Post `/ci-assistant suggest add tests for the UserService` on any PR, even without a prior failure.
- **Retry when CI Assistant gives up.** Post `/ci-assistant retry` to run the analysis from scratch, or `/ci-assistant suggest the issue is in the migration` to provide additional context.
- **Check usage and get help.** Post `/ci-assistant limits` or `/ci-assistant help`.
- **Admin commands.** Admins can adjust limits, override the Claude model, start fresh on a PR, and unban users. See [Admin commands](#admin-commands).

### Prerequisites

- **Claude Code authentication**, one of:
  - `claude-code-oauth-token` from `claude setup-token`, uses your subscription quota, recommended
  - `anthropic-api-key` as a pay-per-use fallback
- **GitHub repository** with Actions enabled
- **GitHub token** with write access to contents, pull-requests, and issues, plus read access to actions. The built-in `GITHUB_TOKEN` works out of the box.

### Quick start with the reusable workflow

CI Assistant is set up with two workflow files. The first adds a `ci-assistant` job to your existing default workflow so it runs automatically when the pipeline fails. The second handles interactive commands, scheduled cleanup, and manual triggers.

**1. Add to your default workflow** (`.github/workflows/default.yml`):

```yaml
jobs:
  default-workflow:
    uses: phorus-group/workflows/.github/workflows/back.lib.gradle.yml@main
    # ... your existing inputs and secrets ...

  ci-assistant:
    needs: [default-workflow]
    if: ${{ failure() }}
    uses: phorus-group/workflows/.github/workflows/ci-assistant.yml@main
    with:
      java-version: "21"
      slack-failure-channel: "YOUR_CHANNEL_ID"
      admin-users: "your-username"
    secrets:
      claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      slack-bot-token: ${{ secrets.SLACK_BOT_TOKEN }}
      # Optional: GitHub App for custom bot identity
      # github-app-private-key: ${{ secrets.CI_ASSISTANT_PRIVATE_KEY }}
```

**2. Create `.github/workflows/ci-assistant.yml`** for commands, cleanup, and manual triggers:

```yaml
name: "CI Assistant"

on:
  issue_comment:
    types: [created]
  schedule:
    - cron: "0 6 * * 1"
  workflow_dispatch:
    inputs:
      run-id:
        description: "Failed run ID to analyze"
        required: true

jobs:
  ci-assistant:
    uses: phorus-group/workflows/.github/workflows/ci-assistant.yml@main
    with:
      java-version: "21"
      slack-failure-channel: "YOUR_CHANNEL_ID"
      admin-users: "your-username"
    secrets:
      claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      slack-bot-token: ${{ secrets.SLACK_BOT_TOKEN }}
```

Set `java-version` or `node-version` so Claude can reproduce errors and run your project's tests. Leave both out if your project needs neither. See the [reusable workflow inputs](https://github.com/phorus-group/workflows) for all available options.

> **Note:** Using a standalone `workflow_run` trigger (`types: [completed]`) instead of embedding in the default workflow also works but creates a visible skipped workflow run on every successful pipeline. The embedded approach avoids this.

### Quick start standalone

If you cannot use the reusable workflow, call the action directly. See the [custom workflow example](#custom-workflow-no-reusable-workflow) for a complete standalone setup with all three triggers.

### Custom bot identity

By default, comments and commits appear as `github-actions[bot]`. For a custom identity like `CI Assistant[bot]`:

1. [Create a GitHub App](https://docs.github.com/en/apps/creating-github-apps) with the following repository permissions:
   - **Contents: Read & Write** for pushing fix branches, creating/deleting git refs, and cherry-picking accepted fixes
   - **Issues: Read & Write** for posting and updating PR comments (the GitHub API serves PR comments through the Issues API)
   - **Pull requests: Read & Write** for creating fix PRs on branch failures, closing stale `ci-assistant/` PRs during cleanup, and reading PR metadata
   - **Actions: Read-only** for downloading failure logs from workflow runs
2. Install the app on your organization or repository
3. Store the **App ID** and **Private Key** as organization secrets (`CI_ASSISTANT_APP_ID` and `CI_ASSISTANT_PRIVATE_KEY`)
4. Pass them to the reusable workflow or use [`actions/create-github-app-token`](https://github.com/actions/create-github-app-token) to generate a token when calling the action directly:

```yaml
- uses: actions/create-github-app-token@v1
  id: app-token
  with:
    app-id: ${{ secrets.CI_ASSISTANT_APP_ID }}
    private-key: ${{ secrets.CI_ASSISTANT_PRIVATE_KEY }}

- uses: phorus-group/ci-assistant-action@v1
  with:
    github-token: ${{ steps.app-token.outputs.token }}
```

GitHub Apps are free (no seat cost). The app identity shows on all comments and commits, and the meta comment integrity check uses this identity to verify ownership.

## Features

- Pipeline failure analysis and fix suggestions via Claude Code CLI
- Interactive PR comment commands: `accept`, `alternative`, `suggest`, `retry`, `explain`, `help`, `limits`
- Admin commands for limit overrides, model selection, state management, and user banning
- Confidence status categories with percentage scoring
- Retry loop with context passing between attempts, working directory restore, and best-fix selection
- On-demand code assistance via `/ci-assistant suggest` on any PR, even without pipeline failures
- Non-code failure detection for infrastructure, runner, network, OOM, and flaky test issues
- Customizable prompt templates with `{{PLACEHOLDER}}` variables
- Slack integration with live updates across workflow runs and self-truncating blocks
- Prompt injection detection with automatic per-PR user banning
- Git ref storage for fix suggestions with invisible refs and cherry-pick on accept
- Configurable per-command limits plus a general total limit, with admin overrides
- State machine governing which commands are valid at any point
- State reset on new commit to keep limits fresh while preserving anti-abuse totals
- Works with Claude OAuth token or API key, with automatic fallback
- Custom bot identity via GitHub App at no additional cost
- Scheduled cleanup of stale `ci-assistant/` PRs and orphaned refs
- Tag failure handling with automatic source branch resolution
- Fork safety and bot comment filtering to prevent infinite loops
- Multiple operating modes: `auto-fix`, `command`, `manual`, `cleanup`

## Modes

The `mode` input controls which flow the action executes:

| Mode | Trigger | What it does |
|---|---|---|
| `auto-fix` | `workflow_run` with `conclusion == 'failure'` | Downloads failure logs, runs Claude, posts fix suggestion |
| `command` | `issue_comment` starting with `/ci-assistant` | Parses the command, executes it, updates meta |
| `manual` | `workflow_dispatch` with a run ID | Same as auto-fix but fetches branch/SHA from the provided run ID |
| `cleanup` | `schedule` (weekly) | Closes stale ci-assistant PRs, cleans orphaned refs, resets PR state |

`cleanup` mode does not require Claude authentication (only a GitHub token). All other modes install the Claude Code CLI and validate auth before proceeding.

## How it works

### PR branch failure (auto-fix)

When a pipeline fails on a PR branch, the action downloads the failure logs, runs Claude Code to analyze, reproduce, and fix the error, then posts a suggestion as a PR comment. The fix is not pushed to the branch until the user runs `/ci-assistant accept`.

<details>
<summary>Detailed flow</summary>

1. The action installs Claude Code CLI via `npm install -g @anthropic-ai/claude-code`
2. Auth is validated (OAuth token tested, API key as fallback)
3. Failure logs are downloaded from the GitHub API (failed jobs only, truncated to last 100KB if larger)
4. If the PR has a prior CI Assistant meta comment and the commit SHA changed since the last analysis, per-command limits and fix history are reset (the general total limit persists)
5. Claude Code runs with the failure logs, reproducing the error, implementing a fix, and running tests
6. If the first attempt does not produce a verified fix, the action retries with context about what previous attempts tried (see [Retry loop](#retry-loop-and-fix-selection))
7. The best fix across all attempts is selected based on confidence ranking
8. If a code fix was found, it is stored as an invisible git ref (`refs/ci-assistant/<pr>/<fix-id>`)
9. A PR comment is posted with the diff, confidence score, and available commands
10. Slack is updated (if configured)
11. The meta comment is written/updated with the current state

</details>

### Branch failure without a PR

When a branch like `main` or `release/1.0` fails and has no open PR, the action runs the same analysis. If a code fix is found, it creates a `ci-assistant/<branch>` PR with the fix committed directly. If no code fix is produced, no PR is created and the analysis goes to Slack only.

<details>
<summary>Detailed flow</summary>

1. Same analysis as the PR failure flow above
2. If Claude produces a **code fix**: the action creates a `ci-assistant/<branch>` branch from the failing commit SHA, commits the fix directly, pushes, and opens a PR targeting the failed branch. The suggestion comment notes that the fix is already on the branch and merging the PR applies it.
3. If the same branch fails again later (existing `ci-assistant/` PR): subsequent fixes are posted as comments on the existing PR, stored as refs, and require `/ci-assistant accept` to apply.
4. If Claude **cannot produce a code fix** (non-code issue or gave up): no PR is created. A branch with no code changes serves no purpose. The analysis is reported via Slack only.

When the base branch pipeline recovers, the scheduled cleanup closes the `ci-assistant/` PR, deletes the branch, and cleans up all fix refs for that PR.

</details>

### Tag failure

When a tag pipeline fails (for example, `v1.0.0`), the action resolves the tag's source branch and opens a fix PR targeting that branch. If the source branch cannot be determined, no PR is created to avoid targeting the wrong branch.

<details>
<summary>Detailed flow</summary>

1. The action detects the failure is for a tag by checking the GitHub API (`git/ref/tags/<name>`)
2. It resolves the tag's source branch by running `git fetch --unshallow` (to get full history in shallow clones) followed by `git branch -r --contains refs/tags/<tag>`. Branches starting with `ci-assistant/` and `HEAD` are filtered out.
3. If the source branch is resolved: a `ci-assistant/<tag>` PR is opened targeting that source branch. The PR body and suggestion comment include a note: "After merging this fix, create a new tag from `<source-branch>`."
4. If the source branch cannot be determined: no PR is created (to avoid targeting the wrong branch and potentially breaking production). A Slack warning is posted explaining the situation.

</details>

### On-demand assistance (suggest)

`/ci-assistant suggest <text>` works on any PR in any state, even without a pipeline failure:

- The user's text is passed to Claude as context instead of failure logs
- The `suggestPrompt` template is used (with `{{USER_CONTEXT}}` and `{{FAILURE_LOGS_IF_AVAILABLE}}`)
- Same suggestion, ref storage, and accept flow applies
- Useful for requests like "add tests for the UserService", "add error handling to the parser", "refactor this function"
- If the command produces a fix, state transitions to `active`. If it fails, state transitions to `gave-up`.

### Manual trigger (workflow_dispatch)

The `manual` mode allows analyzing a specific failed run by ID:

1. The user provides a workflow run ID via `workflow_dispatch`
2. The action fetches branch name and commit SHA from the run info via the GitHub API
3. From that point, it follows the same flow as `auto-fix`

This is useful for re-analyzing failures after the `workflow_run` event has already fired, or for debugging.

### Cleanup

Cleanup runs in two ways: orphaned ref cleanup runs at the start of every CI Assistant invocation, and full cleanup runs on a weekly schedule.

<details>
<summary>Detailed flow</summary>

**Per-invocation (automatic):** orphaned refs are cleaned at the start of every auto-fix, command, or manual run. This removes refs for PRs that have been closed or merged.

**Scheduled (weekly):** full cleanup runs via the `schedule` trigger. This handles:

1. **Closes stale `ci-assistant/` PRs**: finds open PRs with head branch `ci-assistant/<branch>` and checks if the base branch pipeline is now passing. For each recovered branch: posts a closing comment, closes the PR, deletes the `ci-assistant/<branch>` branch (via `refs/heads/`), and deletes all fix refs (`refs/ci-assistant/<pr>/`). Updates Slack if a prior message exists.
2. **Cleans up orphaned refs**: scans all `refs/ci-assistant/<pr>/` refs, checks whether each PR is closed or merged, and deletes refs for closed PRs.

CI Assistant state on regular PRs (meta comments) is not reset during cleanup. State freshness is handled by the auto-fix flow, which resets per-command counters and fix history when a new commit is detected.

</details>

## Retry loop and fix selection

### Retry behavior

Each auto-fix or command-triggered fix runs up to `max-retries` attempts (default: 3). Each attempt gets a fresh `max-turns` budget (default: 50 Claude conversation turns, use `-1` for unlimited). The working directory is reset between attempts, and context about what previous attempts tried is passed to subsequent ones. The loop stops early when a strong fix is found: either reproduced and verified, or tests pass with ≥70% confidence (covers cases like vulnerability fixes where the error can't be reproduced locally).

<details>
<summary>Detailed flow</summary>

1. **First attempt**: uses `autoFixPrompt` (or the command-specific prompt for suggest/alternative) with failure logs, repo, branch, and SHA context
2. **Working directory reset**: before each subsequent attempt, `git checkout -- .` and `git clean -fd` restore a clean state
3. **Subsequent attempts**: use `retryPrompt` which includes what each previous attempt tried and why it still failed
4. **Confidence prompt**: appended to every attempt, asking Claude to output `CONFIDENCE_PERCENT: <number>`
5. **Early exit**: the loop stops immediately if an attempt achieves `REPRODUCED_AND_VERIFIED`, or `NOT_REPRODUCED_TESTS_PASS` with ≥70% confidence
6. **Working directory restore**: after the loop, if the best attempt was not the last one, the action resets the working directory and re-applies the best attempt's diff via `git apply`
7. **Diff capture**: after each attempt, all changes (including new files) are captured via `git add -A` + `git diff --staged`, then unstaged for the next attempt

</details>

### Fix selection ranking

When no attempt achieves the ideal result, the action ranks all attempts:

1. **Reproduced and verified** (best): error reproduced, fix applied, tests pass
2. **Not reproduced but tests pass**: could not reproduce the error, but the fix seems reasonable and all tests pass
3. **Reproduced but tests still fail**: error reproduced, fix applied, but tests still fail
4. **Neither reproduced nor verified**: analysis-only fix based on log inspection
5. **Non-code**: failure is not code-related
6. **Gave up** (worst): no reasonable fix to suggest

Among attempts with the same status tier, the one with the higher confidence percentage wins. Attempts with diffs (actual code changes) are always preferred over attempts without diffs.

## Confidence scoring

### Status categories

| Status | Icon | Label | Meaning |
|---|---|---|---|
| Reproduced and verified | :green_circle: | "Reproduced and verified" | Error reproduced, fix applied, tests pass |
| Not reproduced, tests pass | :yellow_circle: | "Fix suggested but could not be reproduced" | Could not reproduce, but fix and tests pass |
| Reproduced, tests fail | :orange_circle: | "Fix suggested but could not be verified" | Error reproduced, fix applied, tests still fail |
| Neither | :orange_circle: | "Fix suggested but error could not be reproduced" | Could not reproduce, tests fail or not run |
| Non-code | :blue_circle: | "Non-code issue" | Not a code problem |
| Gave up | :red_circle: | "Could not fix" | No fix produced |

The percentage (0-100%) is independent of the status category. A :green_circle: at 60% means the error was reproduced and tests pass, but Claude is not confident it found the real root cause. A :orange_circle: at 90% means it could not reproduce, but is very confident from the logs.

Displayed in comments and Slack as: `:green_circle: Reproduced and verified (85% confidence)`

### How confidence is parsed

The action parses Claude's output text to determine percentage, whether the error was reproduced, and whether tests pass after the fix.

<details>
<summary>Parsing rules</summary>

- **Percentage**: extracted from `CONFIDENCE_PERCENT: <number>` in the output. Clamped to 0-100. Defaults to 50% if the marker is not found in the output.
- **Reproduced**: `true` if output matches "reproduced", "error reproduced", or "successfully reproduced" (case-insensitive) AND does NOT match "could not reproduce", "unable to reproduce", or "cannot reproduce".
- **Tests pass**: `true` if output matches "test pass", "tests pass", "all tests pass", "build success", or "verification success" (case-insensitive) AND does NOT match "test fail", "test failure", or "build fail" in the output **after** the CONFIDENCE_PERCENT marker. This prevents early mentions of test failure (before Claude fixed it) from negating the final result.

</details>

### Non-code detection

When Claude produces no diff (no code changes), the confidence prompt instructs Claude to include `ISSUE_TYPE: NON_CODE` in its response if the failure is not caused by the code itself (e.g. infrastructure, flaky tests, runner issues, network errors, timeouts, out of memory).

If the marker is present: status is `NON_CODE`. Otherwise: status is `GAVE_UP` with 0% confidence.

## Commands reference

All commands are triggered by posting a PR comment starting with `/ci-assistant`. For a walkthrough with examples, see [What can you do with it?](#what-can-you-do-with-it) above.

### User commands

| Command | Valid in states | What it does |
|---|---|---|
| `/ci-assistant accept` | `active` | Cherry-picks the latest fix suggestion from its git ref and pushes to the branch. Does not invoke Claude. |
| `/ci-assistant accept #fix-<id>` | `active`, fix must exist in meta.fixes | Cherry-picks a specific fix by ID. Does not invoke Claude. |
| `/ci-assistant alternative` | `active`, `non-code` | Runs Claude again with all previous suggestions as context (uses `alternativePrompt`). Produces a new fix avoiding prior approaches. |
| `/ci-assistant suggest <text>` | `active`, `non-code`, `gave-up`, `none` | Runs Claude with the user's text as context (uses `suggestPrompt`). Works without a prior failure. |
| `/ci-assistant retry` | `gave-up`, `non-code` | Runs the full retry loop from scratch (uses `autoFixPrompt`). Available when the previous analysis failed or found a non-code issue. |
| `/ci-assistant explain` | All states | Explains the latest fix, or analyzes the failure if no fix exists. Requires at least a fix, failure logs, or a `-p` prompt. |
| `/ci-assistant explain #fix-<id>` | All states | Explains a specific fix by ID. |
| `/ci-assistant explain -p "<text>"` | All states | Asks Claude a question about the project, PR, or code. The fix diff is included as context if one exists. Works without any prior fix. |
| `/ci-assistant explain #fix-<id> -p "<text>"` | All states | Asks Claude a question with a specific fix's diff as context. The `-p` flag and `#fix-<id>` can appear in any order. |
| `/ci-assistant help` | Always | Posts a help comment listing current state, available commands, and previous fix IDs. Does not invoke Claude. |
| `/ci-assistant help <command>` | Always | Shows detailed help for a specific command, including all usage variants, what context is used, and availability. Commands: `accept`, `alternative`, `suggest`, `retry`, `explain`, `help`, `limits`, `admin`. |
| `/ci-assistant limits` | Always | Shows command usage and limits for this PR. Does not invoke Claude. |
| `/ci-assistant limits <type>` | Always | Shows detailed usage for a specific command type (e.g., `limits suggest`). |

**Invalid state errors**: each command has specific error messages when used in the wrong state. For example, `accept` in `gave-up` state responds: "No fix available to accept. Use `/ci-assistant retry` to try again or `/ci-assistant suggest <context>` to provide guidance."

### Admin commands

Admin users are configured via the `admin-users` input (comma-separated, case-insensitive matching). Non-admin users attempting admin commands are silently ignored (no response posted).

| Command | What it does |
|---|---|
| `/ci-assistant admin set-limit <type> <value>` | Overrides a specific limit for this PR. Types: `retry`, `alternative`, `suggest`, `explain`, `total`. Value: positive number, `0` to disable, `-1` for unlimited. When setting a specific limit to `-1`, the total limit is also automatically set to `-1`. |
| `/ci-assistant admin reset-limits` | Resets all limit overrides and all counters (including total) to zero for this PR. |
| `/ci-assistant admin reset-state` | Resets state to `none`, clearing fix history, per-command counters, and the gave-up flag. Preserves: general total counter, limit overrides, model override, max turns override, banned users, exploit count, Slack context, and failure context (lastSha, lastRunId, isTagFailure, tagSourceBranch). |
| `/ci-assistant admin set-model <model>` | Overrides the Claude model for all subsequent invocations on this PR. Example: `/ci-assistant admin set-model claude-opus-4-6` |
| `/ci-assistant admin set-max-turns <value>` | Overrides the max turns (tool-use iterations) per Claude invocation on this PR. Value: positive number or `-1` for unlimited. Use `0` to clear the override. Useful when fixes or explanations seem incomplete. |
| `/ci-assistant admin unban <username>` | Removes a PR-level ban. Only affects bans stored in the meta comment. Repo-level bans (from `banned-users` input) must be removed from the workflow file. |

Admin commands do not count toward the total command limit. Commands that do not invoke Claude (accept, help, limits) also do not count toward any limit.

### Unknown and invalid commands

- Unknown subcommands (e.g., `/ci-assistant blah`) are treated as `/ci-assistant help`
- Comments that don't start with `/ci-assistant` are silently ignored
- Empty `/ci-assistant` (no subcommand) is treated as `/ci-assistant help`

## State machine

### States

| State | Meaning | Valid user commands |
|---|---|---|
| `none` | No prior CI Assistant interaction on this PR | suggest, explain, help, limits |
| `active` | Has one or more code fix suggestions | accept, alternative, suggest, explain, help, limits |
| `non-code` | Failure identified as not code-related | alternative, suggest, retry, explain, help, limits |
| `gave-up` | Claude could not produce a fix | retry, suggest, explain, help, limits |

### Transitions

| From | Command/event | Outcome | To |
|---|---|---|---|
| `none` | suggest (fix found) | Code fix produced | `active` |
| `none` | suggest (no fix) | Claude failed | `gave-up` |
| `active` | accept | Fix applied | `active` (unchanged) |
| `active` | alternative/suggest (fix) | New code fix | `active` |
| `active` | alternative/suggest (non-code) | Detected infra issue | `non-code` |
| `active` | alternative/suggest (no fix) | Claude failed | `gave-up` |
| `non-code` | suggest/alternative/retry (fix) | Code fix found | `active` |
| `non-code` | retry/suggest (non-code) | Still infra issue | `non-code` |
| `non-code` | retry/suggest (no fix) | Claude failed | `gave-up` |
| `gave-up` | retry/suggest (fix) | Code fix found | `active` |
| `gave-up` | retry/suggest (no fix) | Still failed | `gave-up` |
| Any | admin reset-state | Admin action | `none` |

CI Assistant stays present on the PR after any command. State only resets to `none` via admin reset or when a new commit triggers the SHA-based reset in the auto-fix flow.

### State reset on new commit

When a new commit is pushed to a PR and the pipeline fails again, the action compares the current SHA to `lastSha` stored in the meta comment. If they differ:

- Per-command counters reset to 0 (`retryCt`, `altCt`, `suggestCt`, `explainCt`)
- Fix history is cleared (`fixes` array emptied, `latestFix` set to null)
- `gaveUp` flag is cleared
- General total counter (`totalCt`) does **not** reset (anti-abuse, persists for the PR's lifetime)

## Command limits

### Default limits

Only commands that invoke Claude have limits. Commands that do not use Claude (accept, help, limits) are always free.

| Input | Default | Exhaustion message |
|---|---|---|
| `max-retry-commands` | 2 | "`retry` limit reached" |
| `max-alternative-commands` | 3 | "`alternative` limit reached" |
| `max-suggest-commands` | 3 | "`suggest` limit reached" |
| `max-explain-commands` | 3 | "`explain` limit reached" |
| `max-total-commands` | 20 | "Command limit reached for this PR. No further CI Assistant interactions allowed." |

When a per-command limit is reached, the error message reminds the user they can still `accept` a previous fix and check limits with `/ci-assistant limits`. When the total limit is reached, only free commands (accept, help, limits) still work. The total limit exhaustion also triggers a Slack update.

### Limit values

- `0` disables the command entirely (rejected even at 0 uses)
- `-1` makes the command unlimited
- Any positive number sets that many uses allowed

Setting a specific limit to `-1` via admin also requires the total limit to be `-1`. The `admin set-limit` command handles this automatically.

### Limit reset behavior

- **New commit on same PR**: per-command counters reset, fix history cleared, total persists
- **New `ci-assistant/` PR** (old one closed by cleanup): everything resets (fresh meta comment)
- **Admin `reset-limits`**: all counters and overrides reset to zero/defaults
- **Admin `reset-state`**: per-command counters reset, total preserved

### Admin limit overrides

Admin overrides (set via `admin set-limit`) take precedence over the workflow input defaults. They are stored in the meta comment's `limitOverrides` object and persist until cleared via `admin reset-limits` or `admin reset-state`.

The effective limit for any command is: `limitOverrides[type]` if defined, otherwise the input default.

## Authentication

### Claude Code (OAuth vs API key)

| Scenario | Behavior |
|---|---|
| OAuth token valid | Used for Claude invocations, no messages |
| OAuth token expired, API key available | Warning posted to step summary with renewal instructions, falls back to API key (pay-per-use) |
| OAuth token expired, no API key | Error posted to step summary, action fails (`core.setFailed`) |
| No OAuth token, API key available | Warning posted to step summary recommending `claude setup-token`, uses API key |
| Neither configured | Error posted to step summary listing both options, action fails |
| `cleanup` mode | Auth validation skipped entirely (only needs GitHub token) |

OAuth token validation runs `claude --version` with the token in the environment. If the command produces output, the token is valid.

**To set up OAuth** (recommended):

```bash
claude setup-token
# Copy the token
# Store as CLAUDE_CODE_OAUTH_TOKEN secret in repository or organization settings
```

**To renew an expired token**, run `claude setup-token` again and update the secret. The step summary includes these instructions when expiration is detected.

### GitHub token

The action accepts an optional `github-token` input for custom bot identity via GitHub App. When not provided, it falls back to the built-in `GITHUB_TOKEN`.

| Token type | Identity | Cost | Notes |
|---|---|---|---|
| Default `GITHUB_TOKEN` | `github-actions[bot]` | Free | No setup needed, used automatically |
| GitHub App token | `<app-name>[bot]` | Free | Pass via `github-token` input, recommended (see [Custom bot identity](#custom-bot-identity)) |
| PAT | User's account | Costs a seat | Not recommended |

## Customizing prompts

### Prompt templates

All prompt inputs use `{{PLACEHOLDER}}` syntax. The action replaces each `{{KEY}}` with its value at runtime using a global regex. If a prompt input is left empty, the built-in default is used.

| Input | Used when | Purpose |
|---|---|---|
| `auto-fix-prompt` | First attempt in auto-fix/retry mode | Analyze failure logs and produce a fix |
| `retry-prompt` | Second and subsequent retry attempts | Try a different approach given what failed before |
| `alternative-prompt` | `/ci-assistant alternative` command | Find a different fix given all prior suggestions |
| `suggest-prompt` | `/ci-assistant suggest <text>` command | Implement a fix based on the developer's request |
| `explain-prompt` | `/ci-assistant explain` command | Explain the fix, analyze the failure, or answer a developer question |
| `confidence-prompt` | Appended to all fix prompts | Ask Claude to output `CONFIDENCE_PERCENT: <number>` |

### Built-in defaults

**auto-fix-prompt**:
```
Here are the CI pipeline failure logs:

{{FAILURE_LOGS}}

Repository: {{REPO}}
Branch: {{BRANCH}}
Commit: {{SHA}}

Reproduce the error, implement a fix, and verify it works by running the relevant tests.
```

**retry-prompt**:
```
Here are the CI pipeline failure logs:

{{FAILURE_LOGS}}

Previous attempts that did not work:
{{PREVIOUS_ATTEMPTS}}

Try a fundamentally different approach.
```

**alternative-prompt**:
```
Here are the CI pipeline failure logs:

{{FAILURE_LOGS}}

Previous fixes already suggested (do NOT repeat these):
{{PREVIOUS_SUGGESTIONS}}

Try a fundamentally different approach.
```

**suggest-prompt**:
```
Analyze the repository code and implement a fix based on the developer's request. Reproduce the error if possible and verify the fix by running the relevant tests.

Developer's request:
{{USER_CONTEXT}}

CI failure logs (if available):
{{FAILURE_LOGS_IF_AVAILABLE}}

CI Assistant conversation history:
{{CONVERSATION_HISTORY}}
```

**explain-prompt**:
```
Analyze the context below. If the developer provides a specific request, respond to it. Otherwise, explain the fix: what each change does, why it addresses the failure, and any relevant technical details. If no fix is present, analyze the failure and provide insights based on the available context. If you need to understand the failure better, reproduce the error by running the relevant tests or build commands.

Developer's request (if any):
{{USER_PROMPT}}

CI failure logs (if available):
{{FAILURE_LOGS_IF_AVAILABLE}}

Fix diff (if available):
{{LATEST_FIX_DIFF}}

CI Assistant conversation history:
{{CONVERSATION_HISTORY}}

Repository: {{REPO}}
Branch: {{BRANCH}}
```

**confidence-prompt**:
```
Rate your confidence from 0-100% that this fix correctly addresses the issue.

Output exactly: CONFIDENCE_PERCENT: <number>
```

### Available placeholders

| Placeholder | Description |
|---|---|
| `{{FAILURE_LOGS}}` | Downloaded pipeline failure logs (from failed jobs only, truncated to 100KB) |
| `{{FAILURE_LOGS_IF_AVAILABLE}}` | Same as above if a failure triggered this run, empty string otherwise |
| `{{REPO}}` | Repository full name (`owner/repo`) |
| `{{BRANCH}}` | Branch name |
| `{{SHA}}` | Commit SHA |
| `{{PREVIOUS_ATTEMPTS}}` | Summary of each prior retry attempt: what files were modified and test output |
| `{{PREVIOUS_SUGGESTIONS}}` | All previous fix suggestions from PR comments, with fix IDs, summaries, and diffs |
| `{{USER_CONTEXT}}` | Text provided by the user in `/ci-assistant suggest <text>` |
| `{{USER_PROMPT}}` | Text provided via `-p` in `/ci-assistant explain -p "<text>"`, empty if not provided |
| `{{LATEST_FIX_DIFF}}` | Diff of the fix being explained (specific fix if `#fix-<id>` given, latest otherwise, empty if no fix exists) |
| `{{CONVERSATION_HISTORY}}` | All PR comments (from all users, excluding meta), with author attribution. Gives Claude full context of prior analyses, suggestions, explanations, and developer discussions |
| `{{FIX_DIFF}}` | Placeholder for the current fix diff (filled by Claude during confidence analysis) |
| `{{REPRODUCTION_OUTPUT}}` | Output from Claude's attempt to reproduce the error |
| `{{POST_FIX_TEST_OUTPUT}}` | Output from running tests after applying the fix |

## Inputs reference

| Input | Default | Description |
|---|---|---|
| `mode` | (required) | `auto-fix`, `command`, `manual`, `cleanup` |
| `working-directory` | `.` | Directory where Claude Code runs |
| `max-turns` | `50` | Max Claude conversation turns per attempt. Use `-1` for unlimited. Can be overridden per PR via `/ci-assistant admin set-max-turns`. |
| `max-retries` | `3` | Max retry attempts per run |
| `max-retry-commands` | `2` | Max retry commands per PR (`-1` for unlimited, `0` to disable) |
| `max-alternative-commands` | `3` | Max alternative commands per PR |
| `max-suggest-commands` | `3` | Max suggest commands per PR |
| `max-explain-commands` | `3` | Max explain commands per PR |
| `max-total-commands` | `20` | Max total commands that invoke Claude per PR |
| `model` | `claude-sonnet-4-6` | Claude model to use |
| `skip-permissions` | `true` | Pass `--dangerously-skip-permissions` to Claude Code. Safe in CI since the runner is ephemeral. Set to `false` to require permission checks. |
| `allowed-tools` | `""` | Comma-separated list of tools Claude Code can use (e.g. `Bash,Edit,Read,Write,WebSearch`). Empty means all tools. |
| `disallowed-tools` | `""` | Comma-separated list of tools Claude Code cannot use (e.g. `WebSearch,WebFetch`). Takes precedence over `allowed-tools`. |
| `append-system-prompt` | `""` | Additional system prompt appended to Claude Code's default. Use for project-specific instructions not covered by `CLAUDE.md`. |
| `admin-users` | `""` | Comma-separated GitHub usernames with admin access (case-insensitive) |
| `banned-users` | `""` | Comma-separated GitHub usernames banned repo-wide from CI Assistant |
| `slack-failure-channel` | `""` | Slack channel ID for notifications (optional, everything works without Slack) |
| `slack-thread-ts` | `""` | Slack thread timestamp to reply in (optional) |
| `slack-bot-token` | `""` | Slack Bot OAuth Token (optional) |
| `failed-run-id` | `""` | The workflow run ID that failed |
| `failed-branch` | `""` | The branch that failed |
| `failed-sha` | `""` | The commit SHA that failed |
| `failed-pr-number` | `""` | The PR number (if failure was on a PR branch) |
| `comment-pr-number` | `""` | The PR number the command was posted on (command mode) |
| `auto-fix-prompt` | (built-in) | Prompt template for automatic fix attempts |
| `retry-prompt` | (built-in) | Prompt template for retry attempts |
| `alternative-prompt` | (built-in) | Prompt template for alternative suggestions |
| `suggest-prompt` | (built-in) | Prompt template for suggest commands |
| `explain-prompt` | (built-in) | Prompt template for explain commands |
| `confidence-prompt` | (built-in) | Prompt appended to all fix prompts for confidence analysis |
| `github-token` | `""` | GitHub token for API calls. Falls back to `GITHUB_TOKEN`. Only needed for GitHub App custom identity. |
| `claude-code-oauth-token` | `""` | Claude Code OAuth token (from `claude setup-token`, uses subscription quota) |
| `anthropic-api-key` | `""` | Anthropic API key (pay-per-use fallback) |
| `comment-body` | `""` | The PR comment text (command mode) |

## Outputs reference

| Output | Description |
|---|---|
| `outcome` | High-level result: `fix-suggested`, `non-code`, `gave-up`, or empty for cleanup/command modes without a fix attempt |
| `fix-id` | The selected fix ID (e.g. `#fix-abc1234`), empty if no fix was suggested |
| `confidence-status` | Confidence classification: `reproduced-and-verified`, `not-reproduced-tests-pass`, `reproduced-tests-fail`, `neither`, `non-code`, `gave-up` |
| `confidence-percentage` | Numeric confidence score (0–100) |
| `pr-number` | The PR number that was created or commented on |
| `total-input-tokens` | Total input tokens used across all attempts |
| `total-output-tokens` | Total output tokens used across all attempts |
| `total-cache-read-tokens` | Total cache read tokens across all attempts |
| `total-cache-creation-tokens` | Total cache creation tokens across all attempts |
| `total-attempts` | Number of fix attempts made |
| `total-duration-ms` | Total Claude API duration in milliseconds |

## Environment variables

| Variable | Purpose |
|---|---|
| `GITHUB_TOKEN` | Built-in GitHub token, used as fallback when `github-token` input is not provided |
| `GITHUB_REPOSITORY` | Set automatically by GitHub Actions (`owner/repo`) |
| `GITHUB_ACTOR` | The user who triggered the workflow (used for ban/admin checks) |
| `GITHUB_TRIGGERING_ACTOR` | Fallback for comment author identification |
| `GITHUB_ACTIONS` | When `"true"`, the entry point calls `run()` (set automatically by GitHub Actions) |

## CLAUDE.md support

Claude Code automatically discovers and respects `CLAUDE.md` files in the working directory. If your project has a `CLAUDE.md` with build commands, test commands, coding conventions, or other instructions, Claude will follow them when analyzing failures and implementing fixes.

This means you can guide CI Assistant's behavior per-project without changing the workflow configuration. For example, a `CLAUDE.md` that says "always run `./gradlew test` to verify fixes" will make Claude use that exact command instead of guessing.

For instructions that apply across all projects using CI Assistant (not project-specific), use the `append-system-prompt` input instead.

## Slack integration

All Slack functionality is optional. If `slack-failure-channel` and `slack-bot-token` are not set, the action works without Slack. Slack API errors are caught and logged as warnings; they never cause the action to fail.

Slack messages are only sent when there is failure context (a pipeline actually failed). On-demand `/ci-assistant suggest` on a working PR with no prior failure does not post to the failure channel. Once a pipeline fails and auto-fix runs, all subsequent commands on that PR (suggest, alternative, retry, accept, explain) update the existing Slack message.

### Message types

| Type | When posted | Style |
|---|---|---|
| **Suggestion** | New fix found (auto-fix, or command with prior failure context) | Stethoscope icon, confidence status with icon/label/percentage, fix ID, "View on GitHub" button, context line with fix count and test status |
| **Status update** | Status changes (accept, gave up, non-code, limit hit, cleanup) with prior failure context | Stethoscope icon, status text, "View on GitHub" button, context line with fix count and command count |
| **Exploit alert** | Exploitation attempt detected | Warning icon, "Potential exploitation attempt" header, "View Comment" button (danger style), ban instructions. Posted as a top-level message (not in thread) for visibility. |
| **Unresolved tag** | Tag failure with unknown source branch | Warning icon, tag name, explanation that no PR was created, analysis excerpt (first 500 chars) |

Suggestion and status messages are posted once and updated in place on subsequent events. The message timestamp (`ts`) is stored in the meta comment so updates work across separate workflow runs.

### Block truncation

- Individual block text sections: truncated at 2,900 characters with `_[truncated]_` appended
- Total message payload: if the JSON exceeds 50KB, trailing blocks are removed until under the limit

## Security

### Prompt injection protection

User input from `/ci-assistant suggest <text>` is scanned before being passed to Claude. Multiple patterns across several categories are checked. If any match, the command is blocked and the user is banned on that PR.

<details>
<summary>All detection patterns (40 total)</summary>

**Prompt injection (15 patterns)**:
- "ignore previous/above instructions"
- "you are now a"
- "new/override system prompt"
- "disregard prior"
- "forget previous"
- "act as different"
- "pretend you are"
- "your new instructions"
- "from now on you"
- "system: " (with space after colon)
- `[SYSTEM]` marker
- LLM boundary markers (`<|im_start|>`, `<|endoftext|>`)

**Secret access (9 patterns)**:
- `process.env`
- `${{ secrets.* }}` or `${{ env.* }}` patterns
- Named secrets: `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `SLACK_BOT_TOKEN`
- `cat .env`, `printenv`, `echo $VAR` patterns

**Destructive commands (8 patterns)**:
- `rm -rf /` or `rm -rf *`
- `dd if=...of=/dev`
- `mkfs.`
- Fork bomb (`:(){ :|:& };:`)
- `git push --force`
- `git reset --hard`
- `chmod -R 777 /`

**Data exfiltration (8 patterns)**:
- `curl ... | sh` or `wget ... | sh`
- `curl -d @...`
- `nc -e`
- `base64 | curl`
- `curl ... ngrok/webhook.site/requestbin`

</details>

When any pattern is detected:
1. The command is not processed (Claude is never called)
2. The user is added to `bannedUsers` in the meta comment
3. The `exploitAttempts` counter is incremented
4. A comment is posted: "User `<username>` has been banned from CI Assistant on this PR due to a potential exploitation attempt."
5. A Slack exploit alert is posted (top-level, not in thread)

### Meta comment integrity

The meta comment (`<!-- ci-assistant-meta: {...} -->`) stores all CI Assistant state for a PR as JSON. The action only trusts meta comments authored by the bot's own identity (determined at runtime by calling `getAuthenticatedUser()`, which falls back to `github-actions[bot]` if the API call fails). If a user posts a comment containing the meta marker, it is ignored. This prevents users from spoofing state, limits, bans, or model overrides.

When reading meta or previous suggestions, the action fetches the first 100 comments on the PR. On very active PRs with more than 100 comments, older suggestions beyond this limit may not be included in the context passed to Claude.

### User banning

- **PR-level ban**: triggered by exploitation detection, stored in the meta comment's `bannedUsers` array. Affects only that PR. Can be reversed by an admin via `/ci-assistant admin unban <username>`.
- **Repo-level ban**: configured via the `banned-users` input in the workflow file. Affects all PRs in the repository. Must be removed from the workflow file to reverse.

Both levels use case-insensitive matching. Banned users' commands are silently ignored (no response posted).

### Fork safety and bot filtering

The workflow `if` condition includes three safety checks:

- `github.event.workflow_run.repository.full_name == github.repository`: prevents running on `workflow_run` events triggered by forks
- `github.event.issue.pull_request`: only processes comments on PRs, not on issues
- `github.event.comment.user.type != 'Bot'`: prevents bots (including CI Assistant itself) from triggering command processing, avoiding infinite loops

## Git ref storage

### How refs work

Each fix suggestion (except the first fix on a new ci-assistant PR) is stored as an invisible git ref at `refs/ci-assistant/<pr-number>/<fix-id>`. These refs do not appear in the branch list or the GitHub UI. They are namespaced per PR to avoid conflicts.

<details>
<summary>Ref creation steps (internal)</summary>

1. `git add -A` (stage all changes)
2. `git write-tree` (capture the tree SHA)
3. `git rev-parse HEAD` (get the parent commit)
4. `git commit-tree <tree> -p <parent> -m "ci-assistant: <fix-id>"` (create a commit object)
5. `git push origin <commit-sha>:refs/ci-assistant/<pr>/<fix-id>` (push to the ref)
6. `git reset --hard HEAD` (clean up working directory)

</details>

### First fix on ci-assistant PRs

When the action creates a new `ci-assistant/<branch>` PR for a branch failure, the fix is committed directly to the branch via `createBranchAndPushFix()`:
1. `git checkout -b ci-assistant/<branch> <failing-sha>`
2. `git add -A`
3. `git commit -m "ci-assistant: automated fix for pipeline failure"`
4. `git push origin ci-assistant/<branch>`

No ref is created because the fix is already on the branch. The suggestion comment includes: "This fix has been pushed directly to the branch. Merge the PR to apply it." The fix is not added to `meta.fixes` (so `/ci-assistant accept` correctly says "No fix available to accept" since the fix is already applied).

Subsequent fixes on the same ci-assistant PR are stored as refs and follow the normal accept flow.

### Accept flow (cherry-pick)

When a user runs `/ci-assistant accept` or `/ci-assistant accept #fix-<id>`:

1. Validate the fix ID exists in `meta.fixes` (rejects with available fix list if not found)
2. `git fetch origin refs/ci-assistant/<pr>/<fix-id>` (download the ref)
3. `git cherry-pick FETCH_HEAD` (apply the fix on top of the current branch)
4. `git push` (push to the PR branch)

If the cherry-pick fails (e.g., the branch has moved forward since the fix was suggested, or there is a merge conflict):
1. `git cherry-pick --abort` is run automatically to restore the branch to its pre-attempt state
2. An error comment is posted with manual recovery instructions so the user can resolve conflicts locally:
   ```
   git fetch origin refs/ci-assistant/<pr>/<fix-id>
   git cherry-pick FETCH_HEAD
   ```

### Ref cleanup

Refs are cleaned up in three situations:
1. **Cleanup closes a ci-assistant PR**: all `refs/ci-assistant/<pr>/` refs are deleted
2. **Orphaned ref scan**: during every cleanup run, refs for closed/merged PRs are found and deleted
3. **State reset on new commit**: the `meta.fixes` array is cleared, but the refs themselves remain until cleanup runs

## PR comment format

### Suggestion comment

````markdown
## CI Assistant Suggestion `#fix-a1b2c3d`

**Status:** :green_circle: Reproduced and verified (85% confidence)
**Reproduced:** Yes | **Tests pass after fix:** Yes

### Summary
Fixed the null check in UserService.findById()

### What failed
<details>
<summary>Error details</summary>
(first 5000 chars of failure logs)
</details>

### Suggested fix
<details>
<summary>View diff (3 files changed)</summary>

```diff
(diff content, truncated at 50,000 chars if larger)
```

</details>

`#fix-a1b2c3d` | `/ci-assistant accept` | `/ci-assistant alternative` | `/ci-assistant suggest <context>` | `/ci-assistant explain` | `/ci-assistant help`
````

If the diff exceeds 50,000 characters, it is truncated with: "_Diff truncated. Accept the fix to see full changes, or use `/ci-assistant explain` for a detailed walkthrough._"

### Non-code comment

```markdown
## CI Assistant Suggestion

**Status:** :blue_circle: Non-code issue (75% confidence)

### Analysis
(Claude's analysis of the infrastructure/environment issue)

This failure does not appear to be caused by code changes.
Common causes: runner issues, network timeouts, out of memory, flaky infrastructure.

`/ci-assistant suggest <context>` | `/ci-assistant alternative` | `/ci-assistant explain` | `/ci-assistant help`
```

### Gave-up comment

```markdown
## CI Assistant Suggestion

**Status:** :red_circle: Could not fix

### Analysis
(Claude's analysis or "Could not determine the issue.")

CI Assistant was unable to produce a fix for this failure after all retry attempts.

`/ci-assistant retry` | `/ci-assistant suggest <context>` | `/ci-assistant help`
```

### Tag failure note

When the failure is on a tag, a blockquote is appended to suggestion, non-code, and gave-up comments:

> **Tag failure:** `v1.0.0` (targeting branch `main`). After merging this fix, create a new tag from `main`.

### Pushed-directly note

When the fix was pushed directly to a new ci-assistant branch (first fix on a branch failure):

> This fix has been pushed directly to the branch. Merge the PR to apply it.

## Failure log handling

The action downloads logs from the GitHub API by listing failed jobs for the workflow run and fetching each job's logs:

- Only jobs with `conclusion == 'failure'` are included (passing jobs are skipped)
- Each job's logs are prefixed with `--- Job: <name> ---`
- If a job's logs can't be downloaded, the section reads `--- Job: <name> (logs unavailable) ---`
- If total log output exceeds 100KB, the beginning is trimmed and the **last 100KB** is kept (the end of logs is most relevant for diagnosing failures). Prefixed with `[...truncated, showing last 100KB...]`
- If the entire download fails, returns "Failed to download pipeline logs."
- If no failed jobs are found, returns "No failed jobs found in the workflow run."
- If no `failed-run-id` is provided, returns "No failure logs available."

In command mode, if `failed-run-id` is not provided as an input, the action reads `lastRunId` from the meta comment (stored during the initial auto-fix run). The branch and SHA are also populated from the meta comment or from the PR's head ref/sha.

## Non-code failures

Claude analyzes logs and may determine the failure is not code-related. When no code changes are produced and Claude's output contains the explicit marker `ISSUE_TYPE: NON_CODE`, the status is set to `NON_CODE`.

In `non-code` state:
- `accept` is not available (no code fix to apply)
- `suggest`, `alternative`, `explain`, `retry`, `help` remain available
- `retry` runs the full retry loop from scratch
- `suggest` and `alternative` can produce a code fix (transitioning to `active`) if Claude reconsiders with additional context

For non-PR branch failures (main, release branches) that result in non-code or gave-up, no `ci-assistant/` PR is created. A branch with no code changes serves no purpose. The analysis is reported via Slack only.

## Fix ID format

Fix IDs are deterministic hashes of the diff content:

1. SHA-256 hash of the full diff string
2. Take the first 7 hex characters
3. Prefix with `#fix-`

Example: `#fix-a1b2c3d`

The same diff always produces the same fix ID. Different diffs produce different IDs (with high probability given 7 hex chars = ~268 million combinations).

## GitHub permissions

The action requires these permissions when called directly (the reusable workflow sets them automatically). These are the same permissions required when creating a GitHub App for custom bot identity.

| Permission | Level | Why |
|---|---|---|
| `contents` | write | Push fix branches, create and delete git refs for fix storage, cherry-pick accepted fixes |
| `pull-requests` | write | Create fix PRs on branch failures, close stale `ci-assistant/` PRs during cleanup, read PR metadata |
| `issues` | write | Post and update PR comments. The GitHub API serves PR comments through the Issues API, so this permission is required for all comment operations. |
| `actions` | read | Download failure logs from workflow runs for analysis |

## Concurrency

The custom workflow example uses a concurrency group to prevent multiple CI Assistant runs from interfering with each other:

```yaml
concurrency:
  group: ci-assistant-${{ github.event.issue.number || github.event.workflow_run.head_branch || 'manual' }}
  cancel-in-progress: false
```

This ensures:
- Only one CI Assistant run per PR (using the issue/PR number)
- Only one CI Assistant run per branch (using the branch name for non-PR failures)
- `cancel-in-progress: false` ensures in-progress runs complete (cancelling mid-analysis would leave the working directory in a bad state)

## Examples

### Gradle project

Add to your `default.yml`:

```yaml
  ci-assistant:
    needs: [default-workflow]
    if: ${{ failure() }}
    uses: phorus-group/workflows/.github/workflows/ci-assistant.yml@main
    with:
      java-version: "21"
      slack-failure-channel: "YOUR_CHANNEL_ID"
      admin-users: "your-username"
    secrets:
      claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      slack-bot-token: ${{ secrets.SLACK_BOT_TOKEN }}
```

### Node project

Add to your `default.yml`:

```yaml
  ci-assistant:
    needs: [default-workflow]
    if: ${{ failure() }}
    uses: phorus-group/workflows/.github/workflows/ci-assistant.yml@main
    with:
      node-version: "20"
      admin-users: "your-username"
    secrets:
      claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

### Custom workflow (no reusable workflow)

For full control, call the action directly. This standalone example uses `workflow_run` to trigger on pipeline failures. For the recommended approach of embedding CI Assistant as a job in your default workflow, see the [quick start](#quick-start-with-the-reusable-workflow) section.

```yaml
name: "CI Assistant"

on:
  workflow_run:
    workflows: ["Default Workflow"]
    types: [completed]
  issue_comment:
    types: [created]
  schedule:
    - cron: "0 6 * * 1"
  workflow_dispatch:
    inputs:
      run-id:
        description: "Failed run ID to analyze"
        required: true

jobs:
  ci-assistant:
    if: >-
      (github.event_name == 'workflow_run' && github.event.workflow_run.conclusion == 'failure' && github.event.workflow_run.repository.full_name == github.repository) ||
      (github.event_name == 'issue_comment' && startsWith(github.event.comment.body, '/ci-assistant') && github.event.issue.pull_request && github.event.comment.user.type != 'Bot') ||
      github.event_name == 'workflow_dispatch' ||
      github.event_name == 'schedule'
    runs-on: ubuntu-latest
    concurrency:
      group: ci-assistant-${{ github.event.issue.number || github.event.workflow_run.head_branch || 'manual' }}
      cancel-in-progress: false
    permissions:
      contents: write
      pull-requests: write
      actions: read
      issues: write
    steps:
      - name: Determine mode and context
        id: context
        run: |
          if [[ "${{ github.event_name }}" == "workflow_run" ]]; then
            echo "mode=auto-fix" >> $GITHUB_OUTPUT
            echo "checkout-ref=${{ github.event.workflow_run.head_sha }}" >> $GITHUB_OUTPUT
            echo "failed-run-id=${{ github.event.workflow_run.id }}" >> $GITHUB_OUTPUT
            echo "failed-branch=${{ github.event.workflow_run.head_branch }}" >> $GITHUB_OUTPUT
            echo "failed-sha=${{ github.event.workflow_run.head_sha }}" >> $GITHUB_OUTPUT
            PR_NUMBER=$(gh api repos/${{ github.repository }}/commits/${{ github.event.workflow_run.head_sha }}/pulls --jq '.[0].number // empty' 2>/dev/null || echo "")
            echo "failed-pr-number=${PR_NUMBER}" >> $GITHUB_OUTPUT
          elif [[ "${{ github.event_name }}" == "issue_comment" ]]; then
            echo "mode=command" >> $GITHUB_OUTPUT
            echo "comment-pr-number=${{ github.event.issue.number }}" >> $GITHUB_OUTPUT
            PR_SHA=$(gh api repos/${{ github.repository }}/pulls/${{ github.event.issue.number }} --jq '.head.sha')
            echo "checkout-ref=${PR_SHA}" >> $GITHUB_OUTPUT
          elif [[ "${{ github.event_name }}" == "schedule" ]]; then
            echo "mode=cleanup" >> $GITHUB_OUTPUT
            echo "checkout-ref=" >> $GITHUB_OUTPUT
          else
            echo "mode=manual" >> $GITHUB_OUTPUT
            echo "failed-run-id=${{ inputs.run-id }}" >> $GITHUB_OUTPUT
            echo "checkout-ref=" >> $GITHUB_OUTPUT
          fi
        env:
          GH_TOKEN: ${{ github.token }}

      - uses: actions/checkout@v4
        with:
          ref: ${{ steps.context.outputs.checkout-ref || '' }}

      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: "21"
          cache: gradle

      - uses: phorus-group/ci-assistant-action@v1
        with:
          mode: ${{ steps.context.outputs.mode }}
          failed-run-id: ${{ steps.context.outputs.failed-run-id }}
          failed-branch: ${{ steps.context.outputs.failed-branch }}
          failed-sha: ${{ steps.context.outputs.failed-sha }}
          failed-pr-number: ${{ steps.context.outputs.failed-pr-number }}
          comment-pr-number: ${{ steps.context.outputs.comment-pr-number }}
          admin-users: "your-username"
          slack-failure-channel: "YOUR_CHANNEL_ID"
          slack-bot-token: ${{ secrets.SLACK_BOT_TOKEN }}
          claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          comment-body: ${{ github.event.comment.body }}
```

## Building and contributing

```bash
yarn install       # install dependencies
yarn lint          # run eslint
yarn test          # run all tests
yarn build         # bundle with esbuild to dist/index.js
```

The project uses:
- **esbuild** for bundling (compiles src + node_modules into a single `dist/index.js` for GitHub Actions)
- **@swc/jest** for test transpilation (handles Jest mock hoisting)
- **TypeScript** for type checking (`tsc --noEmit`)
- **ESLint + Prettier** for formatting
- **Husky + lint-staged** for pre-commit hooks

`dist/` is gitignored and built during the release process. Consumers reference the action via version tags (`@v1`), not `@main`.

## Authors and acknowledgment

Developed and maintained by the [Phorus Group](https://phorus.group) team.
