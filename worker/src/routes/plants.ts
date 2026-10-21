import type { Sql } from '../lib/db';
import { json } from '../lib/http';
import { errorResponse } from '../lib/error-response';
import type { AuthedUser } from '../lib/auth';
import type { Env } from '../env';
import type { PhotoSigner } from '../lib/photos';
import { canViewWithDb, type Visibility } from '../lib/visibility';
import { asDateStr, asText, asVisibility, clampIntParam, isUuid } from '../lib/validate';
import { parsePlantTraits } from '../lib/traits';
import {
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  MAX_NAME_LEN,
  MAX_TEXT_LEN,
  PHOTO_CONTENT_TYPES,
  PHOTO_MAX_BYTES,
} from '../constants';

// 個体（plants）の CRUD。書き込みは常に所有者のみ。
// 閲覧は所有者 + canViewWithDb（visibility 列に基づく共通判定。lib/visibility.ts）。

const PLANT_COLS = `id, user_id, name, species, visibility, notes, traits,
  origin_sowing_id, deleted_at, created_at, updated_at`;

// GET /api/plants — 自分の個体一覧（soft delete 済みは除く）。?limit&offset
export async function handleListPlants(
  req: Request,
  sql: Sql,
  user: AuthedUser,
): Promise<Response> {
  const url = new URL(req.url);
  const limit = clampIntParam(url.searchParams.get('limit'), 1, LIST_LIMIT_MAX, LIST_LIMIT_DEFAULT);
  const offset = clampIntParam(url.searchParams.get('offset'), 0, 100_000, 0);

  const plants = await sql`
    select ${sql.unsafe(PLANT_COLS)}
    from pollenia.plants
    where user_id = ${user.uid}::uuid and deleted_at is null
    order by created_at desc
    limit ${limit} offset ${offset}
  `;
  return json({ plants });
}

// POST /api/plants — 個体登録。
// Request: { name(必須), species?, visibility?, notes?, origin_sowing_id? }
// origin_sowing_id は自分の播種記録のみ指せる（他人の sowing への昇格リンクを防ぐ）。
export async function handleCreatePlant(
  req: Request,
  sql: Sql,
  user: AuthedUser,
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return errorResponse('VALIDATION_ERROR', { publicMessage: 'JSON ボディが必要です。' });

  const name = asText(body.name, MAX_NAME_LEN);
  if (!name) {
    return errorResponse('VALIDATION_ERROR', {
      publicMessage: `name は必須です（${MAX_NAME_LEN}文字以内）。`,
    });
  }

  const parsed = parseOptionalPlantFields(body);
  if (!parsed.ok) return parsed.response;
  const { species, visibility, notes, traits, originSowingId } = parsed.value;

  if (originSowingId) {
    const own = await sql`
      select 1 from pollenia.sowings
      where id = ${originSowingId}::uuid and user_id = ${user.uid}::uuid
    `;
    if (own.length === 0) {
      return errorResponse('VALIDATION_ERROR', {
        publicMessage: 'origin_sowing_id が自分の播種記録ではありません。',
      });
    }
  }

  const rows = await sql`
    insert into pollenia.plants (user_id, name, species, visibility, notes, traits, origin_sowing_id)
    values (${user.uid}::uuid, ${name}, ${species}, ${visibility ?? 'private'},
            ${notes}, ${sql.json((traits ?? {}) as Record<string, string | number>)},
            ${originSowingId ? sql`${originSowingId}::uuid` : null})
    returning ${sql.unsafe(PLANT_COLS)}
  `;
  return json({ plant: rows[0] }, 201);
}

// GET /api/plants/:id — 個体詳細 + 写真。
// 所有者: 全フィールド。他人: canViewWithDb を通過した場合のみ公開向けサブセット。
// 不可視は 404（存在を秘匿。403 と使い分けない）。
export async function handleGetPlant(
  sql: Sql,
  signPhotos: PhotoSigner,
  user: AuthedUser,
  plantId: string,
): Promise<Response> {
  if (!isUuid(plantId)) return errorResponse('NOT_FOUND');

  const rows = await sql`
    select ${sql.unsafe(PLANT_COLS)}
    from pollenia.plants
    where id = ${plantId}::uuid and deleted_at is null
  `;
  if (rows.length === 0) return errorResponse('NOT_FOUND');
  const plant = rows[0];

  const isOwner = plant.user_id === user.uid;
  if (!isOwner) {
    const visible = await canViewWithDb(sql, user.uid, {
      ownerId: plant.user_id,
      visibility: plant.visibility as Visibility,
    });
    if (!visible) return errorResponse('NOT_FOUND');
  }

  const photos = await listPhotosWithUrls(sql, signPhotos, plantId);

  if (isOwner) return json({ plant, photos });
  // 他人向けサブセット（notes・origin_sowing_id 等の記録詳細は所有者のみ）。
  // traits は個体の特性（開花期・香り・サイズ等）で、可視性は plants の visibility に従う
  // 方針のため、canViewWithDb を通過した閲覧者には含める（name/species と同じ扱い）。
  return json({
    plant: {
      id: plant.id,
      user_id: plant.user_id,
      name: plant.name,
      species: plant.species,
      visibility: plant.visibility,
      traits: plant.traits,
      created_at: plant.created_at,
    },
    photos,
  });
}

// PATCH /api/plants/:id — 所有者のみ。name / species / visibility / notes / origin_sowing_id
export async function handleUpdatePlant(
  req: Request,
  sql: Sql,
  user: AuthedUser,
  plantId: string,
): Promise<Response> {
  if (!isUuid(plantId)) return errorResponse('NOT_FOUND');
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return errorResponse('VALIDATION_ERROR', { publicMessage: 'JSON ボディが必要です。' });

  const patch: Record<string, unknown> = {};

  if (body.name !== undefined) {
    const name = asText(body.name, MAX_NAME_LEN);
    if (!name) return errorResponse('VALIDATION_ERROR', { publicMessage: 'name が不正です。' });
    patch.name = name;
  }
  const parsed = parseOptionalPlantFields(body);
  if (!parsed.ok) return parsed.response;
  if (body.species !== undefined) patch.species = parsed.value.species;
  if (body.visibility !== undefined) patch.visibility = parsed.value.visibility;
  if (body.notes !== undefined) patch.notes = parsed.value.notes;
  if (body.traits !== undefined) {
    // sql.json で渡す（traits を丸ごと置換）。JSON.stringify 済み文字列を ${...}::jsonb に
    // 渡すと postgres.js が再度 JSON エンコードして jsonb が「文字列」になり、
    // 0004 の CHECK（jsonb_typeof='object'）に違反する（ローカル検証で確認）。
    // 値は parsePlantTraits で string|number のみに正規化済み（JSONValue へのキャストは安全）。
    patch.traits = sql.json((parsed.value.traits ?? {}) as Record<string, string | number>);
  }
  if (body.origin_sowing_id !== undefined) {
    const originSowingId = parsed.value.originSowingId;
    if (originSowingId) {
      const own = await sql`
        select 1 from pollenia.sowings
        where id = ${originSowingId}::uuid and user_id = ${user.uid}::uuid
      `;
      if (own.length === 0) {
        return errorResponse('VALIDATION_ERROR', {
          publicMessage: 'origin_sowing_id が自分の播種記録ではありません。',
        });
      }
    }
    patch.origin_sowing_id = originSowingId;
  }

  if (Object.keys(patch).length === 0) {
    return errorResponse('VALIDATION_ERROR', { publicMessage: '更新項目がありません。' });
  }

  const rows = await sql`
    update pollenia.plants set ${sql(patch)}
    where id = ${plantId}::uuid and user_id = ${user.uid}::uuid and deleted_at is null
    returning ${sql.unsafe(PLANT_COLS)}
  `;
  if (rows.length === 0) return errorResponse('NOT_FOUND');
  return json({ plant: rows[0] });
}

// DELETE /api/plants/:id — soft delete（deleted_at を立てるだけ。系統記録の保全のため物理削除しない）。
export async function handleDeletePlant(
  sql: Sql,
  user: AuthedUser,
  plantId: string,
): Promise<Response> {
  if (!isUuid(plantId)) return errorResponse('NOT_FOUND');
  const rows = await sql`
    update pollenia.plants set deleted_at = now()
    where id = ${plantId}::uuid and user_id = ${user.uid}::uuid and deleted_at is null
    returning id
  `;
  if (rows.length === 0) return errorResponse('NOT_FOUND');
  return json({ ok: true, id: rows[0].id });
}

// POST /api/plants/:id/photos — plant_photos 行作成 + アップロード先（PUT /api/photos/:id）の返却。
// Request: { content_type: 'image/jpeg'|'image/png'|'image/webp', caption?, taken_at? }
// Response: { photo: {...}, upload: { url, method: 'PUT', content_type } }
//   クライアントは upload.url に画像本体を PUT する（セッション必須・同じ content_type）。
//   行を先に作るため、アップロード失敗時は uploaded_at が null の行が残る（一覧には出ない。MVP 許容）。
export async function handleCreatePhoto(
  req: Request,
  sql: Sql,
  user: AuthedUser,
  plantId: string,
): Promise<Response> {
  if (!isUuid(plantId)) return errorResponse('NOT_FOUND');
  const own = await sql`
    select 1 from pollenia.plants
    where id = ${plantId}::uuid and user_id = ${user.uid}::uuid and deleted_at is null
  `;
  if (own.length === 0) return errorResponse('NOT_FOUND');

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const contentType = typeof body?.content_type === 'string' ? body.content_type : '';
  const ext = PHOTO_CONTENT_TYPES[contentType];
  if (!ext) {
    return errorResponse('VALIDATION_ERROR', {
      publicMessage: `content_type は ${Object.keys(PHOTO_CONTENT_TYPES).join(' | ')} のいずれか。`,
    });
  }
  const caption = body?.caption === undefined ? null : asText(body.caption, MAX_TEXT_LEN);
  if (body?.caption !== undefined && caption === null) {
    return errorResponse('VALIDATION_ERROR', { publicMessage: 'caption が不正です。' });
  }
  const takenAt = body?.taken_at === undefined ? null : asDateStr(body.taken_at);
  if (body?.taken_at !== undefined && takenAt === null) {
    return errorResponse('VALIDATION_ERROR', { publicMessage: 'taken_at は YYYY-MM-DD。' });
  }

  // パスは Worker が採番する（クライアント指定のパスを信用しない）。
  const storagePath = `${user.uid}/${plantId}/${crypto.randomUUID()}.${ext}`;

  const rows = await sql`
    insert into pollenia.plant_photos (plant_id, user_id, storage_path, caption, taken_at)
    values (${plantId}::uuid, ${user.uid}::uuid, ${storagePath}, ${caption}, ${takenAt})
    returning id, plant_id, storage_path, caption, taken_at, created_at
  `;
  const photo = rows[0];
  return json(
    {
      photo,
      upload: { url: `/api/photos/${photo.id}`, method: 'PUT', content_type: contentType },
    },
    201,
  );
}

// PUT /api/photos/:id — 画像本体を R2 に置く（1 行につき 1 回だけ）。
//   * 自分の行・未アップロード・個体が未削除のときだけ受け付ける（それ以外は 404）
//   * Content-Type は行の拡張子から決まる値と一致すること（R2 にはその値を保存し、配信時もそれだけを使う）
//   * 本文は PHOTO_MAX_BYTES まで（Content-Length と実際の長さの両方で確かめる）
// uploaded_at の更新は「null のときだけ」の条件付き UPDATE で行い、同時 PUT でも 1 回に絞る
// （R2 への put は条件付き UPDATE の後。失敗したら uploaded_at を戻して再試行できるようにする）。
export async function handleUploadPhoto(
  req: Request,
  env: Env,
  sql: Sql,
  user: AuthedUser,
  photoId: string,
): Promise<Response> {
  if (!isUuid(photoId)) return errorResponse('NOT_FOUND');

  // Content-Length 必須（chunked で上限を超える本文をメモリに読み込ませない。ブラウザの fetch は
  // File / Blob の本文に必ず付ける）
  const declared = Number(req.headers.get('content-length') ?? NaN);
  if (!Number.isFinite(declared) || declared <= 0 || declared > PHOTO_MAX_BYTES) {
    return errorResponse('VALIDATION_ERROR', {
      publicMessage: `画像は 1 バイト以上 ${PHOTO_MAX_BYTES / 1024 / 1024}MB までです（Content-Length が必要）。`,
    });
  }

  const claimed = await sql`
    update pollenia.plant_photos ph
    set uploaded_at = now()
    from pollenia.plants p
    where ph.id = ${photoId}::uuid
      and ph.user_id = ${user.uid}::uuid
      and ph.uploaded_at is null
      and p.id = ph.plant_id and p.deleted_at is null
    returning ph.storage_path
  `;
  if (claimed.length === 0) return errorResponse('NOT_FOUND');
  const storagePath = claimed[0].storage_path as string;

  const release = () => sql`
    update pollenia.plant_photos set uploaded_at = null where id = ${photoId}::uuid
  `;

  const ext = storagePath.slice(storagePath.lastIndexOf('.') + 1);
  const expectedType = Object.entries(PHOTO_CONTENT_TYPES).find(([, e]) => e === ext)?.[0];
  const sentType = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!expectedType || sentType !== expectedType) {
    await release();
    return errorResponse('VALIDATION_ERROR', {
      publicMessage: `Content-Type は ${expectedType ?? '登録時の形式'} で送ってください。`,
    });
  }

  const body = await req.arrayBuffer();
  if (body.byteLength === 0 || body.byteLength > PHOTO_MAX_BYTES) {
    await release();
    return errorResponse('VALIDATION_ERROR', {
      publicMessage: `画像は 1 バイト以上 ${PHOTO_MAX_BYTES / 1024 / 1024}MB までです。`,
    });
  }

  try {
    await env.PHOTOS.put(storagePath, body, { httpMetadata: { contentType: expectedType } });
  } catch (e) {
    await release();
    throw e;
  }
  return json({ ok: true, id: photoId });
}

// 写真一覧（アップロード済みのみ）に閲覧用の署名URLを添えて返す（storage_path は保存のみ、URL は都度発行）。
// 呼び出し側が個体の可視性判定を済ませてから呼ぶこと。
export async function listPhotosWithUrls(
  sql: Sql,
  signPhotos: PhotoSigner,
  plantId: string,
): Promise<unknown[]> {
  const photos = await sql`
    select id, plant_id, storage_path, caption, taken_at, created_at
    from pollenia.plant_photos
    where plant_id = ${plantId}::uuid and uploaded_at is not null
    order by created_at desc
  `;
  if (photos.length === 0) return [];

  const urlByPath = await signPhotos(photos.map((p) => p.storage_path));
  return photos.map((p) => ({ ...p, url: urlByPath.get(p.storage_path) ?? null }));
}

// name 以外の任意フィールドの共通パース（POST / PATCH で共用）。
function parseOptionalPlantFields(body: Record<string, unknown>):
  | {
      ok: true;
      value: {
        species: string | null;
        visibility: Visibility | null;
        notes: string | null;
        traits: Record<string, unknown> | null;
        originSowingId: string | null;
      };
    }
  | { ok: false; response: Response } {
  let species: string | null = null;
  if (body.species !== undefined && body.species !== null) {
    species = asText(body.species, MAX_NAME_LEN);
    if (!species) {
      return { ok: false, response: errorResponse('VALIDATION_ERROR', { publicMessage: 'species が不正です。' }) };
    }
  }

  let visibility: Visibility | null = null;
  if (body.visibility !== undefined) {
    visibility = asVisibility(body.visibility);
    if (!visibility) {
      return {
        ok: false,
        response: errorResponse('VALIDATION_ERROR', {
          publicMessage: 'visibility は public | followers | private。',
        }),
      };
    }
  }

  let notes: string | null = null;
  if (body.notes !== undefined && body.notes !== null) {
    notes = asText(body.notes, MAX_TEXT_LEN);
    if (!notes) {
      return { ok: false, response: errorResponse('VALIDATION_ERROR', { publicMessage: 'notes が不正です。' }) };
    }
  }

  // traits: 未指定なら null（呼び出し側で「触らない / 既定 {}」に振り分ける）。
  // 指定時は既知キーのみに正規化し、空欄キーは落とす（lib/traits.ts）。
  let traits: Record<string, unknown> | null = null;
  if (body.traits !== undefined) {
    const parsed = parsePlantTraits(body.traits);
    if (!parsed.ok) {
      return {
        ok: false,
        response: errorResponse('VALIDATION_ERROR', { publicMessage: parsed.message }),
      };
    }
    traits = parsed.value;
  }

  let originSowingId: string | null = null;
  if (body.origin_sowing_id !== undefined && body.origin_sowing_id !== null) {
    if (!isUuid(body.origin_sowing_id)) {
      return {
        ok: false,
        response: errorResponse('VALIDATION_ERROR', { publicMessage: 'origin_sowing_id が不正です。' }),
      };
    }
    originSowingId = body.origin_sowing_id;
  }

  return { ok: true, value: { species, visibility, notes, traits, originSowingId } };
}
