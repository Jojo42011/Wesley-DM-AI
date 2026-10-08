/** Read-only, bounded history recovery. Never executes or replays old turns. */
export interface HistoryMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string;
}
export interface ConversationHistory {
  messages: HistoryMessage[];
  complete: boolean;
}
type Page = { ok: boolean; json: unknown };
const string = (v: unknown): string => typeof v === "string" ? v.trim() : "";

export async function readConversationHistory(
  input: { conversationId: string; accountId: string; beforeMessageId?: string | null; beforeAt?: string | null },
  getPage: (path: string) => Promise<Page>,
): Promise<ConversationHistory> {
  const rows: Record<string, unknown>[] = [];
  const cursors = new Set<string>();
  let cursor = "", complete = false;
  try {
    for (let page = 0; page < 10; page++) {
      const query = new URLSearchParams({ accountId: input.accountId, sortOrder: "desc", limit: "100" });
      if (cursor) query.set("cursor", cursor);
      const response = await getPage(`/inbox/conversations/${encodeURIComponent(input.conversationId)}/messages?${query}`);
      if (!response.ok) break;
      const data = (response.json ?? {}) as { messages?: unknown; data?: unknown; pagination?: { hasMore?: boolean; nextCursor?: string } };
      const list = Array.isArray(data.messages) ? data.messages : Array.isArray(data.data) ? data.data : [];
      rows.push(...list.filter((m): m is Record<string, unknown> => !!m && typeof m === "object"));
      if (!data.pagination?.hasMore) { complete = true; break; }
      const next = string(data.pagination.nextCursor);
      if (!next || cursors.has(next)) break;
      cursors.add(next); cursor = next;
    }
  } catch { /* An unavailable provider must not prevent the live reply. */ }

  const boundary = rows.find(m => input.beforeMessageId &&
    [string(m.id), string(m.platformMessageId)].includes(input.beforeMessageId));
  const time = Date.parse(string(boundary?.createdAt) || string(boundary?.sentAt) || input.beforeAt || "");
  const seen = new Set<string>();
  const messages: HistoryMessage[] = [];
  for (const row of rows) {
    const id = string(row.platformMessageId) || string(row.id);
    const at = string(row.createdAt) || string(row.sentAt);
    const text = string(row.message) || string(row.text);
    if (!id || seen.has(id) || !text || !Number.isFinite(Date.parse(at))) continue;
    if (row.isDeleted === true || !["incoming", "outgoing"].includes(string(row.direction))) continue;
    // Without a trustworthy boundary, do not import a possibly future message.
    if (!Number.isFinite(time) || Date.parse(at) >= time ||
        (input.beforeMessageId && [string(row.id), string(row.platformMessageId)].includes(input.beforeMessageId))) continue;
    seen.add(id);
    messages.push({ id, role: row.direction === "incoming" ? "user" : "assistant", text, at: new Date(at).toISOString() });
  }
  messages.sort((a, b) => a.at.localeCompare(b.at));
  return { messages, complete: complete && Number.isFinite(time) };
}

/** Explicit response to an invitation, not a general bypass of spam/opt-out gates. */
export function respondsToDmInvitation(text: string): boolean {
  return /\b(?:you|u)\s+(?:(?:had|just)\s+)?(?:said|asked|told|wanted)\b.{0,45}\b(?:dm|message|messaging|text|inbox)\b/i.test(text)
    || /\b(?:here|messaging|dm(?:ing)?)\s+(?:you\s+)?(?:as|like|because)\s+(?:you|u)\s+(?:asked|said)\b/i.test(text);
}
