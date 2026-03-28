import * as core from "@actions/core"
import * as exec from "@actions/exec"
import { Mode } from "./types"

export interface AuthResult {
  method: "oauth" | "api-key"
  token: string
}

export async function validateAuth(
  mode: Mode,
  oauthToken: string = "",
  apiKey: string = ""
): Promise<AuthResult | null> {
  if (mode === Mode.CLEANUP) {
    return null
  }

  if (oauthToken) {
    const valid = await testOAuthToken(oauthToken)
    if (valid) {
      return { method: "oauth", token: oauthToken }
    }

    const renewalInstructions = [
      "To renew the OAuth token:",
      "1. Run: claude setup-token",
      "2. Copy the token",
      "3. Update CLAUDE_CODE_OAUTH_TOKEN secret in your repository/organization settings",
    ].join("\n")

    if (apiKey) {
      const warning = `## :warning: Claude OAuth token expired\n\nFalling back to API key (pay-per-use billing).\n\n${renewalInstructions}`
      core.warning("Claude OAuth token expired, falling back to API key (pay-per-use)")
      core.summary.addRaw(warning)
      await core.summary.write()
      return { method: "api-key", token: apiKey }
    }

    const error = `## :x: Claude OAuth token expired\n\nNo API key fallback configured.\n\n${renewalInstructions}`
    core.setFailed("Claude OAuth token expired and no API key fallback")
    core.summary.addRaw(error)
    await core.summary.write()
    return null
  }

  if (apiKey) {
    const warning = `## :warning: Using API key (pay-per-use)\n\nConsider using \`claude setup-token\` for subscription-based quota instead of pay-per-use billing.\n\n1. Run: \`claude setup-token\`\n2. Copy the token\n3. Store as \`CLAUDE_CODE_OAUTH_TOKEN\` secret`
    core.warning("Using API key (pay-per-use). Recommend claude setup-token.")
    core.summary.addRaw(warning)
    await core.summary.write()
    return { method: "api-key", token: apiKey }
  }

  const error = `## :x: No Claude authentication configured\n\nSet one of:\n- \`CLAUDE_CODE_OAUTH_TOKEN\` (from \`claude setup-token\`, uses subscription quota, recommended)\n- \`ANTHROPIC_API_KEY\` (pay-per-use)`
  core.setFailed("No Claude authentication configured")
  core.summary.addRaw(error)
  await core.summary.write()
  return null
}

async function testOAuthToken(token: string): Promise<boolean> {
  try {
    let output = ""
    await exec.exec("claude", ["--version"], {
      env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token },
      silent: true,
      listeners: {
        stdout: (data) => {
          output += data.toString()
        },
      },
    })
    return output.trim().length > 0
  } catch {
    return false
  }
}

export async function installClaude(): Promise<void> {
  core.info("Installing Claude Code CLI...")
  await exec.exec("npm", ["install", "-g", "@anthropic-ai/claude-code"], {
    silent: true,
  })
  core.info("Claude Code CLI installed")
}
