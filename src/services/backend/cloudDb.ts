// The subset of Claude's artifact `db` capability that CloudBackend uses.
// Matches the platform contract (runtime 0.2.88) so the real namespace and the
// test double in tests/ are interchangeable.

export interface DocSnap { id: string; exists: boolean; data(): Record<string, unknown> | undefined }
export interface QuerySnap { docs: DocSnap[]; size: number; empty: boolean }
export type Unsub = () => void;
export interface DbErr { code: string; message: string }

export interface DocRef {
  id: string;
  path: string;
  get(): Promise<DocSnap>;
  set(data: Record<string, unknown>): Promise<void>;
  update(data: Record<string, unknown>): Promise<void>;
  delete(): Promise<void>;
  onSnapshot(next: (s: DocSnap) => void, error?: (e: DbErr) => void): Unsub;
  collection(path: string): CollRef;
}
export interface Query {
  where(field: string, op: string, value: unknown): Query;
  orderBy(field: string, dir?: 'asc' | 'desc'): Query;
  limit(n: number): Query;
  get(): Promise<QuerySnap>;
  onSnapshot(next: (s: QuerySnap) => void, error?: (e: DbErr) => void): Unsub;
}
export interface CollRef extends Query { path: string; doc(id?: string): DocRef }
export interface CloudDb { doc(path: string): DocRef; collection(path: string): CollRef }

export interface CloudUser {
  id(): Promise<string | null>;
  me(): Promise<{ id: string | null; name: string }>;
  can(name: string): Promise<boolean | null>;
}

/** Access rules declared at publish (see scripts/publishConfig). */
export const DB_RULES = [
  { path: '', read: 'interact', write: 'owner' },
  { path: 'data/users/{self}', write: 'interact' },
  { path: 'pat', read: 'interact', write: 'owner' },
  { path: 'pat/{self}', write: 'interact' },
  { path: 'doc', read: 'interact', write: 'owner' },
  { path: 'doc/{self}', write: 'interact' },
  { path: 'cg', read: 'interact', write: 'owner' },
  { path: 'cg/{self}', write: 'interact' },
];
