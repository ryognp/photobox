const KEY = "photobox:active-session";

export type StoredSession = { sessionId: string; workspaceId: string };

export function loadStoredSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "sessionId" in parsed &&
      "workspaceId" in parsed &&
      typeof (parsed as Record<string, unknown>).sessionId === "string" &&
      typeof (parsed as Record<string, unknown>).workspaceId === "string"
    ) {
      return {
        sessionId: (parsed as Record<string, string>).sessionId,
        workspaceId: (parsed as Record<string, string>).workspaceId,
      };
    }
    return null;
  } catch { return null; }
}

export function saveSession(session: StoredSession): void {
  try { localStorage.setItem(KEY, JSON.stringify(session)); } catch { /* ignore */ }
}

export function clearStoredSession(): void {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
