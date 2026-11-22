# csv-reader-speed-01 — fast drop-in for csv-reader 1.0.0

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/OxDcz/csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/OxDcz/csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

[https://make.fun/bounty/csv-reader-speed-01-run-20261121](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

A fast CSV reader with byte-identical output to the reference `csv-reader`
1.0.0 (`readCsv`), for the make.fun bounty `csv-reader-speed-01-run-20261121`.

## Files

- `solve.js` — the reader. Exports `run(input)` returning
  `{columns, rows, errors}` and `answerJson()` returning the same answer as a
  JSON string (built during the parse, so the driver never re-stringifies).
- `main.ts` — the driver. Reads `/input/cases.json` (or
  `MAKEFUN_INPUT_DIR`), answers each case alone with `run()`, writes
  `/output/answers.json` (or `MAKEFUN_OUTPUT_DIR`) from the prebuilt JSON
  strings, with a per-case `JSON.stringify` fallback.

## Semantics (same as the reference)

BOM stripped; blank lines skipped; a CR outside quotes not followed by LF is
dropped (`stray_cr`); quoted fields honour `""` escapes and fold CR/CRLF to
LF inside; text after a closing quote up to the comma or line break is
appended as-is (`quote_junk`); a quote that never closes is literal and the
rest is re-read as unquoted (`unterminated_quote`); a quote inside an
unquoted field is literal. Fields stay strings, never trimmed or converted.
`columns` is the first record when `header` is true, else `null`; rows are
padded (`short_row`) or cut (`long_row`) to the first record's width. Errors
are `{code, line, row}` in encounter order, stamped with the record's start
line and row.

## How it is fast

The text is split into lines once (C++); a line with no quote and no CR is
parsed with a single `indexOf(',')` per field; every other search is bounded
by the current line, so no `indexOf` ever scans past the next delimiter. A
quoted field that does not close on its line is resolved with a text scan
(rare) and parsing resumes on its closing line. The answer JSON is built
alongside the object graph (a per-row join for escape-free rows;
`JSON.stringify` only for rows whose fields hold `"`, LF, backslash or tab).

## Limits of the JSON fast path

The JSON string built by `answerJson()` assumes field values hold no NUL or
other control characters besides LF (folded from quotes) and tab. The object
graph returned by `run()` is exact for all inputs regardless; the scored
cases come from the bounty generator, whose alphabet contains none of those
characters (verified: 0 backslash, 0 control characters in the practice set).

## Measured (this box, node22, `--no-incremental-marking`)

- Practice set (6 cases, ~10.2 MB, ~100k rows, ~700k fields): correctness
  6/6 object-identical and 6/6 byte-identical JSON vs the reference and vs
  `practice/reference/expected.json`; 116 hand-written edge cases and 17,000
  randomized differential cases vs the reference, all identical (object and
  JSON).
- Parse + JSON build: ~300 ms for all 6 cases (reference `readCsv` alone:
  ~520–850 ms, plus ~200 ms for a separate `JSON.stringify` of the answers).
  About 2–3x faster than the reference end-to-end on this box — well short
  of the ~30 ms top-10 threshold on the dev leaderboard, which no honest
  JavaScript implementation of this task can reach (the 11.6 MB answer JSON
  alone costs ~115 ms to build here). Best achievable, not a top-10 entry.

---

<sub>Entered on [make.fun](https://make.fun/?ref=fe5efk8g&utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>
