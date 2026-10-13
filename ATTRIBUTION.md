# Data attribution

## wordfreq

The words and frequencies used for entries in the Multilingual Phonetic
Representations (MPR) database come from
[wordfreq](https://github.com/rspeer/wordfreq), created by **Robyn Speer**.

**Copyright 2022 Robyn Speer.**

The wordfreq data is licensed under
[Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)](https://creativecommons.org/licenses/by-sa/4.0/).
The [full license](https://creativecommons.org/licenses/by-sa/4.0/legalcode.en)
includes attribution and ShareAlike conditions and a disclaimer of warranties
and limitation of liability. The upstream material is provided as-is, without
warranties; see section 5 of that license.

MPR incorporates word spellings and frequency values into its `entries` table
and adds IPA transcriptions and pronunciation respellings through its own
population tools. Those added phonetic representations are not supplied by
wordfreq. The exact imported wordfreq release and import parameters have not
yet been recorded in this repository.

This notice identifies the source and existing license of the imported
material. It does not assign a new license to MPR's software or phonetic
representations, or establish the licensing scope of the combined database.

The wordfreq software has a separate
[Apache License 2.0 notice](https://github.com/rspeer/wordfreq/blob/912caf64b657478d1dff1138efdc078947d54bb1/LICENSE.txt);
that software license does not replace the data license.

## Upstream source acknowledgments

The following acknowledgments preserve the source credits described in
[wordfreq's upstream notice](https://github.com/rspeer/wordfreq/blob/912caf64b657478d1dff1138efdc078947d54bb1/NOTICE.md):

- [Google Books Ngram Viewer](https://books.google.com/ngrams) and
  [Google Books Syntactic Ngrams](https://commondatastorage.googleapis.com/books/syntactic-ngrams/index.html).
- [Leeds Internet Corpus](http://corpus.leeds.ac.uk/list.html), University of
  Leeds Centre for Translation Studies.
- [Wikipedia](https://www.wikipedia.org), the free encyclopedia.
- [ParaCrawl](https://paracrawl.eu), a multilingual web crawl.
- [OpenSubtitles](https://www.opensubtitles.org), through
  [OPUS OpenSubtitles 2018](http://opus.nlpl.eu/OpenSubtitles.php).
- [SUBTLEX](http://crr.ugent.be/programs-data/subtitle-frequencies), credited below.

The upstream README also describes contributions from NewsCrawl, GlobalVoices,
OSCAR, Twitter, Reddit, and a word list distributed with Jieba. Contributions
vary by language; see wordfreq's
[sources and supported languages](https://github.com/rspeer/wordfreq/blob/912caf64b657478d1dff1138efdc078947d54bb1/README.md#sources-and-supported-languages).
These are sources used by wordfreq, rather than separate direct imports by MPR.

## SUBTLEX authors

**SUBTLEX is freely available data.** We credit the authors of the SUBTLEX
lists identified by wordfreq:

| List | Authors |
| --- | --- |
| SUBTLEX-US | M. Brysbaert and B. New. |
| SUBTLEX-UK | W. J. van Heuven, P. Mandera, E. Keuleers, and M. Brysbaert. |
| SUBTLEX-CH | Q. Cai and M. Brysbaert. |
| SUBTLEX-DE | M. Brysbaert, M. Buchmeier, M. Conrad, A. M. Jacobs, J. Bölte, and A. Böhl. |
| SUBTLEX-NL | E. Keuleers, M. Brysbaert, and B. New. |

The corresponding publications and additional corpus references appear in
[wordfreq's bibliography](https://github.com/rspeer/wordfreq/blob/912caf64b657478d1dff1138efdc078947d54bb1/README.md#citations-to-work-that-wordfreq-is-built-on).

## Research citation and notice provenance

For research, wordfreq's upstream notice requires citation. Its README provides:

Robyn Speer (2022), *rspeer/wordfreq: v3.0 (v3.0.2)*, Zenodo,
[doi:10.5281/zenodo.7199437](https://doi.org/10.5281/zenodo.7199437).

These acknowledgments were checked on October 13, 2026 against wordfreq commit
[`912caf64b657478d1dff1138efdc078947d54bb1`](https://github.com/rspeer/wordfreq/tree/912caf64b657478d1dff1138efdc078947d54bb1).
That identifies the documentation reviewed, not the release originally used
to populate the database.
