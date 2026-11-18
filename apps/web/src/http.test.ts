import { afterEach, describe, expect, it, vi } from "vitest";
import { GameError, HttpError, apiFetch, authFailMessage, httpFailMessage, isUnauthorized, onUnauthorized, request, setVisitorId, unwrap } from "./http.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  setVisitorId(null);
  onUnauthorized(null);
});

describe("request / HttpError（HTTP 错误分类）", () => {
  it("非 2xx 抛 HttpError，并解析响应体里的 code/message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: false, code: "E_FORBIDDEN", message: "拒绝" }), { status: 403 })),
    );
    const e = await request("x", "/api").catch((err: unknown) => err);
    expect(e).toBeInstanceOf(HttpError);
    expect(e).toMatchObject({ status: 403, code: "E_FORBIDDEN", message: "拒绝" });
  });

  it("非 JSON 错误体只留状态码，不吞掉", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 })));
    const e = await request("x", "/api").catch((err: unknown) => err);
    expect(e).toBeInstanceOf(HttpError);
    expect(e).toMatchObject({ status: 502 });
    expect((e as HttpError).code).toBeUndefined();
  });

  it("HTTP 200 + ok:false 仍走 GameError（游戏层拒绝）", () => {
    expect(() => unwrap({ ok: false, code: "E_PRECONDITION", message: "m" })).toThrow(GameError);
  });

  it("受保护端点 401 通知会话失效；auth 端点自身的 401 不通知", async () => {
    const seen: string[] = [];
    onUnauthorized(() => seen.push("expired"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, code: "E_UNAUTHORIZED", message: "未登录" }), { status: 401 })));
    await request("gallery", "/api/v1/rooms/r/gallery").catch(() => undefined);
    await request("login", "/api/v1/auth/login").catch(() => undefined);
    expect(seen).toEqual(["expired"]);
  });
});

describe("authFailMessage（登录/注册页优先展示服务端 message）", () => {
  it("401/403/429 保留服务端人话，5xx 折叠为统一提示", () => {
    expect(authFailMessage(new HttpError(401, "用户名或密码错误"))).toBe("用户名或密码错误");
    expect(authFailMessage(new HttpError(403, "注册未开放"))).toBe("注册未开放");
    expect(authFailMessage(new HttpError(429, "尝试过于频繁，请稍后再试"))).toBe("尝试过于频繁，请稍后再试");
    expect(authFailMessage(new HttpError(503, "boom"))).toBe("服务端暂时不可用");
  });
});

describe("httpFailMessage / isUnauthorized（状态→人话，数据驱动）", () => {
  it("401/403/429/5xx/网络异常各自归类", () => {
    expect(httpFailMessage(new HttpError(401, "x"))).toBe("登录已失效，请重新登录");
    expect(httpFailMessage(new HttpError(403, "x"))).toBe("没有权限");
    expect(httpFailMessage(new HttpError(429, "x", "E_RATE_LIMITED"))).toContain("额度");
    expect(httpFailMessage(new HttpError(503, "x"))).toBe("服务端暂时不可用");
    expect(httpFailMessage(new TypeError("Failed to fetch"))).toContain("网络异常");
  });

  it("未收录状态保留 code/message；GameError 原样透出", () => {
    expect(httpFailMessage(new HttpError(400, "字段缺失", "E_SCHEMA_INVALID"))).toBe("E_SCHEMA_INVALID: 字段缺失");
    expect(httpFailMessage(new GameError("E_ROOM_NOT_FOUND", "没了"))).toBe("E_ROOM_NOT_FOUND: 没了");
  });

  it("401 与 E_UNAUTHORIZED 都判为会话失效（多标签页改密场景）", () => {
    expect(isUnauthorized(new HttpError(401, "x"))).toBe(true);
    expect(isUnauthorized(new HttpError(400, "x", "E_UNAUTHORIZED"))).toBe(true);
    expect(isUnauthorized(new GameError("E_UNAUTHORIZED", "x"))).toBe(true);
    expect(isUnauthorized(new HttpError(500, "x"))).toBe(false);
    expect(isUnauthorized(new Error("x"))).toBe(false);
  });
});

describe("apiFetch（同源 Cookie + 访客头）", () => {
  it("默认带 same-origin 凭据；访客模式附加 X-User-Id，退出后移除", async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_path: string, init?: RequestInit) => {
        calls.push(init ?? {});
        return new Response("{}", { status: 200 });
      }),
    );
    await apiFetch("/a");
    setVisitorId("visitor_x");
    await apiFetch("/b", { headers: { "content-type": "application/json" } });
    setVisitorId(null);
    await apiFetch("/c");
    expect(calls[0]).toMatchObject({ credentials: "same-origin" });
    expect((calls[0]?.headers as Record<string, string>)["x-user-id"]).toBeUndefined();
    expect((calls[1]?.headers as Record<string, string>)["x-user-id"]).toBe("visitor_x");
    expect((calls[1]?.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect((calls[2]?.headers as Record<string, string>)["x-user-id"]).toBeUndefined();
  });
});