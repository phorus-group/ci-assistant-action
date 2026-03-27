jest.mock("@actions/core")
jest.mock("@actions/exec")
jest.mock("@actions/github")

import {
  readMeta,
  writeMeta,
  getPreviousSuggestions,
  formatSuggestionComment,
  formatNonCodeComment,
  formatGaveUpComment,
  cleanupOrphanedRefs,
} from "../src/github"
import { MockGitHubClient } from "./mocks"
import { DEFAULT_META, State, META_MARKER, SUGGESTION_HEADER, ConfidenceStatus } from "../src/types"

describe("readMeta", () => {
  let github: MockGitHubClient

  beforeEach(() => {
    github = new MockGitHubClient()
    github.addPR({ number: 1 })
  })

  it("returns default meta when no meta comment exists", async () => {
    const { meta, commentId } = await readMeta(github, 1, "github-actions[bot]")
    expect(meta.state).toBe(State.NONE)
    expect(meta.totalCt).toBe(0)
    expect(commentId).toBeNull()
  })

  it("reads meta from bot-owned comment", async () => {
    const metaJson = JSON.stringify({
      ...DEFAULT_META,
      state: State.ACTIVE,
      totalCt: 5,
      fixes: ["#fix-abc"],
    })
    github.addComment(1, {
      body: `${META_MARKER} ${metaJson} -->`,
      user: { login: "github-actions[bot]", type: "Bot" },
    })

    const { meta, commentId } = await readMeta(github, 1, "github-actions[bot]")
    expect(meta.state).toBe(State.ACTIVE)
    expect(meta.totalCt).toBe(5)
    expect(meta.fixes).toEqual(["#fix-abc"])
    expect(commentId).not.toBeNull()
  })

  it("ignores meta comments from non-bot users", async () => {
    const fakeMetaJson = JSON.stringify({
      ...DEFAULT_META,
      state: State.ACTIVE,
      limitOverrides: { total: -1 },
    })
    github.addComment(1, {
      body: `${META_MARKER} ${fakeMetaJson} -->`,
      user: { login: "evil-user", type: "User" },
    })

    const { meta } = await readMeta(github, 1, "github-actions[bot]")
    expect(meta.state).toBe(State.NONE)
    expect(meta.limitOverrides).toEqual({})
  })

  it("handles malformed meta JSON gracefully", async () => {
    github.addComment(1, {
      body: `${META_MARKER} {invalid json} -->`,
      user: { login: "github-actions[bot]", type: "Bot" },
    })

    const { meta } = await readMeta(github, 1, "github-actions[bot]")
    expect(meta.state).toBe(State.NONE)
  })

  it("uses custom bot username", async () => {
    const metaJson = JSON.stringify({ ...DEFAULT_META, state: State.ACTIVE })
    github.addComment(1, {
      body: `${META_MARKER} ${metaJson} -->`,
      user: { login: "ci-assistant[bot]", type: "Bot" },
    })

    const { meta } = await readMeta(github, 1, "ci-assistant[bot]")
    expect(meta.state).toBe(State.ACTIVE)
  })
})

describe("writeMeta", () => {
  let github: MockGitHubClient

  beforeEach(() => {
    github = new MockGitHubClient()
    github.addPR({ number: 1 })
  })

  it("creates new meta comment with correct content", async () => {
    const meta = { ...DEFAULT_META, state: State.ACTIVE, totalCt: 3 }
    const id = await writeMeta(github, 1, meta, null)

    expect(id).toBeGreaterThan(0)
    const comments = github.getCommentsForPR(1)
    const metaComment = comments.find((c) => c.body.includes(META_MARKER))
    expect(metaComment).toBeDefined()
    expect(metaComment!.body).toContain('"state":"active"')
    expect(metaComment!.body).toContain('"totalCt":3')
    expect(metaComment!.user.login).toBe("github-actions[bot]")
  })

  it("updates existing meta comment", async () => {
    const meta1 = { ...DEFAULT_META, state: State.ACTIVE }
    const id = await writeMeta(github, 1, meta1, null)

    const meta2 = { ...meta1, totalCt: 5 }
    await writeMeta(github, 1, meta2, id)

    const comments = github.getCommentsForPR(1)
    const metaComment = comments.find((c) => c.id === id)
    expect(metaComment!.body).toContain('"totalCt":5')
  })
})

describe("getPreviousSuggestions", () => {
  it("extracts suggestions from bot comments", () => {
    const comments = [
      {
        id: 1,
        body: `${SUGGESTION_HEADER} \`#fix-aaa\`\n### Summary\nFixed null check\n\`\`\`diff\n-old\n+new\n\`\`\``,
        user: { login: "github-actions[bot]", type: "Bot" },
      },
      {
        id: 2,
        body: "Regular comment",
        user: { login: "developer", type: "User" },
      },
      {
        id: 3,
        body: `${SUGGESTION_HEADER} \`#fix-bbb\`\n### Summary\nFixed import\n\`\`\`diff\n-import old\n+import new\n\`\`\``,
        user: { login: "github-actions[bot]", type: "Bot" },
      },
    ]

    const suggestions = getPreviousSuggestions(comments, "github-actions[bot]")
    expect(suggestions.length).toBe(2)
    expect(suggestions[0].fixId).toBe("#fix-aaa")
    expect(suggestions[1].fixId).toBe("#fix-bbb")
    expect(suggestions[0].diff).toContain("-old")
  })

  it("ignores suggestion comments from non-bot users", () => {
    const comments = [
      {
        id: 1,
        body: `${SUGGESTION_HEADER} \`#fix-fake\`\n### Summary\nFake fix\n\`\`\`diff\n-a\n+b\n\`\`\``,
        user: { login: "attacker", type: "User" },
      },
    ]

    const suggestions = getPreviousSuggestions(comments, "github-actions[bot]")
    expect(suggestions.length).toBe(0)
  })

  it("returns empty for no suggestions", () => {
    const suggestions = getPreviousSuggestions([], "github-actions[bot]")
    expect(suggestions.length).toBe(0)
  })
})

describe("formatSuggestionComment", () => {
  it("includes all required sections", () => {
    const comment = formatSuggestionComment({
      fixId: "#fix-test123",
      summary: "Fixed the null pointer exception",
      errorDetails: "Error at line 42",
      diff: "-old code\n+new code",
      confidence: {
        status: ConfidenceStatus.REPRODUCED_AND_VERIFIED,
        percentage: 90,
        reproduced: true,
        testsPass: true,
      },
      filesChanged: 2,
    })

    expect(comment).toContain("#fix-test123")
    expect(comment).toContain("Fixed the null pointer exception")
    expect(comment).toContain("Error at line 42")
    expect(comment).toContain("-old code")
    expect(comment).toContain("Reproduced and verified")
    expect(comment).toContain("90% confidence")
    expect(comment).toContain("Reproduced:** Yes")
    expect(comment).toContain("Tests pass after fix:** Yes")
    expect(comment).toContain("2 files changed")
    expect(comment).toContain("/ci-assistant accept")
    expect(comment).toContain("/ci-assistant alternative")
    expect(comment).toContain("<details>")
  })

  it("truncates large diffs", () => {
    const largeDiff = "x".repeat(60000)
    const comment = formatSuggestionComment({
      fixId: "#fix-big",
      summary: "Big fix",
      errorDetails: "Error",
      diff: largeDiff,
      confidence: {
        status: ConfidenceStatus.NEITHER,
        percentage: 50,
        reproduced: false,
        testsPass: false,
      },
      filesChanged: 10,
    })

    expect(comment.length).toBeLessThan(65536)
    expect(comment).toContain("truncated")
    expect(comment).toContain("/ci-assistant explain")
  })
})

describe("formatNonCodeComment", () => {
  it("shows non-code analysis without accept command", () => {
    const comment = formatNonCodeComment({
      analysis: "OOM killed, runner ran out of memory",
      confidence: {
        status: ConfidenceStatus.NON_CODE,
        percentage: 80,
        reproduced: false,
        testsPass: false,
      },
    })

    expect(comment).toContain("Non-code issue")
    expect(comment).toContain("OOM killed")
    expect(comment).not.toContain("/ci-assistant accept")
    expect(comment).toContain("/ci-assistant suggest")
  })
})

describe("formatGaveUpComment", () => {
  it("shows gave-up analysis with retry command", () => {
    const comment = formatGaveUpComment("Cannot determine the root cause")

    expect(comment).toContain("Could not fix")
    expect(comment).toContain("Cannot determine")
    expect(comment).toContain("/ci-assistant retry")
    expect(comment).toContain("/ci-assistant suggest")
  })
})

describe("cleanupOrphanedRefs", () => {
  let github: MockGitHubClient

  beforeEach(() => {
    github = new MockGitHubClient()
  })

  it("deletes refs for closed PRs", async () => {
    github.addPR({ number: 10, state: "closed" })
    github.refs = ["refs/ci-assistant/10/#fix-aaa", "refs/ci-assistant/10/#fix-bbb"]

    const cleaned = await cleanupOrphanedRefs(github)
    expect(cleaned).toBe(2)
    expect(github.refs.length).toBe(0)
  })

  it("preserves refs for open PRs", async () => {
    github.addPR({ number: 20, state: "open" })
    github.refs = ["refs/ci-assistant/20/#fix-ccc"]

    const cleaned = await cleanupOrphanedRefs(github)
    expect(cleaned).toBe(0)
    expect(github.refs.length).toBe(1)
  })

  it("handles mixed open and closed PRs", async () => {
    github.addPR({ number: 30, state: "closed" })
    github.addPR({ number: 40, state: "open" })
    github.refs = [
      "refs/ci-assistant/30/#fix-d",
      "refs/ci-assistant/30/#fix-e",
      "refs/ci-assistant/40/#fix-f",
    ]

    const cleaned = await cleanupOrphanedRefs(github)
    expect(cleaned).toBe(2)
    expect(github.refs).toEqual(["refs/ci-assistant/40/#fix-f"])
  })

  it("returns 0 when no refs exist", async () => {
    const cleaned = await cleanupOrphanedRefs(github)
    expect(cleaned).toBe(0)
  })
})
