// Driver for the fast csv-reader entry. The harness runs `node /bot/main.ts`
// (node22). It reads every case from /input/cases.json (a JSON array of
// {id, input}), answers each one alone with run() from solve.js, and writes
// /output/answers.json: a JSON array of the answers, one per case and in the
// cases' order. Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR
// stand in for /input and /output.
//
// solve.js builds each answer's JSON string alongside the object graph, so
// this driver takes the prebuilt string (answerJson) instead of
// re-stringifying the whole answers array (a separate stringify of the
// 11.6 MB practice answers costs ~200 ms on this box); if a case ever has
// no prebuilt string it falls back to JSON.stringify for that case alone.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its
// work runs under it (the rules: the house baseline runs with
// --no-incremental-marking, and an entry may tune V8's flags too).
setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run, answerJson } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
  answerJson: () => string;
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const parts: string[] = [];
for (const c of cases) {
  const a = run(c.input);
  const j = answerJson();
  parts.push(typeof j === 'string' && j.length > 0 ? j : JSON.stringify(a));
}
writeFileSync(join(OUTPUT_DIR, 'answers.json'), '[' + parts.join(',') + ']');
