-- SAPO's migrated Turso schema, used only by isolated in-memory tests.
CREATE TABLE languages (
  id TEXT PRIMARY KEY NOT NULL,
  created_at REAL NOT NULL,
  language_code TEXT NOT NULL,
  name TEXT NOT NULL
);
CREATE UNIQUE INDEX languages_by_language_code ON languages(language_code);
CREATE TABLE entries (
  id TEXT PRIMARY KEY NOT NULL,
  created_at REAL NOT NULL,
  orthographic_form TEXT NOT NULL,
  frequency REAL NOT NULL,
  language_id TEXT NOT NULL REFERENCES languages(id)
);
CREATE INDEX entries_by_language_and_orth ON entries(language_id, orthographic_form, id);
CREATE TABLE phonetic_transcriptions (
  id TEXT PRIMARY KEY NOT NULL,
  created_at REAL NOT NULL,
  entry_id TEXT NOT NULL REFERENCES entries(id),
  type TEXT NOT NULL CHECK (type = 'ipa'),
  transcription TEXT NOT NULL,
  UNIQUE (id, entry_id)
);
CREATE INDEX phonetic_transcriptions_by_entry ON phonetic_transcriptions(entry_id);
CREATE TABLE pronunciation_respellings (
  id TEXT PRIMARY KEY NOT NULL,
  created_at REAL NOT NULL,
  entry_id TEXT NOT NULL REFERENCES entries(id),
  phonetic_transcription_id TEXT NOT NULL,
  target_language_id TEXT NOT NULL REFERENCES languages(id),
  type TEXT NOT NULL CHECK (type IN ('cross-lingual', 'intralingual')),
  respelling TEXT NOT NULL,
  source_language_id TEXT NOT NULL REFERENCES languages(id),
  FOREIGN KEY (phonetic_transcription_id, entry_id) REFERENCES phonetic_transcriptions(id, entry_id),
  CHECK ((type = 'intralingual' AND source_language_id = target_language_id)
    OR (type = 'cross-lingual' AND source_language_id <> target_language_id))
);
CREATE INDEX pronunciation_respellings_by_phonetic_transcription_and_target
  ON pronunciation_respellings(phonetic_transcription_id, target_language_id);
