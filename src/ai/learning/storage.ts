/**
 * Where player models are kept between sessions (DESIGN.md 7.2).
 *
 * Two implementations behind one interface, because the same AI code has to
 * run in three places: the browser (IndexedDB, survives a reload), Node and
 * the batch tool (memory, and usually thrown away between runs), and the
 * tests (memory, so they stay deterministic and leave nothing behind).
 *
 * Every method is async, including the memory one. A synchronous interface
 * would have been simpler here and wrong the moment IndexedDB showed up.
 */

import type { PlayerModelData } from './playerModel.ts';

/**
 * Models are per map and per player, as DESIGN.md asks.
 *
 * Per map because a haunt is a place, and places do not survive a map change.
 * Per player because the whole point is to learn *this* opponent — a shared
 * model would average every player who has ever sat down into one mush.
 */
export interface ModelKey {
  mapId: string;
  playerId: string;
}

export interface ModelStore {
  load(key: ModelKey): Promise<PlayerModelData | null>;
  save(key: ModelKey, data: PlayerModelData): Promise<void>;
  /** Forget one player's model, or everything when no key is given. */
  clear(key?: ModelKey): Promise<void>;
  /** Keys currently held, for a settings screen that lists them. */
  list(): Promise<ModelKey[]>;
}

export function keyOf(key: ModelKey): string {
  return `${key.mapId}::${key.playerId}`;
}

function parseKey(raw: string): ModelKey {
  const [mapId = '', playerId = ''] = raw.split('::');
  return { mapId, playerId };
}

/** The store used by Node, the batch tool and the tests. */
export class MemoryModelStore implements ModelStore {
  private readonly entries = new Map<string, PlayerModelData>();

  async load(key: ModelKey): Promise<PlayerModelData | null> {
    return this.entries.get(keyOf(key)) ?? null;
  }

  async save(key: ModelKey, data: PlayerModelData): Promise<void> {
    // Structured-cloned on the way in so a later mutation of the live model
    // cannot reach back and edit what is supposedly already saved.
    this.entries.set(keyOf(key), structuredClone(data));
  }

  async clear(key?: ModelKey): Promise<void> {
    if (key) this.entries.delete(keyOf(key));
    else this.entries.clear();
  }

  async list(): Promise<ModelKey[]> {
    return [...this.entries.keys()].map(parseKey);
  }
}

const DB_NAME = 'sky-tag-learning';
const DB_VERSION = 1;
const STORE = 'playerModels';

/**
 * The browser store.
 *
 * Every operation opens the database, does its work and closes: these happen
 * once between rounds, never in the loop, so holding a connection open for the
 * life of the page would buy nothing and would have to be torn down carefully.
 */
export class IndexedDbModelStore implements ModelStore {
  static available(): boolean {
    return typeof indexedDB !== 'undefined';
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'));
    });
  }

  private async run<T>(
    mode: IDBTransactionMode,
    body: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = body(tx.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'));
      });
    } finally {
      db.close();
    }
  }

  async load(key: ModelKey): Promise<PlayerModelData | null> {
    const found = await this.run<PlayerModelData | undefined>('readonly', (store) =>
      store.get(keyOf(key)),
    );
    return found ?? null;
  }

  async save(key: ModelKey, data: PlayerModelData): Promise<void> {
    await this.run('readwrite', (store) => store.put(data, keyOf(key)));
  }

  async clear(key?: ModelKey): Promise<void> {
    await this.run('readwrite', (store) => (key ? store.delete(keyOf(key)) : store.clear()));
  }

  async list(): Promise<ModelKey[]> {
    const keys = await this.run<IDBValidKey[]>('readonly', (store) => store.getAllKeys());
    return keys.map((raw) => parseKey(String(raw)));
  }
}

/**
 * The store this environment can actually use.
 *
 * Falls back to memory rather than throwing, so a private window with storage
 * blocked still plays — it just does not remember you between sessions.
 */
export function defaultModelStore(): ModelStore {
  return IndexedDbModelStore.available() ? new IndexedDbModelStore() : new MemoryModelStore();
}
