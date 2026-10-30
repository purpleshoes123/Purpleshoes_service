type ExpiringValue<T> = { value: T; expiresAt: number };

const hashStore = new Map<string, Record<string, string>>();
const setStore = new Map<string, Set<string>>();
const stringStore = new Map<string, ExpiringValue<string>>();

function nowMs() {
  return Date.now();
}

function cleanupString(key: string): void {
  const entry = stringStore.get(key);
  if (entry && nowMs() > entry.expiresAt) {
    stringStore.delete(key);
  }
}

export function memoryGet(key: string): string | null {
  cleanupString(key);
  const entry = stringStore.get(key);
  return entry ? entry.value : null;
}

export function memorySet(key: string, value: string, ttlSeconds: number): void {
  stringStore.set(key, { value, expiresAt: nowMs() + ttlSeconds * 1000 });
}

export function memorySetNxEx(key: string, value: string, ttlSeconds: number): boolean {
  cleanupString(key);
  if (stringStore.has(key)) {
    return false;
  }
  memorySet(key, value, ttlSeconds);
  return true;
}

export function memoryDel(key: string): void {
  stringStore.delete(key);
  hashStore.delete(key);
  setStore.delete(key);
}

export function memoryHGetAll(key: string): Record<string, string> {
  return { ...(hashStore.get(key) || {}) };
}

export function memoryHSet(key: string, values: Record<string, string>): void {
  const existing = hashStore.get(key) || {};
  hashStore.set(key, { ...existing, ...values });
}

export function memoryHDel(key: string, fields: string[]): void {
  const existing = hashStore.get(key);
  if (!existing) {
    return;
  }
  for (const field of fields) {
    delete existing[field];
  }
  hashStore.set(key, existing);
}

export function memorySAdd(key: string, value: string): void {
  const set = setStore.get(key) || new Set<string>();
  set.add(value);
  setStore.set(key, set);
}

export function memorySRem(key: string, value: string): void {
  const set = setStore.get(key);
  if (!set) {
    return;
  }
  set.delete(value);
  setStore.set(key, set);
}

export function memorySMembers(key: string): string[] {
  const set = setStore.get(key);
  return set ? Array.from(set) : [];
}

export function memorySIsMember(key: string, value: string): boolean {
  const set = setStore.get(key);
  return set ? set.has(value) : false;
}
