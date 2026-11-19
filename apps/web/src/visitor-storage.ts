const VISITOR_KEY = "ecust.galgame.visitorId";
const VISITOR_SIGNED_OUT_KEY = "ecust.galgame.visitorSignedOut";

type VisitorStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function visitorIdForRestore(storage: VisitorStorage): string | null {
  return storage.getItem(VISITOR_SIGNED_OUT_KEY) === "1" ? null : storage.getItem(VISITOR_KEY);
}

export function enterVisitorStorage(storage: VisitorStorage, createId: () => string): string {
  const saved = storage.getItem(VISITOR_KEY);
  const id = saved || createId();
  if (!saved) storage.setItem(VISITOR_KEY, id);
  storage.removeItem(VISITOR_SIGNED_OUT_KEY);
  return id;
}

export function signOutVisitorStorage(storage: VisitorStorage): void {
  storage.setItem(VISITOR_SIGNED_OUT_KEY, "1");
}
