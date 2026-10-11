import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { integer, usd, rate } from '../../utils/numbers.mjs';
import { tursoSettings } from '../../utils/turso.mjs';

export const help = (task) => `Usage: bun [--env-file=.env.local] scripts/generators/populate-${task}.mjs [options]
  (no flags)           Generate missing values and save finalized results locally
  --write             Insert each finalized batch; create no local files
  --budget USD        Per-run stop threshold; finish the active batch/reviews
  --config PATH       YAML settings; default <script-dir>/config/${task}.yml
  --model NAME        Default: gpt-6.1-sol
  --provider NAME     Only openai (provider-native AI Gateway)
  --batch-size N      Usable words per processing batch / items per AI call, 1-1000; default 20
  --batch-size-multiplicity N  Retrieve batch size × N usable words at a time; default 1, explicit integer N > 1
  --state-dir PATH    Local results/pair; default <script-dir>/.state
  --help              This help
See README.md and scripts/generators/config/${task}.yml. Environment variables supply Turso connection settings and credentials.
The database target comes from TURSO_DATABASE_URL.`;

const CONFIG_SCHEMA = {
  stateDir: 'string', batchSize: 'number', batchSizeMultiplicity: 'number',
  ai: {
    provider: 'string', model: 'string', api: 'string', reasoningEffort: 'string', maxOutputTokens: 'number',
    pricesUsdPerMillion: { input: 'string', cachedInput: 'string', cacheWrite: 'string', output: 'string' },
  },
  limits: {
    maxUsd: 'string', requestsPerMinute: 'number', tokensPerMinute: 'number', maxAttempts: 'number', timeoutMs: 'number',
  },
  cloudflare: { accountId: 'string', gatewayId: 'string' },
  languagePolicies: 'policies',
};

function validateSettings(value, schema, path = 'config') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be a mapping`);
  for (const [key, item] of Object.entries(value)) {
    const field = `${path}.${key}`;
    if (!Object.hasOwn(schema, key)) throw new Error(`Unknown setting: ${field}`);
    const type = schema[key];
    if (typeof type === 'object') validateSettings(item, type, field);
    else if (type === 'policies') {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${field} must be a mapping`);
      for (const [code, policy] of Object.entries(item)) {
        validateSettings(policy, { dialect: 'string', script: 'string' }, `${field}.${code}`);
        for (const text of Object.values(policy)) {
          if (text.length > 200 || /[\p{Cc}\p{Cf}]/u.test(text)) throw new Error(`Invalid policy: ${field}.${code}`);
        }
        if (policy.script && policy.script !== 'Japanese') new RegExp(`\\p{Script_Extensions=${policy.script}}`, 'u');
      }
    } else if (typeof item !== type || (type === 'string' && !item.trim()) ||
        (type === 'number' && !Number.isSafeInteger(item))) {
      throw new Error(`${field} must be ${type === 'number' ? 'an integer' : 'a nonempty string (quote monetary values)'}`);
    }
  }
}

export function configuration(task, argv = process.argv.slice(2), env = process.env, read = readFileSync) {
  if (!['transcriptions', 'respellings'].includes(task)) throw new Error('Unknown population task');
  const { values } = parseArgs({ args: argv, options: {
    help: { type: 'boolean' }, write: { type: 'boolean' },
    budget: { type: 'string' }, model: { type: 'string' }, provider: { type: 'string' },
    'batch-size': { type: 'string' }, 'batch-size-multiplicity': { type: 'string' },
    'state-dir': { type: 'string' }, config: { type: 'string' },
  } });
  if (values.help) return { help: true };
  const path = values.config ? resolve(values.config) : fileURLToPath(new URL(`../config/${task}.yml`, import.meta.url));
  const text = read(path, 'utf8');
  let settings;
  try { settings = Bun.YAML.parse(text); }
  catch { throw new Error(`Invalid YAML in ${path}`); }
  validateSettings(settings, CONFIG_SCHEMA);
  const ai = settings.ai ?? {}, limits = settings.limits ?? {}, cloudflare = settings.cloudflare ?? {};
  const model = values.model ?? ai.model ?? 'gpt-6.1-sol';
  const provider = values.provider ?? ai.provider ?? 'openai';
  if (!/^[a-z0-9-]+$/.test(provider) || !/^[a-zA-Z0-9._:-]+$/.test(model)) {
    throw new Error('Invalid provider/model; use a native OpenAI model name without a provider prefix');
  }
  if (provider !== 'openai') throw new Error('This gateway integration supports only openai with a stored provider key');
  const api = ai.api ?? 'responses';
  if (!['responses', 'chat'].includes(api)) throw new Error('ai.api must be responses or chat');
  const effort = ai.reasoningEffort ?? 'high';
  if (!['omit', 'none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error('Invalid reasoning effort');
  const builtIn = provider === 'openai' && model === 'gpt-6.1-sol';
  if (builtIn && ['none', 'omit'].includes(effort)) throw new Error('GPT-6.1 Sol requires low, medium, high, xhigh, or max effort');
  const names = ['input', 'cachedInput', 'cacheWrite', 'output'];
  const configuredPrices = ai.pricesUsdPerMillion ?? {};
  if (Object.keys(configuredPrices).length &&
      (model !== (ai.model ?? 'gpt-6.1-sol') || provider !== (ai.provider ?? 'openai'))) {
    throw new Error('Model/provider override does not match YAML token prices; select a matching --config');
  }
  if (!builtIn && names.some((name) => configuredPrices[name] === undefined)) {
    throw new Error('Changing models/providers requires all four explicit token prices');
  }
  const prices = Object.fromEntries(['input', 'cached', 'write', 'output'].map((name, i) =>
    [name, rate(configuredPrices[names[i]] ?? ['2', '0.1', '2.5', '10'][i], `ai.pricesUsdPerMillion.${names[i]}`)]));
  const account = cloudflare.accountId;
  const gateway = cloudflare.gatewayId;
  if (account !== undefined && !/^[a-f0-9]{32}$/.test(account)) throw new Error('Invalid cloudflare.accountId');
  if (gateway !== undefined && !/^[a-zA-Z0-9_-]+$/.test(gateway)) throw new Error('Invalid cloudflare.gatewayId');
  if (!account || !gateway || !env.CLOUDFLARE_API_TOKEN) {
    throw new Error('Generation requires Cloudflare account ID, gateway ID, and API token');
  }
  const budget = usd(values.budget ?? limits.maxUsd ?? '0');
  if (!budget) throw new Error('Generation requires a positive --budget or limits.maxUsd');
  const batchSize = integer(values['batch-size'] ?? settings.batchSize ?? 20, 'batch size', 1, 1000);
  const multiplicity = values['batch-size-multiplicity'] ?? settings.batchSizeMultiplicity;
  const batchSizeMultiplicity = multiplicity === undefined ? 1 :
    integer(multiplicity, 'batch size multiplicity', 2, Math.floor(Number.MAX_SAFE_INTEGER / batchSize));
  const database = tursoSettings(env);
  return {
    databaseUrl: database.url, databaseToken: database.authToken,
    stateDir: values['state-dir'] ? resolve(values['state-dir']) : settings.stateDir ? resolve(dirname(path), settings.stateDir === '~' ? homedir() :
      settings.stateDir.startsWith('~/') ? resolve(homedir(), settings.stateDir.slice(2)) : settings.stateDir) :
      fileURLToPath(new URL('../.state', import.meta.url)),
    write: values.write ?? false,
    budget, model, provider, api, effort, prices, account, gateway,
    token: env.CLOUDFLARE_API_TOKEN,
    batchSize, batchSizeMultiplicity,
    outputTokens: integer(ai.maxOutputTokens ?? 25000, 'output tokens', 256, 128000),
    rpm: integer(limits.requestsPerMinute ?? 10, 'RPM', 1, 1000),
    tpm: integer(limits.tokensPerMinute ?? 200000, 'TPM', 1000, 1e9),
    attempts: integer(limits.maxAttempts ?? 3, 'attempts', 1, 5),
    timeout: integer(limits.timeoutMs ?? 300000, 'timeout', 1000, 900000),
    languagePolicies: settings.languagePolicies ?? {},
    builtIn,
  };
}
