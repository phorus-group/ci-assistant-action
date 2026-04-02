import * as core from "@actions/core"
import {
  Mode,
  State,
  Command,
  MetaComment,
  ActionInputs,
  ConfidenceStatus,
  ConfidenceResult,
  RetryAttempt,
  createDefaultMeta,
  META_MARKER,
} from "./types"
import { validateAuth, installClaude } from "./auth"
import { checkForExploitation } from "./security"
import {
  OctokitGitHubClient,
  GitHubClient,
  PR,
  readMeta,
  writeMeta,
  getPreviousSuggestions,
  formatSuggestionComment,
  formatNonCodeComment,
  formatGaveUpComment,
  createBranchAndPushFix,
  createFixRef,
  acceptFixFromRef,
  cleanupOrphanedRefs,
  resolveTagTargetBranch,
} from "./github"
import {
  parseCommand,
  validateCommandForState,
  checkLimits,
  incrementCounter,
  isAdmin,
  isBanned,
  formatHelpComment,
  formatLimitsComment,
} from "./commands"
import { handleAdminCommand } from "./admin"
import {
  CliClaudeRunner,
  RealGitOperations,
  runWithRetries,
  generateFixId,
  renderPrompt,
  ClaudeRunner,
  GitOperations,
} from "./claude"
import {
  HttpSlackClient,
  SlackClient,
  buildSuggestionBlocks,
  buildStatusUpdateBlocks,
  buildExploitAlertBlocks,
  buildUnresolvedTagBlocks,
  postOrUpdateSlack,
} from "./slack"

function getInputs(): ActionInputs {
  return {
    mode: core.getInput("mode") as Mode,
    workingDirectory: core.getInput("working-directory") || ".",
    maxTurns: parseInt(core.getInput("max-turns") || "50"),
    maxRetries: parseInt(core.getInput("max-retries") || "3"),
    maxRetryCommands: parseInt(core.getInput("max-retry-commands") || "2"),
    maxAlternativeCommands: parseInt(core.getInput("max-alternative-commands") || "3"),
    maxSuggestCommands: parseInt(core.getInput("max-suggest-commands") || "3"),
    maxExplainCommands: parseInt(core.getInput("max-explain-commands") || "3"),
    maxTotalCommands: parseInt(core.getInput("max-total-commands") || "20"),
    model: core.getInput("model") || "claude-sonnet-4-6",
    skipPermissions: core.getInput("skip-permissions") !== "false",
    allowedTools: (core.getInput("allowed-tools") || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    disallowedTools: (core.getInput("disallowed-tools") || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    appendSystemPrompt: core.getInput("append-system-prompt") || "",
    adminUsers: (core.getInput("admin-users") || "")
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean),
    bannedUsers: (core.getInput("banned-users") || "")
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean),
    slackFailureChannel: core.getInput("slack-failure-channel") || "",
    slackThreadTs: core.getInput("slack-thread-ts") || "",
    slackBotToken: core.getInput("slack-bot-token") || "",
    failedRunId: core.getInput("failed-run-id") || "",
    failedBranch: core.getInput("failed-branch") || "",
    failedSha: core.getInput("failed-sha") || "",
    failedPrNumber: core.getInput("failed-pr-number") || "",
    commentPrNumber: core.getInput("comment-pr-number") || "",
    autoFixPrompt:
      core.getInput("auto-fix-prompt") ||
      `Here are the CI pipeline failure logs:

{{FAILURE_LOGS}}

Repository: {{REPO}}
Branch: {{BRANCH}}
Commit: {{SHA}}

Reproduce the error, implement a fix, and verify it works by running the relevant tests.`,
    retryPrompt:
      core.getInput("retry-prompt") ||
      `Here are the CI pipeline failure logs:

{{FAILURE_LOGS}}

Previous attempts that did not work:
{{PREVIOUS_ATTEMPTS}}

Try a fundamentally different approach.`,
    alternativePrompt:
      core.getInput("alternative-prompt") ||
      `Here are the CI pipeline failure logs:

{{FAILURE_LOGS}}

Previous fixes already suggested (do NOT repeat these):
{{PREVIOUS_SUGGESTIONS}}

Try a fundamentally different approach.`,
    suggestPrompt:
      core.getInput("suggest-prompt") ||
      `Analyze the repository code and implement a fix based on the developer's request. Reproduce the error if possible and verify the fix by running the relevant tests.

Developer's request:
{{USER_CONTEXT}}

CI failure logs (if available):
{{FAILURE_LOGS_IF_AVAILABLE}}

CI Assistant conversation history:
{{CONVERSATION_HISTORY}}`,
    explainPrompt:
      core.getInput("explain-prompt") ||
      `Analyze the context below. If the developer provides a specific request, respond to it. Otherwise, explain the fix: what each change does, why it addresses the failure, and any relevant technical details. If no fix is present, analyze the failure and provide insights based on the available context. If you need to understand the failure better, reproduce the error by running the relevant tests or build commands.

Developer's request (if any):
{{USER_PROMPT}}

CI failure logs (if available):
{{FAILURE_LOGS_IF_AVAILABLE}}

Fix diff (if available):
{{LATEST_FIX_DIFF}}

CI Assistant conversation history:
{{CONVERSATION_HISTORY}}

Repository: {{REPO}}
Branch: {{BRANCH}}`,
    confidencePrompt:
      core.getInput("confidence-prompt") ||
      `Rate your confidence from 0-100% that this fix correctly addresses the issue.

If this failure is not caused by the code itself (e.g. infrastructure, flaky tests, runner issues, network errors, timeouts, out of memory), include in your response: ISSUE_TYPE: NON_CODE

Output exactly: CONFIDENCE_PERCENT: <number>`,
    githubToken: core.getInput("github-token") || "",
    claudeCodeOauthToken: core.getInput("claude-code-oauth-token") || "",
    anthropicApiKey: core.getInput("anthropic-api-key") || "",
    commentBody: core.getInput("comment-body") || "",
  }
}

export async function run(
  githubClient?: GitHubClient,
  slackClient?: SlackClient,
  claudeRunner?: ClaudeRunner,
  gitOps?: GitOperations
): Promise<void> {
  try {
    const inputs = getInputs()

    // Export token inputs to process.env so child processes (claude CLI, gh CLI) can read them
    // github-token falls back to the built-in GITHUB_TOKEN
    const ghToken = inputs.githubToken || process.env.GITHUB_TOKEN || ""
    if (ghToken) process.env.GH_TOKEN = ghToken
    if (inputs.claudeCodeOauthToken)
      process.env.CLAUDE_CODE_OAUTH_TOKEN = inputs.claudeCodeOauthToken
    if (inputs.anthropicApiKey) process.env.ANTHROPIC_API_KEY = inputs.anthropicApiKey

    const github = githubClient || new OctokitGitHubClient(ghToken)
    const slack =
      slackClient || (inputs.slackBotToken ? new HttpSlackClient(inputs.slackBotToken) : null)

    // Clean orphaned refs at the start of every invocation.
    // Full cleanup (closing stale PRs, resetting state) only runs in dedicated
    // cleanup mode since it requires the pipeline to have passed.
    if (inputs.mode !== Mode.CLEANUP) {
      const cleaned = await cleanupOrphanedRefs(github)
      if (cleaned > 0) core.info(`Cleaned up ${cleaned} orphaned refs`)
    }

    switch (inputs.mode) {
      case Mode.CLEANUP:
        await handleCleanup(github, slack, inputs)
        break
      case Mode.AUTO_FIX:
      case Mode.MANUAL:
        await handleAutoFix(github, slack, claudeRunner, gitOps, inputs)
        break
      case Mode.COMMAND:
        await handleCommand(github, slack, claudeRunner, gitOps, inputs)
        break
      default:
        core.setFailed(`Unknown mode: ${inputs.mode}`)
    }
  } catch (error) {
    core.setFailed(`CI Assistant failed: ${error}`)
  }
}

async function handleCleanup(
  github: GitHubClient,
  slack: SlackClient | null,
  inputs: ActionInputs
): Promise<void> {
  core.info("Running cleanup...")

  const botUser = await github.getAuthenticatedUser()

  // Determine which ci-assistant branches to check.
  // When failedBranch is set (workflow_run trigger), only check that branch.
  // When empty (schedule trigger), scan all open ci-assistant PRs.
  const ciAssistantPrs: { pr: PR; baseBranch: string }[] = []

  if (inputs.failedBranch) {
    const ciAssistantBranch = `ci-assistant/${inputs.failedBranch}`
    const prs = await github.listPRs({ head: ciAssistantBranch, state: "open" })
    for (const pr of prs) {
      ciAssistantPrs.push({ pr, baseBranch: inputs.failedBranch })
    }
  } else {
    const allOpenPrs = await github.listPRs({ state: "open" })
    for (const pr of allOpenPrs) {
      if (pr.head.ref.startsWith("ci-assistant/")) {
        ciAssistantPrs.push({ pr, baseBranch: pr.base.ref })
      }
    }
  }

  // Close ci-assistant PRs whose base branch pipeline now passes
  for (const { pr, baseBranch } of ciAssistantPrs) {
    const shouldClose = inputs.failedBranch
      ? true
      : (await github.getBranchLatestConclusion(baseBranch)) === "success"

    if (!shouldClose) continue

    core.info(`Closing ci-assistant PR #${pr.number} (${baseBranch} pipeline recovered)`)
    await github.createComment(
      pr.number,
      `Closing this PR because the \`${baseBranch}\` pipeline is now passing. The fix is no longer needed.`
    )
    await github.closePR(pr.number)

    try {
      await github.deleteRef(`refs/heads/${pr.head.ref}`)
      core.info(`Deleted branch ${pr.head.ref}`)
    } catch {
      core.warning(`Could not delete branch ${pr.head.ref}`)
    }

    const prRefs = await github.listRefs(`ci-assistant/${pr.number}/`)
    for (const ref of prRefs) {
      try {
        await github.deleteRef(ref)
      } catch {
        core.warning(`Could not delete ref ${ref}`)
      }
    }
    if (prRefs.length > 0) {
      core.info(`Deleted ${prRefs.length} fix refs for PR #${pr.number}`)
    }

    if (slack && inputs.slackFailureChannel) {
      const { meta } = await readMeta(github, pr.number, botUser)
      if (meta.slackTs) {
        const { blocks, text } = buildStatusUpdateBlocks({
          repo: process.env.GITHUB_REPOSITORY || "",
          branch: baseBranch,
          status: "Auto-closed (base branch recovered)",
          meta,
          prUrl: `https://github.com/${process.env.GITHUB_REPOSITORY}/pull/${pr.number}`,
        })
        await slack.updateMessage(inputs.slackFailureChannel, meta.slackTs, blocks, text)
      }
    }
  }

  // Clean up orphaned refs
  const cleaned = await cleanupOrphanedRefs(github)
  core.info(`Cleaned up ${cleaned} orphaned refs`)
}

async function handleAutoFix(
  github: GitHubClient,
  slack: SlackClient | null,
  claudeRunnerParam: ClaudeRunner | undefined,
  gitOpsParam: GitOperations | undefined,
  inputs: ActionInputs
): Promise<void> {
  await installClaude()
  const auth = await validateAuth(inputs.mode, inputs.claudeCodeOauthToken, inputs.anthropicApiKey)
  if (!auth) return

  // If manual mode, fetch run info to fill in missing context
  if (inputs.mode === Mode.MANUAL && inputs.failedRunId) {
    const runInfo = await github.getRunInfo(parseInt(inputs.failedRunId))
    inputs.failedBranch = inputs.failedBranch || runInfo.head_branch
    inputs.failedSha = inputs.failedSha || runInfo.head_sha
  }

  // Detect tag failures and resolve the target branch
  let isTagFailure = false
  let tagSourceBranch: string | null = null
  let prTargetBranch = inputs.failedBranch

  if (!inputs.failedPrNumber && inputs.failedBranch) {
    isTagFailure = await github.isTag(inputs.failedBranch)
    if (isTagFailure) {
      tagSourceBranch = await resolveTagTargetBranch(inputs.failedBranch)
      if (tagSourceBranch) {
        prTargetBranch = tagSourceBranch
        core.info(
          `Tag failure detected: ${inputs.failedBranch} -> targeting branch ${tagSourceBranch}`
        )
      } else {
        core.warning(
          `Tag failure detected for ${inputs.failedBranch} but could not resolve the source branch. ` +
            `Skipping PR creation to avoid targeting the wrong branch.`
        )
      }
    }
  }

  // Download failure logs
  const logs = inputs.failedRunId
    ? await github.downloadRunLogs(parseInt(inputs.failedRunId))
    : "No failure logs available."

  // Determine the PR
  let prNumber: number
  let isNewCiAssistantPr = false

  if (inputs.failedPrNumber) {
    prNumber = parseInt(inputs.failedPrNumber) || 0
  } else {
    // No PR: branch, release branch, or tag failure
    const ciAssistantBranch = `ci-assistant/${inputs.failedBranch}`
    const existingPrs = await github.listPRs({
      head: ciAssistantBranch,
      state: "open",
    })

    if (existingPrs.length > 0) {
      prNumber = existingPrs[0].number
    } else {
      isNewCiAssistantPr = true
      prNumber = 0
    }
  }

  // Read meta (if PR exists)
  const botUser = await github.getAuthenticatedUser()
  let meta: MetaComment
  let metaCommentId: number | null = null

  if (prNumber > 0) {
    const metaResult = await readMeta(github, prNumber, botUser)
    meta = metaResult.meta
    metaCommentId = metaResult.commentId
  } else {
    meta = createDefaultMeta()
  }

  // State reset on new commit: if the SHA changed, reset per-command limits
  if (meta.lastSha && inputs.failedSha && meta.lastSha !== inputs.failedSha) {
    core.info(
      `New commit detected (${meta.lastSha} -> ${inputs.failedSha}), resetting per-command limits`
    )
    meta.retryCt = 0
    meta.altCt = 0
    meta.suggestCt = 0
    meta.explainCt = 0
    meta.fixes = []
    meta.latestFix = null
    meta.gaveUp = false
    // totalCt is NOT reset (anti-abuse)
  }

  // Store context in meta for future command-mode access
  meta.lastSha = inputs.failedSha || null
  meta.lastRunId = inputs.failedRunId || null
  meta.isTagFailure = isTagFailure
  meta.tagSourceBranch = tagSourceBranch

  // Get previous suggestions and conversation history for context
  let previousSuggestions = ""
  let conversationHistory = ""
  if (prNumber > 0) {
    const comments = await github.getComments(prNumber)
    const suggestions = getPreviousSuggestions(comments, botUser)
    previousSuggestions = suggestions
      .map((s) => `- ${s.fixId}: ${s.summary}\n${s.diff}`)
      .join("\n\n")
    conversationHistory = comments
      .filter((c) => !c.body.includes(META_MARKER))
      .map((c) => `**${c.user.login}:**\n${c.body}`)
      .join("\n\n---\n\n")
  }

  // Run Claude (apply admin overrides)
  const model = meta.modelOverride || inputs.model
  if (meta.maxTurnsOverride != null) {
    inputs.maxTurns = meta.maxTurnsOverride
  }
  const runner =
    claudeRunnerParam ||
    new CliClaudeRunner(inputs.workingDirectory, {
      skipPermissions: inputs.skipPermissions,
      allowedTools: inputs.allowedTools,
      disallowedTools: inputs.disallowedTools,
      appendSystemPrompt: inputs.appendSystemPrompt,
    })
  const git = gitOpsParam || new RealGitOperations(inputs.workingDirectory)

  const { bestAttempt } = await runWithRetries(
    runner,
    git,
    inputs,
    logs,
    previousSuggestions,
    "",
    model,
    undefined,
    conversationHistory
  )

  const confidence: ConfidenceResult = bestAttempt.confidence || {
    status: ConfidenceStatus.GAVE_UP,
    percentage: 0,
    reproduced: false,
    testsPass: false,
  }

  const repo = process.env.GITHUB_REPOSITORY || ""
  const tagNote = isTagFailure
    ? `\n\n> **Tag failure:** \`${inputs.failedBranch}\` (targeting branch \`${tagSourceBranch}\`). After merging this fix, create a new tag from \`${tagSourceBranch}\`.`
    : ""

  // Tracks whether the fix was already pushed directly to the ci-assistant branch.
  // When true, skip createFixRef (ref would be redundant, accept would fail).
  let fixAlreadyPushed = false

  // For non-PR failures that need a ci-assistant PR.
  // Skips PR creation for tag failures where the source branch could not be resolved,
  // to avoid accidentally targeting the wrong branch.
  const ensureCiAssistantPr = async (): Promise<void> => {
    if (!isNewCiAssistantPr || prNumber > 0) return

    // Tag failure with unresolved source branch: do not create a PR
    if (isTagFailure && !tagSourceBranch) {
      core.warning(
        `Cannot create fix PR for tag ${inputs.failedBranch}: source branch could not be determined. ` +
          `The analysis will be logged but no PR will be created.`
      )

      if (slack && inputs.slackFailureChannel) {
        const analysis =
          bestAttempt.testOutput || bestAttempt.reproductionOutput || extractSummary(bestAttempt)
        const { blocks, text } = buildUnresolvedTagBlocks({
          repo,
          tag: inputs.failedBranch,
          analysis,
        })
        const slackTs = await slack.postMessage(
          inputs.slackFailureChannel,
          blocks,
          text,
          inputs.slackThreadTs
        )
        if (slackTs) {
          meta.slackTs = slackTs
          meta.slackChannel = inputs.slackFailureChannel
        }
      }

      return
    }

    const ciAssistantBranch = `ci-assistant/${inputs.failedBranch}`
    await createBranchAndPushFix(ciAssistantBranch, inputs.failedSha)

    const prBody = isTagFailure
      ? `Automated fix from CI Assistant for pipeline failure on tag \`${inputs.failedBranch}\`.\n\nTargeting branch \`${tagSourceBranch}\`. After merging, create a new tag from \`${tagSourceBranch}\`.`
      : `Automated fix from CI Assistant for pipeline failure on \`${inputs.failedBranch}\`.`

    const pr = await github.createPR({
      title: `CI Assistant: fix for ${inputs.failedBranch}`,
      body: prBody,
      head: ciAssistantBranch,
      base: prTargetBranch,
    })
    prNumber = pr.number
    isNewCiAssistantPr = false
    fixAlreadyPushed = true
  }

  const prUrl = () =>
    prNumber > 0 ? `https://github.com/${repo}/pull/${prNumber}` : `https://github.com/${repo}`

  // Handle non-code failure
  if (confidence.status === ConfidenceStatus.NON_CODE) {
    meta.state = State.NON_CODE
    meta.gaveUp = false

    // Non-code issues: post on existing PR, but do NOT create a new ci-assistant PR
    // (a branch with no code changes serves no purpose)
    if (prNumber > 0) {
      await github.createComment(
        prNumber,
        formatNonCodeComment({
          analysis:
            bestAttempt.testOutput ||
            bestAttempt.reproductionOutput ||
            "Infrastructure or environment issue detected.",
          confidence,
        }) + tagNote
      )
    }

    if (slack && inputs.slackFailureChannel) {
      const { blocks, text } = buildStatusUpdateBlocks({
        repo,
        branch: inputs.failedBranch,
        status: "Non-code issue detected",
        meta,
        prUrl: prUrl(),
        confidence,
      })
      const slackTs = await postOrUpdateSlack(
        slack,
        meta,
        inputs.slackFailureChannel,
        blocks,
        text,
        inputs.slackThreadTs
      )
      if (slackTs) {
        meta.slackTs = slackTs
        meta.slackChannel = inputs.slackFailureChannel
      }
    }
  } else if (bestAttempt.diff && bestAttempt.diff.length > 0) {
    // Code fix found
    const fixId = generateFixId(bestAttempt.diff)

    await ensureCiAssistantPr()

    meta.state = State.ACTIVE
    meta.gaveUp = false

    if (prNumber > 0) {
      if (fixAlreadyPushed) {
        // Fix was pushed directly to the ci-assistant branch as part of PR creation.
        // No ref needed (cherry-pick would fail since changes are already on the branch).
        // Don't add to meta.fixes so accept doesn't try to use a non-existent ref.
        const pushedNote =
          "\n\n> This fix has been pushed directly to the branch. Merge the PR to apply it."
        await github.createComment(
          prNumber,
          formatSuggestionComment({
            fixId,
            summary: extractSummary(bestAttempt),
            errorDetails: logs.slice(0, 5000),
            diff: bestAttempt.diff,
            confidence,
            filesChanged: bestAttempt.filesChanged.length,
          }) +
            tagNote +
            pushedNote
        )
      } else {
        // Store fix as ref for later accept via cherry-pick
        await createFixRef(prNumber, fixId)
        meta.fixes.push(fixId)
        meta.latestFix = fixId

        await github.createComment(
          prNumber,
          formatSuggestionComment({
            fixId,
            summary: extractSummary(bestAttempt),
            errorDetails: logs.slice(0, 5000),
            diff: bestAttempt.diff,
            confidence,
            filesChanged: bestAttempt.filesChanged.length,
          }) + tagNote
        )
      }
    }

    if (slack && inputs.slackFailureChannel) {
      const { blocks, text } = buildSuggestionBlocks({
        repo,
        branch: inputs.failedBranch,
        fixId,
        confidence,
        meta,
        prUrl: prUrl(),
      })
      const slackTs = await postOrUpdateSlack(
        slack,
        meta,
        inputs.slackFailureChannel,
        blocks,
        text,
        inputs.slackThreadTs
      )
      if (slackTs) {
        meta.slackTs = slackTs
        meta.slackChannel = inputs.slackFailureChannel
      }
    }
  } else {
    // Gave up: post on existing PR, but do NOT create a new ci-assistant PR
    meta.state = State.GAVE_UP
    meta.gaveUp = true

    if (prNumber > 0) {
      await github.createComment(
        prNumber,
        formatGaveUpComment(bestAttempt.testOutput || "Could not determine the issue.") + tagNote
      )
    }

    if (slack && inputs.slackFailureChannel) {
      const { blocks, text } = buildStatusUpdateBlocks({
        repo,
        branch: inputs.failedBranch,
        status: "Could not fix",
        meta,
        prUrl: prUrl(),
      })
      const slackTs = await postOrUpdateSlack(
        slack,
        meta,
        inputs.slackFailureChannel,
        blocks,
        text,
        inputs.slackThreadTs
      )
      if (slackTs) {
        meta.slackTs = slackTs
        meta.slackChannel = inputs.slackFailureChannel
      }
    }
  }

  // Write meta
  if (prNumber > 0) {
    await writeMeta(github, prNumber, meta, metaCommentId)
  }
}

async function handleCommand(
  github: GitHubClient,
  slack: SlackClient | null,
  claudeRunnerParam: ClaudeRunner | undefined,
  gitOpsParam: GitOperations | undefined,
  inputs: ActionInputs
): Promise<void> {
  const commentBody = inputs.commentBody
  const prNumber = parseInt(inputs.commentPrNumber) || 0

  if (!prNumber) {
    core.warning("No PR number for command mode")
    return
  }

  // Parse command
  const parsed = parseCommand(commentBody)
  if (!parsed) return

  // Log command for audit (user-provided input, useful for exploit analysis)
  const commentAuthorForLog =
    process.env.GITHUB_ACTOR || process.env.GITHUB_TRIGGERING_ACTOR || "unknown"
  core.info(
    `Command: ${parsed.command} | User: ${commentAuthorForLog} | PR: #${prNumber} | Input: ${commentBody}`
  )

  // Get bot identity
  const botUser = await github.getAuthenticatedUser()

  // Read meta
  const { meta, commentId: metaCommentId } = await readMeta(github, prNumber, botUser)

  // Populate context from meta + PR for command mode
  if (!inputs.failedRunId && meta.lastRunId) {
    inputs.failedRunId = meta.lastRunId
  }
  if (!inputs.failedSha && meta.lastSha) {
    inputs.failedSha = meta.lastSha
  }
  if (!inputs.failedBranch) {
    try {
      const pr = await github.getPR(prNumber)
      inputs.failedBranch = pr.head.ref
      if (!inputs.failedSha) {
        inputs.failedSha = pr.head.sha
      }
    } catch {
      core.warning("Could not retrieve PR info for branch context")
    }
  }

  // Get comment author (for ban/admin checks)
  const commentAuthor = process.env.GITHUB_ACTOR || process.env.GITHUB_TRIGGERING_ACTOR || ""

  // Check bans
  if (isBanned(commentAuthor, meta, inputs.bannedUsers)) {
    return // Silently ignore
  }

  // Handle admin commands
  if (parsed.command === Command.ADMIN) {
    if (!isAdmin(commentAuthor, inputs.adminUsers)) {
      return // Silently ignore
    }

    if (!parsed.adminCommand) {
      await github.createComment(
        prNumber,
        "Usage: `/ci-assistant admin <set-limit|reset-limits|reset-state|set-model|set-max-turns|unban> [args]`"
      )
      return
    }

    const result = handleAdminCommand(parsed.adminCommand, parsed.adminArgs || [], meta)

    await github.createComment(
      prNumber,
      result.success ? `**Admin:** ${result.message}` : `**Admin Error:** ${result.message}`
    )

    if (result.updatedMeta) {
      await writeMeta(github, prNumber, result.updatedMeta, metaCommentId)
    }
    return
  }

  // Security check for suggest
  if (parsed.command === Command.SUGGEST && parsed.userContext) {
    const secCheck = checkForExploitation(parsed.userContext)
    if (!secCheck.safe) {
      // Ban user on this PR
      meta.bannedUsers.push(commentAuthor)
      meta.exploitAttempts += 1
      await writeMeta(github, prNumber, meta, metaCommentId)

      await github.createComment(
        prNumber,
        `This request could not be processed. User \`${commentAuthor}\` has been banned from CI Assistant on this PR due to a potential exploitation attempt.`
      )

      // Slack alert (top-level, not thread)
      if (slack && inputs.slackFailureChannel) {
        const { blocks, text } = buildExploitAlertBlocks({
          repo: process.env.GITHUB_REPOSITORY || "",
          prNumber,
          username: commentAuthor,
          commentUrl: `https://github.com/${process.env.GITHUB_REPOSITORY}/pull/${prNumber}`,
        })
        await slack.postMessage(inputs.slackFailureChannel, blocks, text)
      }

      return
    }
  }

  // Validate command for current state
  const stateValidation = validateCommandForState(parsed.command, meta.state)
  if (!stateValidation.valid) {
    await github.createComment(prNumber, stateValidation.error!)
    return
  }

  // Check limits
  const limitCheck = checkLimits(parsed.command, meta, inputs)
  if (!limitCheck.allowed) {
    const limitMsg =
      limitCheck.limitType === "total"
        ? "Command limit reached for this PR. No further CI Assistant interactions allowed. Run `/ci-assistant limits` to see usage details."
        : `\`${limitCheck.limitType}\` limit reached (${limitCheck.current}/${limitCheck.max}). ` +
          "You can still `/ci-assistant accept` a previous suggestion. " +
          "Run `/ci-assistant limits` to see all limits, or ask an admin to adjust them."

    await github.createComment(prNumber, limitMsg)

    // Update Slack for significant limits
    if (slack && meta.slackTs && meta.slackChannel && limitCheck.limitType === "total") {
      const { blocks, text } = buildStatusUpdateBlocks({
        repo: process.env.GITHUB_REPOSITORY || "",
        branch: inputs.failedBranch,
        status: "Command limit reached",
        meta,
        prUrl: `https://github.com/${process.env.GITHUB_REPOSITORY}/pull/${prNumber}`,
      })
      await slack.updateMessage(meta.slackChannel, meta.slackTs, blocks, text)
    }

    return
  }

  // Increment counters
  const updatedMeta = incrementCounter(meta, parsed.command)

  // Execute command
  switch (parsed.command) {
    case Command.HELP:
      await github.createComment(
        prNumber,
        formatHelpComment(updatedMeta.state, updatedMeta, parsed.userContext)
      )
      break

    case Command.LIMITS:
      await github.createComment(
        prNumber,
        formatLimitsComment(updatedMeta, inputs, parsed.userContext)
      )
      break

    case Command.ACCEPT:
      await handleAccept(github, slack, updatedMeta, prNumber, parsed, inputs)
      break

    case Command.EXPLAIN:
      await handleExplain(github, claudeRunnerParam, updatedMeta, prNumber, parsed, inputs, botUser)
      break

    case Command.ALTERNATIVE:
    case Command.SUGGEST:
    case Command.RETRY:
      await handleFixCommand(
        github,
        slack,
        claudeRunnerParam,
        gitOpsParam,
        updatedMeta,
        prNumber,
        parsed,
        inputs,
        botUser
      )
      break
  }

  // Write updated meta
  await writeMeta(github, prNumber, updatedMeta, metaCommentId)
}

async function handleAccept(
  github: GitHubClient,
  slack: SlackClient | null,
  meta: MetaComment,
  prNumber: number,
  parsed: ReturnType<typeof parseCommand> & {},
  inputs: ActionInputs
): Promise<void> {
  const fixId = parsed.fixId || meta.latestFix
  if (!fixId) {
    await github.createComment(prNumber, "No fix available to accept.")
    return
  }

  if (!meta.fixes.includes(fixId)) {
    await github.createComment(
      prNumber,
      `Fix \`${fixId}\` not found. Available fixes: ${meta.fixes.map((f) => `\`${f}\``).join(", ")}`
    )
    return
  }

  const result = await acceptFixFromRef(prNumber, fixId)

  if (result.success) {
    await github.createComment(
      prNumber,
      `Fix \`${fixId}\` has been applied and pushed to the branch.`
    )

    if (slack && inputs.slackFailureChannel && meta.lastRunId) {
      const { blocks, text } = buildStatusUpdateBlocks({
        repo: process.env.GITHUB_REPOSITORY || "",
        branch: inputs.failedBranch,
        status: `Fix ${fixId} accepted and pushed`,
        meta,
        prUrl: `https://github.com/${process.env.GITHUB_REPOSITORY}/pull/${prNumber}`,
      })
      const slackTs = await postOrUpdateSlack(slack, meta, inputs.slackFailureChannel, blocks, text)
      if (slackTs) {
        meta.slackTs = slackTs
        meta.slackChannel = inputs.slackFailureChannel
      }
    }
  } else {
    await github.createComment(prNumber, result.error!)
  }
}

async function handleExplain(
  github: GitHubClient,
  claudeRunnerParam: ClaudeRunner | undefined,
  meta: MetaComment,
  prNumber: number,
  parsed: ReturnType<typeof parseCommand> & {},
  inputs: ActionInputs,
  botUser: string
): Promise<void> {
  await installClaude()
  const auth = await validateAuth(inputs.mode, inputs.claudeCodeOauthToken, inputs.anthropicApiKey)
  if (!auth) return

  const model = meta.modelOverride || inputs.model
  const maxTurns = meta.maxTurnsOverride ?? inputs.maxTurns
  const runner =
    claudeRunnerParam ||
    new CliClaudeRunner(inputs.workingDirectory, {
      skipPermissions: inputs.skipPermissions,
      allowedTools: inputs.allowedTools,
      disallowedTools: inputs.disallowedTools,
      appendSystemPrompt: inputs.appendSystemPrompt,
    })

  // Gather context: fix diff, failure logs, previous suggestions
  let fixDiff = ""
  const comments = await github.getComments(prNumber)
  const suggestions = getPreviousSuggestions(comments, botUser)

  if (parsed.fixId) {
    const match = suggestions.find((s) => s.fixId === parsed.fixId)
    if (!match) {
      await github.createComment(
        prNumber,
        `Fix \`${parsed.fixId}\` not found. Available: ${suggestions.map((s) => `\`${s.fixId}\``).join(", ") || "none"}`
      )
      return
    }
    fixDiff = match.diff
  } else if (suggestions.length > 0) {
    fixDiff = suggestions[suggestions.length - 1].diff
  }

  let logs = ""
  if (inputs.failedRunId) {
    logs = await github.downloadRunLogs(parseInt(inputs.failedRunId))
  }

  // Build conversation history from all PR comments (exclude meta)
  const conversationHistory = comments
    .filter((c) => !c.body.includes(META_MARKER))
    .map((c) => `**${c.user.login}:**\n${c.body}`)
    .join("\n\n---\n\n")

  // Need at least some context to explain
  if (!fixDiff && !logs && !parsed.userContext && !conversationHistory) {
    await github.createComment(
      prNumber,
      'No fix, failure logs, or prompt available to explain. Use `-p "<question>"` to ask a question about the project.'
    )
    return
  }

  const prompt = renderPrompt(inputs.explainPrompt, {
    USER_PROMPT: parsed.userContext || "",
    FAILURE_LOGS_IF_AVAILABLE: logs,
    LATEST_FIX_DIFF: fixDiff ? `\`\`\`diff\n${fixDiff}\n\`\`\`` : "",
    CONVERSATION_HISTORY: conversationHistory,
    REPO: process.env.GITHUB_REPOSITORY || "",
    BRANCH: inputs.failedBranch,
  })

  const result = await runner.run(prompt, model, maxTurns)

  await github.createComment(prNumber, `## CI Assistant Explanation\n\n${result.output}`)
}

async function handleFixCommand(
  github: GitHubClient,
  slack: SlackClient | null,
  claudeRunnerParam: ClaudeRunner | undefined,
  gitOpsParam: GitOperations | undefined,
  meta: MetaComment,
  prNumber: number,
  parsed: ReturnType<typeof parseCommand> & {},
  inputs: ActionInputs,
  botUser: string
): Promise<void> {
  await installClaude()
  const auth = await validateAuth(inputs.mode, inputs.claudeCodeOauthToken, inputs.anthropicApiKey)
  if (!auth) return

  // Get previous suggestions and conversation history
  const comments = await github.getComments(prNumber)
  const suggestions = getPreviousSuggestions(comments, botUser)
  const previousSuggestions = suggestions
    .map((s) => `- ${s.fixId}: ${s.summary}\n${s.diff}`)
    .join("\n\n")
  const conversationHistory = comments
    .filter((c) => c.user.login === botUser)
    .map((c) => c.body)
    .join("\n\n---\n\n")

  // Get failure logs if available
  let logs = ""
  if (inputs.failedRunId) {
    logs = await github.downloadRunLogs(parseInt(inputs.failedRunId))
  }

  const model = meta.modelOverride || inputs.model
  if (meta.maxTurnsOverride != null) {
    inputs.maxTurns = meta.maxTurnsOverride
  }
  const runner =
    claudeRunnerParam ||
    new CliClaudeRunner(inputs.workingDirectory, {
      skipPermissions: inputs.skipPermissions,
      allowedTools: inputs.allowedTools,
      disallowedTools: inputs.disallowedTools,
      appendSystemPrompt: inputs.appendSystemPrompt,
    })
  const git = gitOpsParam || new RealGitOperations(inputs.workingDirectory)

  // Select the command-specific prompt template
  let commandPrompt: string | undefined
  if (parsed.command === Command.SUGGEST) {
    commandPrompt = inputs.suggestPrompt
  } else if (parsed.command === Command.ALTERNATIVE) {
    commandPrompt = inputs.alternativePrompt
  }
  // RETRY uses autoFixPrompt for the first attempt (same as auto-fix)

  const { bestAttempt } = await runWithRetries(
    runner,
    git,
    inputs,
    logs,
    previousSuggestions,
    parsed.userContext || "",
    model,
    commandPrompt,
    conversationHistory
  )

  const confidence: ConfidenceResult = bestAttempt.confidence || {
    status: ConfidenceStatus.GAVE_UP,
    percentage: 0,
    reproduced: false,
    testsPass: false,
  }

  const repo = process.env.GITHUB_REPOSITORY || ""
  const prUrlStr = `https://github.com/${repo}/pull/${prNumber}`

  // Only send Slack for commands that have failure context (a pipeline actually failed).
  // Suggest on a working PR with no prior failure should not post to the failure channel.
  const hasFailureContext = !!meta.lastRunId

  if (confidence.status === ConfidenceStatus.NON_CODE) {
    // Non-code issue detected
    meta.state = State.NON_CODE
    meta.gaveUp = false

    await github.createComment(
      prNumber,
      formatNonCodeComment({
        analysis:
          bestAttempt.testOutput ||
          bestAttempt.reproductionOutput ||
          "Infrastructure or environment issue detected.",
        confidence,
      })
    )

    if (slack && inputs.slackFailureChannel && hasFailureContext) {
      const { blocks, text } = buildStatusUpdateBlocks({
        repo,
        branch: inputs.failedBranch,
        status: "Non-code issue detected",
        meta,
        prUrl: prUrlStr,
        confidence,
      })
      const slackTs = await postOrUpdateSlack(slack, meta, inputs.slackFailureChannel, blocks, text)
      if (slackTs) {
        meta.slackTs = slackTs
        meta.slackChannel = inputs.slackFailureChannel
      }
    }
  } else if (bestAttempt.diff && bestAttempt.diff.length > 0) {
    // Code fix found
    const fixId = generateFixId(bestAttempt.diff)
    await createFixRef(prNumber, fixId)

    meta.state = State.ACTIVE
    meta.fixes.push(fixId)
    meta.latestFix = fixId
    meta.gaveUp = false

    await github.createComment(
      prNumber,
      formatSuggestionComment({
        fixId,
        summary: extractSummary(bestAttempt),
        errorDetails: logs.slice(0, 5000),
        diff: bestAttempt.diff,
        confidence,
        filesChanged: bestAttempt.filesChanged.length,
      })
    )

    if (slack && inputs.slackFailureChannel && hasFailureContext) {
      const { blocks, text } = buildSuggestionBlocks({
        repo,
        branch: inputs.failedBranch,
        fixId,
        confidence,
        meta,
        prUrl: prUrlStr,
      })
      const slackTs = await postOrUpdateSlack(slack, meta, inputs.slackFailureChannel, blocks, text)
      if (slackTs) {
        meta.slackTs = slackTs
        meta.slackChannel = inputs.slackFailureChannel
      }
    }
  } else {
    // Gave up
    meta.state = State.GAVE_UP
    meta.gaveUp = true

    await github.createComment(
      prNumber,
      formatGaveUpComment(bestAttempt.testOutput || "Could not determine the issue.")
    )

    if (slack && inputs.slackFailureChannel && hasFailureContext) {
      const { blocks, text } = buildStatusUpdateBlocks({
        repo,
        branch: inputs.failedBranch,
        status: "Could not fix",
        meta,
        prUrl: prUrlStr,
      })
      const slackTs = await postOrUpdateSlack(slack, meta, inputs.slackFailureChannel, blocks, text)
      if (slackTs) {
        meta.slackTs = slackTs
        meta.slackChannel = inputs.slackFailureChannel
      }
    }
  }
}

function extractSummary(attempt: RetryAttempt): string {
  if (attempt.testOutput) {
    const lines = attempt.testOutput.split("\n").slice(0, 3)
    return lines.join("\n")
  }
  return `Modified ${attempt.filesChanged.length} file(s): ${attempt.filesChanged.join(", ")}`
}

// Entry point, called directly by GitHub Actions runtime
// Export run for testing; the action.yml points to dist/index.js which executes run() via this block
if (process.env.GITHUB_ACTIONS === "true") {
  run()
}
