// transducer.ts — JSON-to-JSON CSV transducer for csv-reader-speed-01.
//
// Reads /input/cases.json bytes (at address 0), finds each case's "text" and
// "header", unescapes the JSON string in place, parses the CSV with the exact
// semantics of csv-reader 1.0.0 (vendor/csv-reader/index.js), and emits the
// answers JSON straight into the output buffer — no JSON.parse, no object
// graph, no GC. AssemblyScript, --runtime stub, --enable simd.
//
// Design (v2): fields are emitted straight into the output buffer as they
// are parsed (no field descriptors, no second pass). A record's row is
// written tentatively; a blank record rewinds outPos, a long row rewinds to
// the first extra field (its bytes are the long_row error's `extra`). Quoted
// fields copy their span with SIMD and patch each doubled "" into \" in
// place (length-preserving); only spans holding CR/LF/backslash fall back to
// a scalar materializing pass.
//
// Memory layout (set by JS via transduce):
//   [0, inLen)            input bytes (cases.json), unescaped in place
//   [outPtr, outPtr+outCap)  answers.json bytes
//   [errPtr, errPtr+errCap)  per-case errors JSON fragments
//   [scrPtr, scrPtr+scrCap)  scratch: per-field output offsets (offs),
//                            itoa temp

const COMMA: i32 = 0;
const LINE_BREAK: i32 = 1;
const END: i32 = 2;

// error codes
const E_STRAY_CR: i32 = 0;
const E_UNTERM: i32 = 1;
const E_JUNK: i32 = 2;
const E_SHORT: i32 = 3;
const E_LONG: i32 = 4;

let inLen: i32 = 0;
let outBase: i32 = 0;
let outPos: i32 = 0;
let outEnd: i32 = 0;
let errBase: i32 = 0;
let errPos: i32 = 0;
let errEnd: i32 = 0;
let scrBase: i32 = 0;
let offsBase: i32 = 0; // per-field output offsets, i32 each, capacity 4096
let numBase: i32 = 0;
let failed: i32 = 0;

let csvStart: i32 = 0;
let csvEnd: i32 = 0;
let nextPos: i32 = 0;
let pos: i32 = 0;
let line: i32 = 1;
let recordLine: i32 = 1;
let recordRow: i32 = 0; // -1 = null (header record)
let width: i32 = -1;
let header: bool = false;
let colsDone: bool = false;
let colsWritten: bool = false;
let rowsCount: i32 = 0;
let nFields: i32 = 0;
let firstLen: i32 = 0;
let lastQuoted: bool = false;
let errCount: i32 = 0;
let recOutStart: i32 = 0;

let scanKind: i32 = 0; // 0 comma, 1 LF, 2 CR, 3 END
let scanEsc: bool = false;
let fieldEnded: i32 = 0;
let curLen: i32 = 0; // value byte length of the field just parsed

// ---------- low-level output ----------

@inline
function outReserve(n: i32): bool {
  if (outPos + n > outEnd) { failed = 1; return false; }
  return true;
}

@inline
function errReserve(n: i32): bool {
  if (errPos + n > errEnd) { failed = 1; return false; }
  return true;
}

@inline
function outByte(b: i32): void {
  if (outPos >= outEnd) { failed = 1; return; }
  store<u8>(outPos, b);
  outPos++;
}

// Unchecked byte store: the caller must have reserved enough capacity with
// outReserve first (a field's JSON is at most 6x its span: a control byte
// becomes \u00XX, everything else at most 2x, plus quotes).
@inline
function outByteF(b: i32): void {
  store<u8>(outPos, b);
  outPos++;
}

@inline
function outBytesF(src: i32, len: i32): void {
  if (len <= 0) return;
  let d = outPos;
  let s = src;
  let n = len;
  if (n < 16) {
    if (n >= 8) { store<u64>(d, load<u64>(s)); d += 8; s += 8; n -= 8; }
    if (n >= 4) { store<u32>(d, load<u32>(s)); d += 4; s += 4; n -= 4; }
    if (n >= 2) { store<u16>(d, load<u16>(s)); d += 2; s += 2; n -= 2; }
    if (n >= 1) { store<u8>(d, load<u8>(s)); }
    outPos = d + n;
    return;
  }
  while (n >= 16) {
    v128.store(d, v128.load(s));
    d += 16; s += 16; n -= 16;
  }
  if (n >= 8) { store<u64>(d, load<u64>(s)); d += 8; s += 8; n -= 8; }
  if (n >= 4) { store<u32>(d, load<u32>(s)); d += 4; s += 4; n -= 4; }
  if (n >= 2) { store<u16>(d, load<u16>(s)); d += 2; s += 2; n -= 2; }
  if (n >= 1) { store<u8>(d, load<u8>(s)); }
  outPos = d + n;
}

@inline
function outBytes(src: i32, len: i32): void {
  if (len <= 0) return;
  if (outPos + len > outEnd) { failed = 1; return; }
  let d = outPos;
  let s = src;
  let n = len;
  if (n < 16) {
    // Small copy (the common field case): wide loads, no byte loop.
    if (n >= 8) { store<u64>(d, load<u64>(s)); d += 8; s += 8; n -= 8; }
    if (n >= 4) { store<u32>(d, load<u32>(s)); d += 4; s += 4; n -= 4; }
    if (n >= 2) { store<u16>(d, load<u16>(s)); d += 2; s += 2; n -= 2; }
    if (n >= 1) { store<u8>(d, load<u8>(s)); }
    outPos = d + n;
    return;
  }
  while (n >= 16) {
    v128.store(d, v128.load(s));
    d += 16; s += 16; n -= 16;
  }
  if (n >= 8) { store<u64>(d, load<u64>(s)); d += 8; s += 8; n -= 8; }
  if (n >= 4) { store<u32>(d, load<u32>(s)); d += 4; s += 4; n -= 4; }
  if (n >= 2) { store<u16>(d, load<u16>(s)); d += 2; s += 2; n -= 2; }
  if (n >= 1) { store<u8>(d, load<u8>(s)); }
  outPos = d + n;
}

@inline
function outNum(n: i32): void {
  // n >= 0 always (line / row / field count)
  let p = numBase + 16;
  let v = n;
  if (v == 0) {
    outByte(48);
    return;
  }
  let start = p;
  while (v > 0) {
    p--;
    store<u8>(p, 48 + (v % 10));
    v = v / 10;
  }
  outBytes(p, start - p);
}

@inline
function errByte(b: i32): void {
  if (errPos >= errEnd) { failed = 1; return; }
  store<u8>(errPos, b);
  errPos++;
}

@inline
function errBytes(src: i32, len: i32): void {
  if (len <= 0) return;
  if (errPos + len > errEnd) { failed = 1; return; }
  let d = errPos;
  let s = src;
  let n = len;
  if (n < 16) {
    if (n >= 8) { store<u64>(d, load<u64>(s)); d += 8; s += 8; n -= 8; }
    if (n >= 4) { store<u32>(d, load<u32>(s)); d += 4; s += 4; n -= 4; }
    if (n >= 2) { store<u16>(d, load<u16>(s)); d += 2; s += 2; n -= 2; }
    if (n >= 1) { store<u8>(d, load<u8>(s)); }
    errPos = d + n;
    return;
  }
  while (n >= 16) {
    v128.store(d, v128.load(s));
    d += 16; s += 16; n -= 16;
  }
  if (n >= 8) { store<u64>(d, load<u64>(s)); d += 8; s += 8; n -= 8; }
  if (n >= 4) { store<u32>(d, load<u32>(s)); d += 4; s += 4; n -= 4; }
  if (n >= 2) { store<u16>(d, load<u16>(s)); d += 2; s += 2; n -= 2; }
  if (n >= 1) { store<u8>(d, load<u8>(s)); }
  errPos = d + n;
}

@inline
function errNum(n: i32): void {
  let p = numBase + 16;
  let v = n;
  if (v == 0) {
    errByte(48);
    return;
  }
  let start = p;
  while (v > 0) {
    p--;
    store<u8>(p, 48 + (v % 10));
    v = v / 10;
  }
  errBytes(p, start - p);
}

// JSON literals, written as packed integer stores (no strings: --runtime
// stub cannot run String#charCodeAt).
@inline
function outL_columnsOpen(): void {
  if (!outReserve(10)) return;
  store<i64>(outPos, 0x736E6D756C6F6322);
  store<u16>(outPos + 8, 0x3A22);
  outPos += 10;
}
@inline
function outL_nullRows(): void {
  if (!outReserve(13)) return;
  store<i64>(outPos, 0x6F72222C6C6C756E);
  store<i32>(outPos + 8, 0x3A227377);
  store<u8>(outPos + 12, 91);
  outPos += 13;
}
@inline
function outL_colsRows(): void {
  if (!outReserve(10)) return;
  store<i64>(outPos, 0x2273776F72222C5D);
  store<u16>(outPos + 8, 0x5B3A);
  outPos += 10;
}
@inline
function outL_rowsOpen(): void {
  if (!outReserve(9)) return;
  store<i64>(outPos, 0x3A2273776F72222C);
  store<u8>(outPos + 8, 91);
  outPos += 9;
}
@inline
function outL_errorsOpen(): void {
  if (!outReserve(12)) return;
  store<i64>(outPos, 0x726F727265222C5D);
  store<i32>(outPos + 8, 0x5B3A2273);
  outPos += 12;
}
@inline
function outL_caseClose(): void {
  if (!outReserve(2)) return;
  store<u16>(outPos + 0, 0x7D5D);
  outPos += 2;
}
@inline
function errL_open(): void {
  if (!errReserve(9)) return;
  store<i64>(errPos, 0x3A2265646F63227B);
  store<u8>(errPos + 8, 34);
  errPos += 9;
}
@inline
function errL_strayCr(): void {
  if (!errReserve(8)) return;
  store<i64>(errPos, 0x72635F7961727473);
  errPos += 8;
}
@inline
function errL_unterm(): void {
  if (!errReserve(18)) return;
  store<i64>(errPos, 0x6E696D7265746E75);
  store<i64>(errPos + 8, 0x6F75715F64657461);
  store<u16>(errPos + 16, 0x6574);
  errPos += 18;
}
@inline
function errL_junk(): void {
  if (!errReserve(10)) return;
  store<i64>(errPos, 0x756A5F65746F7571);
  store<u16>(errPos + 8, 0x6B6E);
  errPos += 10;
}
@inline
function errL_short(): void {
  if (!errReserve(9)) return;
  store<i64>(errPos, 0x6F725F74726F6873);
  store<u8>(errPos + 8, 119);
  errPos += 9;
}
@inline
function errL_long(): void {
  if (!errReserve(8)) return;
  store<i64>(errPos, 0x776F725F676E6F6C);
  errPos += 8;
}
@inline
function errL_lineSep(): void {
  if (!errReserve(9)) return;
  store<i64>(errPos, 0x22656E696C222C22);
  store<u8>(errPos + 8, 58);
  errPos += 9;
}
@inline
function errL_rowSep(): void {
  if (!errReserve(7)) return;
  store<i32>(errPos + 0, 0x6F72222C);
  store<u16>(errPos + 4, 0x2277);
  store<u8>(errPos + 6, 58);
  errPos += 7;
}
@inline
function errL_null(): void {
  if (!errReserve(4)) return;
  store<i32>(errPos + 0, 0x6C6C756E);
  errPos += 4;
}
@inline
function errL_fieldsSep(): void {
  if (!errReserve(10)) return;
  store<i64>(errPos, 0x73646C656966222C);
  store<u16>(errPos + 8, 0x3A22);
  errPos += 10;
}
@inline
function errL_extraSep(): void {
  if (!errReserve(10)) return;
  store<i64>(errPos, 0x226172747865222C);
  store<u16>(errPos + 8, 0x5B3A);
  errPos += 10;
}
@inline
function errL_extraClose(): void {
  if (!errReserve(2)) return;
  store<u16>(errPos + 0, 0x7D5D);
  errPos += 2;
}
@inline
function errL_close(): void {
  if (!errReserve(1)) return;
  store<u8>(errPos + 0, 125);
  errPos += 1;
}

// ---------- SIMD scanners ----------

// First index >= p and < lim holding byte a or b; lim when none.
@inline
function findByte2(p: i32, lim: i32, a: i32, b: i32): i32 {
  let va = i8x16.splat(<i8>a);
  let vb = i8x16.splat(<i8>b);
  let i = p;
  while (i + 16 <= lim) {
    let v = v128.load(i);
    let m = v128.or(i8x16.eq(v, va), i8x16.eq(v, vb));
    let mask = i8x16.bitmask(m);
    if (mask != 0) return i + i32.ctz(mask);
    i += 16;
  }
  while (i < lim) {
    let c = load<u8>(i);
    if (c == a || c == b) return i;
    i++;
  }
  return lim;
}

// First index >= p holding ',', LF or CR, or lim. Sets scanKind (0 comma,
// 1 LF, 2 CR, 3 END) and scanEsc (any '"' | '\\' | byte < 0x20 before it).
@inline
function scanDelim(p: i32, lim: i32): i32 {
  let vc = i8x16.splat(44);
  let vn = i8x16.splat(10);
  let vr = i8x16.splat(13);
  let vq = i8x16.splat(34);
  let vb = i8x16.splat(92);
  let v32 = i8x16.splat(32);
  scanEsc = false;
  let i = p;
  while (i + 16 <= lim) {
    let v = v128.load(i);
    let dm = v128.or(v128.or(i8x16.eq(v, vc), i8x16.eq(v, vn)), i8x16.eq(v, vr));
    let dmask = i8x16.bitmask(dm);
    let em = v128.or(v128.or(i8x16.eq(v, vq), i8x16.eq(v, vb)), i8x16.lt_u(v, v32));
    let emask = i8x16.bitmask(em);
    if (dmask != 0) {
      let bit = i32.ctz(dmask);
      if (bit > 0 && (emask & ((1 << bit) - 1)) != 0) scanEsc = true;
      let idx = i + bit;
      let c = load<u8>(idx);
      scanKind = c == 44 ? 0 : (c == 10 ? 1 : 2);
      return idx;
    }
    if (emask != 0) scanEsc = true;
    i += 16;
  }
  while (i < lim) {
    let c = load<u8>(i);
    if (c == 44) { scanKind = 0; return i; }
    if (c == 10) { scanKind = 1; return i; }
    if (c == 13) { scanKind = 2; return i; }
    if (c == 34 || c == 92 || c < 32) scanEsc = true;
    i++;
  }
  scanKind = 3;
  return lim;
}

// ---------- JSON unescape (in place) ----------

@inline
function hexVal(c: i32): i32 {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  if (c >= 65 && c <= 70) return c - 55;
  return -1;
}

@inline
function hex4(p: i32): i32 {
  let v = 0;
  for (let i = 0; i < 4; i++) {
    let h = hexVal(load<u8>(p + i));
    if (h < 0) return -1;
    v = (v << 4) | h;
  }
  return v;
}

// Encode code point cp as UTF-8 at w; returns bytes written.
@inline
function utf8Encode(w: i32, cp: i32): i32 {
  if (cp < 0x80) {
    store<u8>(w, cp);
    return 1;
  }
  if (cp < 0x800) {
    store<u8>(w, 0xC0 | (cp >> 6));
    store<u8>(w + 1, 0x80 | (cp & 0x3F));
    return 2;
  }
  if (cp < 0x10000) {
    store<u8>(w, 0xE0 | (cp >> 12));
    store<u8>(w + 1, 0x80 | ((cp >> 6) & 0x3F));
    store<u8>(w + 2, 0x80 | (cp & 0x3F));
    return 3;
  }
  store<u8>(w, 0xF0 | (cp >> 18));
  store<u8>(w + 1, 0x80 | ((cp >> 12) & 0x3F));
  store<u8>(w + 2, 0x80 | ((cp >> 6) & 0x3F));
  store<u8>(w + 3, 0x80 | (cp & 0x3F));
  return 4;
}

// Unescape the JSON string whose content starts at s. Returns the CSV byte
// length, or -1 on malformed input; sets nextPos past the closing quote.
// Single fused loop: scan a 16-byte chunk for '\' or '"'; chunks with
// neither are bulk-copied; otherwise the prefix is copied and the escape is
// handled scalarly.
function unescape(s: i32, lim: i32): i32 {
  let r = s;
  let w = s;
  let vbs = i8x16.splat(92);
  let vq = i8x16.splat(34);
  while (r < lim) {
    if (r + 16 <= lim) {
      let v = v128.load(r);
      let mask = i8x16.bitmask(v128.or(i8x16.eq(v, vbs), i8x16.eq(v, vq)));
      if (mask == 0) {
        v128.store(w, v);
        r += 16;
        w += 16;
        continue;
      }
      let f = r + i32.ctz(mask);
      // Copy [r, f) to w. Forward copy, dst <= src: a 16-byte store at w is
      // safe while the gap (r - w) is >= 16; otherwise copy byte by byte.
      if (f > r) {
        if (r - w >= 16) {
          v128.store(w, v);
          w += f - r;
        } else {
          let i = r;
          while (i < f) {
            store<u8>(w, load<u8>(i));
            w++; i++;
          }
        }
      }
      r = f;
    } else {
      // Tail: scalar scan for the next '\' or '"'.
      let f = r;
      while (f < lim) {
        let c = load<u8>(f);
        if (c == 92 || c == 34) break;
        f++;
      }
      if (f > r) {
        if (r - w >= 16) {
          // f - r < 16 here; a 16-byte store would overrun the tail's real
          // bytes, so copy byte by byte when the gap is small, else still
          // use chunked copy only for full 16-byte runs (none here).
          let i = r;
          while (i < f) {
            store<u8>(w, load<u8>(i));
            w++; i++;
          }
        } else {
          let i = r;
          while (i < f) {
            store<u8>(w, load<u8>(i));
            w++; i++;
          }
        }
      }
      r = f;
    }
    if (r >= lim) return -1;
    let b = load<u8>(r);
    if (b == 34) {
      nextPos = r + 1;
      return w - s;
    }
    // backslash escape
    if (r + 1 >= lim) return -1;
    let e = load<u8>(r + 1);
    r += 2;
    if (e == 34) { store<u8>(w, 34); w++; }
    else if (e == 92) { store<u8>(w, 92); w++; }
    else if (e == 47) { store<u8>(w, 47); w++; }
    else if (e == 98) { store<u8>(w, 8); w++; }
    else if (e == 102) { store<u8>(w, 12); w++; }
    else if (e == 110) { store<u8>(w, 10); w++; }
    else if (e == 114) { store<u8>(w, 13); w++; }
    else if (e == 116) { store<u8>(w, 9); w++; }
    else if (e == 117) {
      if (r + 4 > lim) return -1;
      let cp = hex4(r);
      if (cp < 0) return -1;
      r += 4;
      if (cp >= 0xD800 && cp <= 0xDBFF && r + 6 <= lim && load<u8>(r) == 92 && load<u8>(r + 1) == 117) {
        let lo = hex4(r + 2);
        if (lo >= 0xDC00 && lo <= 0xDFFF) {
          cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
          r += 6;
        }
      }
      w += utf8Encode(w, cp);
    } else {
      return -1;
    }
  }
  return -1;
}

// ---------- errors ----------

@inline
function emitError(code: i32, ln: i32, rw: i32, extra: i32): void {
  // extra: short_row -> field count; other codes -> ignored.
  if (errCount > 0) errByte(44);
  errCount++;
  errL_open();
  if (code == E_STRAY_CR) errL_strayCr();
  else if (code == E_UNTERM) errL_unterm();
  else if (code == E_JUNK) errL_junk();
  else if (code == E_SHORT) errL_short();
  else errL_long();
  errL_lineSep();
  errNum(ln);
  errL_rowSep();
  if (rw < 0) errL_null(); else errNum(rw);
  if (code == E_SHORT) {
    errL_fieldsSep();
    errNum(extra);
    errL_close();
  } else {
    errL_close();
  }
}

// long_row: the extra fields' JSON text is the output buffer's tail
// [offs[width], outPos) — already JSON-escaped field strings.
@inline
function emitErrorLong(ln: i32, rw: i32): void {
  if (errCount > 0) errByte(44);
  errCount++;
  errL_open();
  errL_long();
  errL_lineSep();
  errNum(ln);
  errL_rowSep();
  if (rw < 0) errL_null(); else errNum(rw);
  errL_extraSep();
  errBytes(load<i32>(offsBase + width * 4), outPos - load<i32>(offsBase + width * 4));
  errL_extraClose();
}

// ---------- JSON escaping helpers ----------

// Write the JSON-escaped form of [src, src+len) to the output buffer.
// Unchecked: the caller must have reserved 6*len + 8 first.
@inline
function outEscaped(src: i32, len: i32): void {
  let e = src + len;
  let i = src;
  while (i < e) {
    let b = load<u8>(i);
    if (b == 34) { outByteF(92); outByteF(34); }
    else if (b == 92) { outByteF(92); outByteF(92); }
    else if (b == 10) { outByteF(92); outByteF(110); }
    else if (b == 13) { outByteF(92); outByteF(114); }
    else if (b == 9) { outByteF(92); outByteF(116); }
    else if (b == 8) { outByteF(92); outByteF(98); }
    else if (b == 12) { outByteF(92); outByteF(102); }
    else if (b < 32) {
      outByteF(92); outByteF(117); outByteF(48); outByteF(48);
      let hi = b >> 4;
      let lo = b & 15;
      outByteF(hi < 10 ? 48 + hi : 87 + hi);
      outByteF(lo < 10 ? 48 + lo : 87 + lo);
    } else {
      outByteF(b);
    }
    i++;
  }
}

// ---------- CSV field parsing ----------

// Advance pos/line and set fieldEnded for a delimiter found by scanDelim.
@inline
function advanceDelim(idx: i32): void {
  if (scanKind == 0) { pos = idx + 1; fieldEnded = COMMA; }
  else if (scanKind == 1) { pos = idx + 1; line++; fieldEnded = LINE_BREAK; }
  else if (scanKind == 2) { pos = idx + 2; line++; fieldEnded = LINE_BREAK; }
  else { pos = idx; fieldEnded = END; }
}

// Unquoted field starting at `start`, optionally prepending one literal
// byte (prefix >= 0: the opening quote of an unterminated field, which is
// written JSON-escaped). Writes the whole field JSON ("..." ) to the output
// buffer; sets fieldEnded, pos, line, curLen.
@inline
function parseUnquoted(start: i32, prefix: i32): void {
  let idx = scanDelim(start, csvEnd);
  if (scanKind == 2 && !(idx + 1 < csvEnd && load<u8>(idx + 1) == 10)) {
    unquotedSlow(start, prefix);
    return;
  }
  if (!outReserve(6 * (idx - start) + 8)) return;
  outByteF(34);
  if (prefix >= 0) { outByteF(92); outByteF(34); }
  if (!scanEsc) {
    outBytesF(start, idx - start);
  } else {
    outEscaped(start, idx - start);
  }
  outByteF(34);
  curLen = (prefix >= 0 ? 1 : 0) + (idx - start);
  advanceDelim(idx);
}

// Slow path: unquoted scan that must drop lone CRs (stray_cr errors).
@inline
function unquotedSlow(start: i32, prefix: i32): void {
  outByte(34);
  if (prefix >= 0) { outByte(92); outByte(34); }
  let kept = 0;
  let i = start;
  let ended = END;
  while (i < csvEnd) {
    let c = load<u8>(i);
    if (c == 44) { i++; ended = COMMA; break; }
    if (c == 10) { i++; line++; ended = LINE_BREAK; break; }
    if (c == 13) {
      if (i + 1 < csvEnd && load<u8>(i + 1) == 10) { i += 2; line++; ended = LINE_BREAK; break; }
      emitError(E_STRAY_CR, recordLine, recordRow, -1);
      i++;
      continue;
    }
    if (c == 34) { outByte(92); outByte(34); }
    else if (c == 92) { outByte(92); outByte(92); }
    else if (c == 9) { outByte(92); outByte(116); }
    else if (c == 8) { outByte(92); outByte(98); }
    else if (c == 12) { outByte(92); outByte(102); }
    else if (c < 32) {
      outByte(92); outByte(117); outByte(48); outByte(48);
      let hi = c >> 4;
      let lo = c & 15;
      outByte(hi < 10 ? 48 + hi : 87 + hi);
      outByte(lo < 10 ? 48 + lo : 87 + lo);
    } else {
      outByte(c);
    }
    kept++;
    i++;
  }
  outByte(34);
  curLen = (prefix >= 0 ? 1 : 0) + kept;
  pos = i;
  fieldEnded = ended;
}

// Quoted field at pos (pos points at the opening quote). Writes the whole
// field JSON to the output buffer.
@inline
function parseQuoted(): void {
  let open = pos;
  // --- fused search for the closing quote; also detect CR/LF/backslash
  // in the span (those force the scalar materializing path).
  let i = open + 1;
  let closed = -1;
  let needMat = false;
  let skipFirst = false; // previous chunk ended with the first half of a "" pair
  let vbs = i8x16.splat(92);
  let vq = i8x16.splat(34);
  let v32 = i8x16.splat(32);
  while (i < csvEnd) {
    if (i + 16 > csvEnd) {
      while (i < csvEnd) {
        let c = load<u8>(i);
        if (c == 34) {
          if (skipFirst) { skipFirst = false; i++; continue; }
          if (i + 1 < csvEnd && load<u8>(i + 1) == 34) { i += 2; continue; }
          closed = i;
          break;
        }
        skipFirst = false;
        if (c == 92 || c < 32) needMat = true;
        i++;
      }
      break;
    }
    let v = v128.load(i);
    let mQ = i8x16.bitmask(i8x16.eq(v, vq));
    let mS = i8x16.bitmask(v128.or(i8x16.eq(v, vbs), i8x16.lt_u(v, v32)));
    let m = mQ | mS;
    if (skipFirst) {
      // Byte 0 of this chunk is the second half of a "" pair: ignore it.
      m &= ~1;
      skipFirst = false;
    }
    // Process every special in this chunk in order, from the loaded masks.
    while (m != 0) {
      let bit = i32.ctz(m);
      let p = i + bit;
      let c = load<u8>(p);
      if (c == 34) {
        if (p + 1 < csvEnd && load<u8>(p + 1) == 34) {
          m &= ~(1 << bit);
          if (bit + 1 < 16) {
            m &= ~(1 << (bit + 1));
          } else {
            skipFirst = true;
          }
          continue;
        }
        closed = p;
        break;
      }
      needMat = true;
      m &= ~(1 << bit);
    }
    if (closed >= 0) break;
    i += 16;
  }
  if (closed < 0) {
    emitError(E_UNTERM, recordLine, recordRow, -1);
    parseUnquoted(open + 1, 34);
    return;
  }
  let spanStart = open + 1;
  let spanLen = closed - spanStart;
  // One reserve covers the whole field JSON: 2 quotes + content (at most
  // 6x the span) + the closing quote after the field (1) + slack.
  if (!outReserve(6 * spanLen + 16)) return;
  if (!needMat) {
    // Patch-copy: the span's only specials are doubled quotes; copy it
    // verbatim and replace the first quote of each pair with a backslash
    // ("" -> \" is length-preserving).
    outByteF(34);
    let s = spanStart;
    let e = closed;
    let parity = 0;
    while (s + 16 <= e) {
      let v = v128.load(s);
      let mQ = i8x16.bitmask(i8x16.eq(v, vq));
      v128.store(outPos, v);
      if (mQ != 0) {
        let mm = mQ;
        while (mm != 0) {
          let bit = i32.ctz(mm);
          if (parity == 0) store<u8>(outPos + bit, 92);
          parity ^= 1;
          mm &= mm - 1;
        }
      }
      outPos += 16;
      s += 16;
    }
    while (s < e) {
      let c = load<u8>(s);
      if (c == 34) {
        if (parity == 0) store<u8>(outPos, 92); else store<u8>(outPos, 34);
        parity ^= 1;
      } else {
        store<u8>(outPos, c);
      }
      outPos++;
      s++;
    }
    curLen = spanLen;
  } else {
    // Scalar materialize: "" -> ", CR/CRLF/LF -> LF (JSON-escaped), and
    // backslash / controls JSON-escaped.
    outByteF(34);
    let breaks = 0;
    let j = spanStart;
    let e = closed;
    while (j < e) {
      let c = load<u8>(j);
      if (c == 34) { outByteF(92); outByteF(34); j += 2; continue; }
      if (c == 13) {
        outByteF(92); outByteF(110); breaks++;
        j += (j + 1 < e && load<u8>(j + 1) == 10) ? 2 : 1;
        continue;
      }
      if (c == 10) { outByteF(92); outByteF(110); breaks++; j++; continue; }
      if (c == 92) { outByteF(92); outByteF(92); j++; continue; }
      if (c == 9) { outByteF(92); outByteF(116); j++; continue; }
      if (c == 8) { outByteF(92); outByteF(98); j++; continue; }
      if (c == 12) { outByteF(92); outByteF(102); j++; continue; }
      if (c < 32) {
        outByteF(92); outByteF(117); outByteF(48); outByteF(48);
        let hi = c >> 4;
        let lo = c & 15;
        outByteF(hi < 10 ? 48 + hi : 87 + hi);
        outByteF(lo < 10 ? 48 + lo : 87 + lo);
        j++;
        continue;
      }
      outByteF(c);
      j++;
    }
    line += breaks;
    curLen = spanLen;
  }
  // --- post-close: comma / line break / end, else junk appended to value.
  pos = closed + 1;
  if (pos >= csvEnd) { outByteF(34); fieldEnded = END; return; }
  let c = load<u8>(pos);
  if (c == 44) { outByteF(34); pos++; fieldEnded = COMMA; return; }
  if (c == 10) { outByteF(34); pos++; line++; fieldEnded = LINE_BREAK; return; }
  if (c == 13 && pos + 1 < csvEnd && load<u8>(pos + 1) == 10) { outByteF(34); pos += 2; line++; fieldEnded = LINE_BREAK; return; }
  // Junk after the closing quote: unquoted scan appended inside the quotes.
  let junkStart = pos;
  let idx = scanDelim(pos, csvEnd);
  if (scanKind == 2 && !(idx + 1 < csvEnd && load<u8>(idx + 1) == 10)) {
    let added = 0;
    let k = junkStart;
    let ended = END;
    while (k < csvEnd) {
      let cc = load<u8>(k);
      if (cc == 44) { k++; ended = COMMA; break; }
      if (cc == 10) { k++; line++; ended = LINE_BREAK; break; }
      if (cc == 13) {
        if (k + 1 < csvEnd && load<u8>(k + 1) == 10) { k += 2; line++; ended = LINE_BREAK; break; }
        emitError(E_STRAY_CR, recordLine, recordRow, -1);
        k++;
        continue;
      }
      if (cc == 34) { outByte(92); outByte(34); }
      else if (cc == 92) { outByte(92); outByte(92); }
      else if (cc == 9) { outByte(92); outByte(116); }
      else if (cc == 8) { outByte(92); outByte(98); }
      else if (cc == 12) { outByte(92); outByte(102); }
      else if (cc < 32) {
        outByte(92); outByte(117); outByte(48); outByte(48);
        let hi = cc >> 4;
        let lo = cc & 15;
        outByte(hi < 10 ? 48 + hi : 87 + hi);
        outByte(lo < 10 ? 48 + lo : 87 + lo);
      } else {
        outByte(cc);
      }
      added++;
      k++;
    }
    pos = k;
    if (added > 0) emitError(E_JUNK, recordLine, recordRow, -1);
    outByte(34);
    fieldEnded = ended;
    return;
  }
  let added = idx - junkStart;
  if (added > 0) {
    if (!outReserve(6 * added + 8)) return;
    if (scanEsc) outEscaped(junkStart, added); else outBytesF(junkStart, added);
    emitError(E_JUNK, recordLine, recordRow, -1);
  }
  outByteF(34);
  advanceDelim(idx);
}

// ---------- record ----------

@inline
function parseRecord(): void {
  recOutStart = outPos;
  // One reserve covers this record's structural bytes: '[' + one ','
  // separator per field (at most 4095) + ']' + the trailing empty field.
  // Each field's own content is covered by its own reserve (6x its span),
  // which always leaves >= 6 bytes of slack for the next separator.
  if (!outReserve(4112)) return;
  let needComma = !(header && !colsDone) && rowsCount > 0;
  if (needComma) outByteF(44);
  outByteF(91);
  nFields = 0;
  firstLen = 0;
  lastQuoted = false;
  while (true) {
    if (pos >= csvEnd) {
      // Trailing empty field after a comma at EOF: the separator comma
      // comes first (it was skipped by the check above).
      if (nFields > 0) outByteF(44);
      if (nFields >= 4096) { failed = 1; return; }
      store<i32>(offsBase + nFields * 4, outPos);
      outByteF(34);
      outByteF(34);
      curLen = 0;
      lastQuoted = false;
      fieldEnded = END;
      nFields++;
      break;
    }
    if (nFields > 0) outByteF(44);
    if (nFields >= 4096) { failed = 1; return; }
    store<i32>(offsBase + nFields * 4, outPos);
    if (load<u8>(pos) == 34) {
      lastQuoted = true;
      parseQuoted();
    } else {
      lastQuoted = false;
      parseUnquoted(pos, -1);
    }
    if (failed) return;
    if (nFields == 0) firstLen = curLen;
    nFields++;
    if (fieldEnded != COMMA) break;
  }
}

@inline
function finishRecord(): void {
  if (nFields == 1 && firstLen == 0 && !lastQuoted) {
    outPos = recOutStart;
    return;
  }
  if (width < 0) width = nFields;
  if (header && !colsDone) {
    colsDone = true;
    outL_colsRows();
    colsWritten = true;
    return;
  }
  if (nFields < width) {
    emitError(E_SHORT, recordLine, recordRow, nFields);
    if (!outReserve(3 * width + 8)) return;
    while (nFields < width) {
      outByteF(44);
      outByteF(34);
      outByteF(34);
      nFields++;
    }
  } else if (nFields > width) {
    emitErrorLong(recordLine, recordRow);
    outPos = load<i32>(offsBase + width * 4) - 1;
  }
  outByteF(93);
  rowsCount++;
}

// ---------- one case ----------

@inline
function processCase(): void {
  pos = csvStart;
  line = 1;
  if (csvEnd - csvStart >= 3 && load<u8>(csvStart) == 0xEF && load<u8>(csvStart + 1) == 0xBB && load<u8>(csvStart + 2) == 0xBF) {
    pos = csvStart + 3;
  }
  width = -1;
  colsDone = false;
  colsWritten = false;
  rowsCount = 0;
  errCount = 0;
  errPos = errBase;
  outByte(123);
  outL_columnsOpen();
  if (!header) {
    outL_nullRows();
    colsWritten = true;
  }
  while (true) {
    while (pos < csvEnd) {
      let c = load<u8>(pos);
      if (c == 10) { pos++; line++; continue; }
      if (c == 13 && pos + 1 < csvEnd && load<u8>(pos + 1) == 10) { pos += 2; line++; continue; }
      break;
    }
    if (pos >= csvEnd) break;
    recordLine = line;
    recordRow = (header && !colsDone) ? -1 : rowsCount;
    parseRecord();
    if (failed) return;
    finishRecord();
    if (failed) return;
  }
  if (!colsWritten) {
    outByte(91);
    outByte(93);
    outL_rowsOpen();
  }
  outL_errorsOpen();
  outBytes(errBase, errPos - errBase);
  outL_caseClose();
}

// ---------- top level ----------

// Find `"text":"` at or after p; returns its index, or -1.
function findTextKey(p: i32, lim: i32): i32 {
  let i = p;
  while (i < lim) {
    // SIMD scan for '"'
    let found = -1;
    let vq = i8x16.splat(34);
    while (i + 16 <= lim) {
      let mask = i8x16.bitmask(i8x16.eq(v128.load(i), vq));
      if (mask != 0) { found = i + i32.ctz(mask); break; }
      i += 16;
    }
    if (found < 0) {
      while (i < lim) {
        if (load<u8>(i) == 34) { found = i; break; }
        i++;
      }
      if (found < 0) return -1;
    }
    i = found;
    if (i + 8 <= lim &&
        load<u8>(i + 1) == 116 && load<u8>(i + 2) == 101 && load<u8>(i + 3) == 120 &&
        load<u8>(i + 4) == 116 && load<u8>(i + 5) == 34 && load<u8>(i + 6) == 58 &&
        load<u8>(i + 7) == 34) {
      return i;
    }
    i++;
  }
  return -1;
}

// Find `"header":` at or after p; returns its index, or -1.
function findHeaderKey(p: i32, lim: i32): i32 {
  let i = p;
  while (i < lim) {
    let found = -1;
    let vq = i8x16.splat(34);
    while (i + 16 <= lim) {
      let mask = i8x16.bitmask(i8x16.eq(v128.load(i), vq));
      if (mask != 0) { found = i + i32.ctz(mask); break; }
      i += 16;
    }
    if (found < 0) {
      while (i < lim) {
        if (load<u8>(i) == 34) { found = i; break; }
        i++;
      }
      if (found < 0) return -1;
    }
    i = found;
    if (i + 9 <= lim &&
        load<u8>(i + 1) == 104 && load<u8>(i + 2) == 101 && load<u8>(i + 3) == 97 &&
        load<u8>(i + 4) == 100 && load<u8>(i + 5) == 101 && load<u8>(i + 6) == 114 &&
        load<u8>(i + 7) == 34 && load<u8>(i + 8) == 58) {
      return i;
    }
    i++;
  }
  return -1;
}

function setupOut(outPtr_: i32, outCap_: i32, errPtr_: i32, errCap_: i32, scrPtr_: i32): void {
  outBase = outPtr_;
  outPos = outPtr_;
  outEnd = outPtr_ + outCap_;
  errBase = errPtr_;
  errPos = errPtr_;
  errEnd = errPtr_ + errCap_;
  scrBase = scrPtr_;
  offsBase = scrPtr_;
  numBase = scrPtr_ + 4096 * 4 + 1024;
  failed = 0;
}

export function transduce(
  inLen_: i32, outPtr_: i32, outCap_: i32,
  errPtr_: i32, errCap_: i32, scrPtr_: i32, scrCap_: i32
): i32 {
  inLen = inLen_;
  setupOut(outPtr_, outCap_, errPtr_, errCap_, scrPtr_);

  outByte(91);
  let p = 0;
  let firstCase = true;
  while (true) {
    let ti = findTextKey(p, inLen);
    if (ti < 0) break;
    let textStart = ti + 8;
    let csvLen = unescape(textStart, inLen);
    if (csvLen < 0) return -1;
    csvStart = textStart;
    csvEnd = textStart + csvLen;
    let hi = findHeaderKey(nextPos, inLen);
    if (hi < 0) return -1;
    let hp = hi + 9;
    while (hp < inLen && (load<u8>(hp) == 32 || load<u8>(hp) == 9 || load<u8>(hp) == 10 || load<u8>(hp) == 13)) hp++;
    if (hp >= inLen) return -1;
    header = load<u8>(hp) == 116; // 't' = true
    if (!firstCase) outByte(44);
    firstCase = false;
    processCase();
    if (failed) return -1;
    p = nextPos;
  }
  outByte(93);
  if (failed) return -1;
  return outPos - outBase;
}
