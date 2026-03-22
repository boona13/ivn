import chalk from 'chalk';
import { IvnStore } from './store.js';

export type CommandHandler<TArgs extends unknown[]> = (...args: TArgs) => void | Promise<void>;

export function exitWithCliError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  console.error(chalk.red(`  \u2716 ${message}`));
  process.exit(1);
}

export function handleCommand<TArgs extends unknown[]>(handler: CommandHandler<TArgs>) {
  return async (...args: TArgs): Promise<void> => {
    try {
      await handler(...args);
    } catch (err: unknown) {
      exitWithCliError(err);
    }
  };
}

export function withOpenStore<T>(run: (store: IvnStore) => T, root?: string): T {
  const store = IvnStore.open(root);
  try {
    return run(store);
  } finally {
    store.close();
  }
}

export async function withOpenStoreAsync<T>(
  run: (store: IvnStore) => Promise<T> | T,
  root?: string,
): Promise<T> {
  const store = IvnStore.open(root);
  try {
    return await run(store);
  } finally {
    store.close();
  }
}

export function parseTags(value?: string): string[] | undefined {
  return value
    ?.split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

export function requireEntry(store: IvnStore, id: string) {
  const entry = store.get(id);
  if (!entry) {
    throw new Error(`Knowledge #${id} not found`);
  }
  return entry;
}

export async function getChangedFilesForCommand(
  store: IvnStore,
  sinceGit?: string | boolean,
): Promise<{ ref: string; changedFiles: string[] }> {
  const { getChangedFiles } = await import('./git.js');
  const ref = typeof sinceGit === 'string' ? sinceGit : 'HEAD';
  return {
    ref,
    changedFiles: getChangedFiles(store.getRoot(), ref),
  };
}
