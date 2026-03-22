import { isAbsolute, normalize, resolve, sep } from 'node:path';

export function assertSafePackRelativePath(filePath: string, field: string): string {
  const normalized = filePath.trim();
  if (!normalized) {
    throw new Error(`${field} must be a non-empty relative path.`);
  }
  if (isAbsolute(normalized)) {
    throw new Error(`${field} must stay within the pack directory.`);
  }

  const normalizedPath = normalize(normalized);
  if (normalizedPath === '..' || normalizedPath.startsWith(`..${sep}`)) {
    throw new Error(`${field} must stay within the pack directory.`);
  }

  return normalizedPath;
}

export function resolvePackFilePath(packDir: string, filePath: string, field: string): string {
  const safeRelativePath = assertSafePackRelativePath(filePath, field);
  const absolutePackDir = resolve(packDir);
  const absolutePath = resolve(absolutePackDir, safeRelativePath);
  if (absolutePath !== absolutePackDir && !absolutePath.startsWith(`${absolutePackDir}${sep}`)) {
    throw new Error(`${field} must stay within the pack directory.`);
  }
  return absolutePath;
}
