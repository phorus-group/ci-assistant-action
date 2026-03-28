import * as core from "@actions/core"
import * as exec from "@actions/exec"
import * as github from "@actions/github"
import {
  MetaComment,
  createDefaultMeta,
  META_MARKER,
  SUGGESTION_HEADER,
  ConfidenceResult,
  CONFIDENCE_STATUS_ICONS,
  CONFIDENCE_STATUS_LABELS,
} from "./types"

export interface GitHubClient {
  getComments(prNumber: number): Promise<PRComment[]>
  createComment(prNumber: number, body: string): Promise<PRComment>
  updateComment(commentId: number, body: string): Promise<void>
  getPR(prNumber: number): Promise<PR>
  createPR(params: CreatePRParams): Promise<PR>
  closePR(prNumber: number): Promise<void>
  listPRs(params: ListPRsParams): Promise<PR[]>
  downloadRunLogs(runId: number): Promise<string>
  getRunInfo(runId: number): Promise<RunInfo>
  getAuthenticatedUser(): Promise<string>
  listRefs(prefix: string): Promise<string[]>
  deleteRef(ref: string): Promise<void>
  isTag(ref: string): Promise<boolean>
}

export interface PRComment {
  id: number
  body: string
  user: { login: string; type: string }
}

export interface PR {
  number: number
  state: string
  head: { ref: string; sha: string }
  base: { ref: string }
}

export interface CreatePRParams {
  title: string
  body: string
  head: string
  base: string
}

export interface ListPRsParams {
  head?: string
  base?: string
  state?: string
}

export interface RunInfo {
  id: number
  head_branch: string
  head_sha: string
  conclusion: string
  repository: { full_name: string }
}

type OctokitClient = ReturnType<typeof github.getOctokit>

interface OctokitComment {
  id: number
  body?: string | null
  user?: { login?: string; type?: string } | null
}

interface OctokitPR {
  number: number
  state: string
  head: { ref: string; sha: string }
  base: { ref: string }
}

interface OctokitJob {
  conclusion: string | null
}

interface OctokitRef {
  ref: string
}

export class OctokitGitHubClient implements GitHubClient {
  private octokit: OctokitClient
  private owner: string
  private repo: string

  constructor(token: string = "") {
    this.octokit = github.getOctokit(token)
    const [owner, repo] = (process.env.GITHUB_REPOSITORY || "").split("/")
    this.owner = owner
    this.repo = repo
  }

  async getComments(prNumber: number): Promise<PRComment[]> {
    const { data } = await this.octokit.rest.issues.listComments({
      owner: this.owner,
      repo: this.repo,
      issue_number: prNumber,
      per_page: 100,
    })
    return data.map((c: OctokitComment) => ({
      id: c.id,
      body: c.body || "",
      user: { login: c.user?.login || "", type: c.user?.type || "" },
    }))
  }

  async createComment(prNumber: number, body: string): Promise<PRComment> {
    const { data } = await this.octokit.rest.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: prNumber,
      body,
    })
    return {
      id: data.id,
      body: data.body || "",
      user: {
        login: data.user?.login || "",
        type: data.user?.type || "",
      },
    }
  }

  async updateComment(commentId: number, body: string): Promise<void> {
    await this.octokit.rest.issues.updateComment({
      owner: this.owner,
      repo: this.repo,
      comment_id: commentId,
      body,
    })
  }

  async getPR(prNumber: number): Promise<PR> {
    const { data } = await this.octokit.rest.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
    })
    return {
      number: data.number,
      state: data.state,
      head: { ref: data.head.ref, sha: data.head.sha },
      base: { ref: data.base.ref },
    }
  }

  async createPR(params: CreatePRParams): Promise<PR> {
    const { data } = await this.octokit.rest.pulls.create({
      owner: this.owner,
      repo: this.repo,
      title: params.title,
      body: params.body,
      head: params.head,
      base: params.base,
    })
    return {
      number: data.number,
      state: data.state,
      head: { ref: data.head.ref, sha: data.head.sha },
      base: { ref: data.base.ref },
    }
  }

  async closePR(prNumber: number): Promise<void> {
    await this.octokit.rest.pulls.update({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      state: "closed",
    })
  }

  async listPRs(params: ListPRsParams): Promise<PR[]> {
    const { data } = await this.octokit.rest.pulls.list({
      owner: this.owner,
      repo: this.repo,
      head: params.head ? `${this.owner}:${params.head}` : undefined,
      base: params.base,
      state: (params.state as "open" | "closed" | "all") || "open",
    })
    return data.map((pr: OctokitPR) => ({
      number: pr.number,
      state: pr.state,
      head: { ref: pr.head.ref, sha: pr.head.sha },
      base: { ref: pr.base.ref },
    }))
  }

  async downloadRunLogs(runId: number): Promise<string> {
    try {
      const { data } = await this.octokit.rest.actions.listJobsForWorkflowRun({
        owner: this.owner,
        repo: this.repo,
        run_id: runId,
        filter: "latest",
      })

      const failedJobs = data.jobs.filter((j: OctokitJob) => j.conclusion === "failure")
      if (failedJobs.length === 0) {
        return "No failed jobs found in the workflow run."
      }

      let logs = ""
      for (const job of failedJobs) {
        try {
          const { data: logData } = await this.octokit.rest.actions.downloadJobLogsForWorkflowRun({
            owner: this.owner,
            repo: this.repo,
            job_id: job.id,
          })
          logs += `\n--- Job: ${job.name} ---\n${logData}\n`
        } catch {
          logs += `\n--- Job: ${job.name} (logs unavailable) ---\n`
        }
      }

      const maxLogSize = 100 * 1024
      if (logs.length > maxLogSize) {
        logs = "[...truncated, showing last 100KB...]\n" + logs.slice(logs.length - maxLogSize)
      }

      return logs
    } catch (error) {
      core.warning(`Failed to download logs for run ${runId}: ${error}`)
      return "Failed to download pipeline logs."
    }
  }

  async getRunInfo(runId: number): Promise<RunInfo> {
    const { data } = await this.octokit.rest.actions.getWorkflowRun({
      owner: this.owner,
      repo: this.repo,
      run_id: runId,
    })
    return {
      id: data.id,
      head_branch: data.head_branch || "",
      head_sha: data.head_sha,
      conclusion: data.conclusion || "",
      repository: { full_name: data.repository.full_name },
    }
  }

  async getAuthenticatedUser(): Promise<string> {
    try {
      const { data } = await this.octokit.rest.users.getAuthenticated()
      return data.login
    } catch {
      return "github-actions[bot]"
    }
  }

  async listRefs(prefix: string): Promise<string[]> {
    try {
      const { data } = await this.octokit.rest.git.listMatchingRefs({
        owner: this.owner,
        repo: this.repo,
        ref: prefix,
      })
      return data.map((r: OctokitRef) => r.ref)
    } catch {
      return []
    }
  }

  async deleteRef(ref: string): Promise<void> {
    await this.octokit.rest.git.deleteRef({
      owner: this.owner,
      repo: this.repo,
      ref: ref.replace("refs/", ""),
    })
  }

  async isTag(ref: string): Promise<boolean> {
    try {
      await this.octokit.rest.git.getRef({
        owner: this.owner,
        repo: this.repo,
        ref: `tags/${ref}`,
      })
      return true
    } catch {
      return false
    }
  }
}

export async function resolveTagTargetBranch(tag: string): Promise<string | null> {
  // Fetch full history if needed (shallow clones can't resolve branch containment)
  try {
    await exec.exec("git", ["fetch", "--unshallow"], {
      silent: true,
      ignoreReturnCode: true,
    })
  } catch {
    // Already unshallowed or not a shallow clone
  }

  try {
    const result = await exec.getExecOutput(
      "git",
      ["branch", "-r", "--contains", `refs/tags/${tag}`, "--format=%(refname:short)"],
      { silent: true, ignoreReturnCode: true }
    )
    if (result.exitCode === 0 && result.stdout.trim()) {
      const branches = result.stdout
        .trim()
        .split("\n")
        .map((b) => b.replace("origin/", "").trim())
        .filter((b) => b && !b.startsWith("ci-assistant/") && b !== "HEAD")
      if (branches.length > 0) {
        return branches[0]
      }
    }
  } catch {
    // git command failed
  }

  // Cannot determine source branch, return null to signal caller should not guess
  return null
}

export async function readMeta(
  client: GitHubClient,
  prNumber: number,
  botUsername: string
): Promise<{ meta: MetaComment; commentId: number | null }> {
  const comments = await client.getComments(prNumber)

  for (const comment of comments) {
    if (comment.user.login === botUsername && comment.body.includes(META_MARKER)) {
      try {
        const jsonMatch = comment.body.match(/<!-- ci-assistant-meta: ({.*?}) -->/s)
        if (jsonMatch) {
          const meta = JSON.parse(jsonMatch[1]) as MetaComment
          return { meta: { ...createDefaultMeta(), ...meta }, commentId: comment.id }
        }
      } catch {
        core.warning(`Failed to parse meta comment ${comment.id}`)
      }
    }
  }

  return { meta: createDefaultMeta(), commentId: null }
}

export async function writeMeta(
  client: GitHubClient,
  prNumber: number,
  meta: MetaComment,
  commentId: number | null
): Promise<number> {
  const body = `${META_MARKER} ${JSON.stringify(meta)} -->`

  if (commentId) {
    await client.updateComment(commentId, body)
    return commentId
  }

  const comment = await client.createComment(prNumber, body)
  return comment.id
}

export function getPreviousSuggestions(
  comments: PRComment[],
  botUsername: string
): { fixId: string; diff: string; summary: string }[] {
  const suggestions: { fixId: string; diff: string; summary: string }[] = []

  for (const comment of comments) {
    if (comment.user.login === botUsername && comment.body.includes(SUGGESTION_HEADER)) {
      const fixIdMatch = comment.body.match(/## CI Assistant Suggestion `(#fix-[a-f0-9]+)`/)
      const diffMatch = comment.body.match(/```diff\n([\s\S]*?)```/)
      const summaryMatch = comment.body.match(/### Summary\n([\s\S]*?)(?=\n###)/)

      if (fixIdMatch) {
        suggestions.push({
          fixId: fixIdMatch[1],
          diff: diffMatch ? diffMatch[1].trim() : "",
          summary: summaryMatch ? summaryMatch[1].trim() : "",
        })
      }
    }
  }

  return suggestions
}

export function formatSuggestionComment(params: {
  fixId: string
  summary: string
  errorDetails: string
  diff: string
  confidence: ConfidenceResult
  filesChanged: number
}): string {
  const { fixId, summary, errorDetails, diff, confidence, filesChanged } = params

  const icon = CONFIDENCE_STATUS_ICONS[confidence.status]
  const label = CONFIDENCE_STATUS_LABELS[confidence.status]

  const maxDiffLen = 50000
  let diffBlock = diff
  let truncatedNote = ""
  if (diff.length > maxDiffLen) {
    diffBlock = diff.slice(0, maxDiffLen)
    truncatedNote =
      "\n\n_Diff truncated. Accept the fix to see full changes, or use `/ci-assistant explain` for a detailed walkthrough._"
  }

  return `${SUGGESTION_HEADER} \`${fixId}\`

**Status:** ${icon} ${label} (${confidence.percentage}% confidence)
**Reproduced:** ${confidence.reproduced ? "Yes" : "No"} | **Tests pass after fix:** ${confidence.testsPass ? "Yes" : "No"}

### Summary
${summary}

### What failed
<details>
<summary>Error details</summary>

${errorDetails}

</details>

### Suggested fix
<details>
<summary>View diff (${filesChanged} files changed)</summary>

\`\`\`diff
${diffBlock}
\`\`\`${truncatedNote}

</details>

<sub>

\`${fixId}\` | \`/ci-assistant accept\` | \`/ci-assistant alternative\` | \`/ci-assistant suggest <context>\` | \`/ci-assistant explain\` | \`/ci-assistant help\`

</sub>`
}

export function formatNonCodeComment(params: {
  analysis: string
  confidence: ConfidenceResult
}): string {
  const { analysis, confidence } = params

  return `${SUGGESTION_HEADER}

**Status:** :blue_circle: Non-code issue (${confidence.percentage}% confidence)

### Analysis
${analysis}

This failure does not appear to be caused by code changes. Common causes: runner issues, network timeouts, out of memory, flaky infrastructure.

<sub>

\`/ci-assistant suggest <context>\` | \`/ci-assistant alternative\` | \`/ci-assistant explain\` | \`/ci-assistant help\`

</sub>`
}

export function formatGaveUpComment(analysis: string): string {
  return `${SUGGESTION_HEADER}

**Status:** :red_circle: Could not fix

### Analysis
${analysis}

CI Assistant was unable to produce a fix for this failure after all retry attempts.

<sub>

\`/ci-assistant retry\` | \`/ci-assistant suggest <context>\` | \`/ci-assistant help\`

</sub>`
}

export async function createBranchAndPushFix(branchName: string, baseSha: string): Promise<void> {
  await exec.exec("git", ["checkout", "-b", branchName, baseSha], { silent: true })

  await exec.exec("git", ["add", "-A"], { silent: true })

  await exec.exec("git", ["commit", "-m", `ci-assistant: automated fix for pipeline failure`], {
    silent: true,
  })

  await exec.exec("git", ["push", "origin", branchName], { silent: true })

  core.info(`Created and pushed branch ${branchName}`)
}

export async function createFixRef(prNumber: number, fixId: string): Promise<void> {
  const ref = `refs/ci-assistant/${prNumber}/${fixId}`
  let tree = ""
  let commit = ""

  await exec.exec("git", ["add", "-A"], { silent: true })

  const treeResult = await exec.getExecOutput("git", ["write-tree"], {
    silent: true,
  })
  tree = treeResult.stdout.trim()

  const headResult = await exec.getExecOutput("git", ["rev-parse", "HEAD"], { silent: true })
  const parent = headResult.stdout.trim()

  const commitResult = await exec.getExecOutput(
    "git",
    ["commit-tree", tree, "-p", parent, "-m", `ci-assistant: ${fixId}`],
    { silent: true }
  )
  commit = commitResult.stdout.trim()

  await exec.exec("git", ["push", "origin", `${commit}:${ref}`], {
    silent: true,
  })

  await exec.exec("git", ["reset", "--hard", "HEAD"], { silent: true })
  core.info(`Stored fix as ref ${ref}`)
}

export async function acceptFixFromRef(
  prNumber: number,
  fixId: string
): Promise<{ success: boolean; error?: string }> {
  const ref = `refs/ci-assistant/${prNumber}/${fixId}`

  try {
    await exec.exec("git", ["fetch", "origin", ref], { silent: true })
    await exec.exec("git", ["cherry-pick", "FETCH_HEAD"], { silent: true })
    await exec.exec("git", ["push"], { silent: true })
    return { success: true }
  } catch {
    await exec.exec("git", ["cherry-pick", "--abort"], {
      silent: true,
      ignoreReturnCode: true,
    })
    return {
      success: false,
      error: `Cherry-pick failed. The branch may have moved forward since the fix was suggested. Please resolve manually.\n\nYou can fetch the fix with:\n\`\`\`\ngit fetch origin ${ref}\ngit cherry-pick FETCH_HEAD\n\`\`\``,
    }
  }
}

export async function cleanupOrphanedRefs(client: GitHubClient): Promise<number> {
  const refs = await client.listRefs("ci-assistant/")
  let cleaned = 0

  const prNumbers = new Set<number>()
  for (const ref of refs) {
    const match = ref.match(/refs\/ci-assistant\/(\d+)\//)
    if (match) {
      prNumbers.add(parseInt(match[1]))
    }
  }

  for (const prNumber of prNumbers) {
    try {
      const pr = await client.getPR(prNumber)
      if (pr.state === "closed") {
        const prRefs = refs.filter((r) => r.startsWith(`refs/ci-assistant/${prNumber}/`))
        for (const ref of prRefs) {
          await client.deleteRef(ref)
          cleaned++
        }
        core.info(`Cleaned up ${prRefs.length} refs for closed PR #${prNumber}`)
      }
    } catch {
      core.warning(`Could not check PR #${prNumber} status for ref cleanup`)
    }
  }

  return cleaned
}
