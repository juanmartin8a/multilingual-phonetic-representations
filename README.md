# SAPO phonetic population

Two standalone Bun scripts generate missing IPA transcriptions and native-script
respellings for SAPO's Turso database. Generation is always enabled.
By default, finalized results are saved locally. With `--write`, each finalized
batch is inserted into the database and no local files are created or updated.

## Repository layout

```text
scripts/
  generators/
    populate-transcriptions.mjs
    populate-respellings.mjs
    config/                 # Per-generator YAML settings
    prompts/                # Generation and review prompts
    lib/                    # Phonetic-generation implementation
    test/                   # Generator tests
    .state/                 # Local generator results (ignored by Git)
  utils/
    files.mjs               # Shared hashing and atomic JSON file helpers
    turso.mjs               # Shared Turso connection and transactions
    ai-gateway.mjs          # Shared AI requests, retries, pacing, and costs
    numbers.mjs             # Exact monetary and integer helpers
    test/                   # Shared utility tests
```

Keep each script category's configuration, prompts, implementation, tests, and
local output in its own directory under `scripts/`. Put reusable helpers in
`scripts/utils/`; those helpers must not depend on generator-specific modules or
assets. The root package, Bun configuration, and credential files serve the whole
repository. Existing migration artifacts remain in the root `.state/` directory.

## Setup

The project pins Bun 1.4.2 in `.bun-version` and `packageManager`.

1. Run `bun install` to install the Turso/libSQL client.
2. Copy `.env.example` to `.env.local` and fill in `TURSO_DATABASE_URL`,
   `TURSO_AUTH_TOKEN`, and `CLOUDFLARE_API_TOKEN`. Both generators use that Turso
   database; credentials stay outside YAML.
3. Configure AI Gateway with an OpenAI provider key under alias `default`,
   authenticated gateway access, and an API token with AI Gateway Run permission.
   No local `OPENAI_API_KEY` is used.
4. Set `cloudflare.accountId` and `cloudflare.gatewayId` in each generator's YAML
   configuration.

The Turso database must contain the existing SAPO tables: `languages`, `entries`,
`phonetic_transcriptions`, and `pronunciation_respellings`. The generators use
`id` primary keys and `created_at` timestamps and do not create or alter tables.
New databases use `database/schema.sql`. For existing databases, apply
`database/migrations/001_unique_respelling_target.sql` to enforce one guide per
IPA/target pair and replace the old nonunique index. Duplicate pairs must be
resolved first; the migration fails instead of deleting data.
Connections use HTTPS and reject HTTP redirects. The generators read the database
by default and insert results only with `--write`.

## Run

```sh
# Generate and save finalized results locally.
bun run transcriptions
bun run respellings

# Generate and insert each finalized batch; no local writes.
bun run transcriptions --write
bun run respellings --write

# Override the budget or retrieve three processing batches at a time.
bun run transcriptions --budget 1 --batch-size-multiplicity 3
bun run respellings --write --budget 5

# Offline tests with mocked AI and in-memory database integration checks.
bun test
```

The package shortcuts explicitly load this checkout's `.env.local`. Direct
invocation is equivalent: `bun --env-file=.env.local scripts/generators/populate-transcriptions.mjs`.
`bunfig.toml` disables automatic environment-file loading.

There is no `--generate` or `--rescan` flag. Every invocation scans from the start,
reusing matching local results or skipping values already present in the database.
Both scripts retrieve up to `batchSize × batchSizeMultiplicity` usable words at
a time, process that window in batches of up to `batchSize` words, then retrieve
the next window. For example, a batch size of 100 and multiplicity of 3 retrieves
300 usable words, processes three batches of 100, and repeats. Multiplicity is
not a per-run limit. It defaults to 1 when omitted from both CLI and YAML;
explicit values must be integers greater than 1.

Runs stop when the budget is reached or surpassed, after finishing the active
processing batch, or when no usable words remain. Ctrl-C aborts the process.
Transcriptions continue across populated languages; respellings use the selected
source language. Completed database words are skipped and do not count toward
the retrieval window. A word missing IPA or any selected-target guide counts
once, even if it has multiple IPA variants. Database-missing words with matching
local results still count; their values are reused without AI generation.
`--help` displays the available flags without generating anything.

## Configuration

`scripts/generators/populate-transcriptions.mjs` uses
`scripts/generators/config/transcriptions.yml`;
`scripts/generators/populate-respellings.mjs` uses
`scripts/generators/config/respellings.yml`. Each loads only its own
file. Use `--config PATH` to select a replacement.

CLI options override YAML settings. Environment variables supply the Turso
connection URL and credentials.
YAML paths are relative to the selected file; CLI paths are relative to the shell.
`~/` is supported in YAML paths. Default config and state paths are relative to
these scripts, independent of the working directory.

- `stateDir`: local results directory, default `scripts/generators/.state/`.
- `batchSize`: 1–1000 usable words per processing batch and maximum items per AI
  request or database insertion transaction, default 20. Generation, reviews,
  and saves/inserts finish before the next processing batch starts. Multiple IPA variants or long inputs/review
  notes can require several AI requests for one processing batch.
- `batchSizeMultiplicity`: multiplies `batchSize` to set each retrieval window's
  usable-word count. Omit for 1; explicit values must be integers greater than 1.
  SQL filters out completed entries before applying this window's `LIMIT`.
  The window is processed before the next window is read. IPA lookup queries
  do not count toward the limit. For example, `batchSize: 20` with
  `batchSizeMultiplicity: 3` retrieves up to 60 usable words at a time and
  processes them in batches of 20.
- `ai`: provider, model, API, reasoning effort, output cap, and token prices.
- `limits`: positive per-run USD allowance, RPM/TPM, attempts, and timeout.
- `cloudflare`: account and gateway identifiers.
- `languagePolicies`: source dialect and target Unicode-script overrides.

Unknown settings and invalid types are rejected. Quote monetary values for exact
arithmetic. The integration supports OpenAI provider-native Responses and Chat
Completions endpoints through AI Gateway. Change the model and all four token
prices together; alternate models require explicit prices and structured-output
support. Models without a reasoning parameter can use `reasoningEffort: omit`.

## Local storage and write mode

Default mode stores only:

| Path | Contents |
| --- | --- |
| `results/<hash>.json` | Task, word/entry identity, source language, final value, and generation signature. Respelling results also contain the target language and exact source IPA. |
| `respelling-pair.json` | Source and target language codes for subsequent respelling runs. |

Only valid, finalized results are saved. Review notes, first-pass decisions, raw
provider responses, failed attempts, rejections, usage history, checkpoints, and
locks are not stored. Cache files are written atomically with private permissions.
The default `scripts/generators/.state/` directory and credential files are ignored
by Git.

The cache signature covers prompts, schemas, language policies, model, reasoning
effort, and API. The filename also identifies the Turso database and exact job.
Batch size changes reuse compatible results; incompatible settings generate new ones.

`--write` can read matching results and a language pair from an existing local
cache, so generating locally first and inserting later does not require paying
again for those results. It creates or updates no local state. Without a saved
pair, a write run chooses its source and target in memory.

After each AI batch, required reviews finish before finalized values are inserted.
Database insert transactions contain at most `batchSize` records (maximum 1000).
An insertion failure stops further AI generation; previous inserted batches
remain in the database. Any uninserted
in-memory results are lost when the process exits and may need generating again.
Repeating the command discovers progress by scanning existing database values and
local results. There is no separate cache-only insertion mode.

## Data and review

Transcriptions scan populated languages and generate only for words without IPA.
Existing transcriptions and pronunciation variants are preserved.

Respellings choose a populated source and a distinct target language. They process
every source IPA variant missing its target guide. Missing IPA is generated first;
write mode inserts it and reloads real database IDs before linking respellings.
Turso retrieves only entries needing work, in `(orthographic_form, id)` order,
with `LIMIT batchSize × batchSizeMultiplicity`. The limit counts words before
their IPA variants are loaded. An in-memory spelling/ID marker advances to the
next window even in local mode or when invalid results were skipped; it resets
on restart. There are no fixed-size scan pages or page-boundary refreshes.
After missing IPA is inserted, only the entries that needed it are reloaded by
ID and checked for changes. Insert batches validate entry/pronunciation identity
and native-script values, commit atomically, and skip results already present.
Local mode uses the generated IPA directly, without requiring a database ID.

Requests contain ordered words with positional indexes; database IDs stay local.
Returned indexes and words must match exactly. Both IPA prompts receive a shared
character inventory from the IPA Association's chart and symbol identifiers.
Both respelling prompts receive only the selected target's character inventory:
native alphabets for English, Spanish, French, German, Portuguese, Russian, and
Arabic; configured Unicode script inventories for other languages, with large
inventories such as Han encoded as compact ranges. The same inventories validate
generated values and database inserts. Canonically equivalent Unicode spellings
are accepted without changing the copied input word.
Correctly aligned first-pass records with invalid pronunciation values become
review records with null values and diagnostic notes naming disallowed characters
and their language, or explaining invalid formatting. They receive the final-editor
pass before saving/insertion. Structural mismatches are skipped and reported in
the terminal; rerunning retries them because they were not saved/inserted.
Invalid JSON, refusals, incomplete responses, and billing errors stop the batch.

Valid first-pass items marked for review receive a separate final-editor request
using the same model. Only flagged words, their review notes, and authoritative IPA
where applicable are sent. Every reviewed item must return a valid definitive
value. A failed review prevents the batch from being saved or inserted.

Structural validation cannot prove pronunciation accuracy or resolve every
context-dependent reading. Language policies guide the model's choice.

## Budget and rate limits

Every invocation starts with a fresh budget. Before retrieving another window or
starting a processing batch, the script checks spending committed during that
invocation. A processing batch admitted below the threshold finishes all required
AI requests, retries, reviews, and saves/inserts even if they exceed it. For
respellings, this includes generating and inserting missing IPA, refreshing its
IDs, and generating and saving/inserting the target guides for that batch.
The budget is a stop threshold, not a hard spending cap. Reaching it leaves any
remaining prefetched batches unprocessed and prevents further window retrieval.

Costs use integer nano-USD and account for uncached input, cached input, cache
writes, and total output, including reasoning. Each attempt temporarily reserves
a conservative input/output cost in memory. Returned usage settles it to known
cost; missing usage or transport failures retain the reservation for that run.
The final terminal summary reports known cost, uncertain cost, and token usage.
Nothing is written to a usage ledger.

RPM/TPM tracking is in memory and resets on restart. Transient HTTP and transport
failures retry with exponential backoff and `Retry-After`; gateway automatic
retries and response caching are disabled. Provider error messages are not logged
because they may echo credentials. Provider billing remains authoritative.
