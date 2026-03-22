import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const DEFAULT_MAX_JSON_BODY_BYTES = 256 * 1024;

export function generateAccessToken(): string {
  return randomBytes(24).toString('hex');
}

export function normalizeAccessToken(token: string | undefined, field: string): string {
  const normalized = token?.trim();
  if (!normalized) {
    throw new Error(`Missing ${field}.`);
  }
  if (normalized.length < 24) {
    throw new Error(`${field} must be at least 24 characters.`);
  }
  if (/[\0\r\n]/.test(normalized)) {
    throw new Error(`${field} must not contain control characters.`);
  }
  return normalized;
}

export function requestHasValidToken(req: IncomingMessage, expectedToken: string): boolean {
  const provided = getRequestToken(req);
  if (!provided) return false;

  const left = Buffer.from(provided, 'utf8');
  const right = Buffer.from(expectedToken, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number = DEFAULT_MAX_JSON_BODY_BYTES,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new Error(`JSON body exceeds ${maxBytes} bytes.`);
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    throw new Error('Request body must be valid JSON.');
  }

  try {
    return JSON.parse(raw);
  } catch (err: unknown) {
    throw new Error(`Invalid JSON body: ${(err as Error).message}`);
  }
}

export function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

function getRequestToken(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string') {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  const tokenHeader = req.headers['x-ivn-token'];
  if (typeof tokenHeader === 'string' && tokenHeader.trim()) {
    return tokenHeader.trim();
  }

  return null;
}
