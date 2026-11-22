// Driver for the WASM SIMD csv-reader entry. The harness runs
// `node /bot/main.ts` (node22). It reads /input/cases.json once and hands the
// raw bytes to the WASM transducer (wasm.js), which scans the JSON, unescapes
// each case's text in place, parses the CSV with csv-reader 1.0.0's exact
// semantics, and emits /output/answers.json straight into WASM memory — no
// JSON.parse, no object graph. If the WASM path fails for any reason, the
// driver falls back to the proven pure-JS solve.js (slow but correct).
//
// Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for
// /input and /output.

import { readFileSync, writeFileSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, as the house baseline runs (an entry may tune
// V8's flags the same way).
setFlagsFromString('--no-incremental-marking');

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Zero-copy WASM path: read cases.json straight into WASM memory (no
// readFileSync Buffer, no copy-in), transduce in place, write the output
// view out. Any failure falls through to the JS implementation below.
let done = false;
try {
  const wasm = (await import(
    new URL('./wasm.js', import.meta.url).href
  )) as {
    getInstance: () => { exports: { memory: WebAssembly.Memory; transduce: (...a: number[]) => number } };
    layoutFor: (inLen: number) => { outPtr: number; need: number };
    ensureMemory: (inst: unknown, need: number) => WebAssembly.Memory;
    transduceLoaded: (inst: unknown, inLen: number) => number;
  };
  const inst = wasm.getInstance();
  const fd = openSync(join(INPUT_DIR, 'cases.json'), 'r');
  const size = fstatSync(fd).size;
  const lay = wasm.layoutFor(size);
  const mem = wasm.ensureMemory(inst, lay.need);
  const view = new Uint8Array(mem.buffer, 0, size);
  let read = 0;
  while (read < size) {
    const n = readSync(fd, view, read, size - read, read);
    if (n === 0) break;
    read += n;
  }
  closeSync(fd);
  if (read !== size) throw new Error('short read');
  const outLen = wasm.transduceLoaded(inst, size);
  if (outLen < 0) throw new Error('wasm transduce failed');
  writeFileSync(join(OUTPUT_DIR, 'answers.json'), Buffer.from(mem.buffer, lay.outPtr, outLen));
  done = true;
} catch {
  // Fall through to the JS implementation below.
}

if (!done) {
  const { run, answerJson } = (await import(
    new URL('./solve.js', import.meta.url).href
  )) as {
    run: (input: unknown) => unknown;
    answerJson: () => string;
  };
  const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json')).toString('utf8')) as {
    id: string;
    input: unknown;
  }[];
  const parts: string[] = [];
  for (const c of cases) {
    const a = run(c.input);
    const j = answerJson();
    parts.push(typeof j === 'string' && j.length > 0 ? j : JSON.stringify(a));
  }
  writeFileSync(join(OUTPUT_DIR, 'answers.json'), '[' + parts.join(',') + ']');
}
