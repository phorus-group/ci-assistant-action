import { AdminCommand, MetaComment, LimitType, createDefaultMeta } from "./types"

export interface AdminResult {
  success: boolean
  message: string
  updatedMeta?: MetaComment
}

const VALID_LIMIT_TYPES: LimitType[] = ["retry", "alternative", "suggest", "explain", "total"]

export function handleAdminCommand(
  adminCommand: AdminCommand,
  args: string[],
  meta: MetaComment
): AdminResult {
  switch (adminCommand) {
    case AdminCommand.SET_LIMIT:
      return handleSetLimit(args, meta)

    case AdminCommand.RESET_LIMITS:
      return handleResetLimits(meta)

    case AdminCommand.RESET_STATE:
      return handleResetState(meta)

    case AdminCommand.SET_MODEL:
      return handleSetModel(args, meta)

    case AdminCommand.UNBAN:
      return handleUnban(args, meta)

    case AdminCommand.SET_MAX_TURNS:
      return handleSetMaxTurns(args, meta)

    default:
      return {
        success: false,
        message: `Unknown admin command: \`${adminCommand}\`. Available: \`set-limit\`, \`reset-limits\`, \`reset-state\`, \`set-model\`, \`set-max-turns\`, \`unban\`.`,
      }
  }
}

function handleSetLimit(args: string[], meta: MetaComment): AdminResult {
  if (args.length < 2) {
    return {
      success: false,
      message:
        "Usage: `/ci-assistant admin set-limit <type> <value>`\n\nTypes: `accept`, `retry`, `alternative`, `suggest`, `explain`, `help`, `total`\nValue: number or `-1` for unlimited",
    }
  }

  const limitType = args[0].toLowerCase() as LimitType
  const value = parseInt(args[1])

  if (!VALID_LIMIT_TYPES.includes(limitType)) {
    return {
      success: false,
      message: `Invalid limit type: \`${limitType}\`. Valid types: ${VALID_LIMIT_TYPES.map((t) => `\`${t}\``).join(", ")}`,
    }
  }

  if (isNaN(value) || value < -1) {
    return {
      success: false,
      message: "Value must be a number: `-1` for unlimited, `0` to disable, or a positive number.",
    }
  }

  const updated = { ...meta, limitOverrides: { ...meta.limitOverrides } }
  updated.limitOverrides[limitType] = value

  let extraNote = ""

  // If setting a specific limit to unlimited (-1), also set total to unlimited
  if (value === -1 && limitType !== "total") {
    const totalOverride = updated.limitOverrides.total
    if (totalOverride === undefined || totalOverride !== -1) {
      updated.limitOverrides.total = -1
      extraNote =
        "\n\n> Note: Total command limit has also been set to unlimited, since a specific limit was set to unlimited."
    }
  }

  return {
    success: true,
    message: `Limit \`${limitType}\` set to \`${value === -1 ? "unlimited" : value}\` for this PR.${extraNote}`,
    updatedMeta: updated,
  }
}

function handleResetLimits(meta: MetaComment): AdminResult {
  const updated = {
    ...meta,
    limitOverrides: {},
    retryCt: 0,
    altCt: 0,
    suggestCt: 0,
    explainCt: 0,
    totalCt: 0,
  }

  return {
    success: true,
    message: "All limits and counters have been reset to their configured defaults for this PR.",
    updatedMeta: updated,
  }
}

function handleResetState(meta: MetaComment): AdminResult {
  const updated: MetaComment = {
    ...createDefaultMeta(),
    // Preserve general limit counter (anti-abuse)
    totalCt: meta.totalCt,
    // Preserve admin overrides
    limitOverrides: meta.limitOverrides,
    modelOverride: meta.modelOverride,
    maxTurnsOverride: meta.maxTurnsOverride,
    // Preserve bans and exploit tracking
    bannedUsers: meta.bannedUsers,
    exploitAttempts: meta.exploitAttempts,
    // Preserve Slack context
    slackTs: meta.slackTs,
    slackChannel: meta.slackChannel,
    // Preserve failure context (needed for commands to download logs and populate prompts)
    lastSha: meta.lastSha,
    lastRunId: meta.lastRunId,
    isTagFailure: meta.isTagFailure,
    tagSourceBranch: meta.tagSourceBranch,
  }

  return {
    success: true,
    message:
      "State has been reset. Fix history cleared. General limit counter and admin overrides preserved.",
    updatedMeta: updated,
  }
}

function handleSetModel(args: string[], meta: MetaComment): AdminResult {
  if (args.length < 1) {
    return {
      success: false,
      message:
        "Usage: `/ci-assistant admin set-model <model>`\n\nExample: `/ci-assistant admin set-model claude-opus-4-6`",
    }
  }

  const model = args[0]
  const updated = { ...meta, modelOverride: model }

  return {
    success: true,
    message: `Model override set to \`${model}\` for this PR. All subsequent Claude invocations will use this model.`,
    updatedMeta: updated,
  }
}

function handleUnban(args: string[], meta: MetaComment): AdminResult {
  if (args.length < 1) {
    return {
      success: false,
      message:
        "Usage: `/ci-assistant admin unban <username>`\n\nNote: This only removes PR-level bans. Repo-level bans must be removed from the `banned-users` input in the workflow file.",
    }
  }

  const username = args[0].toLowerCase()
  const wasBanned = meta.bannedUsers.some((u) => u.toLowerCase() === username)

  if (!wasBanned) {
    return {
      success: false,
      message: `User \`${args[0]}\` is not banned on this PR. If they are banned at the repo level, remove them from the \`banned-users\` input in the workflow file.`,
    }
  }

  const updated = {
    ...meta,
    bannedUsers: meta.bannedUsers.filter((u) => u.toLowerCase() !== username),
  }

  return {
    success: true,
    message: `User \`${args[0]}\` has been unbanned on this PR.`,
    updatedMeta: updated,
  }
}

function handleSetMaxTurns(args: string[], meta: MetaComment): AdminResult {
  if (args.length < 1) {
    return {
      success: false,
      message:
        "Usage: `/ci-assistant admin set-max-turns <value>`\n\nValue: positive number or `-1` for unlimited. Controls how many tool-use iterations Claude gets per invocation.",
    }
  }

  const value = parseInt(args[0])

  if (isNaN(value) || value < -1) {
    return {
      success: false,
      message: `Invalid value: \`${args[0]}\`. Must be a positive number or \`-1\` for unlimited.`,
    }
  }

  const updated = { ...meta, maxTurnsOverride: value === 0 ? null : value }

  const label = value === -1 ? "unlimited" : `${value}`
  return {
    success: true,
    message: `Max turns override set to \`${label}\` for this PR. ${value === -1 ? "Claude will run without a turn limit." : `Claude will use up to ${value} tool-use turns per invocation.`}`,
    updatedMeta: updated,
  }
}
