import * as core from "@actions/core"
import * as exec from "@actions/exec"
import { createHash } from "crypto"
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "fs"
import { join } from "path"
import { ConfidenceResult, ConfidenceStatus, RetryAttempt, ActionInputs } from "./types"
import { GitHubClient } from "./github"

const CONTEXT_DIR = ".ci-assistant"

export enum LogPrefix {
  CONTEXT = "context",
  RETRY = "retry",
  GIT = "git",
  USAGE = "usage",
  CLEANUP = "cleanup",
  COMMAND = "command",
  AUTH = "auth",
  SLACK = "slack",
  CLAUDE = "claude",
  TOOL = "tool",
  DONE = "done",
}

export function log(prefix: LogPrefix, message: string): void {
  core.info(`[${prefix}] ${message}`)
}

export function logWarning(prefix: LogPrefix, message: string): void {
  core.warning(`[${prefix}] ${message}`)
}

export function logError(prefix: LogPrefix, message: string): void {
  core.error(`[${prefix}] ${message}`)
}

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

const MAX_AUTO_DOWNLOAD_BYTES = 10 * 1024 * 1024 // 10MB

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/**
 * Downloads failed job logs and artifacts from a workflow run, writing them
 * to .ci-assistant/logs/ and .ci-assistant/artifacts/. Small artifacts
 * (< 10MB) are auto-extracted. Large artifacts are listed in a manifest
 * so Claude can download them via `gh` if needed.
 *
 * Returns a prompt snippet describing what was downloaded and where.
 */
export async function prepareRunContext(
  github: GitHubClient,
  runId: number,
  workingDirectory: string
): Promise<string> {
  const lines: string[] = []
  const repo = process.env.GITHUB_REPOSITORY || ""
  const baseDir = join(workingDirectory, CONTEXT_DIR)
  mkdirSync(baseDir, { recursive: true })
  writeFileSync(join(baseDir, ".gitignore"), "*\n", "utf-8")

  // Download per-job logs
  log(LogPrefix.CONTEXT, `Downloading logs for run ${runId}...`)
  const jobLogs = await github.downloadFailedJobLogs(runId)

  if (jobLogs.length > 0) {
    const logsDir = join(baseDir, "logs")
    mkdirSync(logsDir, { recursive: true })
    for (const job of jobLogs) {
      const safeName = job.name.replace(/[^a-zA-Z0-9._-]/g, "_")
      writeFileSync(join(logsDir, `${safeName}.txt`), job.logs, "utf-8")
      log(LogPrefix.CONTEXT, `Wrote logs for job "${job.name}" (${formatBytes(job.logs.length)})`)
    }
    const jobNames = jobLogs.map((j) => `"${j.name}"`).join(", ")
    lines.push(
      `Failed job logs saved to ${CONTEXT_DIR}/logs/ (${jobLogs.length} job(s): ${jobNames}). ` +
        `Each file is named after the job. Read or grep them to find the error.`
    )
  } else {
    lines.push("No failed job logs available.")
  }

  // List and download artifacts
  log(LogPrefix.CONTEXT, `Listing artifacts for run ${runId}...`)
  const artifacts = await github.listRunArtifacts(runId)

  if (artifacts.length > 0) {
    const artifactsDir = join(baseDir, "artifacts")
    mkdirSync(artifactsDir, { recursive: true })

    const downloaded: string[] = []
    const skipped: { name: string; size: string }[] = []

    for (const artifact of artifacts) {
      if (artifact.sizeBytes <= MAX_AUTO_DOWNLOAD_BYTES) {
        try {
          log(
            LogPrefix.CONTEXT,
            `Downloading artifact "${artifact.name}" (${formatBytes(artifact.sizeBytes)})...`
          )
          const zipBuffer = await github.downloadArtifact(artifact.id)
          // Use artifact name as dir, append ID on collision
          const dirName = existsSync(join(artifactsDir, artifact.name))
            ? `${artifact.name}_${artifact.id}`
            : artifact.name
          const artifactDir = join(artifactsDir, dirName)
          await extractZip(zipBuffer, artifactDir)
          downloaded.push(dirName)
          log(
            LogPrefix.CONTEXT,
            `Extracted artifact "${artifact.name}" to ${CONTEXT_DIR}/artifacts/${dirName}/`
          )
        } catch (error) {
          logWarning(LogPrefix.CONTEXT, `Failed to download artifact "${artifact.name}": ${error}`)
          skipped.push({ name: artifact.name, size: formatBytes(artifact.sizeBytes) })
        }
      } else {
        log(
          LogPrefix.CONTEXT,
          `Skipping large artifact "${artifact.name}" (${formatBytes(artifact.sizeBytes)}, exceeds ${formatBytes(MAX_AUTO_DOWNLOAD_BYTES)} limit)`
        )
        skipped.push({ name: artifact.name, size: formatBytes(artifact.sizeBytes) })
      }
    }

    // Write manifest
    const manifestLines = ["# Artifacts from failed workflow run", ""]
    if (downloaded.length > 0) {
      manifestLines.push("## Downloaded (extracted to artifacts/<name>/)")
      for (const name of downloaded) {
        manifestLines.push(`- ${name}`)
      }
      manifestLines.push("")
    }
    if (skipped.length > 0) {
      manifestLines.push("## Not downloaded (too large or failed)")
      manifestLines.push("Use `gh api` to download if needed:")
      manifestLines.push("")
      for (const { name, size } of skipped) {
        const matchingArtifact = artifacts.find((a) => a.name === name)
        if (matchingArtifact) {
          manifestLines.push(
            `- ${name} (${size}), download with: gh api repos/${repo}/actions/artifacts/${matchingArtifact.id}/zip > ${name}.zip`
          )
        }
      }
      manifestLines.push("")
    }
    writeFileSync(join(artifactsDir, "manifest.txt"), manifestLines.join("\n"), "utf-8")

    if (downloaded.length > 0) {
      lines.push(
        `Artifacts extracted to ${CONTEXT_DIR}/artifacts/ (${downloaded.join(", ")}). ` +
          `Check these for detailed reports (e.g. vulnerability-report.json).`
      )
    }
    if (skipped.length > 0) {
      lines.push(
        `${skipped.length} large artifact(s) were not auto-downloaded. ` +
          `See ${CONTEXT_DIR}/artifacts/manifest.txt for download commands if you need them.`
      )
    }
  }

  // Give Claude the run info so it can fetch more data via `gh` if needed
  lines.push(
    `Failed workflow run: ${repo} run ID ${runId}. ` +
      `Use \`gh run view ${runId}\` or \`gh api repos/${repo}/actions/runs/${runId}\` for more details.`
  )

  return lines.join("\n")
}

async function extractZip(zipBuffer: Buffer, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true })
  // Use native unzip via exec since we're already in a Node.js GitHub Action runner
  const tmpZip = join(destDir, "__tmp.zip")
  writeFileSync(tmpZip, zipBuffer)
  try {
    await exec.exec("unzip", ["-o", "-q", tmpZip, "-d", destDir], {
      silent: true,
      ignoreReturnCode: true,
    })
  } finally {
    try {
      unlinkSync(tmpZip)
    } catch {
      // best effort cleanup
    }
  }
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
          parts.push(`[${LogPrefix.CLAUDE}] ${c.text}`)
        } else if (c.type === "tool_use" && c.name) {
          const input = JSON.stringify(c.input ?? {})
          parts.push(`[${LogPrefix.TOOL}] ${c.name}: ${input}`)
        }
      }
      return parts.length > 0 ? parts.join("\n") : null
    }

    case "result": {
      const u = event.usage
      if (!u)
        return `[${LogPrefix.DONE}] turns=${event.num_turns ?? 0} ${((event.duration_ms ?? 0) / 1000).toFixed(1)}s`
      return (
        `[${LogPrefix.DONE}] turns=${event.num_turns ?? 0}` +
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
    log(LogPrefix.GIT, "resetHard: git checkout -- .")
    const result = await exec.getExecOutput("git", ["checkout", "--", "."], {
      cwd: this.cwd,
      silent: true,
      ignoreReturnCode: true,
    })
    if (result.exitCode !== 0) {
      logError(LogPrefix.GIT, `resetHard failed (exit ${result.exitCode}): ${result.stderr.trim()}`)
      // Log git status for context
      const status = await exec.getExecOutput("git", ["status", "--short"], {
        cwd: this.cwd,
        silent: true,
        ignoreReturnCode: true,
      })
      log(LogPrefix.GIT, `status after failed resetHard:\n${status.stdout.trim()}`)
      throw new Error(`git checkout -- . failed with exit code ${result.exitCode}`)
    }
  }

  async clean(): Promise<void> {
    log(LogPrefix.GIT, "clean: git clean -fd")
    const result = await exec.getExecOutput("git", ["clean", "-fd"], {
      cwd: this.cwd,
      silent: true,
      ignoreReturnCode: true,
    })
    if (result.exitCode !== 0) {
      logError(LogPrefix.GIT, `clean failed (exit ${result.exitCode}): ${result.stderr.trim()}`)
      throw new Error(`git clean -fd failed with exit code ${result.exitCode}`)
    }
  }

  async applyDiff(diff: string): Promise<void> {
    if (!diff) return
    log(LogPrefix.GIT, `applyDiff: git apply (${diff.length} bytes)`)
    const result = await exec.getExecOutput("git", ["apply"], {
      cwd: this.cwd,
      silent: true,
      ignoreReturnCode: true,
      input: Buffer.from(diff),
    })
    if (result.exitCode !== 0) {
      logError(LogPrefix.GIT, `applyDiff failed (exit ${result.exitCode}): ${result.stderr.trim()}`)
      // Log first 500 chars of diff for context
      log(LogPrefix.GIT, `diff that failed to apply:\n${diff}`)
      throw new Error(`git apply failed with exit code ${result.exitCode}`)
    }
  }
}

export async function runWithRetries(
  runner: ClaudeRunner,
  git: GitOperations,
  inputs: ActionInputs,
  runContextRef: string,
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

  // Write remaining large context to files
  const suggestionsRef = previousSuggestions
    ? `Previous fix suggestions saved to ${writeContextFile(inputs.workingDirectory, "previous-suggestions.txt", previousSuggestions)}. Read them to avoid repeating the same approaches.`
    : ""
  const historyRef = conversationHistory
    ? `PR conversation history saved to ${writeContextFile(inputs.workingDirectory, "conversation-history.txt", conversationHistory)}. Read it if you need context from prior discussion.`
    : ""

  for (let i = 1; i <= inputs.maxRetries; i++) {
    log(LogPrefix.RETRY, `Fix attempt ${i}/${inputs.maxRetries}...`)

    // Reset working tree between attempts
    if (i > 1) {
      await git.resetHard()
      await git.clean()
    }

    // Build prompt
    let prompt: string
    const commonValues = {
      FAILURE_LOGS: runContextRef,
      FAILURE_LOGS_IF_AVAILABLE: runContextRef,
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
            `Attempt ${a.attempt}: modified ${a.filesChanged.join(", ") || "no files"}. Full output saved to ${a.outputFile}.`
        )
        .join("\n")

      const prevAttempt = attempts[i - 2]
      prompt = renderPrompt(inputs.retryPrompt, {
        ...commonValues,
        PREVIOUS_ATTEMPTS: previousAttemptsContext,
        REPRODUCTION_OUTPUT: prevAttempt?.outputFile
          ? `Previous attempt output saved to ${prevAttempt.outputFile}. Read it for reproduction details.`
          : "",
      })
    }

    // Append confidence prompt
    prompt +=
      "\n\n" +
      renderPrompt(inputs.confidencePrompt, {
        FAILURE_LOGS: runContextRef,
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

    // Write full Claude output per attempt so retries can reference it
    const outputFile = writeContextFile(
      inputs.workingDirectory,
      `attempt-${i}-output.txt`,
      result.output
    )

    attempts.push({
      attempt: i,
      diff: result.diff || null,
      filesChanged: result.filesChanged,
      testOutput: extractTestOutput(result.output),
      reproductionOutput: extractReproductionOutput(result.output),
      outputFile,
      confidence,
    })

    // Stop retrying if the fix is good enough:
    // - REPRODUCED_AND_VERIFIED: always stop.
    // - NOT_REPRODUCED_TESTS_PASS with >= 70% confidence.
    // - NEITHER with >= 80% confidence: fallback for when markers are missing
    //   or the verification doesn't fit neatly into reproduced/verified categories.
    const shouldStop =
      confidence &&
      (confidence.status === ConfidenceStatus.REPRODUCED_AND_VERIFIED ||
        (confidence.status === ConfidenceStatus.NOT_REPRODUCED_TESTS_PASS &&
          confidence.percentage >= 70) ||
        (confidence.status === ConfidenceStatus.NEITHER && confidence.percentage >= 80))
    if (shouldStop) {
      log(
        LogPrefix.RETRY,
        `Fix verified on attempt ${i} (${confidence!.status}, ${confidence!.percentage}%)`
      )
      break
    }

    log(
      LogPrefix.RETRY,
      `Attempt ${i} result: ${confidence?.status || "unknown"} (${confidence?.percentage || 0}%)`
    )
  }

  const bestAttempt = selectBestAttempt(attempts)

  // Restore working directory to match the best attempt's state.
  // The working directory currently has the LAST attempt's state, which may differ.
  if (bestAttempt.diff && bestAttempt.attempt !== attempts.length) {
    log(
      LogPrefix.RETRY,
      `Best attempt was #${bestAttempt.attempt} (not the last), restoring its changes`
    )
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
    log(
      LogPrefix.USAGE,
      `Total across ${attempts.length} attempt(s): In: ${totalInputTokens} | Out: ${totalOutputTokens} | Cache read: ${totalCacheReadTokens} | Cache create: ${totalCacheCreationTokens}`
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

  // Parse structured markers from Claude's output
  const reproducedMatch = output.match(/REPRODUCED:\s*(YES|NO)/i)
  const verifiedMatch = output.match(/VERIFIED:\s*(YES|NO)/i)

  const reproduced = reproducedMatch ? reproducedMatch[1].toUpperCase() === "YES" : false
  const testsPass = verifiedMatch ? verifiedMatch[1].toUpperCase() === "YES" : false

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
      return match[0]
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
      return match[0]
    }
  }

  return null
}
