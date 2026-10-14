# Shared script utilities

Utilities here can be used by any script category under `scripts/`.

- `files.mjs`: hashing, JSON reads, and atomic JSON writes.
- `turso.mjs`: connection settings, HTTPS clients, and transaction cleanup.
- `ai-gateway.mjs`: structured OpenAI requests through Cloudflare AI Gateway,
  usage costs, retries, rolling rate limits, and per-run budget accounting.
- `numbers.mjs`: integer validation and exact USD/token-rate conversion.

Keep these modules independent of generator-specific prompts, schemas, queries,
and output files. Each script category owns those details.

## Turso

```js
import { connectTurso, tursoSettings, withTransaction } from './scripts/utils/turso.mjs';

const client = connectTurso(tursoSettings());
try {
  const result = await withTransaction(client, 'read', (transaction) =>
    transaction.execute({ sql: 'SELECT name FROM languages WHERE id = ?', args: ['language-id'] }));
  console.log(result.rows);
} finally {
  client.close();
}
```

`withTransaction` commits on success, rolls back on failure, and always closes the
transaction. Read transactions retry transient connection failures up to three
attempts, restarting the entire transaction with a fresh stream. Standalone
read queries can use `retryTursoRead(() => client.execute(...))`. Both accept
retry options (`attempts`, `wait`, `log`); pass them as the fourth argument to
`withTransaction`. SQL errors, authentication failures, and caller cancellation
are not retried. Writes are never retried implicitly because a lost commit
response can leave their outcome unknown.

The HTTP client disables Bun's connection reuse to avoid stale database sockets
after long AI calls. Transport failures identify Turso in the error message;
retry logs omit raw errors and credentials.

## AI Gateway

`requestBody(cfg, prompt, input, schema, schemaName)` accepts the caller's payload
and JSON schema without assuming phonetic records. `createGateway(cfg, options)`
accepts caller-supplied metadata and injectable fetch, clock, wait, and logging
functions. Configuration fields are `provider`, `api`, `model`, `effort`,
`builtIn`, `outputTokens`, `account`, `gateway`, `token`, `prices`, `rpm`, `tpm`,
`attempts`, `timeout`, and `budget`; costs and budgets use integer nano-USD.

Use `gateway.runBatch(async () => { ... })` to admit a processing batch below its
budget, then finish its requests/reviews after crossing the threshold. Call
`gateway.assertBudget()` before starting independent work outside that scope.
`gateway.request(body)` accounts for every attempt, and `gateway.totals()` reports
usage and known/uncertain costs. The caller validates and persists results.

Provider-native requests use the stored OpenAI key and gateway authentication:
[Cloudflare BYOK documentation](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/).
The Turso client uses the official
[libSQL client API](https://docs.turso.tech/sdk/ts/reference).
