/** 存档列表的状态机：loading / ready / empty(ready+[]) / unauthorized / forbidden / error 分开，不再静默吞错。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchSaves } from "./api.ts";
import type { SaveEntry, SaveSlot } from "./api.ts";
import { HttpError, httpFailMessage, isUnauthorized } from "./http.ts";

export type SavesStatus = "idle" | "loading" | "ready" | "unauthorized" | "forbidden" | "error";

export interface SavesState {
  status: SavesStatus;
  saves: SaveEntry[];
  /** issue #98：命名槽映射（旧服务端缺省 → 空数组） */
  slots: SaveSlot[];
  error: string;
}

const IDLE: SavesState = { status: "idle", saves: [], slots: [], error: "" };

/** identity = 当前账号/访客 id；切换时作废旧请求并按新身份重拉 */
export function useSaves(identity: string | null): { savesState: SavesState; refreshSaves: () => Promise<void> } {
  const [savesState, setSavesState] = useState<SavesState>(IDLE);
  const version = useRef(0);

  const refreshSaves = useCallback(async () => {
    const v = ++version.current;
    setSavesState((s) => ({ ...s, status: "loading" }));
    try {
      const { saves, slots } = await fetchSaves();
      if (v === version.current) setSavesState({ status: "ready", saves, slots, error: "" });
    } catch (e) {
      if (v !== version.current) return;
      const status: SavesStatus = isUnauthorized(e)
        ? "unauthorized"
        : e instanceof HttpError && e.status === 403
          ? "forbidden"
          : "error";
      setSavesState({ status, saves: [], slots: [], error: httpFailMessage(e) });
    }
  }, []);

  useEffect(() => {
    if (!identity) {
      version.current += 1;
      setSavesState(IDLE);
      return;
    }
    void refreshSaves();
  }, [identity, refreshSaves]);

  return { savesState, refreshSaves };
}