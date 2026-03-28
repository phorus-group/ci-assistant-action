jest.mock("@actions/core", () => ({
  info: jest.fn(),
  warning: jest.fn(),
  setFailed: jest.fn(),
  summary: {
    addRaw: jest.fn().mockReturnThis(),
    write: jest.fn().mockResolvedValue(undefined),
  },
}))
jest.mock("@actions/exec", () => ({
  exec: jest.fn().mockResolvedValue(0),
  getExecOutput: jest.fn().mockResolvedValue({ stdout: "1.0.0\n", stderr: "", exitCode: 0 }),
}))

import * as core from "@actions/core"
import * as exec from "@actions/exec"
import { validateAuth, installClaude } from "../src/auth"
import { Mode } from "../src/types"

describe("validateAuth", () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    jest.clearAllMocks()
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it("skips auth for cleanup mode", async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    delete process.env.ANTHROPIC_API_KEY

    const result = await validateAuth(Mode.CLEANUP)
    expect(result).toBeNull()
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it("uses OAuth token when valid", async () => {
    // testOAuthToken uses exec.exec with listeners.stdout
    ;(exec.exec as jest.Mock).mockImplementationOnce(
      async (
        _cmd: string,
        _args: string[],
        options?: { listeners?: { stdout?: (data: Buffer) => void } }
      ) => {
        if (options?.listeners?.stdout) {
          options.listeners.stdout(Buffer.from("claude 1.0.0\n"))
        }
        return 0
      }
    )

    const result = await validateAuth(Mode.AUTO_FIX, "sk-ant-oat01-test")
    expect(result).toEqual({ method: "oauth", token: "sk-ant-oat01-test" })
    expect(core.warning).not.toHaveBeenCalled()
  })

  it("falls back to API key when OAuth expired", async () => {
    ;(exec.getExecOutput as jest.Mock).mockRejectedValueOnce(new Error("401 Unauthorized"))

    const result = await validateAuth(Mode.AUTO_FIX, "expired-token", "sk-test-api-key")
    expect(result).toEqual({ method: "api-key", token: "sk-test-api-key" })
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("expired"))
    expect(core.summary.addRaw).toHaveBeenCalledWith(expect.stringContaining("expired"))
  })

  it("fails when OAuth expired and no API key", async () => {
    ;(exec.getExecOutput as jest.Mock).mockRejectedValueOnce(new Error("401 Unauthorized"))

    const result = await validateAuth(Mode.AUTO_FIX, "expired-token")
    expect(result).toBeNull()
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining("expired"))
    expect(core.summary.addRaw).toHaveBeenCalled()
  })

  it("uses API key with warning when no OAuth token", async () => {
    const result = await validateAuth(Mode.AUTO_FIX, "", "sk-test-api-key")
    expect(result).toEqual({ method: "api-key", token: "sk-test-api-key" })
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("pay-per-use"))
    expect(core.summary.addRaw).toHaveBeenCalledWith(expect.stringContaining("setup-token"))
  })

  it("fails when neither token is set", async () => {
    const result = await validateAuth(Mode.AUTO_FIX)
    expect(result).toBeNull()
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining("No Claude authentication"))
    expect(core.summary.addRaw).toHaveBeenCalledWith(
      expect.stringContaining("CLAUDE_CODE_OAUTH_TOKEN")
    )
  })
})

describe("installClaude", () => {
  it("runs npm install", async () => {
    await installClaude()
    expect(exec.exec).toHaveBeenCalledWith(
      "npm",
      ["install", "-g", "@anthropic-ai/claude-code"],
      expect.any(Object)
    )
  })
})
