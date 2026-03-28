import { GitHubClient, PRComment, PR, CreatePRParams, ListPRsParams, RunInfo } from "../src/github"
import { SlackClient } from "../src/slack"
import { ClaudeRunner, ClaudeResult, GitOperations } from "../src/claude"
import { SlackBlock } from "../src/types"

export class MockGitHubClient implements GitHubClient {
  comments: Map<number, PRComment[]> = new Map()
  prs: Map<number, PR> = new Map()
  refs: string[] = []
  logs: Map<number, string> = new Map()
  runs: Map<number, RunInfo> = new Map()
  authenticatedUser = "github-actions[bot]"
  tags: Set<string> = new Set()
  deletedRefs: string[] = []
  branchConclusions: Map<string, string> = new Map()

  private nextCommentId = 1
  private nextPrNumber = 100

  addComment(prNumber: number, comment: Partial<PRComment>): PRComment {
    const full: PRComment = {
      id: this.nextCommentId++,
      body: comment.body || "",
      user: comment.user || {
        login: this.authenticatedUser,
        type: "Bot",
      },
    }
    const existing = this.comments.get(prNumber) || []
    existing.push(full)
    this.comments.set(prNumber, existing)
    return full
  }

  addPR(pr: Partial<PR> & { number: number }): PR {
    const full: PR = {
      number: pr.number,
      state: pr.state || "open",
      head: pr.head || { ref: "feature", sha: "abc123" },
      base: pr.base || { ref: "main" },
    }
    this.prs.set(pr.number, full)
    return full
  }

  setRunInfo(runId: number, info: Partial<RunInfo>): void {
    this.runs.set(runId, {
      id: runId,
      head_branch: info.head_branch || "main",
      head_sha: info.head_sha || "abc123",
      conclusion: info.conclusion || "failure",
      repository: info.repository || { full_name: "owner/repo" },
    })
  }

  setLogs(runId: number, logs: string): void {
    this.logs.set(runId, logs)
  }

  async getComments(prNumber: number): Promise<PRComment[]> {
    return this.comments.get(prNumber) || []
  }

  async createComment(prNumber: number, body: string): Promise<PRComment> {
    return this.addComment(prNumber, {
      body,
      user: { login: this.authenticatedUser, type: "Bot" },
    })
  }

  async updateComment(commentId: number, body: string): Promise<void> {
    for (const [, comments] of this.comments) {
      const comment = comments.find((c) => c.id === commentId)
      if (comment) {
        comment.body = body
        return
      }
    }
  }

  async getPR(prNumber: number): Promise<PR> {
    const pr = this.prs.get(prNumber)
    if (!pr) throw new Error(`PR #${prNumber} not found`)
    return pr
  }

  async createPR(params: CreatePRParams): Promise<PR> {
    const pr: PR = {
      number: this.nextPrNumber++,
      state: "open",
      head: { ref: params.head, sha: "new-sha" },
      base: { ref: params.base },
    }
    this.prs.set(pr.number, pr)
    return pr
  }

  async closePR(prNumber: number): Promise<void> {
    const pr = this.prs.get(prNumber)
    if (pr) pr.state = "closed"
  }

  async listPRs(params: ListPRsParams): Promise<PR[]> {
    return Array.from(this.prs.values()).filter((pr) => {
      if (params.state && pr.state !== params.state) return false
      if (params.head && pr.head.ref !== params.head) return false
      if (params.base && pr.base.ref !== params.base) return false
      return true
    })
  }

  async downloadRunLogs(runId: number): Promise<string> {
    return this.logs.get(runId) || "No logs available"
  }

  async getRunInfo(runId: number): Promise<RunInfo> {
    const info = this.runs.get(runId)
    if (!info) throw new Error(`Run ${runId} not found`)
    return info
  }

  async getAuthenticatedUser(): Promise<string> {
    return this.authenticatedUser
  }

  async listRefs(prefix: string): Promise<string[]> {
    return this.refs.filter((r) => r.includes(prefix))
  }

  async deleteRef(ref: string): Promise<void> {
    this.refs = this.refs.filter((r) => r !== ref)
    this.deletedRefs.push(ref)
  }

  async isTag(ref: string): Promise<boolean> {
    return this.tags.has(ref)
  }

  async getBranchLatestConclusion(branch: string): Promise<string | null> {
    return this.branchConclusions.get(branch) ?? null
  }

  getCommentsForPR(prNumber: number): PRComment[] {
    return this.comments.get(prNumber) || []
  }
}

export class MockSlackClient implements SlackClient {
  messages: {
    channel: string
    blocks: SlackBlock[]
    text: string
    threadTs?: string
    ts: string
  }[] = []
  updates: {
    channel: string
    ts: string
    blocks: SlackBlock[]
    text: string
  }[] = []

  private nextTs = 1000000

  async postMessage(
    channel: string,
    blocks: SlackBlock[],
    text: string,
    threadTs?: string
  ): Promise<string | null> {
    const ts = `${this.nextTs++}.000000`
    this.messages.push({ channel, blocks, text, threadTs, ts })
    return ts
  }

  async updateMessage(
    channel: string,
    ts: string,
    blocks: SlackBlock[],
    text: string
  ): Promise<void> {
    this.updates.push({ channel, ts, blocks, text })
  }

  getLastMessage() {
    return this.messages[this.messages.length - 1]
  }

  getLastUpdate() {
    return this.updates[this.updates.length - 1]
  }
}

export class MockClaudeRunner implements ClaudeRunner {
  results: ClaudeResult[] = []
  private callIndex = 0

  addResult(result: Partial<ClaudeResult>): void {
    this.results.push({
      output: result.output || "",
      exitCode: result.exitCode || 0,
      diff: result.diff || "",
      filesChanged: result.filesChanged || [],
    })
  }

  async run(_prompt: string, _model: string, _maxTurns: number): Promise<ClaudeResult> {
    if (this.callIndex >= this.results.length) {
      return { output: "", exitCode: 1, diff: "", filesChanged: [] }
    }
    return this.results[this.callIndex++]
  }
}

export class MockGitOperations implements GitOperations {
  resetCount = 0
  cleanCount = 0

  async resetHard(): Promise<void> {
    this.resetCount++
  }

  async clean(): Promise<void> {
    this.cleanCount++
  }

  async applyDiff(_diff: string): Promise<void> {
    // No-op in tests
  }
}

export function setEnv(vars: Record<string, string>): () => void {
  const originals: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(vars)) {
    originals[key] = process.env[key]
    process.env[key] = value
  }
  return () => {
    for (const [key] of Object.entries(vars)) {
      if (originals[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = originals[key]
      }
    }
  }
}

export function setInputs(inputs: Record<string, string>): () => void {
  const envVars: Record<string, string> = {}
  for (const [key, value] of Object.entries(inputs)) {
    envVars[`INPUT_${key.toUpperCase().replace(/-/g, "_")}`] = value
  }
  return setEnv(envVars)
}
