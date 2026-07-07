import { describe, expect, it } from 'vitest';
import {
  asDateStr,
  asNonNegInt,
  asText,
  asVisibility,
  clampIntParam,
  isUuid,
} from '../src/lib/validate';

describe('isUuid', () => {
  it('UUID 形式のみ通す', () => {
    expect(isUuid('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBe(true);
    expect(isUuid('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA')).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('')).toBe(false);
    expect(isUuid(42)).toBe(false);
    expect(isUuid(null)).toBe(false);
    // SQLに紛れ込ませる細工を弾く
    expect(isUuid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'--")).toBe(false);
  });
});

describe('asVisibility', () => {
  it('ENUM の3値のみ', () => {
    expect(asVisibility('public')).toBe('public');
    expect(asVisibility('followers')).toBe('followers');
    expect(asVisibility('private')).toBe('private');
    expect(asVisibility('PUBLIC')).toBeNull();
    expect(asVisibility('')).toBeNull();
    expect(asVisibility(undefined)).toBeNull();
  });
});

describe('asDateStr', () => {
  it('YYYY-MM-DD の実在日付のみ', () => {
    expect(asDateStr('2026-07-07')).toBe('2026-07-07');
    expect(asDateStr('2026-02-30')).toBeNull(); // 実在しない日付
    expect(asDateStr('2026-13-01')).toBeNull();
    expect(asDateStr('2026/07/07')).toBeNull();
    expect(asDateStr('2026-7-7')).toBeNull();
    expect(asDateStr(20260707)).toBeNull();
  });
});

describe('asNonNegInt', () => {
  it('0 以上の整数のみ', () => {
    expect(asNonNegInt(0)).toBe(0);
    expect(asNonNegInt(42)).toBe(42);
    expect(asNonNegInt(-1)).toBeNull();
    expect(asNonNegInt(1.5)).toBeNull();
    expect(asNonNegInt('42')).toBeNull();
    expect(asNonNegInt(NaN)).toBeNull();
  });
});

describe('asText', () => {
  it('trim して 1..maxLen 文字', () => {
    expect(asText('  hello  ', 10)).toBe('hello');
    expect(asText('', 10)).toBeNull();
    expect(asText('   ', 10)).toBeNull();
    expect(asText('a'.repeat(11), 10)).toBeNull();
    expect(asText(42, 10)).toBeNull();
  });
});

describe('clampIntParam', () => {
  // depth / limit をクライアント指定のまま DB に渡さないための関門（api.md）
  it('範囲内はそのまま、範囲外はクランプ', () => {
    expect(clampIntParam('5', 1, 10, 3)).toBe(5);
    expect(clampIntParam('0', 1, 10, 3)).toBe(1);
    expect(clampIntParam('999', 1, 10, 3)).toBe(10);
    expect(clampIntParam('-4', 1, 10, 3)).toBe(1);
  });
  it('未指定・非整数はデフォルト', () => {
    expect(clampIntParam(null, 1, 10, 3)).toBe(3);
    expect(clampIntParam('', 1, 10, 3)).toBe(3);
    expect(clampIntParam('abc', 1, 10, 3)).toBe(3);
    expect(clampIntParam('2.5', 1, 10, 3)).toBe(3);
    expect(clampIntParam('Infinity', 1, 10, 3)).toBe(3);
  });
});
