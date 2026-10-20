import type { LookupPayload, NoteDraft } from '@english-reader/contracts';

/** Adapter unwraps RPC success data; rejects on transport or contract errors. No secrets in this interface. */
export type UiRpc = <T = unknown>(type: string, payload?: Record<string, unknown>) => Promise<T>;
export interface PopupOptions {
  rpc: UiRpc;
  anchor: DOMRect | (() => DOMRect | null);
  lookupPayload: LookupPayload;
  source: NoteDraft['source'];
  onClose?: () => void;
  /** Only extension-owned pages may opt in. Webpage DOM must never contain private Anki metadata. */
  trustedPage?: boolean;
  /** Fixed host callback opening trusted extension settings; never an arbitrary page URL. */
  openSettings?: () => void | Promise<void>;
  /** Must use the same renderer used by the Anki adapter. HTML is extension-generated, never page/model HTML. */
  renderPreview?: (draft: NoteDraft) => { front: string; back: string };
}
export interface PopupHandle { close(): void; update(options: PopupOptions): void; }
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Не удалось выполнить действие. Повторите попытку.';
}
