import { describe, expect, it } from "vitest";
import { RequestScope } from "./request-scope.ts";

describe("RequestScope（身份+房间版本隔离）", () => {
  it("renew 作废旧令牌并中止旧请求，新令牌可用", () => {
    const scope = new RequestScope();
    const old = scope.current();
    expect(scope.isCurrent(old.version)).toBe(true);
    const next = scope.renew();
    expect(scope.isCurrent(old.version)).toBe(false);
    expect(scope.isCurrent(next.version)).toBe(true);
    expect(old.signal.aborted).toBe(true);
    expect(next.signal.aborted).toBe(false);
  });

  it("连续切换只有最新一代有效", () => {
    const scope = new RequestScope();
    const a = scope.renew();
    const b = scope.renew();
    const c = scope.renew();
    expect(scope.isCurrent(a.version)).toBe(false);
    expect(scope.isCurrent(b.version)).toBe(false);
    expect(scope.isCurrent(c.version)).toBe(true);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
  });

  it("abort 中止当前在途请求但不改版本号", () => {
    const scope = new RequestScope();
    const token = scope.current();
    scope.abort();
    expect(token.signal.aborted).toBe(true);
    expect(scope.isCurrent(token.version)).toBe(true);
  });
});