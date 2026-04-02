import * as core from "@actions/core"
import * as exec from "@actions/exec"
import { createHash } from "crypto"
import { mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { ConfidenceResult, ConfidenceStatus, RetryAttempt, ActionInputs } from "./types"

const CONTEXT_DIR = ".ci-assistant"

/**
 * Writes large context to a file instead of embedding it in the prompt.
 * Claude Code can read the file with its Read/Grep tools, only loading
 * the parts it needs instead of processing the entire content upfront.
 * Returns the file path relative to the working directory.
 */
export function writeContextFile(
  workingDirectory: string,
  filename: string,
  content: string
): string {
  const dir = join(workingDirectory, CONTEXT_DIR)
  mkdirSync(dir, { recursive: true })
  // Gitignore the context dir so it doesn't pollute Claude's diffs
  const gitignorePath = join(dir, ".gitignore")
  writeFileSync(gitignorePath, "*\n", "utf-8")
  const filePath = join(dir, filename)
  writeFileSync(filePath, content, "utf-8")
  return join(CONTEXT_DIR, filename)
}

export interface ClaudeRunner {
  run(prompt: string, model: string, maxTurns: number): Promise<ClaudeResult>
}

export interface ClaudeResult {
  output: string
  exitCode: number
  diff: string
  filesChanged: string[]
  usage: ClaudeUsage | null
}

export interface TotalUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  attempts: number
  durationMs: number
}

export interface ClaudeUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  numTurns: number
  durationMs: number
}

export interface StreamEvent {
  type: string
  subtype?: string
  result?: string
  message?: {
    content?: { type: string; text?: string; name?: string; input?: Record<string, unknown> }[]
  }
  usage?: Record<string, unknown>
  num_turns?: number
  duration_ms?: number
}

export function parseStreamEvent(line: string): StreamEvent | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith("{")) return null
  try {
    return JSON.parse(trimmed) as StreamEvent
  } catch {
    return null
  }
}

export function formatStreamEvent(event: StreamEvent): string | null {
  switch (event.type) {
    case "system":
      return null // skip init noise

    case "assistant": {
      const parts: string[] = []
      for (const c of event.message?.content ?? []) {
        if (c.type === "text" && c.text) {
          parts.push(`[claude] ${c.text.length > 500 ? c.text.slice(0, 500) + "..." : c.text}`)
        } else if (c.type === "tool_use" && c.name) {
          const input = JSON.stringify(c.input ?? {})
          const short = input.length > 150 ? input.slice(0, 150) + "..." : input
          parts.push(`[tool] ${c.name}: ${short}`)
        }
      }
      return parts.length > 0 ? parts.join("\n") : null
    }

    case "result": {
      const u = event.usage
      if (!u)
        return `[done] turns=${event.num_turns ?? 0} ${((event.duration_ms ?? 0) / 1000).toFixed(1)}s`
      return (
        `[done] turns=${event.num_turns ?? 0}` +
        ` in=${u.input_tokens ?? 0} out=${u.output_tokens ?? 0}` +
        ` cache_read=${u.cache_read_input_tokens ?? 0}` +
        ` cache_create=${u.cache_creation_input_tokens ?? 0}` +
        ` ${((event.duration_ms ?? 0) / 1000).toFixed(1)}s`
      )
    }

    default:
      return null // skip rate_limit_event, user (tool results), etc.
  }
}

export function parseResultEvent(event: StreamEvent): {
  text: string
  usage: ClaudeUsage | null
} {
  const text = event.result ?? ""
  const u = event.usage
  const usage: ClaudeUsage | null = u
    ? {
        inputTokens: (u.input_tokens as number) ?? 0,
        outputTokens: (u.output_tokens as number) ?? 0,
        cacheReadTokens: (u.cache_read_input_tokens as number) ?? 0,
        cacheCreationTokens: (u.cache_creation_input_tokens as number) ?? 0,
        numTurns: event.num_turns ?? 0,
        durationMs: event.duration_ms ?? 0,
      }
    : null
  return { text, usage }
}

export class CliClaudeRunner implements ClaudeRunner {
  private workingDirectory: string
  private skipPermissions: boolean
  private allowedTools: string[]
  private disallowedTools: string[]
  private appendSystemPrompt: string

  constructor(
    workingDirectory: string,
    options?: {
      skipPermissions?: boolean
      allowedTools?: string[]
      disallowedTools?: string[]
      appendSystemPrompt?: string
    }
  ) {
    this.workingDirectory = workingDirectory
    this.skipPermissions = options?.skipPermissions ?? true
    this.allowedTools = options?.allowedTools ?? []
    this.disallowedTools = options?.disallowedTools ?? []
    this.appendSystemPrompt = options?.appendSystemPrompt ?? ""
  }

  buildArgs(prompt: string, model: string, maxTurns: number): string[] {
    const args = ["--model", model]
    if (maxTurns >= 0) {
      args.push("--max-turns", maxTurns.toString())
    }
    if (this.skipPermissions) {
      args.push("--dangerously-skip-permissions")
    }
    if (this.allowedTools.length > 0) {
      args.push("--allowedTools", ...this.allowedTools)
    }
    if (this.disallowedTools.length > 0) {
      args.push("--disallowedTools", ...this.disallowedTools)
    }
    if (this.appendSystemPrompt) {
      args.push("--append-system-prompt", this.appendSystemPrompt)
    }
    args.push("--output-format", "stream-json", "--verbose", "--print", "-p", prompt)
    return args
  }

  async run(prompt: string, model: string, maxTurns: number): Promise<ClaudeResult> {
    let output = ""
    let exitCode = 0
    let usage: ClaudeUsage | null = null

    try {
      const args = this.buildArgs(prompt, model, maxTurns)

      // Stream events in real time so the Actions log shows progress.
      // The prompt (with embedded failure logs) is never in the stream,
      // only Claude's responses and tool usage appear.
      let resultEvent: StreamEvent | null = null

      const result = await exec.getExecOutput("claude", args, {
        cwd: this.workingDirectory,
        silent: true,
        ignoreReturnCode: true,
        env: process.env as Record<string, string>,
        listeners: {
          stdline: (line: string) => {
            const event = parseStreamEvent(line)
            if (!event) return
            if (event.type === "result") {
              resultEvent = event
            }
            const formatted = formatStreamEvent(event)
            if (formatted) {
              core.info(formatted)
            }
          },
        },
      })
      exitCode = result.exitCode

      if (resultEvent) {
        const parsed = parseResultEvent(resultEvent)
        output = parsed.text
        usage = parsed.usage
      } else {
        // Fallback: no result event found, use raw stdout
        output = result.stdout + result.stderr
      }
    } catch (error) {
      output = String(error)
      exitCode = 1
    }

    // Stage everything (including new files) to capture the full diff
    await exec.exec("git", ["add", "-A"], {
      cwd: this.workingDirectory,
      silent: true,
    })

    const diffResult = await exec.getExecOutput("git", ["diff", "--staged"], {
      cwd: this.workingDirectory,
      silent: true,
    })
    // Preserve trailing newline because git apply requires it for valid patch format.
    // Only strip leading whitespace to avoid "corrupt patch" errors.
    const diff = diffResult.stdout.replace(/^\s+/, "")

    const filesResult = await exec.getExecOutput("git", ["diff", "--staged", "--name-only"], {
      cwd: this.workingDirectory,
      silent: true,
    })
    const filesChanged = filesResult.stdout
      .trim()
      .split("\n")
      .filter((f) => f.length > 0)

    // Unstage so the working directory is in a clean state for resetHard/clean
    await exec.exec("git", ["reset", "HEAD"], {
      cwd: this.workingDirectory,
      silent: true,
      ignoreReturnCode: true,
    })

    return { output, exitCode, diff, filesChanged, usage }
  }
}

export interface GitOperations {
  resetHard(): Promise<void>
  clean(): Promise<void>
  applyDiff(diff: string): Promise<void>
}

export class RealGitOperations implements GitOperations {
  private cwd: string

  constructor(cwd: string) {
    this.cwd = cwd
  }

  async resetHard(): Promise<void> {
    core.info("[git] resetHard: git checkout -- .")
    const result = await exec.getExecOutput("git", ["checkout", "--", "."], {
      cwd: this.cwd,
      silent: true,
      ignoreReturnCode: true,
    })
    if (result.exitCode !== 0) {
      core.error(`[git] resetHard failed (exit ${result.exitCode}): ${result.stderr.trim()}`)
      // Log git status for context
      const status = await exec.getExecOutput("git", ["status", "--short"], {
        cwd: this.cwd,
        silent: true,
        ignoreReturnCode: true,
      })
      core.info(`[git] status after failed resetHard:\n${status.stdout.trim()}`)
      throw new Error(`git checkout -- . failed with exit code ${result.exitCode}`)
    }
  }

  async clean(): Promise<void> {
    core.info("[git] clean: git clean -fd")
    const result = await exec.getExecOutput("git", ["clean", "-fd"], {
      cwd: this.cwd,
      silent: true,
      ignoreReturnCode: true,
    })
    if (result.exitCode !== 0) {
      core.error(`[git] clean failed (exit ${result.exitCode}): ${result.stderr.trim()}`)
      throw new Error(`git clean -fd failed with exit code ${result.exitCode}`)
    }
  }

  async applyDiff(diff: string): Promise<void> {
    if (!diff) return
    core.info(`[git] applyDiff: git apply (${diff.length} bytes)`)
    const result = await exec.getExecOutput("git", ["apply"], {
      cwd: this.cwd,
      silent: true,
      ignoreReturnCode: true,
      input: Buffer.from(diff),
    })
    if (result.exitCode !== 0) {
      core.error(`[git] applyDiff failed (exit ${result.exitCode}): ${result.stderr.trim()}`)
      // Log first 500 chars of diff for context
      core.info(`[git] diff preview:\n${diff.slice(0, 500)}`)
      throw new Error(`git apply failed with exit code ${result.exitCode}`)
    }
  }
}

export async function runWithRetries(
  runner: ClaudeRunner,
  git: GitOperations,
  inputs: ActionInputs,
  failureLogs: string,
  previousSuggestions: string,
  userContext: string,
  model: string,
  commandPrompt?: string,
  conversationHistory?: string
): Promise<{ bestAttempt: RetryAttempt; allAttempts: RetryAttempt[]; totalUsage: TotalUsage }> {
  const attempts: RetryAttempt[] = []
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCacheReadTokens = 0
  let totalCacheCreationTokens = 0
  let totalDurationMs = 0

  // Write large context to files so Claude can read only what it needs
  // instead of processing the entire content in the prompt.
  const logsRef = failureLogs
    ? `CI failure logs saved to ${writeContextFile(inputs.workingDirectory, "failure-logs.txt", failureLogs)}. Read the relevant parts to diagnose the issue.`
    : "No failure logs available."
  const suggestionsRef = previousSuggestions
    ? `Previous fix suggestions saved to ${writeContextFile(inputs.workingDirectory, "previous-suggestions.txt", previousSuggestions)}. Read them to avoid repeating the same approaches.`
    : ""
  const historyRef = conversationHistory
    ? `PR conversation history saved to ${writeContextFile(inputs.workingDirectory, "conversation-history.txt", conversationHistory)}. Read it if you need context from prior discussion.`
    : ""

  for (let i = 1; i <= inputs.maxRetries; i++) {
    core.info(`Fix attempt ${i}/${inputs.maxRetries}...`)

    // Reset working tree between attempts
    if (i > 1) {
      await git.resetHard()
      await git.clean()
    }

    // Build prompt
    let prompt: string
    const commonValues = {
      FAILURE_LOGS: logsRef,
      FAILURE_LOGS_IF_AVAILABLE: logsRef,
      PREVIOUS_SUGGESTIONS: suggestionsRef,
      USER_CONTEXT: userContext,
      CONVERSATION_HISTORY: historyRef,
      REPRODUCTION_OUTPUT: "",
      REPO: process.env.GITHUB_REPOSITORY || "",
      BRANCH: inputs.failedBranch,
      SHA: inputs.failedSha,
    }

    if (i === 1 && commandPrompt) {
      // Command-specific prompt template (suggest, alternative)
      prompt = renderPrompt(commandPrompt, commonValues)
    } else if (i === 1) {
      prompt = renderPrompt(inputs.autoFixPrompt, commonValues)
    } else {
      const previousAttemptsContext = attempts
        .map(
          (a) =>
            `Attempt ${a.attempt}: modified ${a.filesChanged.join(", ") || "no files"} - ${a.testOutput || "no test output"}`
        )
        .join("\n")

      prompt = renderPrompt(inputs.retryPrompt, {
        ...commonValues,
        PREVIOUS_ATTEMPTS: previousAttemptsContext,
        REPRODUCTION_OUTPUT: attempts[i - 2]?.reproductionOutput || "",
      })
    }

    // Append confidence prompt
    prompt +=
      "\n\n" +
      renderPrompt(inputs.confidencePrompt, {
        FAILURE_LOGS: logsRef,
        REPRODUCTION_OUTPUT: "",
        FIX_DIFF: "{{WILL_BE_FILLED_AFTER_FIX}}",
        POST_FIX_TEST_OUTPUT: "{{WILL_BE_FILLED_AFTER_TESTS}}",
        PREVIOUS_SUGGESTIONS: suggestionsRef,
        USER_CONTEXT: userContext,
      })

    const result = await runner.run(prompt, model, inputs.maxTurns)

    if (result.usage) {
      totalInputTokens += result.usage.inputTokens
      totalOutputTokens += result.usage.outputTokens
      totalCacheReadTokens += result.usage.cacheReadTokens
      totalCacheCreationTokens += result.usage.cacheCreationTokens
      totalDurationMs += result.usage.durationMs
    }

    const confidence = parseConfidence(result.output, result.diff, result.exitCode)

    attempts.push({
      attempt: i,
      diff: result.diff || null,
      filesChanged: result.filesChanged,
      testOutput: extractTestOutput(result.output),
      reproductionOutput: extractReproductionOutput(result.output),
      confidence,
    })

    // Stop retrying if the fix is good enough:
    // - REPRODUCED_AND_VERIFIED: always stop (best possible outcome).
    // - NOT_REPRODUCED_TESTS_PASS with high confidence: the error couldn't be
    //   reproduced locally (e.g. Trivy vulnerability scan, infra-only checks)
    //   but tests pass and Claude is confident in the fix.
    const shouldStop =
      confidence &&
      (confidence.status === ConfidenceStatus.REPRODUCED_AND_VERIFIED ||
        (confidence.status === ConfidenceStatus.NOT_REPRODUCED_TESTS_PASS &&
          confidence.percentage >= 70))
    if (shouldStop) {
      core.info(`Fix verified on attempt ${i} (${confidence!.status}, ${confidence!.percentage}%)`)
      break
    }

    core.info(
      `Attempt ${i} result: ${confidence?.status || "unknown"} (${confidence?.percentage || 0}%)`
    )
  }

  const bestAttempt = selectBestAttempt(attempts)

  // Restore working directory to match the best attempt's state.
  // The working directory currently has the LAST attempt's state, which may differ.
  if (bestAttempt.diff && bestAttempt.attempt !== attempts.length) {
    core.info(`Best attempt was #${bestAttempt.attempt} (not the last), restoring its changes`)
    await git.resetHard()
    await git.clean()
    await git.applyDiff(bestAttempt.diff)
  }

  const totalUsage: TotalUsage = {
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheReadTokens: totalCacheReadTokens,
    cacheCreationTokens: totalCacheCreationTokens,
    attempts: attempts.length,
    durationMs: totalDurationMs,
  }

  if (totalInputTokens > 0 || totalOutputTokens > 0) {
    core.info(
      `[usage] Total across ${attempts.length} attempt(s): In: ${totalInputTokens} | Out: ${totalOutputTokens}`
    )
  }

  return { bestAttempt, allAttempts: attempts, totalUsage }
}

export function selectBestAttempt(attempts: RetryAttempt[]): RetryAttempt {
  const ranking: ConfidenceStatus[] = [
    ConfidenceStatus.REPRODUCED_AND_VERIFIED,
    ConfidenceStatus.NOT_REPRODUCED_TESTS_PASS,
    ConfidenceStatus.REPRODUCED_TESTS_FAIL,
    ConfidenceStatus.NEITHER,
    ConfidenceStatus.NON_CODE,
    ConfidenceStatus.GAVE_UP,
  ]

  // Prefer attempts with diffs (actual code fixes)
  const withDiffs = attempts.filter((a) => a.diff && a.diff.length > 0)
  if (withDiffs.length > 0) {
    withDiffs.sort((a, b) => {
      const aRank = ranking.indexOf(a.confidence?.status || ConfidenceStatus.GAVE_UP)
      const bRank = ranking.indexOf(b.confidence?.status || ConfidenceStatus.GAVE_UP)
      if (aRank !== bRank) return aRank - bRank
      return (b.confidence?.percentage || 0) - (a.confidence?.percentage || 0)
    })
    return withDiffs[0]
  }

  // No diffs: rank all attempts, non-code is better than gave-up
  const sorted = [...attempts].sort((a, b) => {
    const aRank = ranking.indexOf(a.confidence?.status || ConfidenceStatus.GAVE_UP)
    const bRank = ranking.indexOf(b.confidence?.status || ConfidenceStatus.GAVE_UP)
    if (aRank !== bRank) return aRank - bRank
    return (b.confidence?.percentage || 0) - (a.confidence?.percentage || 0)
  })
  return sorted[0]
}

export function parseConfidence(output: string, diff: string, _exitCode: number): ConfidenceResult {
  const percentMatch = output.match(/CONFIDENCE_PERCENT:\s*(\d+)/)
  const percentage = percentMatch ? Math.min(100, Math.max(0, parseInt(percentMatch[1]))) : 50

  const reproduced =
    /reproduced|error reproduced|successfully reproduced/i.test(output) &&
    !/could not reproduce|unable to reproduce|cannot reproduce/i.test(output)

  const confidenceIdx = output.lastIndexOf("CONFIDENCE_PERCENT")
  const outputAfterConfidence = confidenceIdx >= 0 ? output.slice(confidenceIdx) : output

  const testsPass =
    /tests? pass|all tests? pass|build success|verification success/i.test(output) &&
    !/tests? fail|test failure|build fail/i.test(outputAfterConfidence)

  if (!diff || diff.length === 0) {
    if (/ISSUE_TYPE:\s*NON_CODE/i.test(output)) {
      return {
        status: ConfidenceStatus.NON_CODE,
        percentage,
        reproduced: false,
        testsPass: false,
      }
    }
    return {
      status: ConfidenceStatus.GAVE_UP,
      percentage: 0,
      reproduced: false,
      testsPass: false,
    }
  }

  let status: ConfidenceStatus
  if (reproduced && testsPass) {
    status = ConfidenceStatus.REPRODUCED_AND_VERIFIED
  } else if (!reproduced && testsPass) {
    status = ConfidenceStatus.NOT_REPRODUCED_TESTS_PASS
  } else if (reproduced && !testsPass) {
    status = ConfidenceStatus.REPRODUCED_TESTS_FAIL
  } else {
    status = ConfidenceStatus.NEITHER
  }

  return { status, percentage, reproduced, testsPass }
}

export function generateFixId(diff: string): string {
  const hash = createHash("sha256").update(diff).digest("hex").slice(0, 7)
  return `#fix-${hash}`
}

export function renderPrompt(template: string, values: Record<string, string>): string {
  let result = template
  for (const [key, value] of Object.entries(values)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value)
  }
  return result
}

function extractTestOutput(output: string): string | null {
  const testPatterns = [
    /(?:test|spec|check).*(?:pass|fail|error)[\s\S]{0,500}/gi,
    /(?:BUILD|COMPILATION).*(?:SUCCESS|FAILED)[\s\S]{0,300}/gi,
  ]

  for (const pattern of testPatterns) {
    const match = output.match(pattern)
    if (match) {
      return match[0].slice(0, 1000)
    }
  }

  return null
}

function extractReproductionOutput(output: string): string | null {
  const reproPatterns = [
    /reproduc(?:e|ed|ing)[\s\S]{0,500}/gi,
    /running.*(?:test|spec|check)[\s\S]{0,500}/gi,
  ]

  for (const pattern of reproPatterns) {
    const match = output.match(pattern)
    if (match) {
      return match[0].slice(0, 1000)
    }
  }

  return null
}
