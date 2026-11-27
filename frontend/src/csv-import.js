import { TRAITS } from './trait-spec.js';

// 過去の記録の取り込み（CSV）。読み取り・見出しの対応づけはここ（端末内）で行い、
// 検証と作成は Worker（POST /api/import/plants）が行う。

/** バイト列 → 文字列。UTF-8（BOM 付きも）で読めなければ Shift_JIS（Excel の「CSV」形式）として読む */
export function decodeCsvBytes(buffer) {
  const bytes = new Uint8Array(buffer);
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return new TextDecoder('shift_jis').decode(bytes);
  }
}

/** RFC 4180 の CSV → 行の配列（"" の中のカンマ・改行・"" のエスケープに対応）。空行は落とす */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

// 見出し → API の項目名。括弧の中（「（cm）」「（種子親）」など）と空白は無視して比べる。
// 特性の見出しは trait-spec.js の項目名（「開花時期」「花形」など）と key
const HEADERS = {
  name: ['名前', '個体名', 'name'],
  species: ['属・種', '属種', '種', '品種', 'species'],
  genre: ['ジャンル', 'genre'],
  mother: ['母', '種子親', '母木', 'mother', 'seed_parent'],
  father: ['父', '花粉親', 'father', 'pollen_parent'],
  cross_date: ['交配日', 'cross_date'],
  notes: ['メモ', '備考', 'notes'],
  ...Object.fromEntries(TRAITS.map((t) => [t.key, [t.label, t.key]])),
  flower_size_cm: ['花のサイズ', '花径', 'flower_size_cm'],
};

export function normalizeHeader(h) {
  return h
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/\s|　/g, '')
    .toLowerCase();
}

const KEY_BY_HEADER = new Map(
  Object.entries(HEADERS).flatMap(([key, names]) => names.map((n) => [normalizeHeader(n), key])),
);

/** CSV の行 → API に送る行（1 行目は見出し）。知らない見出しの列は使わない */
export function tableToRows(table) {
  if (table.length === 0) return { rows: [], unknownHeaders: [], hasName: false };
  const [header, ...body] = table;
  const keys = header.map((h) => KEY_BY_HEADER.get(normalizeHeader(h)) ?? null);
  const unknownHeaders = header.filter((h, i) => !keys[i] && h.trim() !== '');
  const rows = body.map((cells) => {
    const r = {};
    keys.forEach((k, i) => {
      if (k && cells[i] !== undefined && cells[i].trim() !== '') r[k] = cells[i].trim();
    });
    return r;
  });
  return { rows, unknownHeaders, hasName: keys.includes('name') };
}
