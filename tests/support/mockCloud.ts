// Test double for Claude's artifact `db` + `user` capabilities.
// One MockCloud is the "server"; each clientFor(uid) is a different signed-in
// person on a different device. Access rules mirror DB_RULES in cloudDb.ts:
//   data/users/<x>/**  read+write only by x
//   pat/<x>/**, doc/<x>/**, cg/<x>/**  read by everyone (interact), write only by x
//   everything else: read by everyone, write by the artifact owner only.

import type { CloudDb, CloudUser, CollRef, DocRef, DocSnap, Query, QuerySnap } from '../../src/services/backend/cloudDb';

type Store = Map<string, Record<string, unknown>>;
const err = (code: string, message = code) => Object.assign(new Error(message), { code, message });
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

export class MockCloud {
  store: Store = new Map();
  private listeners = new Set<() => void>();
  writes = 0;
  constructor(public ownerUid = 'owner') {}

  notify() { for (const l of [...this.listeners]) setTimeout(l, 0); }
  listen(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  canRead(uid: string, path: string) {
    const seg = path.split('/');
    if (seg[0] === 'data' && seg[1] === 'users') return seg[2] === uid;
    return true;
  }
  canWrite(uid: string, path: string) {
    const seg = path.split('/');
    if (seg[0] === 'data' && seg[1] === 'users') return seg[2] === uid;
    if (seg[0] === 'pat' || seg[0] === 'doc' || seg[0] === 'cg') return seg[1] === uid || uid === this.ownerUid;
    return uid === this.ownerUid;
  }

  clientFor(uid: string, name = uid): { db: CloudDb; user: CloudUser } {
    const cloud = this;
    const snap = (path: string): DocSnap => {
      const id = path.split('/').pop()!;
      const visible = cloud.canRead(uid, path) && cloud.store.has(path);
      const body = visible ? Object.freeze(clone(cloud.store.get(path)!)) : undefined;
      return { id, exists: visible, data: () => body };
    };
    const docRef = (path: string): DocRef => {
      const parts = path.split('/');
      if (parts.length % 2 !== 0 || parts.some((p) => !p)) throw new TypeError(`bad doc path ${path}`);
      return {
        id: parts[parts.length - 1], path,
        get: async () => snap(path),
        set: async (data) => {
          if (!cloud.canWrite(uid, path)) throw err('invalid_argument', `write denied ${path}`);
          if (JSON.stringify(data).length > 256 * 1024) throw err('invalid_argument', 'too large');
          cloud.store.set(path, clone(data)); cloud.writes++; cloud.notify();
        },
        update: async (data) => {
          if (!cloud.canWrite(uid, path)) throw err('invalid_argument', `write denied ${path}`);
          if (!cloud.store.has(path)) throw err('invalid_argument', 'update of missing doc');
          cloud.store.set(path, { ...cloud.store.get(path)!, ...clone(data) }); cloud.writes++; cloud.notify();
        },
        delete: async () => {
          if (!cloud.canWrite(uid, path)) throw err('invalid_argument', `delete denied ${path}`);
          cloud.store.delete(path); cloud.writes++; cloud.notify();
        },
        onSnapshot: (next) => {
          let last = '';
          const run = () => { const s = snap(path); const k = JSON.stringify([s.exists, s.data()]); if (k !== last) { last = k; next(s); } };
          setTimeout(run, 0);
          return cloud.listen(run);
        },
        collection: (sub) => collRef(`${path}/${sub}`),
      };
    };
    const makeQuery = (coll: string, filters: [string, string, unknown][], lim = 1000): Query => {
      const run = (): QuerySnap => {
        const depth = coll.split('/').length + 1;
        const docs = [...cloud.store.keys()]
          .filter((p) => p.startsWith(coll + '/') && p.split('/').length === depth && cloud.canRead(uid, p))
          .sort()
          .map(snap)
          .filter((d) => filters.every(([f, op, v]) => {
            const x = (d.data() as Record<string, unknown>)[f];
            if (op === '==') return x === v;
            if (op === '!=') return x !== v;
            if (op === 'array-contains') return Array.isArray(x) && x.includes(v);
            throw err('invalid_argument', 'op not mocked');
          }))
          .slice(0, lim);
        return { docs, size: docs.length, empty: docs.length === 0 };
      };
      return {
        where: (f, op, v) => makeQuery(coll, [...filters, [f, op, v]], lim),
        orderBy: () => makeQuery(coll, filters, lim),
        limit: (n) => makeQuery(coll, filters, n),
        get: async () => run(),
        onSnapshot: (next) => {
          let last = '';
          const tick = () => { const s = run(); const k = JSON.stringify(s.docs.map((d) => [d.id, d.data()])); if (k !== last) { last = k; next(s); } };
          setTimeout(tick, 0);
          return cloud.listen(tick);
        },
      };
    };
    const collRef = (path: string): CollRef => {
      if (path.split('/').length % 2 !== 1) throw new TypeError(`bad collection path ${path}`);
      return Object.assign(makeQuery(path, []), {
        path,
        doc: (id?: string) => docRef(`${path}/${id ?? Math.random().toString(36).slice(2)}`),
      });
    };
    return {
      db: { doc: docRef, collection: collRef },
      user: { id: async () => uid, me: async () => ({ id: uid, name }), can: async () => true },
    };
  }
}
