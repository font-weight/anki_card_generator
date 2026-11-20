import type {LanguageCode} from './languages.ts';

// The local reading transcript is a display record. It is never part of a chat request.
type NoticeKind = 'pending' | 'out_of_scope' | 'model_out_of_scope' | 'model_no_answer' | 'topic_reset';
export type BookChatTurn = { turnId: string; question: string } & (
  | { kind: 'answer'; answer: string; source?: 'analysis'; language?: LanguageCode }
  | { kind: 'failed'; message: string }
  | { kind: NoticeKind }
);

export interface BookChatPage {
  generation: string;
  turns: BookChatTurn[];
  /** Exclusive cursor for more (older) turns. Results are always chronological. */
  before: number | null;
}

export interface BookChatHistory {
  read(before?: number): Promise<BookChatPage>;
  upsert(turn: BookChatTurn, generation: string): Promise<void>;
  clear(generation: string): Promise<BookChatPage>;
  subscribe?(listener: () => void): () => void;
}
