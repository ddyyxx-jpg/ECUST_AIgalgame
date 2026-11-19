import { describe, expect, it } from "vitest";
import { enterVisitorStorage, signOutVisitorStorage, visitorIdForRestore } from "./visitor-storage.ts";

describe("本地访客存档身份", () => {
  it("旧访客可自动进入，退出后保留原 ID，手动重新进入后恢复自动进入", () => {
    const entries = new Map([["ecust.galgame.visitorId", "visitor_existing"]]);
    const storage = {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => { entries.set(key, value); },
      removeItem: (key: string) => { entries.delete(key); },
    };

    expect(visitorIdForRestore(storage)).toBe("visitor_existing");
    signOutVisitorStorage(storage);
    expect(visitorIdForRestore(storage)).toBeNull();
    expect(enterVisitorStorage(storage, () => "visitor_new")).toBe("visitor_existing");
    expect(visitorIdForRestore(storage)).toBe("visitor_existing");
  });
});
