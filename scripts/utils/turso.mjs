import { createClient } from '@libsql/client/http';

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
    fetch: (input, options) => {
      const signal = options?.signal ?? input?.signal;
      return fetchFn(input, { ...options, redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
    },
  });
}

export async function withTransaction(client, mode, operation) {
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
