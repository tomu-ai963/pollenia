import { describe, expect, it } from 'vitest';
import { canView, canViewOwnerOnly } from '../src/lib/visibility';

// SQL 側 pollenia.can_view_as() と同じ意味論であることが要件。
// マトリクス: visibility × (匿名 / 所有者 / フォロワー / 無関係) を全網羅する。
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('canView', () => {
  it('public は誰でも見える（匿名含む）', () => {
    const t = { ownerId: OWNER, visibility: 'public' as const };
    expect(canView(null, t)).toBe(true);
    expect(canView(OWNER, t)).toBe(true);
    expect(canView(OTHER, t)).toBe(true);
    expect(canView(OTHER, t, true)).toBe(true);
  });

  it('private は所有者のみ', () => {
    const t = { ownerId: OWNER, visibility: 'private' as const };
    expect(canView(null, t)).toBe(false);
    expect(canView(OWNER, t)).toBe(true);
    expect(canView(OTHER, t)).toBe(false);
    // private はフォロワーでも不可
    expect(canView(OTHER, t, true)).toBe(false);
  });

  it('followers は所有者とフォロワーのみ', () => {
    const t = { ownerId: OWNER, visibility: 'followers' as const };
    expect(canView(null, t)).toBe(false);
    expect(canView(OWNER, t)).toBe(true);
    expect(canView(OTHER, t, false)).toBe(false);
    expect(canView(OTHER, t, true)).toBe(true);
  });

  it('匿名（null）は isFollower=true を渡されても followers を見られない', () => {
    // 呼び出し側のバグ（匿名なのに isFollower を立てる）に対して fail-closed
    const t = { ownerId: OWNER, visibility: 'followers' as const };
    expect(canView(null, t, true)).toBe(false);
  });
});

describe('canViewOwnerOnly', () => {
  it('所有者のみ true（crossings / seed_harvests / sowings 用）', () => {
    expect(canViewOwnerOnly(OWNER, OWNER)).toBe(true);
    expect(canViewOwnerOnly(OTHER, OWNER)).toBe(false);
    expect(canViewOwnerOnly(null, OWNER)).toBe(false);
  });
});
