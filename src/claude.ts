import * as core from "@actions/core"
import * as exec from "@actions/exec"
import { createHash } from "crypto"
import { ConfidenceResult, ConfidenceStatus, RetryAttempt, ActionInputs } from "./types"

export interface ClaudeRunner {
  run(prompt: string, model: string, maxTurns: number): Promise<ClaudeResult>
}

export interface ClaudeResult {
  output: string
  exitCode: number
  diff: string
  filesChanged: string[]
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
    args.push("--print", "-p", prompt)
    return args
  }

  async run(prompt: string, model: string, maxTurns: number): Promise<ClaudeResult> {
    let output = ""
    let exitCode = 0

    try {
      const args = this.buildArgs(prompt, model, maxTurns)

      const result = await exec.getExecOutput("claude", args, {
        cwd: this.workingDirectory,
        silent: false,
        ignoreReturnCode: true,
        env: process.env as Record<string, string>,
      })
      output = result.stdout + result.stderr
      exitCode = result.exitCode
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
    const diff = diffResult.stdout.trim()

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

    return { output, exitCode, diff, filesChanged }
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
    await exec.exec("git", ["checkout", "--", "."], {
      cwd: this.cwd,
      silent: true,
    })
  }

  async clean(): Promise<void> {
    await exec.exec("git", ["clean", "-fd"], {
      cwd: this.cwd,
      silent: true,
    })
  }

  async applyDiff(diff: string): Promise<void> {
    if (!diff) return
    await exec.exec("git", ["apply"], {
      cwd: this.cwd,
      silent: true,
      input: Buffer.from(diff),
    })
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
): Promise<{ bestAttempt: RetryAttempt; allAttempts: RetryAttempt[] }> {
  const attempts: RetryAttempt[] = []

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
      FAILURE_LOGS: failureLogs,
      FAILURE_LOGS_IF_AVAILABLE: failureLogs || "",
      PREVIOUS_SUGGESTIONS: previousSuggestions,
      USER_CONTEXT: userContext,
      CONVERSATION_HISTORY: conversationHistory || "",
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
        FAILURE_LOGS: failureLogs,
        REPRODUCTION_OUTPUT: "",
        FIX_DIFF: "{{WILL_BE_FILLED_AFTER_FIX}}",
        POST_FIX_TEST_OUTPUT: "{{WILL_BE_FILLED_AFTER_TESTS}}",
        PREVIOUS_SUGGESTIONS: previousSuggestions,
        USER_CONTEXT: userContext,
      })

    const result = await runner.run(prompt, model, inputs.maxTurns)

    const confidence = parseConfidence(result.output, result.diff, result.exitCode)

    attempts.push({
      attempt: i,
      diff: result.diff || null,
      filesChanged: result.filesChanged,
      testOutput: extractTestOutput(result.output),
      reproductionOutput: extractReproductionOutput(result.output),
      confidence,
    })

    // Stop retrying if the fix is strong enough:
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

  return { bestAttempt, allAttempts: attempts }
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
