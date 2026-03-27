import { handleAdminCommand } from "../src/admin"
import { AdminCommand, DEFAULT_META, State } from "../src/types"

describe("handleAdminCommand", () => {
  describe("set-limit", () => {
    it("sets a specific limit", () => {
      const result = handleAdminCommand(AdminCommand.SET_LIMIT, ["retry", "10"], {
        ...DEFAULT_META,
      })
      expect(result.success).toBe(true)
      expect(result.updatedMeta?.limitOverrides.retry).toBe(10)
    })

    it("sets unlimited (-1) and also sets total to unlimited", () => {
      const result = handleAdminCommand(AdminCommand.SET_LIMIT, ["suggest", "-1"], {
        ...DEFAULT_META,
      })
      expect(result.success).toBe(true)
      expect(result.updatedMeta?.limitOverrides.suggest).toBe(-1)
      expect(result.updatedMeta?.limitOverrides.total).toBe(-1)
      expect(result.message).toContain("Total command limit")
    })

    it("sets total to unlimited without affecting specific limits", () => {
      const result = handleAdminCommand(AdminCommand.SET_LIMIT, ["total", "-1"], {
        ...DEFAULT_META,
      })
      expect(result.success).toBe(true)
      expect(result.updatedMeta?.limitOverrides.total).toBe(-1)
      expect(result.updatedMeta?.limitOverrides.suggest).toBeUndefined()
    })

    it("rejects invalid limit type", () => {
      const result = handleAdminCommand(AdminCommand.SET_LIMIT, ["invalid", "5"], {
        ...DEFAULT_META,
      })
      expect(result.success).toBe(false)
    })

    it("rejects invalid value", () => {
      const result = handleAdminCommand(AdminCommand.SET_LIMIT, ["retry", "abc"], {
        ...DEFAULT_META,
      })
      expect(result.success).toBe(false)
    })

    it("rejects missing args", () => {
      const result = handleAdminCommand(AdminCommand.SET_LIMIT, [], { ...DEFAULT_META })
      expect(result.success).toBe(false)
    })
  })

  describe("reset-limits", () => {
    it("resets all counters and overrides", () => {
      const meta = {
        ...DEFAULT_META,
        suggestCt: 5,
        totalCt: 10,
        limitOverrides: { suggest: 20 },
      }
      const result = handleAdminCommand(AdminCommand.RESET_LIMITS, [], meta)
      expect(result.success).toBe(true)
      expect(result.updatedMeta?.suggestCt).toBe(0)
      expect(result.updatedMeta?.totalCt).toBe(0)
      expect(result.updatedMeta?.limitOverrides).toEqual({})
    })
  })

  describe("reset-state", () => {
    it("resets state but preserves total count, overrides, and failure context", () => {
      const meta = {
        ...DEFAULT_META,
        state: State.ACTIVE,
        totalCt: 10,
        fixes: ["#fix-abc"],
        limitOverrides: { suggest: 20 },
        modelOverride: "claude-opus-4-6",
        bannedUsers: ["bad-user"],
        slackTs: "slack-ts-123",
        slackChannel: "C0TEST",
        lastSha: "sha-456",
        lastRunId: "run-789",
        isTagFailure: true,
        tagSourceBranch: "release/1.0",
        exploitAttempts: 2,
      }
      const result = handleAdminCommand(AdminCommand.RESET_STATE, [], meta)
      expect(result.success).toBe(true)
      // Fix history cleared
      expect(result.updatedMeta?.state).toBe("none")
      expect(result.updatedMeta?.fixes).toEqual([])
      expect(result.updatedMeta?.latestFix).toBeNull()
      expect(result.updatedMeta?.gaveUp).toBe(false)
      expect(result.updatedMeta?.retryCt).toBe(0)
      expect(result.updatedMeta?.altCt).toBe(0)
      expect(result.updatedMeta?.suggestCt).toBe(0)
      expect(result.updatedMeta?.explainCt).toBe(0)
      // General limit preserved
      expect(result.updatedMeta?.totalCt).toBe(10)
      // Admin overrides preserved
      expect(result.updatedMeta?.limitOverrides).toEqual({ suggest: 20 })
      expect(result.updatedMeta?.modelOverride).toBe("claude-opus-4-6")
      // Bans and exploit tracking preserved
      expect(result.updatedMeta?.bannedUsers).toEqual(["bad-user"])
      expect(result.updatedMeta?.exploitAttempts).toBe(2)
      // Slack context preserved
      expect(result.updatedMeta?.slackTs).toBe("slack-ts-123")
      expect(result.updatedMeta?.slackChannel).toBe("C0TEST")
      // Failure context preserved (needed for commands to download logs)
      expect(result.updatedMeta?.lastSha).toBe("sha-456")
      expect(result.updatedMeta?.lastRunId).toBe("run-789")
      expect(result.updatedMeta?.isTagFailure).toBe(true)
      expect(result.updatedMeta?.tagSourceBranch).toBe("release/1.0")
    })
  })

  describe("set-model", () => {
    it("sets model override", () => {
      const result = handleAdminCommand(AdminCommand.SET_MODEL, ["claude-opus-4-6"], {
        ...DEFAULT_META,
      })
      expect(result.success).toBe(true)
      expect(result.updatedMeta?.modelOverride).toBe("claude-opus-4-6")
    })

    it("rejects missing model arg", () => {
      const result = handleAdminCommand(AdminCommand.SET_MODEL, [], { ...DEFAULT_META })
      expect(result.success).toBe(false)
    })
  })

  describe("unban", () => {
    it("unbans a PR-banned user", () => {
      const meta = { ...DEFAULT_META, bannedUsers: ["bad-user", "other-user"] }
      const result = handleAdminCommand(AdminCommand.UNBAN, ["bad-user"], meta)
      expect(result.success).toBe(true)
      expect(result.updatedMeta?.bannedUsers).toEqual(["other-user"])
    })

    it("fails when user is not banned", () => {
      const result = handleAdminCommand(AdminCommand.UNBAN, ["not-banned"], { ...DEFAULT_META })
      expect(result.success).toBe(false)
    })

    it("rejects missing username", () => {
      const result = handleAdminCommand(AdminCommand.UNBAN, [], { ...DEFAULT_META })
      expect(result.success).toBe(false)
    })
  })

  describe("set-max-turns", () => {
    it("sets max turns override", () => {
      const result = handleAdminCommand(AdminCommand.SET_MAX_TURNS, ["30"], { ...DEFAULT_META })
      expect(result.success).toBe(true)
      expect(result.updatedMeta?.maxTurnsOverride).toBe(30)
      expect(result.message).toContain("30")
    })

    it("sets unlimited with -1", () => {
      const result = handleAdminCommand(AdminCommand.SET_MAX_TURNS, ["-1"], { ...DEFAULT_META })
      expect(result.success).toBe(true)
      expect(result.updatedMeta?.maxTurnsOverride).toBe(-1)
      expect(result.message).toContain("unlimited")
    })

    it("clears override with 0", () => {
      const meta = { ...DEFAULT_META, maxTurnsOverride: 30 }
      const result = handleAdminCommand(AdminCommand.SET_MAX_TURNS, ["0"], meta)
      expect(result.success).toBe(true)
      expect(result.updatedMeta?.maxTurnsOverride).toBeNull()
    })

    it("rejects missing value", () => {
      const result = handleAdminCommand(AdminCommand.SET_MAX_TURNS, [], { ...DEFAULT_META })
      expect(result.success).toBe(false)
    })

    it("rejects invalid value", () => {
      const result = handleAdminCommand(AdminCommand.SET_MAX_TURNS, ["abc"], { ...DEFAULT_META })
      expect(result.success).toBe(false)
    })

    it("rejects value below -1", () => {
      const result = handleAdminCommand(AdminCommand.SET_MAX_TURNS, ["-5"], { ...DEFAULT_META })
      expect(result.success).toBe(false)
    })
  })

  describe("reset-state preserves overrides", () => {
    it("preserves maxTurnsOverride on reset", () => {
      const meta = { ...DEFAULT_META, maxTurnsOverride: 100, state: State.ACTIVE }
      const result = handleAdminCommand(AdminCommand.RESET_STATE, [], meta)
      expect(result.success).toBe(true)
      expect(result.updatedMeta?.maxTurnsOverride).toBe(100)
      expect(result.updatedMeta?.state).toBe("none")
    })
  })

  it("returns error for unknown admin command", () => {
    const result = handleAdminCommand("unknown" as AdminCommand, [], { ...DEFAULT_META })
    expect(result.success).toBe(false)
    expect(result.message).toContain("set-max-turns")
  })
})
