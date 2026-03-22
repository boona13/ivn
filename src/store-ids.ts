import { randomBytes } from 'node:crypto';

const MAX_ID_ALLOCATION_ATTEMPTS = 5;

export function generateId(): string {
  return randomBytes(8).toString('hex');
}

function isIdCollisionError(err: unknown): boolean {
  return (
    err instanceof Error &&
    /SQLITE_CONSTRAINT(?:_[A-Z]+)?:.*(?:PRIMARY KEY|knowledge\.id|edges\.id|knowledge_events\.id)/.test(err.message)
  );
}

export function allocatePersistedUniqueId<T>(
  buildValue: (id: string) => T,
  persist: (value: T) => void,
  label: string,
): T {
  for (let attempt = 0; attempt < MAX_ID_ALLOCATION_ATTEMPTS; attempt++) {
    const value = buildValue(generateId());
    try {
      persist(value);
      return value;
    } catch (err: unknown) {
      if (isIdCollisionError(err) && attempt < MAX_ID_ALLOCATION_ATTEMPTS - 1) {
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Could not allocate a unique ${label} id.`);
}
