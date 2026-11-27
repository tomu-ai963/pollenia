import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Sql } from '../src/lib/db';
import type { PhotoSigner } from '../src/lib/photos';
import { handlePublicGallery } from '../src/routes/public';
import { handleUpdatePlant } from '../src/routes/plants';
import type { AuthedUser } from '../src/lib/auth';
import { GALLERY_MAX_OFFSET, GALLERY_PAGE_SIZE } from '../src/constants';

// 公開ギャラリー（GET /public/gallery・0005_gallery.sql）。ログイン不要の一覧なので、
// 載る条件・返す項目・ページングの上限を確かめる。実 DB は使わずフェイク sql で検証する。

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const row = (i: number, visibility = 'public') => ({
  id: `p${i}`,
  user_id: OWNER,
  name: `花${i}`,
  species: 'Rosa',
  visibility,
  is_seedling: i % 2 === 0,
  owner_name: '育種家',
  storage_path: `photos/${i}.jpg`,
  photo_at: new Date(),
});

type Q = { q: string; values: unknown[] };
function fakeSql(rows: ReturnType<typeof row>[], queries: Q[]): Sql {
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join('$');
    queries.push({ q, values });
    if (q.includes('from pollenia.plants p')) {
      const [limit, offset] = values.slice(-2) as [number, number];
      return Promise.resolve(rows.slice(offset, offset + limit));
    }
    throw new Error(`fakeSql: 未対応のクエリ: ${q}`);
  }) as unknown as Sql;
}
const signer: PhotoSigner = async (paths) => new Map(paths.map((p) => [p, `/photos/signed-${p}`]));
const get = (qs = '') => new Request(`http://x/public/gallery${qs}`);

describe('GET /public/gallery', () => {
  it('public かつ本人が載せた未削除の個体で、写真のあるものだけを SQL で絞る', async () => {
    const queries: Q[] = [];
    await handlePublicGallery(get(), fakeSql([], queries), signer);
    const q = queries[0].q;
    expect(q).toContain("p.visibility = 'public' and p.in_gallery and p.deleted_at is null");
    expect(q).toContain('uploaded_at is not null');
    expect(q).toContain('join lateral');
  });

  it('返すのは公開系統ページと同じ範囲 + 写真の署名 URL。user_id・notes・traits は返さない。キャッシュは短め', async () => {
    const res = await handlePublicGallery(get(), fakeSql([row(1)], []), signer);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    const body = (await res.json()) as { items: Record<string, unknown>[]; next_offset: number | null };
    expect(body.items).toEqual([
      {
        id: 'p1',
        name: '花1',
        species: 'Rosa',
        is_seedling: false,
        owner_name: '育種家',
        photo_url: '/photos/signed-photos/1.jpg',
      },
    ]);
    expect(body.next_offset).toBeNull();
  });

  it('SQL をすり抜けた非公開の行があっても canView で落とす（写真に署名しない）', async () => {
    const signed: string[] = [];
    const spy: PhotoSigner = async (paths) => {
      signed.push(...paths);
      return signer(paths);
    };
    const res = await handlePublicGallery(get(), fakeSql([row(1, 'private'), row(2, 'followers'), row(3)], []), spy);
    const body = (await res.json()) as { items: { id: string }[] };
    expect(body.items.map((i) => i.id)).toEqual(['p3']);
    expect(signed).toEqual(['photos/3.jpg']);
  });

  it('1 ページ分を超えれば next_offset を返す。offset は上限でクランプする', async () => {
    const many = Array.from({ length: GALLERY_PAGE_SIZE * 2 + 1 }, (_, i) => row(i));
    const res = await handlePublicGallery(get(), fakeSql(many, []), signer);
    const body = (await res.json()) as { items: unknown[]; next_offset: number | null };
    expect(body.items).toHaveLength(GALLERY_PAGE_SIZE);
    expect(body.next_offset).toBe(GALLERY_PAGE_SIZE);

    const queries: Q[] = [];
    await handlePublicGallery(get('?offset=999999'), fakeSql([], queries), signer);
    expect(queries[0].values.slice(-2)).toEqual([GALLERY_PAGE_SIZE + 1, GALLERY_MAX_OFFSET]);
  });

  it('上限の位置ではそれ以上の next_offset を出さない', async () => {
    const many = Array.from({ length: GALLERY_MAX_OFFSET + GALLERY_PAGE_SIZE + 1 }, (_, i) => row(i));
    const res = await handlePublicGallery(get(`?offset=${GALLERY_MAX_OFFSET}`), fakeSql(many, []), signer);
    expect(((await res.json()) as { next_offset: number | null }).next_offset).toBeNull();
  });
});

describe('PATCH /api/plants/:id の in_gallery', () => {
  const user: AuthedUser = { uid: OWNER, displayName: 'わたし' };
  const PLANT = '10000000-0000-4000-8000-000000000001';
  const patch = (body: unknown) =>
    new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) });

  it('真偽値だけ受け付け、自分の個体だけ更新する', async () => {
    const queries: Q[] = [];
    const fn = (first: unknown, ...values: unknown[]) => {
      if (!Array.isArray(first)) return { __patch: first };
      const q = (first as unknown as TemplateStringsArray).join('$');
      queries.push({ q, values });
      return Promise.resolve([{ id: PLANT, in_gallery: true }]);
    };
    const sql = Object.assign(fn, { unsafe: (s: string) => ({ __unsafe: s }) }) as unknown as Sql;
    const ok = await handleUpdatePlant(patch({ in_gallery: true }), sql, user, PLANT);
    expect(ok.status).toBe(200);
    const upd = queries.find((x) => x.q.includes('update pollenia.plants'))!;
    expect(upd.values[0]).toEqual({ __patch: { in_gallery: true } });
    expect(upd.q).toMatch(/user_id = \$::uuid/);

    const ng = await handleUpdatePlant(patch({ in_gallery: 'yes' }), sql, user, PLANT);
    expect(ng.status).toBe(400);
  });
});

describe('画面', () => {
  const read = (name: string) => readFileSync(new URL(`../../frontend/${name}`, import.meta.url), 'utf8');
  it('ログイン画面と公開系統ページからギャラリーへ行ける', () => {
    expect(read('index.html')).toContain('href="/gallery"');
    expect(read('public.html')).toContain('href="/gallery"');
    expect(read('gallery.html')).toContain('src="src/gallery.js"');
  });
  it('利用者の入力を innerHTML で描かない', () => {
    expect(read('src/gallery.js')).not.toMatch(/innerHTML/);
  });
});
