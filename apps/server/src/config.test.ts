/**
 * 配置回归测试：审核器不许"静默自动开启"。
 *
 * 曾经的坑：audit.baseUrl 默认继承 LLM_BASE_URL、model 写死一个名字，
 * 于是只配了叙事模型的标准部署会自动开启审核，等于同一端点同一 key 自审，
 * 且端点不支持那个模型名时每回合都失败 → 叙事全被兜底文案替换。
 */
import { afterEach, describe, expect, it } from "vitest";
import { hasAudit, hasLlm, loadConfig } from "./config.ts";

const KEYS = ["GALGAME_ADMIN_TOKEN", "GALGAME_LLM_BASE_URL", "GALGAME_LLM_MODEL", "GALGAME_LLM_API_KEY", "GALGAME_AUDIT_BASE_URL", "GALGAME_AUDIT_MODEL", "GALGAME_AUDIT_API_KEY"];
const saved = new Map<string, string | undefined>(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function clearAudit(): void {
  for (const k of KEYS) delete process.env[k];
}

describe("审核器配置", () => {
  it("只配叙事模型时，审核仍是关闭的（不继承端点/key，也没有默认模型名）", () => {
    clearAudit();
    process.env.GALGAME_LLM_BASE_URL = "https://example.invalid/api/v1";
    process.env.GALGAME_LLM_MODEL = "some-narrative-model";
    process.env.GALGAME_LLM_API_KEY = "sk-test";

    const cfg = loadConfig();
    expect(hasLlm(cfg)).toBe(true);
    expect(cfg.audit?.baseUrl ?? "").toBe("");
    expect(cfg.audit?.model ?? "").toBe("");
    expect(cfg.audit?.apiKey ?? "").toBe("");
    expect(hasAudit(cfg)).toBe(false);
  });

  it("三项齐全才判定为已配置（缺一项仍关闭）", () => {
    clearAudit();
    process.env.GALGAME_AUDIT_BASE_URL = "https://audit.example.invalid/api/v1";
    process.env.GALGAME_AUDIT_MODEL = "another-family-model";
    expect(hasAudit(loadConfig())).toBe(false);

    process.env.GALGAME_AUDIT_API_KEY = "sk-audit";
    expect(hasAudit(loadConfig())).toBe(true);
  });
});

describe("管理员令牌强度（复审 P1）", () => {
  it("显式配置的低熵/过短令牌拒绝启动", () => {
    clearAudit();
    for (const weak of ["dev-admin", "admin1234567890123", "aaaaaaaaaaaaaaaa"]) {
      process.env.GALGAME_ADMIN_TOKEN = weak;
      expect(() => loadConfig(), weak).toThrow(/GALGAME_ADMIN_TOKEN/);
    }
  });

  it("高熵随机令牌通过并原样使用", () => {
    clearAudit();
    const strong = "K7pQ2xV9mR4tY8wZ3nB6cL1sD5fG0hJ2";
    process.env.GALGAME_ADMIN_TOKEN = strong;
    expect(loadConfig().adminToken).toBe(strong);
  });

  it("未配置时生成本进程随机令牌（不落默认口令）", () => {
    clearAudit();
    const a = loadConfig().adminToken;
    const b = loadConfig().adminToken;
    expect(a.length).toBeGreaterThanOrEqual(16);
    expect(a).not.toBe(b);
  });
});
