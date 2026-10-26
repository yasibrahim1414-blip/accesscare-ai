// Key-value persistence adapter. The demo uses browser localStorage when it is
// available (Claude preview keeps it per viewer, per browser). If storage is
// blocked we fall back to memory and report it so the UI can warn the user.

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  readonly persistent: boolean;
}

export class MemoryStore implements KeyValueStore {
  private data = new Map<string, string>();
  readonly persistent = false;
  get(key: string) { return this.data.has(key) ? this.data.get(key)! : null; }
  set(key: string, value: string) { this.data.set(key, value); }
  remove(key: string) { this.data.delete(key); }
}

export class BrowserStore implements KeyValueStore {
  readonly persistent = true;
  constructor(private ls: Storage) {}
  get(key: string) { try { return this.ls.getItem(key); } catch { return null; } }
  set(key: string, value: string) { try { this.ls.setItem(key, value); } catch { /* quota or blocked */ } }
  remove(key: string) { try { this.ls.removeItem(key); } catch { /* ignore */ } }
}

export function createDefaultStore(): KeyValueStore {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return new MemoryStore();
    const probe = '__accesscare_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return new BrowserStore(ls);
  } catch {
    return new MemoryStore();
  }
}
