import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

export const MAX_INPUT_RESERVATION = 272000;
export const reservedInput = (body) => Buffer.byteLength(JSON.stringify(body), 'utf8') + 8192;

export class BudgetReachedError extends Error {
  constructor(committed, budget) {
    super(`Budget reached: $${(committed / 1e9).toFixed(6)} committed; $${(budget / 1e9).toFixed(6)} limit. No new batch started.`);
    this.name = 'BudgetReachedError';
  }
}

export function usageCost(body, prices, api, requireCacheWrites = false) {
  const usage = body.usage;
  if (!usage) throw new Error('Provider omitted usage; reserved cost remains committed this run');
  const details = (api === 'responses' ? usage.input_tokens_details : usage.prompt_tokens_details) ?? {};
  const input = api === 'responses' ? usage.input_tokens : usage.prompt_tokens;
  const output = api === 'responses' ? usage.output_tokens : usage.completion_tokens;
  const cached = details.cached_tokens ?? 0;
  if (requireCacheWrites && details.cache_write_tokens === undefined) {
    throw new Error('Cache-write usage missing; cannot calculate an accurate cost');
  }
  const written = details.cache_write_tokens ?? 0;
  const reasoning = (api === 'responses' ? usage.output_tokens_details : usage.completion_tokens_details)?.reasoning_tokens ?? 0;
  if (![input, output, cached, written, reasoning].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      cached + written > input || reasoning > output) throw new Error('Inconsistent provider token usage');
  if (input > 272000) throw new Error('Unexpected long-context pricing tier; stop and reconcile billing');
  if (body.service_tier && !['default', 'standard'].includes(body.service_tier)) throw new Error('Unexpected paid service tier');
  const cost = (input - cached - written) * prices.input + cached * prices.cached +
    written * prices.write + output * prices.output;
  if (!Number.isSafeInteger(cost)) throw new Error('Cost exceeds integer range');
  return { input, output, cached, written, reasoning, cost };
}

export function outputText(body, api) {
  if (api === 'chat') {
    if (body.choices?.length !== 1 || body.choices[0].finish_reason !== 'stop' || body.choices[0].message?.refusal) {
      throw new Error('Incomplete/refused chat output; no records will be written');
    }
    return body.choices[0].message.content;
  }
  if (body.status !== 'completed' || body.error) throw new Error('Incomplete/failed response; no records will be written');
  const content = (body.output ?? []).filter((item) => item.type === 'message').flatMap((item) => item.content ?? []);
  if (content.some((item) => item.type === 'refusal')) throw new Error('Model refused the request');
  const text = content.filter((item) => item.type === 'output_text').map((item) => item.text).join('');
  if (!text) throw new Error('Missing structured output');
  return text;
}

export function requestBody(cfg, prompt, input, schema, schemaName = 'structured_output') {
  // Provider-native endpoints take the OpenAI model name, without "openai/".
  const model = cfg.model;
  const format = { name: schemaName, strict: true, schema };
  if (cfg.api === 'chat') return {
    model, messages: [{ role: 'system', content: prompt }, { role: 'user', content: JSON.stringify(input) }],
    response_format: { type: 'json_schema', json_schema: format },
    max_completion_tokens: cfg.outputTokens,
    ...(cfg.effort === 'omit' ? {} : { reasoning_effort: cfg.effort }),
  };
  return {
    model, store: false, service_tier: 'default', max_output_tokens: cfg.outputTokens,
    ...(cfg.effort === 'omit' ? {} : { reasoning: { effort: cfg.effort } }),
    // Explicit-only caching avoids writing unique word batches to the prompt cache.
    ...(cfg.builtIn ? { prompt_cache_options: { mode: 'explicit', ttl: '30m' } } : {}),
    input: [{ role: 'developer', content: [{ type: 'input_text', text: prompt,
      ...(cfg.builtIn ? { prompt_cache_breakpoint: { mode: 'explicit' } } : {}),
    }] }, { role: 'user', content: JSON.stringify(input) }],
    text: { format: { type: 'json_schema', ...format } },
  };
}

export function reservation(body, cfg) {
  // UTF-8 bytes upper-bound visible BPE tokens. Include the schema/request framing
  // plus 8192 tokens of provider framing allowance; never estimate bytes/4.
  const input = reservedInput(body);
  if (input > MAX_INPUT_RESERVATION) throw new Error('Batch is too large; decrease --batch-size');
  const tokens = input + cfg.outputTokens;
  return { input, tokens, cost: input * Math.max(cfg.prices.input, cfg.prices.cached, cfg.prices.write) +
    cfg.outputTokens * cfg.prices.output };
}

export function retryDelay(header, attempt, now = Date.now()) {
  if (header) {
    const seconds = Number(header);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
    if (Number.isFinite(delay) && delay >= 0) return delay + 250;
  }
  return Math.min(60000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
}

export function createGateway(cfg, { fetchFn = fetch, wait = sleep, now = Date.now, log = console.log, metadata = {} } = {}) {
  if (cfg.provider !== 'openai' || !cfg.token) {
    throw new Error('OpenAI gateway generation requires openai and CLOUDFLARE_API_TOKEN');
  }
  const endpoint = cfg.api === 'responses' ? 'responses' : 'chat/completions';
  const url = `https://gateway.ai.cloudflare.com/v1/${cfg.account}/${cfg.gateway}/openai/${endpoint}`;
  const total = { known: 0, uncertain: 0, committed: 0,
    usage: { input: 0, output: 0, cached: 0, written: 0, reasoning: 0 } };
  const recentReservations = [];
  let batchActive = false;
  async function pace(tokens) {
    if (tokens > cfg.tpm) throw new Error('Batch token reservation exceeds limits.tokensPerMinute');
    while (true) {
      while (recentReservations.length && recentReservations[0].at <= now() - 60000) recentReservations.shift();
      if (recentReservations.length < cfg.rpm && recentReservations.reduce((sum, e) => sum + e.tokens, 0) + tokens <= cfg.tpm) return;
      await wait(Math.max(1, recentReservations[0].at + 60001 - now()));
    }
  }

  async function obtain(body) {
    const bound = reservation(body, cfg);
    for (let attempt = 0; attempt < cfg.attempts; attempt++) {
      await pace(bound.tokens);
      const id = randomUUID();
      recentReservations.push({ at: now(), tokens: bound.tokens });
      total.uncertain += bound.cost;
      total.committed = total.known + total.uncertain;
      let response, text;
      try {
        response = await fetchFn(url, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(cfg.timeout),
          // AI Gateway injects its stored provider key.
          headers: { 'cf-aig-authorization': `Bearer ${cfg.token}`,
            'Content-Type': 'application/json', 'cf-aig-no-wholesale': 'true',
            'cf-aig-skip-cache': 'true', 'cf-aig-max-attempts': '1',
            'cf-aig-request-timeout': String(cfg.timeout),
            'cf-aig-metadata': JSON.stringify({ ...metadata, request: id }),
          }, body: JSON.stringify(body),
        });
        text = await response.text();
      } catch (error) {
        log(`Attempt ${id}: network/timeout error; reservation remains committed this run.`);
        if (attempt + 1 === cfg.attempts) throw new Error(`AI transport failed (${error.name}); uncertain costs included in this run`);
        await wait(retryDelay(null, attempt, now()));
        continue;
      }
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      // Never log provider error messages: they may echo credentials.
      if (parsed?.usage) {
        const usage = usageCost(parsed, cfg.prices, cfg.api, cfg.prices.write !== cfg.prices.input);
        total.uncertain -= bound.cost;
        total.known += usage.cost;
        total.committed = total.known + total.uncertain;
        for (const key of Object.keys(total.usage)) total.usage[key] += usage[key];
        if (usage.cost > bound.cost || usage.input > bound.input) {
          throw new Error('Provider exceeded reserved bounds; stop and reconcile usage before continuing');
        }
      } else log(`Attempt ${id}: usage unavailable; reservation remains committed this run.`);
      if (response.ok) {
        if (!parsed?.usage) throw new Error('Missing usage; batch cannot be saved or inserted');
        return parsed;
      }
      const retryable = [408, 429].includes(response.status) || response.status >= 500;
      if (!retryable || attempt + 1 === cfg.attempts) throw new Error(`AI Gateway HTTP ${response.status}`);
      await wait(retryDelay(response.headers.get('retry-after'), attempt, now()));
    }
  }

  async function runBatch(process) {
    if (batchActive) throw new Error('A processing batch is already active');
    if (total.committed >= cfg.budget) throw new BudgetReachedError(total.committed, cfg.budget);
    batchActive = true;
    try { return await process(); }
    finally { batchActive = false; }
  }
  return {
    request: obtain,
    runBatch,
    totals: () => total,
    assertBudget() {
      if (!batchActive && total.committed >= cfg.budget) throw new BudgetReachedError(total.committed, cfg.budget);
    },
  };
}
