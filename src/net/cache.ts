import { get, set } from 'idb-keyval';

const hasIdb = typeof indexedDB !== 'undefined';
const memory = new Map<string, unknown>();

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  if (!hasIdb) return memory.get(key) as T | undefined;
  try {
    return await get<T>(key);
  } catch {
    return undefined;
  }
}

export async function cacheSet(key: string, value: unknown): Promise<void> {
  if (!hasIdb) {
    memory.set(key, value);
    return;
  }
  try {
    await set(key, value);
  } catch {
    // Cache write failure is non-fatal (private mode, quota).
  }
}
