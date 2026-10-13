# Multilingual Phonetic Representations

This repository maintains the Multilingual Phonetic Representations database:
its schema and the tools used to populate and manage its data. The database
connects words across languages with their IPA pronunciations and readable
pronunciation guides.

Browse the database's live content on [sapo.surf](https://sapo.surf/mulyilingual-phonetic-representations).

## How it works

A word can be written one way and pronounced another. The database brings
together three pieces of information:

1. **The written word** and the language it belongs to.
2. **Its pronunciation in IPA**, the International Phonetic Alphabet, which
   represents speech sounds consistently across languages.
3. **A readable pronunciation guide**, also called a *respelling*, that uses
   spelling familiar to speakers of a particular language.

The language a word comes from is its **source language**. The language used
to write a pronunciation guide is its **target language**. A word can have
multiple pronunciations, and each pronunciation can have guides for different
target languages.

### Example

Here is an illustrative English word with a pronunciation guide for Spanish
speakers:

| Part | Example |
| --- | --- |
| Written word | **moon** (English) |
| IPA pronunciation | /muːn/ |
| Guide for Spanish speakers | **mun** |

Reading **mun** using Spanish spelling gives a speaker an approximation of
the English pronunciation. Pronunciation guides help readers get close to the
sound of a word; some sounds, such as the long vowel in this example, do not
have an exact equivalent in the target language.

## Schema

The schema in [`database/schema.sql`](database/schema.sql) separates a word's
written form, its pronunciation, and the way that pronunciation is presented to
speakers of a particular language.

| Table | Stored data | Relationships |
| --- | --- | --- |
| `languages` | Unique `language_code` and human-readable `name`. | Referenced by entries and by the source and target languages of respellings. |
| `entries` | Written form in `orthographic_form` and numeric `frequency`. | `language_id` references `languages(id)`. An entry can have multiple IPA transcriptions. |
| `phonetic_transcriptions` | Pronunciation in `transcription`, with `type` restricted to `ipa`. | `entry_id` references `entries(id)`. Each transcription can have respellings for multiple target languages. |
| `pronunciation_respellings` | Guide in `respelling`, with an `intralingual` or `cross-lingual` `type`. | `entry_id` identifies the word; `phonetic_transcription_id` identifies its pronunciation. `source_language_id` and `target_language_id` reference `languages(id)`. |

All columns are required (`NOT NULL`). Every table has a text `id` primary key
and a numeric `created_at` timestamp. Both `created_at` and `frequency` use
SQLite's `REAL` type; the remaining columns use `TEXT`.

The schema enforces these constraints:

- **Language codes are unique.** A unique index on `languages(language_code)`
  prevents duplicate language records for the same code. Written forms are
  not unique: separate entries can share the same spelling, including within
  a language.
- **Respellings belong to a specific IPA variant.** A unique index on
  `(phonetic_transcription_id, target_language_id)` allows at most one guide
  per pronunciation and target language. Different IPA variants of the same
  entry can each have their own guides.
- **The guide and its IPA must belong to the same entry.** A composite foreign
  key from `pronunciation_respellings(phonetic_transcription_id, entry_id)` to
  `phonetic_transcriptions(id, entry_id)` enforces this relationship. The
  transcription table declares the corresponding `UNIQUE (id, entry_id)` key.
- **The respelling type must match its language pair.** A `CHECK` constraint
  requires equal source and target language IDs for `intralingual` guides and
  different IDs for `cross-lingual` guides.

Lookup indexes cover entry spelling, entries by language
(`language_id, orthographic_form, id`), transcriptions and respellings by
`entry_id`, and respellings by source/target pair
(`source_language_id, target_language_id, created_at, id`). The
[SQL schema](database/schema.sql) contains the complete definitions.

## Population scripts

The scripts expand the database's pronunciation coverage by adding missing IPA
pronunciations and guides for speakers of other languages. They build on the
languages and word entries already available, preserving existing
pronunciations and guides.

There are two generators, written for Bun and using OpenAI through Cloudflare
AI Gateway:

- [`populate-transcriptions.mjs`](scripts/generators/populate-transcriptions.mjs)
  adds IPA pronunciations to words that do not have one yet. It works across
  all languages with entries and follows language-specific settings for dialect
  choices.
- [`populate-respellings.mjs`](scripts/generators/populate-respellings.mjs)
  adds pronunciation guides for speakers of another language, using that
  language's native writing system. It covers each IPA variant missing a guide
  for the chosen target language and generates missing IPA first. It reuses a
  saved source/target language pair when available; otherwise, it randomly
  chooses a source language with entries and a different target language.
  Local runs save that choice for later runs.

Both scripts work through missing data in batches. Generated results are
checked against the input words and the allowed pronunciation characters.
Items flagged for review receive a separate automated editing pass before
being finalized. Generation and review prompts live in
[`scripts/generators/prompts/`](scripts/generators/prompts/).

By default, finalized results are saved locally in
`scripts/generators/.state/`. Database write mode saves results directly to the
database in transactions, without creating or updating local files. Saved
results can be reused when they match the current request, and later runs skip
records already completed in the database.

Each generator has a YAML file in
[`scripts/generators/config/`](scripts/generators/config/) that controls the AI
model, token prices, batch sizes, language and dialect settings, and spending
and request limits. Spending is tracked per run. When the budget threshold is
reached, the current batch and its required reviews finish before processing
stops, so final spending can exceed that threshold. Shared database, file, and
AI request helpers are documented in
[`scripts/utils/README.md`](scripts/utils/README.md).
