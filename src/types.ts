export enum State {
  ACTIVE = "active",
  NON_CODE = "non-code",
  GAVE_UP = "gave-up",
  NONE = "none",
}

export enum Mode {
  AUTO_FIX = "auto-fix",
  COMMAND = "command",
  MANUAL = "manual",
  CLEANUP = "cleanup",
}

export enum ConfidenceStatus {
  REPRODUCED_AND_VERIFIED = "reproduced-and-verified",
  NOT_REPRODUCED_TESTS_PASS = "not-reproduced-tests-pass",
  REPRODUCED_TESTS_FAIL = "reproduced-tests-fail",
  NEITHER = "neither",
  NON_CODE = "non-code",
  GAVE_UP = "gave-up",
}

export enum Command {
  ACCEPT = "accept",
  ALTERNATIVE = "alternative",
  SUGGEST = "suggest",
  RETRY = "retry",
  EXPLAIN = "explain",
  HELP = "help",
  LIMITS = "limits",
  ADMIN = "admin",
}

export enum AdminCommand {
  SET_LIMIT = "set-limit",
  RESET_LIMITS = "reset-limits",
  RESET_STATE = "reset-state",
  SET_MODEL = "set-model",
  SET_MAX_TURNS = "set-max-turns",
  UNBAN = "unban",
}

export type LimitType = "retry" | "alternative" | "suggest" | "explain" | "total"

export interface LimitOverrides {
  retry?: number
  alternative?: number
  suggest?: number
  explain?: number
  total?: number
}

export interface MetaComment {
  version: number
  state: State
  retryCt: number
  altCt: number
  suggestCt: number
  explainCt: number
  totalCt: number
  fixes: string[]
  latestFix: string | null
  slackTs: string | null
  slackChannel: string | null
  gaveUp: boolean
  limitOverrides: LimitOverrides
  modelOverride: string | null
  maxTurnsOverride: number | null
  exploitAttempts: number
  bannedUsers: string[]
  lastSha: string | null
  lastRunId: string | null
  isTagFailure: boolean
  tagSourceBranch: string | null
}

export interface ConfidenceResult {
  status: ConfidenceStatus
  percentage: number
  reproduced: boolean
  testsPass: boolean
}

export interface RetryAttempt {
  attempt: number
  diff: string | null
  filesChanged: string[]
  testOutput: string | null
  reproductionOutput: string | null
  confidence: ConfidenceResult | null
  outputFile: string | null
  fixTitle: string | null
  fixDescription: string | null
  fixError: string | null
}

export interface ParsedCommand {
  command: Command
  fixId?: string
  userContext?: string
  adminCommand?: AdminCommand
  adminArgs?: string[]
}

export interface ActionInputs {
  mode: Mode
  workingDirectory: string
  maxTurns: number
  maxRetries: number
  maxRetryCommands: number
  maxAlternativeCommands: number
  maxSuggestCommands: number
  maxExplainCommands: number
  maxTotalCommands: number
  model: string
  skipPermissions: boolean
  allowedTools: string[]
  disallowedTools: string[]
  appendSystemPrompt: string
  adminUsers: string[]
  bannedUsers: string[]
  slackFailureChannel: string
  slackThreadTs: string
  slackBotToken: string
  failedRunId: string
  failedBranch: string
  failedSha: string
  failedPrNumber: string
  commentPrNumber: string
  autoFixPrompt: string
  retryPrompt: string
  alternativePrompt: string
  suggestPrompt: string
  explainPrompt: string
  confidencePrompt: string
  summaryPrompt: string
  githubToken: string
  claudeCodeOauthToken: string
  anthropicApiKey: string
  commentBody: string
}

export interface SlackBlock {
  type: string
  text?: { type: string; text: string }
  elements?: unknown[]
}

export function createDefaultMeta(): MetaComment {
  return {
    version: 1,
    state: State.NONE,
    retryCt: 0,
    altCt: 0,
    suggestCt: 0,
    explainCt: 0,
    totalCt: 0,
    fixes: [],
    latestFix: null,
    slackTs: null,
    slackChannel: null,
    gaveUp: false,
    limitOverrides: {},
    modelOverride: null,
    maxTurnsOverride: null,
    exploitAttempts: 0,
    bannedUsers: [],
    lastSha: null,
    lastRunId: null,
    isTagFailure: false,
    tagSourceBranch: null,
  }
}

export const DEFAULT_META: MetaComment = createDefaultMeta()

export const CONFIDENCE_STATUS_ICONS: Record<ConfidenceStatus, string> = {
  [ConfidenceStatus.REPRODUCED_AND_VERIFIED]: ":green_circle:",
  [ConfidenceStatus.NOT_REPRODUCED_TESTS_PASS]: ":yellow_circle:",
  [ConfidenceStatus.REPRODUCED_TESTS_FAIL]: ":orange_circle:",
  [ConfidenceStatus.NEITHER]: ":orange_circle:",
  [ConfidenceStatus.NON_CODE]: ":blue_circle:",
  [ConfidenceStatus.GAVE_UP]: ":red_circle:",
}

export const CONFIDENCE_STATUS_LABELS: Record<ConfidenceStatus, string> = {
  [ConfidenceStatus.REPRODUCED_AND_VERIFIED]: "Reproduced and verified",
  [ConfidenceStatus.NOT_REPRODUCED_TESTS_PASS]: "Fix suggested but could not be reproduced",
  [ConfidenceStatus.REPRODUCED_TESTS_FAIL]: "Fix suggested but could not be verified",
  [ConfidenceStatus.NEITHER]: "Fix suggested but error could not be reproduced",
  [ConfidenceStatus.NON_CODE]: "Non-code issue",
  [ConfidenceStatus.GAVE_UP]: "Could not fix",
}

export const META_MARKER = "<!-- ci-assistant-meta:"
export const SUGGESTION_HEADER = "## CI Assistant Suggestion"
export const CI_ASSISTANT_PREFIX = "/ci-assistant"
