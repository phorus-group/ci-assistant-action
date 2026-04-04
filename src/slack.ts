import { log, logWarning, LogPrefix } from "./claude"
import {
  ConfidenceResult,
  CONFIDENCE_STATUS_ICONS_SLACK,
  CONFIDENCE_STATUS_LABELS,
  MetaComment,
  SlackBlock,
} from "./types"

export interface SlackClient {
  postMessage(
    channel: string,
    blocks: SlackBlock[],
    text: string,
    threadTs?: string
  ): Promise<string | null>
  updateMessage(channel: string, ts: string, blocks: SlackBlock[], text: string): Promise<void>
  getMessageBlocks(channel: string, ts: string): Promise<SlackBlock[] | null>
}

export class HttpSlackClient implements SlackClient {
  private token: string

  constructor(token: string) {
    this.token = token
  }

  async postMessage(
    channel: string,
    blocks: SlackBlock[],
    text: string,
    threadTs?: string
  ): Promise<string | null> {
    try {
      const body: Record<string, unknown> = {
        channel,
        blocks: truncateBlocks(blocks),
        text,
        unfurl_links: false,
        unfurl_media: false,
      }
      if (threadTs) {
        body.thread_ts = threadTs
      }

      const response = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      })

      const data = (await response.json()) as { ok: boolean; error?: string; ts?: string }
      if (!data.ok) {
        logWarning(LogPrefix.SLACK, `postMessage failed: ${data.error}`)
        return null
      }
      log(LogPrefix.SLACK, `Posted message to ${channel}${threadTs ? ` (thread ${threadTs})` : ""}`)
      return data.ts ?? null
    } catch (error) {
      logWarning(LogPrefix.SLACK, `postMessage error: ${error}`)
      return null
    }
  }

  async updateMessage(
    channel: string,
    ts: string,
    blocks: SlackBlock[],
    text: string
  ): Promise<void> {
    try {
      const response = await fetch("https://slack.com/api/chat.update", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel,
          ts,
          blocks: truncateBlocks(blocks),
          text,
        }),
      })

      const data = (await response.json()) as { ok: boolean; error?: string; ts?: string }
      if (!data.ok) {
        logWarning(LogPrefix.SLACK, `updateMessage failed: ${data.error}`)
      } else {
        log(LogPrefix.SLACK, `Updated message in ${channel} (ts ${ts})`)
      }
    } catch (error) {
      logWarning(LogPrefix.SLACK, `updateMessage error: ${error}`)
    }
  }

  async getMessageBlocks(channel: string, ts: string): Promise<SlackBlock[] | null> {
    try {
      const response = await fetch(
        `https://slack.com/api/conversations.history?channel=${channel}&latest=${ts}&oldest=${ts}&inclusive=true&limit=1`,
        { headers: { Authorization: `Bearer ${this.token}` } }
      )
      const data = (await response.json()) as {
        ok: boolean
        error?: string
        messages?: { blocks?: SlackBlock[] }[]
      }
      if (!data.ok || !data.messages?.length) {
        logWarning(LogPrefix.SLACK, `getMessageBlocks failed: ${data.error || "no messages"}`)
        return null
      }
      return data.messages[0].blocks ?? null
    } catch (error) {
      logWarning(LogPrefix.SLACK, `getMessageBlocks error: ${error}`)
      return null
    }
  }
}

const MAX_BLOCK_TEXT_LENGTH = 2900

function truncateBlocks(blocks: SlackBlock[]): SlackBlock[] {
  const result: SlackBlock[] = []

  for (const block of blocks) {
    if (block.text?.text && block.text.text.length > MAX_BLOCK_TEXT_LENGTH) {
      result.push({
        ...block,
        text: {
          ...block.text,
          text: block.text.text.slice(0, MAX_BLOCK_TEXT_LENGTH) + "\n\n_[truncated]_",
        },
      })
    } else {
      result.push(block)
    }
  }

  // Check total size, remove blocks from the end if too large
  let totalSize = JSON.stringify(result).length
  while (totalSize > 50000 && result.length > 1) {
    result.pop()
    totalSize = JSON.stringify(result).length
  }

  return result
}

export function buildSuggestionBlocks(params: {
  repo: string
  branch: string
  fixId: string
  confidence: ConfidenceResult
  meta: MetaComment
  prUrl: string
}): { blocks: SlackBlock[]; text: string } {
  const { repo, branch, fixId, confidence, meta, prUrl } = params

  const icon = CONFIDENCE_STATUS_ICONS_SLACK[confidence.status]
  const label = CONFIDENCE_STATUS_LABELS[confidence.status]

  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `\u{1F916} *CI Assistant* for \`${repo}\` on \`${branch}\`\n\n${icon} ${label} (${confidence.percentage}% confidence)\nFix: \`${fixId}\``,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View on GitHub" },
          url: prUrl,
          style: "primary",
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Fixes suggested: ${meta.fixes.length + (meta.latestFix && !meta.fixes.includes(meta.latestFix) ? 1 : 0)} | Status: awaiting review | Reproduced: ${confidence.reproduced ? "yes" : "no"} | Tests pass: ${confidence.testsPass ? "yes" : "no"} | Confidence: ${confidence.percentage}%`,
        },
      ],
    },
  ]

  const text = `CI Assistant: ${label} for ${repo} on ${branch} (${confidence.percentage}% confidence)`

  return { blocks, text }
}

export function buildStatusUpdateBlocks(params: {
  repo: string
  branch: string
  status: string
  meta: MetaComment
  prUrl: string
  confidence?: ConfidenceResult
}): { blocks: SlackBlock[]; text: string } {
  const { repo, branch, status, meta, prUrl, confidence } = params

  let confidenceText = ""
  if (confidence) {
    const icon = CONFIDENCE_STATUS_ICONS_SLACK[confidence.status]
    const label = CONFIDENCE_STATUS_LABELS[confidence.status]
    confidenceText = `\n${icon} ${label} (${confidence.percentage}% confidence)`
  }

  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `\u{1F916} *CI Assistant* for \`${repo}\` on \`${branch}\`${confidenceText}\n\nStatus: ${status}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View on GitHub" },
          url: prUrl,
          style: "primary",
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Fixes suggested: ${meta.fixes.length + (meta.latestFix && !meta.fixes.includes(meta.latestFix) ? 1 : 0)} | Commands used: ${meta.totalCt}${confidence ? ` | Reproduced: ${confidence.reproduced ? "yes" : "no"} | Tests pass: ${confidence.testsPass ? "yes" : "no"}` : ""}`,
        },
      ],
    },
  ]

  const text = `CI Assistant: ${status} for ${repo} on ${branch}`

  return { blocks, text }
}

export function buildExploitAlertBlocks(params: {
  repo: string
  prNumber: number
  username: string
  commentUrl: string
}): { blocks: SlackBlock[]; text: string } {
  const { repo, prNumber, username, commentUrl } = params

  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `\u{26A0}\u{FE0F} *Potential exploitation attempt* detected in \`${repo}\` PR #${prNumber} by \`${username}\``,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View Comment" },
          url: commentUrl,
          style: "danger",
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `User has been banned on this PR. To ban repo-wide, add to \`banned-users\` input.`,
        },
      ],
    },
  ]

  const text = `CI Assistant: Exploitation attempt in ${repo} PR #${prNumber} by ${username}`

  return { blocks, text }
}

export function buildUnresolvedTagBlocks(params: { repo: string; tag: string; analysis: string }): {
  blocks: SlackBlock[]
  text: string
} {
  const { repo, tag, analysis } = params

  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `\u{26A0}\u{FE0F} *CI Assistant* tag \`${tag}\` failed in \`${repo}\` but the source branch could not be determined.\n\nNo PR was created to avoid targeting the wrong branch. A developer should investigate and apply the fix manually.`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Analysis: ${analysis.slice(0, 500)}`,
        },
      ],
    },
  ]

  const text = `CI Assistant: tag ${tag} failed in ${repo}, source branch could not be resolved`

  return { blocks, text }
}

const CI_ASSISTANT_BLOCK_MARKER = "\u{1F916} CI Assistant:"

export async function updateParentFailureStatus(
  client: SlackClient,
  channel: string,
  parentTs: string,
  status: string,
  prUrl?: string
): Promise<void> {
  if (!channel || !parentTs) return

  log(LogPrefix.SLACK, `Updating parent failure message with status: ${status}`)

  const blocks = await client.getMessageBlocks(channel, parentTs)
  if (!blocks) {
    logWarning(LogPrefix.SLACK, "Could not read parent failure message blocks")
    return
  }

  log(LogPrefix.SLACK, `Parent message has ${blocks.length} blocks`)

  // Remove any existing ci-assistant context block (identified by block_id)
  const CI_ASSISTANT_BLOCK_ID = "ci-assistant-status"
  const filtered = blocks.filter((b) => b.block_id !== CI_ASSISTANT_BLOCK_ID)

  log(
    LogPrefix.SLACK,
    `Filtered to ${filtered.length} blocks (removed ${blocks.length - filtered.length})`
  )

  // Build the status text
  let statusText = `${CI_ASSISTANT_BLOCK_MARKER} ${status}`
  if (prUrl) {
    statusText += ` | <${prUrl}|View PR>`
  }

  // Append new ci-assistant context block
  filtered.push({
    type: "context",
    block_id: CI_ASSISTANT_BLOCK_ID,
    elements: [{ type: "mrkdwn", text: statusText }],
  })

  const text = `CI Assistant: ${status}`
  await client.updateMessage(channel, parentTs, filtered, text)
}

export async function postOrUpdateSlack(
  client: SlackClient,
  meta: MetaComment,
  channel: string,
  blocks: SlackBlock[],
  text: string,
  threadTs?: string
): Promise<string | null> {
  if (!channel) {
    log(LogPrefix.SLACK, "No channel configured, skipping Slack")
    return null
  }

  if (meta.slackTs) {
    log(LogPrefix.SLACK, `Updating existing message (ts ${meta.slackTs})`)
    await client.updateMessage(channel, meta.slackTs, blocks, text)
    return meta.slackTs
  }

  log(
    LogPrefix.SLACK,
    threadTs
      ? `Posting new message to ${channel} in thread ${threadTs}`
      : `Posting new message to ${channel} (no thread)`
  )
  return await client.postMessage(channel, blocks, text, threadTs)
}
