import {
  buildSuggestionBlocks,
  buildStatusUpdateBlocks,
  buildExploitAlertBlocks,
  postOrUpdateSlack,
  updateParentFailureStatus,
} from "../src/slack"
import { MockSlackClient } from "./mocks"
import { DEFAULT_META, ConfidenceStatus, State } from "../src/types"

describe("buildSuggestionBlocks", () => {
  it("includes repo, branch, fix ID, confidence, and stats", () => {
    const meta = {
      ...DEFAULT_META,
      state: State.ACTIVE,
      fixes: ["#fix-a", "#fix-b"],
    }
    const { blocks, text } = buildSuggestionBlocks({
      repo: "owner/repo",
      branch: "feature-x",
      fixId: "#fix-b",
      confidence: {
        status: ConfidenceStatus.REPRODUCED_AND_VERIFIED,
        percentage: 88,
        reproduced: true,
        testsPass: true,
      },
      meta,
      prUrl: "https://github.com/owner/repo/pull/42",
    })

    expect(blocks.length).toBe(3)
    expect(blocks[0].text!.text).toContain("owner/repo")
    expect(blocks[0].text!.text).toContain("feature-x")
    expect(blocks[0].text!.text).toContain("#fix-b")
    expect(blocks[0].text!.text).toContain("88% confidence")
    expect(blocks[2].elements![0]).toHaveProperty("text")
    const contextText = (blocks[2].elements![0] as { text: string }).text
    expect(contextText).toContain("Reproduced: yes")
    expect(contextText).toContain("Tests pass: yes")
    expect(contextText).toContain("Fixes suggested: 2")
    expect(text).toContain("CI Assistant")
  })

  it("shows non-reproduced status", () => {
    const { blocks } = buildSuggestionBlocks({
      repo: "owner/repo",
      branch: "main",
      fixId: "#fix-c",
      confidence: {
        status: ConfidenceStatus.NOT_REPRODUCED_TESTS_PASS,
        percentage: 60,
        reproduced: false,
        testsPass: true,
      },
      meta: { ...DEFAULT_META, fixes: ["#fix-c"] },
      prUrl: "https://github.com/owner/repo/pull/1",
    })

    const contextText = (blocks[2].elements![0] as { text: string }).text
    expect(contextText).toContain("Reproduced: no")
    expect(contextText).toContain("Tests pass: yes")
  })
})

describe("buildStatusUpdateBlocks", () => {
  it("includes status and stats", () => {
    const meta = { ...DEFAULT_META, fixes: ["#fix-a"], totalCt: 3 }
    const { blocks, text } = buildStatusUpdateBlocks({
      repo: "owner/repo",
      branch: "main",
      status: "Fix accepted",
      meta,
      prUrl: "https://github.com/owner/repo/pull/42",
    })

    expect(blocks[0].text!.text).toContain("Fix accepted")
    expect(blocks[2].elements![0]).toHaveProperty("text")
    const contextText = (blocks[2].elements![0] as { text: string }).text
    expect(contextText).toContain("Commands used: 3")
    expect(text).toContain("Fix accepted")
  })

  it("includes confidence when provided", () => {
    const { blocks } = buildStatusUpdateBlocks({
      repo: "owner/repo",
      branch: "main",
      status: "New suggestion",
      meta: DEFAULT_META,
      prUrl: "https://github.com/owner/repo/pull/1",
      confidence: {
        status: ConfidenceStatus.REPRODUCED_AND_VERIFIED,
        percentage: 90,
        reproduced: true,
        testsPass: true,
      },
    })

    expect(blocks[0].text!.text).toContain("90% confidence")
  })
})

describe("buildExploitAlertBlocks", () => {
  it("includes repo, PR, username, and danger button", () => {
    const { blocks, text } = buildExploitAlertBlocks({
      repo: "owner/repo",
      prNumber: 42,
      username: "attacker",
      commentUrl: "https://github.com/owner/repo/pull/42#comment-1",
    })

    expect(blocks[0].text!.text).toContain("exploitation attempt")
    expect(blocks[0].text!.text).toContain("owner/repo")
    expect(blocks[0].text!.text).toContain("attacker")
    expect(blocks[0].text!.text).toContain("42")
    expect(blocks[2].elements![0]).toHaveProperty("text")
    const contextText = (blocks[2].elements![0] as { text: string }).text
    expect(contextText).toContain("banned")
    expect(text).toContain("Exploitation")
  })
})

describe("postOrUpdateSlack", () => {
  let slack: MockSlackClient

  beforeEach(() => {
    slack = new MockSlackClient()
  })

  it("posts new message when no existing ts", async () => {
    const meta = { ...DEFAULT_META }
    const ts = await postOrUpdateSlack(
      slack,
      meta,
      "C0TEST",
      [{ type: "section", text: { type: "mrkdwn", text: "test" } }],
      "test message"
    )

    expect(ts).not.toBeNull()
    expect(slack.messages.length).toBe(1)
    expect(slack.updates.length).toBe(0)
  })

  it("updates existing message when ts exists", async () => {
    const meta = { ...DEFAULT_META, slackTs: "existing-ts" }
    await postOrUpdateSlack(
      slack,
      meta,
      "C0TEST",
      [{ type: "section", text: { type: "mrkdwn", text: "updated" } }],
      "updated message"
    )

    expect(slack.messages.length).toBe(0)
    expect(slack.updates.length).toBe(1)
    expect(slack.updates[0].ts).toBe("existing-ts")
  })

  it("posts as thread reply when threadTs provided", async () => {
    const meta = { ...DEFAULT_META }
    await postOrUpdateSlack(
      slack,
      meta,
      "C0TEST",
      [{ type: "section", text: { type: "mrkdwn", text: "reply" } }],
      "thread reply",
      "parent-ts"
    )

    expect(slack.messages[0].threadTs).toBe("parent-ts")
  })

  it("returns null when channel is empty", async () => {
    const ts = await postOrUpdateSlack(slack, DEFAULT_META, "", [], "no channel")
    expect(ts).toBeNull()
    expect(slack.messages.length).toBe(0)
  })
})

describe("updateParentFailureStatus", () => {
  let slack: MockSlackClient

  beforeEach(() => {
    slack = new MockSlackClient()
  })

  it("appends ci-assistant context block to existing message", async () => {
    // Post a failure message first
    await slack.postMessage(
      "C0TEST",
      [
        { type: "section", text: { type: "mrkdwn", text: ":x: Pipeline failed" } },
        { type: "context", elements: [{ type: "mrkdwn", text: ":red_circle: Failed" }] },
      ],
      "failed"
    )
    const parentTs = slack.messages[0].ts

    await updateParentFailureStatus(slack, "C0TEST", parentTs, "Analyzing failure...")

    expect(slack.updates.length).toBe(1)
    const updatedBlocks = slack.updates[0].blocks
    expect(updatedBlocks.length).toBe(3)
    expect(updatedBlocks[2].type).toBe("context")
    expect(updatedBlocks[2].block_id).toBe("ci-assistant-status")
    const contextText = (updatedBlocks[2].elements as { text: string }[])[0].text
    expect(contextText).toContain("CI Assistant:")
    expect(contextText).toContain("Analyzing failure...")
  })

  it("replaces previous ci-assistant status on subsequent updates", async () => {
    await slack.postMessage(
      "C0TEST",
      [
        { type: "section", text: { type: "mrkdwn", text: ":x: Pipeline failed" } },
        { type: "context", elements: [{ type: "mrkdwn", text: ":red_circle: Failed" }] },
      ],
      "failed"
    )
    const parentTs = slack.messages[0].ts

    await updateParentFailureStatus(slack, "C0TEST", parentTs, "Analyzing failure...")
    await updateParentFailureStatus(
      slack,
      "C0TEST",
      parentTs,
      "Fix suggested",
      "https://github.com/org/repo/pull/1"
    )

    const lastUpdate = slack.updates[slack.updates.length - 1]
    const blocks = lastUpdate.blocks
    // Should still have 3 blocks (section + original context + ci-assistant context), not 4
    expect(blocks.length).toBe(3)
    // Original pipeline context block preserved (no block_id)
    expect(blocks[1].type).toBe("context")
    expect(blocks[1].block_id).toBeUndefined()
    // ci-assistant block replaced (same block_id, new content)
    expect(blocks[2].block_id).toBe("ci-assistant-status")
    const contextText = (blocks[2].elements as { text: string }[])[0].text
    expect(contextText).toContain("Fix suggested")
    expect(contextText).toContain("View PR")
    expect(contextText).not.toContain("Analyzing")
  })

  it("skips when channel is empty", async () => {
    await updateParentFailureStatus(slack, "", "some-ts", "test")
    expect(slack.updates.length).toBe(0)
  })

  it("skips when parentTs is empty", async () => {
    await updateParentFailureStatus(slack, "C0TEST", "", "test")
    expect(slack.updates.length).toBe(0)
  })
})
