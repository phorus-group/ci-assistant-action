import {
  Command,
  AdminCommand,
  ParsedCommand,
  State,
  MetaComment,
  ActionInputs,
  LimitType,
  CI_ASSISTANT_PREFIX,
} from "./types"

/**
 * Tokenizes a string respecting double-quoted sections.
 * "hello world" becomes one token, unquoted words are split by whitespace.
 */
function tokenize(input: string): string[] {
  const tokens: string[] = []
  let current = ""
  let inQuotes = false

  for (const char of input) {
    if (char === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (char === " " && !inQuotes) {
      if (current.length > 0) {
        tokens.push(current)
        current = ""
      }
      continue
    }
    current += char
  }
  if (current.length > 0) tokens.push(current)
  return tokens
}

function parseExplainArgs(rawArgs: string): { fixId?: string; prompt?: string } {
  const tokens = tokenize(rawArgs)

  let fixId: string | undefined
  const promptParts: string[] = []

  for (const token of tokens) {
    if (token.startsWith("#fix-") && !fixId) {
      fixId = token
    } else if (token === "-p") {
      continue
    } else {
      promptParts.push(token)
    }
  }

  const prompt = promptParts.join(" ").trim() || undefined
  return { fixId, prompt }
}

export function parseCommand(commentBody: string): ParsedCommand | null {
  const trimmed = commentBody.trim()
  if (!trimmed.startsWith(CI_ASSISTANT_PREFIX)) {
    return null
  }

  const parts = trimmed.slice(CI_ASSISTANT_PREFIX.length).trim().split(/\s+/)
  if (parts.length === 0 || parts[0] === "") {
    return { command: Command.HELP }
  }

  const subcommand = parts[0].toLowerCase()

  switch (subcommand) {
    case "accept":
      if (parts.length > 1 && parts[1].startsWith("#fix-")) {
        return { command: Command.ACCEPT, fixId: parts[1] }
      }
      return { command: Command.ACCEPT }

    case "alternative":
      return { command: Command.ALTERNATIVE }

    case "suggest": {
      const userContext = parts.slice(1).join(" ").trim()
      return { command: Command.SUGGEST, userContext: userContext || undefined }
    }

    case "retry":
      return { command: Command.RETRY }

    case "explain": {
      const explainRaw = trimmed.slice(CI_ASSISTANT_PREFIX.length).replace(/^\s*explain\s*/, "")
      const { fixId: eid, prompt: ep } = parseExplainArgs(explainRaw)
      return { command: Command.EXPLAIN, fixId: eid, userContext: ep }
    }

    case "help": {
      const helpTarget = parts.length > 1 ? parts[1].toLowerCase() : undefined
      return { command: Command.HELP, userContext: helpTarget }
    }

    case "limits":
    case "quota": {
      const limitTarget = parts.length > 1 ? parts[1].toLowerCase() : undefined
      return { command: Command.LIMITS, userContext: limitTarget }
    }

    case "admin": {
      if (parts.length < 2) {
        return { command: Command.ADMIN }
      }
      const adminSub = parts[1].toLowerCase() as AdminCommand
      const adminArgs = parts.slice(2)
      return {
        command: Command.ADMIN,
        adminCommand: adminSub,
        adminArgs,
      }
    }

    default:
      return { command: Command.HELP }
  }
}

export interface ValidationResult {
  valid: boolean
  error?: string
}

const COMMAND_STATE_RULES: Record<
  Command,
  { allowed: State[]; errorMessages: Record<string, string> }
> = {
  [Command.ACCEPT]: {
    allowed: [State.ACTIVE],
    errorMessages: {
      [State.GAVE_UP]:
        "No fix available to accept. Use `/ci-assistant retry` to try again or `/ci-assistant suggest <context>` to provide guidance.",
      [State.NON_CODE]: "This is a non-code issue. There is no code fix to accept.",
      [State.NONE]:
        "No fix has been suggested yet. Use `/ci-assistant suggest <context>` to request one.",
    },
  },
  [Command.ALTERNATIVE]: {
    allowed: [State.ACTIVE, State.NON_CODE],
    errorMessages: {
      [State.GAVE_UP]:
        "CI Assistant gave up. Use `/ci-assistant retry` to start fresh or `/ci-assistant suggest <context>` to provide context.",
      [State.NONE]: "No prior analysis exists. Use `/ci-assistant suggest <context>` to start.",
    },
  },
  [Command.SUGGEST]: {
    allowed: [State.ACTIVE, State.NON_CODE, State.GAVE_UP, State.NONE],
    errorMessages: {},
  },
  [Command.RETRY]: {
    allowed: [State.GAVE_UP, State.NON_CODE],
    errorMessages: {
      [State.ACTIVE]:
        "CI Assistant has an active suggestion. Use `/ci-assistant alternative` for a different approach.",
      [State.NONE]: "No prior analysis exists. Use `/ci-assistant suggest <context>` to start.",
    },
  },
  [Command.EXPLAIN]: {
    allowed: [State.ACTIVE, State.NON_CODE, State.GAVE_UP, State.NONE],
    errorMessages: {},
  },
  [Command.HELP]: {
    allowed: [State.ACTIVE, State.NON_CODE, State.GAVE_UP, State.NONE],
    errorMessages: {},
  },
  [Command.LIMITS]: {
    allowed: [State.ACTIVE, State.NON_CODE, State.GAVE_UP, State.NONE],
    errorMessages: {},
  },
  [Command.ADMIN]: {
    allowed: [State.ACTIVE, State.NON_CODE, State.GAVE_UP, State.NONE],
    errorMessages: {},
  },
}

export function validateCommandForState(command: Command, state: State): ValidationResult {
  const rules = COMMAND_STATE_RULES[command]
  if (!rules) {
    return { valid: false, error: "Unknown command." }
  }

  if (rules.allowed.includes(state)) {
    return { valid: true }
  }

  const errorMessage =
    rules.errorMessages[state] ||
    `Command \`${command}\` is not available in the current state (\`${state}\`).`
  return { valid: false, error: errorMessage }
}

const COMMAND_TO_LIMIT_KEY: Record<Command, LimitType | null> = {
  [Command.ACCEPT]: null,
  [Command.ALTERNATIVE]: "alternative",
  [Command.SUGGEST]: "suggest",
  [Command.RETRY]: "retry",
  [Command.EXPLAIN]: "explain",
  [Command.HELP]: null,
  [Command.LIMITS]: null,
  [Command.ADMIN]: null,
}

const LIMIT_INPUT_MAP: Record<LimitType, keyof ActionInputs> = {
  retry: "maxRetryCommands",
  alternative: "maxAlternativeCommands",
  suggest: "maxSuggestCommands",
  explain: "maxExplainCommands",
  total: "maxTotalCommands",
}

const LIMIT_COUNTER_MAP: Record<LimitType, keyof MetaComment> = {
  retry: "retryCt",
  alternative: "altCt",
  suggest: "suggestCt",
  explain: "explainCt",
  total: "totalCt",
}

export interface LimitCheckResult {
  allowed: boolean
  limitType?: LimitType
  current?: number
  max?: number
}

export function checkLimits(
  command: Command,
  meta: MetaComment,
  inputs: ActionInputs
): LimitCheckResult {
  const freeFromLimits = [Command.ADMIN, Command.HELP, Command.LIMITS, Command.ACCEPT]
  if (freeFromLimits.includes(command)) {
    return { allowed: true }
  }

  // Check general limit first
  const totalMax = getEffectiveLimit("total", meta, inputs)
  if (totalMax !== -1 && meta.totalCt >= totalMax) {
    return {
      allowed: false,
      limitType: "total",
      current: meta.totalCt,
      max: totalMax,
    }
  }

  // Check specific limit
  const limitKey = COMMAND_TO_LIMIT_KEY[command]
  if (limitKey) {
    const max = getEffectiveLimit(limitKey, meta, inputs)
    const current = meta[LIMIT_COUNTER_MAP[limitKey]] as number
    if (max !== -1 && current >= max) {
      return {
        allowed: false,
        limitType: limitKey,
        current,
        max,
      }
    }
  }

  return { allowed: true }
}

export function getEffectiveLimit(
  limitType: LimitType,
  meta: MetaComment,
  inputs: ActionInputs
): number {
  // Admin override takes precedence
  const override = meta.limitOverrides[limitType]
  if (override !== undefined) {
    return override
  }

  // Fall back to input
  const inputKey = LIMIT_INPUT_MAP[limitType]
  return inputs[inputKey] as number
}

export function incrementCounter(meta: MetaComment, command: Command): MetaComment {
  const updated = { ...meta }
  const limitKey = COMMAND_TO_LIMIT_KEY[command]

  if (limitKey) {
    const counterKey = LIMIT_COUNTER_MAP[limitKey]
    ;(updated as Record<string, unknown>)[counterKey] = (updated[counterKey] as number) + 1
  }

  // Increment total for commands that use Claude (excludes admin, help, limits)
  const freeCmds = [Command.ADMIN, Command.HELP, Command.LIMITS, Command.ACCEPT]
  if (!freeCmds.includes(command)) {
    updated.totalCt += 1
  }

  return updated
}

export function isAdmin(username: string, adminUsers: string[]): boolean {
  return adminUsers.some((admin) => admin.toLowerCase() === username.toLowerCase())
}

export function isBanned(username: string, meta: MetaComment, bannedUsers: string[]): boolean {
  const prBanned = meta.bannedUsers.some((u) => u.toLowerCase() === username.toLowerCase())
  const repoBanned = bannedUsers.some((u) => u.toLowerCase() === username.toLowerCase())
  return prBanned || repoBanned
}

const COMMAND_HELP: Record<
  string,
  { summary: string; usage: string[]; details: string[]; states: State[] }
> = {
  accept: {
    summary: "Apply a fix suggestion to the branch via cherry-pick",
    usage: [
      "`/ci-assistant accept` - apply the latest fix",
      "`/ci-assistant accept #fix-<id>` - apply a specific fix by ID",
    ],
    details: [
      "Cherry-picks the fix from a stored git ref and pushes it to the branch.",
      "If the cherry-pick fails due to conflicts, the error message includes manual fallback commands.",
      "Available fix IDs are shown in suggestion comments and in `/ci-assistant help`.",
    ],
    states: [State.ACTIVE],
  },
  alternative: {
    summary: "Request a different fix approach",
    usage: ["`/ci-assistant alternative`"],
    details: [
      "Runs Claude with all previous fix suggestions as context, asking it to try a fundamentally different approach.",
      "Previous suggestions are included so Claude avoids repeating them.",
      "Uses the `alternative-prompt` template.",
    ],
    states: [State.ACTIVE, State.NON_CODE],
  },
  suggest: {
    summary: "Request a fix or code change with custom context",
    usage: ["`/ci-assistant suggest <text>` - provide instructions for what to fix or change"],
    details: [
      "Runs Claude with your text as the primary instruction. Works with or without a prior pipeline failure.",
      "If failure logs exist, they are included as additional context.",
      "The full PR conversation history is also included, so Claude can see prior discussion.",
      "Security: input is scanned for prompt injection, secret access, destructive commands, and data exfiltration attempts.",
      "Uses the `suggest-prompt` template.",
    ],
    states: [State.ACTIVE, State.NON_CODE, State.GAVE_UP, State.NONE],
  },
  retry: {
    summary: "Re-run the analysis from scratch",
    usage: ["`/ci-assistant retry`"],
    details: [
      "Starts a fresh fix attempt using the original failure logs. Useful after CI Assistant gave up or detected a non-code issue.",
      "Runs the full retry loop (up to `max-retries` attempts) with the `auto-fix-prompt` template.",
    ],
    states: [State.GAVE_UP, State.NON_CODE],
  },
  explain: {
    summary: "Explain a fix, analyze a failure, or ask a question",
    usage: [
      "`/ci-assistant explain` - explain the latest fix, or analyze the failure if no fix exists",
      "`/ci-assistant explain #fix-<id>` - explain a specific fix by ID",
      "`/ci-assistant explain -p <text>` - ask a question about the project or PR",
      "`/ci-assistant explain #fix-<id> -p <text>` - ask a question with a specific fix as context",
    ],
    details: [
      "Claude receives the fix diff, failure logs, and the full PR conversation history as context.",
      "If you provide a specific request via `-p`, Claude responds to it. Otherwise, it explains the fix or analyzes the failure.",
      "The `-p` flag is optional. Unquoted text after `-p` is collected as the prompt (quotes also work).",
      "Claude can reproduce the error by running tests or build commands if it needs to understand the failure better.",
      "Uses the `explain-prompt` template.",
    ],
    states: [State.ACTIVE, State.NON_CODE, State.GAVE_UP, State.NONE],
  },
  help: {
    summary: "Show help information",
    usage: [
      "`/ci-assistant help` - show all commands and current state",
      "`/ci-assistant help <command>` - show detailed help for a specific command",
    ],
    details: [
      "Available commands: `accept`, `alternative`, `suggest`, `retry`, `explain`, `help`, `limits`, `admin`.",
    ],
    states: [State.ACTIVE, State.NON_CODE, State.GAVE_UP, State.NONE],
  },
  limits: {
    summary: "Show command usage and limits",
    usage: [
      "`/ci-assistant limits` - show all limits and usage",
      "`/ci-assistant limits <type>` - show details for a specific limit (retry, alternative, suggest, explain, total)",
    ],
    details: [
      "Per-command limits reset when a new commit is pushed and the pipeline fails again.",
      "The general (total) limit persists for the lifetime of the PR.",
      "An admin can override limits with `/ci-assistant admin set-limit <type> <value>`.",
    ],
    states: [State.ACTIVE, State.NON_CODE, State.GAVE_UP, State.NONE],
  },
  admin: {
    summary: "Admin-only commands for managing CI Assistant on this PR",
    usage: [
      "`/ci-assistant admin set-limit <type> <value>` - override a command limit",
      "`/ci-assistant admin reset-limits` - reset all limits and counters",
      "`/ci-assistant admin reset-state` - reset state, clear fix history",
      "`/ci-assistant admin set-model <model>` - override the Claude model",
      "`/ci-assistant admin set-max-turns <value>` - override max tool-use turns per invocation",
      "`/ci-assistant admin unban <username>` - remove a PR-level ban",
    ],
    details: [
      "Admin users are configured via the `admin-users` workflow input.",
      "Non-admin users attempting admin commands are silently ignored.",
      "Admin commands do not count toward the total command limit.",
    ],
    states: [State.ACTIVE, State.NON_CODE, State.GAVE_UP, State.NONE],
  },
}

export function formatHelpComment(
  state: State,
  meta: MetaComment,
  specificCommand?: string
): string {
  if (specificCommand && COMMAND_HELP[specificCommand]) {
    return formatCommandHelp(specificCommand, state)
  }

  if (specificCommand) {
    const validCommands = Object.keys(COMMAND_HELP)
      .map((c) => `\`${c}\``)
      .join(", ")
    return `Unknown command: \`${specificCommand}\`. Available: ${validCommands}`
  }

  const lines = [
    "## CI Assistant Help",
    "",
    `**Current state:** \`${state}\``,
    `**Fixes suggested:** ${meta.fixes.length}`,
    `**Commands used:** ${meta.totalCt}`,
    "",
    "### Available Commands",
    "",
    "| Command | Description |",
    "|---|---|",
  ]

  const commandRows: { cmd: string; desc: string; states: State[] }[] = [
    {
      cmd: "`/ci-assistant accept [#fix-<id>]`",
      desc: COMMAND_HELP.accept.summary,
      states: COMMAND_HELP.accept.states,
    },
    {
      cmd: "`/ci-assistant alternative`",
      desc: COMMAND_HELP.alternative.summary,
      states: COMMAND_HELP.alternative.states,
    },
    {
      cmd: "`/ci-assistant suggest <text>`",
      desc: COMMAND_HELP.suggest.summary,
      states: COMMAND_HELP.suggest.states,
    },
    {
      cmd: "`/ci-assistant retry`",
      desc: COMMAND_HELP.retry.summary,
      states: COMMAND_HELP.retry.states,
    },
    {
      cmd: "`/ci-assistant explain [#fix-<id>] [-p <text>]`",
      desc: COMMAND_HELP.explain.summary,
      states: COMMAND_HELP.explain.states,
    },
    {
      cmd: "`/ci-assistant help [<command>]`",
      desc: COMMAND_HELP.help.summary,
      states: COMMAND_HELP.help.states,
    },
    {
      cmd: "`/ci-assistant limits [<type>]`",
      desc: COMMAND_HELP.limits.summary,
      states: COMMAND_HELP.limits.states,
    },
    {
      cmd: "`/ci-assistant admin <subcommand>`",
      desc: COMMAND_HELP.admin.summary,
      states: COMMAND_HELP.admin.states,
    },
  ]

  for (const { cmd, desc, states } of commandRows) {
    const available = states.includes(state) ? "" : " *(not available)*"
    lines.push(`| ${cmd} | ${desc}${available} |`)
  }

  if (meta.fixes.length > 0) {
    lines.push("")
    lines.push("### Previous Fix IDs")
    lines.push("")
    for (const fixId of meta.fixes) {
      lines.push(`- \`${fixId}\``)
    }
  }

  lines.push("")
  lines.push(
    "<sub>Run `/ci-assistant help <command>` for detailed usage (e.g. `/ci-assistant help explain`). " +
      "Claude Code respects `CLAUDE.md` files in the project directory for build/test/convention instructions.</sub>"
  )

  return lines.join("\n")
}

function formatCommandHelp(commandName: string, state: State): string {
  const info = COMMAND_HELP[commandName]
  const available = info.states.includes(state)

  const lines = [
    `## CI Assistant Help: \`${commandName}\``,
    "",
    `**${info.summary}**`,
    "",
    available
      ? ":white_check_mark: Available in current state"
      : `:x: Not available in current state (\`${state}\`). Available in: ${info.states.map((s) => `\`${s}\``).join(", ")}`,
    "",
    "### Usage",
    "",
  ]

  for (const usage of info.usage) {
    lines.push(`- ${usage}`)
  }

  lines.push("")
  lines.push("### Details")
  lines.push("")

  for (const detail of info.details) {
    lines.push(`- ${detail}`)
  }

  return lines.join("\n")
}

const LIMIT_DESCRIPTIONS: Record<LimitType, { command: string; description: string }> = {
  retry: { command: "`/ci-assistant retry`", description: "Re-run analysis from scratch" },
  alternative: {
    command: "`/ci-assistant alternative`",
    description: "Request a different approach",
  },
  suggest: {
    command: "`/ci-assistant suggest`",
    description: "Analyze with user-provided context",
  },
  explain: {
    command: "`/ci-assistant explain`",
    description: "Explain a fix or analyze the failure",
  },
  total: { command: "All commands", description: "Total commands that invoke Claude on this PR" },
}

export function formatLimitsComment(
  meta: MetaComment,
  inputs: ActionInputs,
  specificType?: string
): string {
  if (specificType) {
    return formatSpecificLimit(meta, inputs, specificType)
  }

  const totalMax = getEffectiveLimit("total", meta, inputs)
  const totalDisplay = totalMax === -1 ? "unlimited" : String(totalMax)

  const lines = [
    "## CI Assistant Limits",
    "",
    `**General limit:** ${meta.totalCt} / ${totalDisplay} commands used`,
    "",
    "| Command | Used | Limit |",
    "|---|---|---|",
  ]

  const types: LimitType[] = ["retry", "alternative", "suggest", "explain"]
  for (const type of types) {
    const max = getEffectiveLimit(type, meta, inputs)
    const current = meta[LIMIT_COUNTER_MAP[type]] as number
    const maxDisplay = max === -1 ? "unlimited" : max === 0 ? "disabled" : String(max)
    const desc = LIMIT_DESCRIPTIONS[type]
    lines.push(`| ${desc.command} | ${current} | ${maxDisplay} |`)
  }

  const maxTurns = meta.maxTurnsOverride ?? inputs.maxTurns
  const maxTurnsDisplay = maxTurns === -1 ? "unlimited" : String(maxTurns)
  const maxTurnsOverridden = meta.maxTurnsOverride != null
  lines.push("")
  lines.push(
    `**Max turns per invocation:** ${maxTurnsDisplay}${maxTurnsOverridden ? " (admin override)" : ""}` +
      " (tool-use iterations per Claude invocation)"
  )

  lines.push("")
  lines.push("### When limits reset")
  lines.push("")
  lines.push(
    "Per-command limits reset when a new commit is pushed and the pipeline fails again. " +
      "The general limit persists for the lifetime of the PR. " +
      "An admin can reset limits with `/ci-assistant admin reset-limits`, " +
      "override a specific limit with `/ci-assistant admin set-limit <type> <value>`, " +
      "or increase the max turns with `/ci-assistant admin set-max-turns <value>`."
  )
  lines.push("")
  lines.push(
    "<sub>" +
      "Run `/ci-assistant limits <command>` for details on a specific command " +
      "(e.g. `/ci-assistant limits suggest`). " +
      "If fixes or explanations seem incomplete, ask an admin to increase max turns." +
      "</sub>"
  )

  return lines.join("\n")
}

function formatSpecificLimit(meta: MetaComment, inputs: ActionInputs, type: string): string {
  const validTypes = Object.keys(LIMIT_DESCRIPTIONS)
  if (!validTypes.includes(type)) {
    return `Unknown limit type: \`${type}\`. Valid types: ${validTypes.map((t) => `\`${t}\``).join(", ")}`
  }

  const limitType = type as LimitType
  const desc = LIMIT_DESCRIPTIONS[limitType]
  const max = getEffectiveLimit(limitType, meta, inputs)
  const current = meta[LIMIT_COUNTER_MAP[limitType]] as number
  const maxDisplay = max === -1 ? "unlimited" : max === 0 ? "disabled" : String(max)
  const remaining = max === -1 ? "unlimited" : max === 0 ? "0" : String(Math.max(0, max - current))

  const totalMax = getEffectiveLimit("total", meta, inputs)
  const totalDisplay = totalMax === -1 ? "unlimited" : String(totalMax)

  const isOverridden = meta.limitOverrides[limitType] !== undefined

  const lines = [
    `## CI Assistant Limits: \`${type}\``,
    "",
    `**Command:** ${desc.command}`,
    `**Description:** ${desc.description}`,
    "",
    `| | |`,
    `|---|---|`,
    `| **Used** | ${current} |`,
    `| **Limit** | ${maxDisplay}${isOverridden ? " (admin override)" : ""} |`,
    `| **Remaining** | ${remaining} |`,
    "",
    `**General limit:** ${meta.totalCt} / ${totalDisplay} commands used`,
  ]

  if (max !== -1 && current >= max) {
    lines.push("")
    lines.push(
      "This command is currently blocked. " +
        "Ask an admin to raise the limit with " +
        `\`/ci-assistant admin set-limit ${type} <value>\`.`
    )
  }

  return lines.join("\n")
}
