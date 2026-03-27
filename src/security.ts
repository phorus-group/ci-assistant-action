export interface SecurityCheckResult {
  safe: boolean
  reason?: string
}

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /ignore\s+(all\s+)?above\s+instructions/i,
  /you\s+are\s+now\s+a/i,
  /new\s+system\s+prompt/i,
  /override\s+system\s+prompt/i,
  /disregard\s+(all\s+)?prior/i,
  /forget\s+(all\s+)?previous/i,
  /act\s+as\s+(a\s+)?different/i,
  /pretend\s+you\s+are/i,
  /your\s+new\s+instructions/i,
  /from\s+now\s+on\s+you/i,
  /system:\s/i,
  /\[SYSTEM\]/i,
  /<\|im_start\|>/i,
  /<\|endoftext\|>/i,
]

const SECRET_ACCESS_PATTERNS = [
  /process\.env/i,
  /\$\{?\{?\s*(secrets|env)\./i,
  /GITHUB_TOKEN/i,
  /ANTHROPIC_API_KEY/i,
  /CLAUDE_CODE_OAUTH_TOKEN/i,
  /SLACK_BOT_TOKEN/i,
  /cat\s+.*\.env/i,
  /printenv/i,
  /echo\s+\$[A-Z_]/i,
]

const DESTRUCTIVE_PATTERNS = [
  /rm\s+-rf\s+\//i,
  /rm\s+-rf\s+\*/i,
  /dd\s+if=.*of=\/dev/i,
  /mkfs\./i,
  /:(){ :\|:& };:/,
  /git\s+push\s+.*--force/i,
  /git\s+reset\s+--hard/i,
  /chmod\s+-R\s+777\s+\//i,
]

const EXFILTRATION_PATTERNS = [
  /curl\s+.*\|\s*sh/i,
  /wget\s+.*\|\s*sh/i,
  /curl\s+.*-d\s+.*@/i,
  /nc\s+-e/i,
  /base64.*\|\s*curl/i,
  /curl\s+.*ngrok/i,
  /curl\s+.*webhook\.site/i,
  /curl\s+.*requestbin/i,
]

export function checkForExploitation(input: string): SecurityCheckResult {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(input)) {
      return { safe: false, reason: "prompt-injection" }
    }
  }

  for (const pattern of SECRET_ACCESS_PATTERNS) {
    if (pattern.test(input)) {
      return { safe: false, reason: "secret-access" }
    }
  }

  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(input)) {
      return { safe: false, reason: "destructive-command" }
    }
  }

  for (const pattern of EXFILTRATION_PATTERNS) {
    if (pattern.test(input)) {
      return { safe: false, reason: "data-exfiltration" }
    }
  }

  return { safe: true }
}
