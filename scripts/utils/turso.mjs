import { createClient } from '@libsql/client/http';
import { setTimeout as sleep } from 'node:timers/promises';

const transportCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE',
  'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ConnectionClosed', 'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

function transportFailure(error) {
  const seen = new Set();
  for (let cause = error; cause && !seen.has(cause); cause = cause.cause) {
    seen.add(cause);
    if (transportCodes.has(cause.code)) return cause.code;
    if (cause.name === 'TimeoutError') return 'timeout';
    if (/socket connection was closed unexpectedly/i.test(cause.message ?? '')) return 'socket closed';
    if (cause.name === 'TypeError' && /^(fetch failed|failed to fetch|network error)$/i.test(cause.message ?? '')) {
      return 'network error';
    }
  }
  return null;
}

// Retry the whole read operation, so a failed transaction uses a fresh stream.
// Replaying individual HTTP requests can reuse an invalid transaction baton.
export async function retryTursoRead(operation, { attempts = 3, wait = sleep, log = console.log } = {}) {
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error('Read attempts must be a positive integer');
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await operation(); }
    catch (error) {
      const reason = transportFailure(error);
      if (!reason) throw error;
      if (attempt + 1 === attempts) {
        throw new Error(`Turso database read failed after ${attempts} attempts (${reason}); rerun to resume completed results`,
          { cause: error });
      }
      log(`Turso database read: ${reason}; retrying (${attempt + 2}/${attempts}).`);
      await wait(Math.min(60000, 1000 * 2 ** attempt));
    }
  }
}

export function tursoSettings(env = process.env) {
  const value = env.TURSO_DATABASE_URL;
  let url;
  try { url = new URL(value); }
  catch { throw new Error('TURSO_DATABASE_URL must be a libsql:// or https:// database URL'); }
  if (!['libsql:', 'https:'].includes(url.protocol) || !url.hostname ||
      url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('TURSO_DATABASE_URL must be a libsql:// or https:// database URL without credentials or query parameters');
  }
  if (typeof env.TURSO_AUTH_TOKEN !== 'string' || !env.TURSO_AUTH_TOKEN.trim()) {
    throw new Error('TURSO_AUTH_TOKEN is missing; load credentials with bun --env-file=.env.local');
  }
  // Both URL schemes identify the same remote database and use HTTPS transport.
  return { url: new URL(`https://${url.host}`).origin, authToken: env.TURSO_AUTH_TOKEN };
}

export function connectTurso(settings, { fetchFn = fetch, timeout = 60000, createClientFn = createClient } = {}) {
  const { url, authToken } = tursoSettings({ TURSO_DATABASE_URL: settings.url, TURSO_AUTH_TOKEN: settings.authToken });
  return createClientFn({ url, authToken,
    fetch: async (input, options) => {
      const signal = options?.signal ?? input?.signal;
      try {
        // Long AI calls leave database sockets idle; avoid reusing stale Bun sockets.
        return await fetchFn(input, { ...options, redirect: 'error', keepalive: false,
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
      } catch (error) {
        const reason = transportFailure(error);
        if (!reason) throw error;
        throw new Error(`Turso HTTP transport failed (${reason})`, { cause: error });
      }
    },
  });
}

export async function withTransaction(client, mode, operation, retryOptions) {
  const execute = () => transactionOnce(client, mode, operation);
  if (mode === 'read') return retryTursoRead(execute, retryOptions);
  try { return await execute(); }
  catch (error) {
    const reason = transportFailure(error);
    if (!reason) throw error;
    throw new Error(`Turso database write failed (${reason}); commit status may be unknown. Rerun to scan for missing records`,
      { cause: error });
  }
}

async function transactionOnce(client, mode, operation) {
  const transaction = await client.transaction(mode);
  try {
    const result = await operation(transaction);
    await transaction.commit();
    return result;
  } catch (error) {
    try { await transaction.rollback(); } catch { /* Preserve the original error. */ }
    throw error;
  } finally {
    transaction.close();
  }
}
