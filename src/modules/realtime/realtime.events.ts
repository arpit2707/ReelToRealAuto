// Contract shared with the webapp (src/lib/realtime.ts there). Events are
// hints, not data: the browser reacts by re-reading the REST endpoints, which
// stay the single source of truth. A missed event therefore costs at most a
// delay, never a wrong or missing message.

export const REALTIME_PATH = '/api/realtime';

export const InboxEvents = {
  /** A message was stored or a chat's state changed for this org. */
  changed: 'inbox:changed',
} as const;

export type InboxChange = {
  kind: 'message' | 'conversation' | 'sync';
  /** Absent when many chats changed at once (a history import). */
  conversationId?: string;
  platform?: string;
  at: string;
};

export const orgRoom = (orgId: string) => `org:${orgId}`;
