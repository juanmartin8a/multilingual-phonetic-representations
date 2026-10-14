# Multilingual Phonetic Representations

This repository maintains the Multilingual Phonetic Representations database:
its schema and the tools used to populate and manage its data. The database
connects words across languages with their IPA pronunciations and readable
pronunciation guides.

Browse the database's live content on [sapo.surf](https://sapo.surf/multilingual-phonetic-representations).

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
  adds IPA pronunciations to words that do not have one yet. It randomly
  chooses a language with entries and follows its dialect settings.
- [`populate-respellings.mjs`](scripts/generators/populate-respellings.mjs)
  adds pronunciation guides for speakers of another language, using that
  language's native writing system. It covers each IPA variant missing a guide
  for the chosen target language. Each generation record contains IPA and its
  respelling together: existing IPA is preserved exactly; missing IPA is
  generated first within the same response, then used to derive the guide. It
  randomly chooses a source language with entries and a different target
  language.

Both scripts work through missing data in batches. After finishing a language
or source/target pair, they randomly choose another one that has not been
scanned in this run. Empty selections are skipped. Each language or pair is
scanned at most once per run, including in local mode where the database is
unchanged. Runs stop when all eligible selections have been scanned or the
spending threshold is reached. Generated results are
checked against the input words and the allowed pronunciation characters.
Items flagged for review receive a separate automated editing pass before
being finalized. In transcription generation, words that still fail review
validation are logged and skipped; valid words in the batch are saved and the
scan continues. Skipped words remain eligible for a later run. Respelling
records use `transcription` and `respelling` fields,
with separate `transcriptionStatus` and `respellingStatus` review decisions.
The reviewer preserves accepted IPA; when newly generated IPA needs
review, it finalizes the IPA first and regenerates the guide to match. Both
fields must be valid and ready before either is saved. Entries with multiple
IPA readings contribute a separate item for each reading missing a guide.
Generation and review prompts live in
[`scripts/generators/prompts/`](scripts/generators/prompts/).

By default, finalized results are saved locally in
`scripts/generators/.state/`. Database write mode saves results directly to the
database in transactions, without creating or updating local files. Saved
results can be reused when they match the current request, and later runs skip
records already completed in the database. The combined respelling contract
uses a new cache signature, so older separate IPA/respelling results are not
reused by that generator; existing database results are preserved.
If an import saves IPA but fails before saving its guide, the next run can reuse
the cached pair when its finalized IPA exactly matches the stored reading.
Existing IPA that fails the generator's format or character checks is reported
and skipped so other entries can continue; its stored value is preserved.

Each generator has a YAML file in
[`scripts/generators/config/`](scripts/generators/config/) that controls the AI
model, token prices, batch sizes, language and dialect settings, and spending
and request limits. Spending is tracked per run. When the budget threshold is
reached, the current batch and its required reviews finish before processing
stops, so final spending can exceed that threshold. Shared database, file, and
AI request helpers are documented in
[`scripts/utils/README.md`](scripts/utils/README.md).

## Licensing

The software in this repository, including the population scripts and SQL
schema, is licensed under [Apache License 2.0](LICENSE).

The Multilingual Phonetic Representations database is licensed under
[Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)](https://creativecommons.org/licenses/by-sa/4.0/).
This includes its language records, word entries, frequencies, IPA
transcriptions, and pronunciation respellings, together with MPR's rights in
the database compilation. The full data license is in [LICENSE-DATA](LICENSE-DATA).
Upstream material retains its original license and attribution notices.
The database is provided as-is, without warranties, subject to section 5 of
the data license.

When distributing database copies or exports, include the
[database attribution](ATTRIBUTION.md) and the data license or a link to it.
Identify any changes made to the data.

## Data sources and attribution

The words and frequencies used for database entries come from
[wordfreq](https://github.com/rspeer/wordfreq) by **Robyn Speer**.
Copyright 2022 Robyn Speer. The wordfreq data is licensed under
[Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)](https://creativecommons.org/licenses/by-sa/4.0/).

Multilingual Phonetic Representations uses that data as the starting vocabulary
and adds IPA transcriptions and pronunciation respellings. See
[ATTRIBUTION.md](ATTRIBUTION.md) for the upstream credits, SUBTLEX authors,
license references, and provenance details.
