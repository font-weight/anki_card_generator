import { ServiceError } from './errors.ts';
/** Secret access is internal to the trusted service worker; never register it as RPC data. */
export interface SecretStorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  setAccessLevel?(options: { accessLevel: 'TRUSTED_CONTEXTS' }): Promise<void>;
}

export interface SecretStorage {
  session?: SecretStorageArea;
  local: SecretStorageArea;
  // Deliberately no sync storage dependency.
}

export type SecretKind = 'openai' | 'ankiConnect';
export type SecretPersistence = 'session' | 'local' | null;
export interface SecretStatus {
  hasOpenAIKey: boolean;
  hasAnkiConnectKey: boolean;
  openAIStorage: SecretPersistence;
  ankiConnectStorage: SecretPersistence;
}

export class SecretStorageError extends ServiceError {
  constructor(code: 'PERMISSION_DENIED' | 'INVALID_INPUT' | 'STORAGE_QUOTA' | 'STORAGE_UNAVAILABLE', message: string, retryable = false) {
    super(code, message, retryable);
    this.name = 'SecretStorageError';
  }
}

const KEYS: Record<SecretKind, string> = {
  openai: 'englishReader.secret.openai.v1',
  ankiConnect: 'englishReader.secret.ankiConnect.v1',
};

function validatedKey(value: string): string {
  if (typeof value !== 'string' || value.length > 4096 || !value.trim() || /\s/.test(value.trim())) {
    throw new SecretStorageError('INVALID_INPUT', 'Некорректный формат ключа.');
  }
  return value.trim();
}

/**
 * Promise-based Chrome storage adapter. Invoke init before exposing any extension RPC.
 * Session storage is the default. Persistent storage is opt-in, not encryption.
 * Service methods are not a public RPC API; status() is the only public-safe projection.
 */
export class SecretVault {
  #storage: SecretStorage;
  #initializing?: Promise<void>;
  #mutations: Promise<void> = Promise.resolve();

  constructor(storage: SecretStorage) {
    this.#storage = storage;
  }

  init(): Promise<void> {
    if (!this.#initializing) {
      this.#initializing = (async () => {
        if (!this.#storage.session) {
          throw new SecretStorageError('PERMISSION_DENIED', 'Для безопасного хранения ключа требуется chrome.storage.session.');
        }
        try {
          // local is normally content-script-readable, so restrict it even before opt-in.
          await this.#storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
          await this.#storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
        } catch {
          throw new SecretStorageError('PERMISSION_DENIED', 'Не удалось ограничить доступ к хранилищу ключей.');
        }
      })();
    }
    return this.#initializing;
  }

  async #read(kind: SecretKind): Promise<{ key: string | null; persistence: SecretPersistence }> {
    await this.init();
    await this.#mutations;
    try {
      const slot = KEYS[kind];
      const session = await this.#storage.session!.get(slot);
      if (typeof session[slot] === 'string' && session[slot]) {
        return { key: session[slot] as string, persistence: 'session' };
      }
      // Fail closed if an older runtime cannot hide local keys from content scripts.
      if (!this.#storage.local.setAccessLevel) return { key: null, persistence: null };
      const local = await this.#storage.local.get(slot);
      return typeof local[slot] === 'string' && local[slot]
        ? { key: local[slot] as string, persistence: 'local' }
        : { key: null, persistence: null };
    } catch {
      throw new SecretStorageError('PERMISSION_DENIED', 'Не удалось прочитать защищённые настройки расширения.');
    }
  }

  /** Internal injection for provider clients ONLY. Never return this value through messaging. */
  async getOpenAIKeyForService(): Promise<string | null> { return (await this.#read('openai')).key; }
  /** Internal injection for AnkiConnect ONLY. Never return this value through messaging. */
  async getAnkiConnectKeyForService(): Promise<string | null> { return (await this.#read('ankiConnect')).key; }

  async status(): Promise<SecretStatus> {
    const openai = await this.#read('openai');
    const anki = await this.#read('ankiConnect');
    return {
      hasOpenAIKey: openai.key !== null,
      hasAnkiConnectKey: anki.key !== null,
      openAIStorage: openai.persistence,
      ankiConnectStorage: anki.persistence,
    };
  }

  #enqueue(work: () => Promise<void>): Promise<void> {
    const result = this.#mutations.then(work);
    this.#mutations = result.catch(() => {});
    return result;
  }

  async #set(kind: SecretKind, value: string, persist: boolean): Promise<void> {
    const key = validatedKey(value);
    if (typeof persist !== 'boolean') throw new SecretStorageError('INVALID_INPUT', 'Требуется явный выбор способа хранения ключа.');
    await this.init();
    if (persist && !this.#storage.local.setAccessLevel) {
      throw new SecretStorageError('PERMISSION_DENIED', 'Постоянное хранение ключа недоступно без ограничения TRUSTED_CONTEXTS.');
    }
    return this.#enqueue(async () => {
      const slot = KEYS[kind];
      try {
        if (persist) {
          await this.#storage.local.set({ [slot]: key });
          await this.#storage.session!.remove(slot);
        } else {
          // Do not leave a previously persisted credential after opt-out.
          await this.#storage.local.remove(slot);
          await this.#storage.session!.set({ [slot]: key });
        }
      } catch (error) {
        const quota = error instanceof Error && (error.name === 'QuotaExceededError' || /(?:QUOTA_BYTES|MAX_WRITE_OPERATIONS|quota exceeded)/i.test(error.message));
        throw new SecretStorageError(quota ? 'STORAGE_QUOTA' : 'STORAGE_UNAVAILABLE', 'Не удалось сохранить ключ. Проверьте доступное место и настройки расширения.');
      }
    });
  }

  setOpenAIKey(key: string, options: { persist?: boolean } = {}): Promise<void> {
    return this.#set('openai', key, options.persist ?? false);
  }
  setAnkiConnectKey(key: string, options: { persist?: boolean } = {}): Promise<void> {
    return this.#set('ankiConnect', key, options.persist ?? false);
  }

  async #clear(kind: SecretKind): Promise<void> {
    await this.init();
    return this.#enqueue(async () => {
      const results = await Promise.allSettled([
        this.#storage.session!.remove(KEYS[kind]), this.#storage.local.remove(KEYS[kind]),
      ]);
      if (results.some(result => result.status === 'rejected')) {
        throw new SecretStorageError('PERMISSION_DENIED', 'Не удалось полностью удалить ключ из хранилищ расширения.');
      }
    });
  }

  clearOpenAIKey(): Promise<void> { return this.#clear('openai'); }
  clearAnkiConnectKey(): Promise<void> { return this.#clear('ankiConnect'); }
}
