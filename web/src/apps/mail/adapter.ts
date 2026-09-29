// The shared mail UI (list, conversation view, compose) talks to a mail provider only through this small adapter.
// Gmail and Outlook each implement it. Everything a provider returns is untrusted text (R12).
import type { AppId } from "../../core/state";

/** One row of the conversation list. */
export interface Thread { id: string; subject: string; senders: string[]; count: number; date: string; snippet: string; unread: boolean; starred: boolean }
export interface TMsg { id: string; from: string; fromAddr: string; replyTo: string; to: string; toAddrs: string[]; cc: string; date: string; unread: boolean; starred: boolean; sent: boolean; text: string; replyHint?: string }
export interface TFull { id: string; subject: string; count: number; truncated: boolean; messages: TMsg[] }
export interface Draft { to: string; cc: string; subject: string; body: string; replyToId?: string; /** simple-reply providers: who the provider will send it to (display only) */ replyHint?: string }
export interface Outgoing { to: string[]; cc: string[]; subject: string; body: string; replyToId?: string }
export type MailAction = "read" | "unread" | "mark" | "unmark" | "archive";

export interface MailState { label: string; q: string; threads: Thread[]; next: string | null; unread: number | null }
export const freshState = (label: string): MailState => ({ label, q: "", threads: [], next: null, unread: null });

export interface MailAdapter {
  app: AppId; name: string; icon: string;
  tabs: Array<[string, string]>; folders: Array<[string, string]>;
  /** Labels whose list loses a conversation when it is archived. */
  inbox: Set<string>;
  markLabel: [on: string, off: string, doneOn: string, doneOff: string]; // Star / Flag wording
  searchable: boolean;
  /** true = the provider chooses the reply recipients and quotes the original (Outlook): the composer only asks for the text. */
  simpleReply: boolean;
  state: MailState;
  wipe(): void;
  list(label: string, q: string, more: string | null): Promise<{ threads: Thread[]; next: string | null }>;
  unreadCount(): Promise<number>;
  open(id: string): Promise<TFull>;
  act(id: string, a: MailAction): Promise<void>;
  trash(id: string, label: string): Promise<void>;
  send(o: Outgoing): Promise<void>;
  replyDraft(t: TFull, last: TMsg): Draft;
}
