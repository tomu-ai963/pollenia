import type { Sql } from '../lib/db';
import { json } from '../lib/http';
import { errorResponse } from '../lib/error-response';
import type { AuthedUser } from '../lib/auth';
import { IMPORT_MAX_ROWS, planImport, type ImportRow } from '../lib/import-plan';

// POST /api/import/plants?dry_run=1 — 過去の記録（CSV を画面で読んだ行）を取り込む。
// Request: { rows: ImportRow[] }（最大 IMPORT_MAX_ROWS 行）
// - dry_run=1: 書き込まずに、作るもの（個体・自動で作る親・交配）の一覧かエラーを返す（画面のプレビュー用）
// - それ以外: 1 つのトランザクションで全部作る（途中で失敗したら何も残らない）
// 作る個体はすべて private・ギャラリーに載せない。親の参照は自分の未削除の個体だけ（他人の個体は探さない）。

const IMPORT_NOTE = 'CSV から取り込み';

export async function handleImportPlants(req: Request, sql: Sql, user: AuthedUser): Promise<Response> {
  const dryRun = new URL(req.url).searchParams.get('dry_run') === '1';
  const body = (await req.json().catch(() => null)) as { rows?: unknown } | null;
  if (!body || !Array.isArray(body.rows)) {
    return errorResponse('VALIDATION_ERROR', { publicMessage: 'rows（配列）が必要です。' });
  }
  if (body.rows.length > IMPORT_MAX_ROWS) {
    return errorResponse('VALIDATION_ERROR', {
      publicMessage: `一度に取り込めるのは ${IMPORT_MAX_ROWS} 行までです。`,
    });
  }
  const rows = body.rows.map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? r : {})) as ImportRow[];

  const existing = await sql`
    select id, name from pollenia.plants
    where user_id = ${user.uid}::uuid and deleted_at is null
  `;
  const result = planImport(
    rows,
    existing.map((p) => ({ id: p.id as string, name: p.name as string })),
  );
  if (!result.ok) return json({ ok: false, errors: result.errors }, 422);
  const { plan } = result;

  const summary = {
    plants: plan.plants.filter((p) => p.row !== null).length,
    auto_parents: plan.plants.filter((p) => p.row === null).map((p) => p.name),
    crossings: plan.crossings.length,
  };
  if (dryRun) return json({ ok: true, dry_run: true, summary });

  await sql.begin(async (tx) => {
    const idByKey = new Map<string, string>();
    for (const e of existing) idByKey.set(`existing:${e.id}`, e.id as string);

    for (const p of plan.plants) {
      const [row] = await tx`
        insert into pollenia.plants (user_id, name, species, genre, visibility, notes, traits)
        values (${user.uid}::uuid, ${p.name}, ${p.species}, ${p.genre}, 'private', ${p.notes},
                ${tx.json(p.traits as Record<string, string | number>)})
        returning id
      `;
      idByKey.set(p.key, row.id as string);
    }

    // 交配 → 採種 → 播種 を作り、子の個体を播種につなぐ（系統樹は plants.origin_sowing_id をたどる）
    for (const c of plan.crossings) {
      const seedId = idByKey.get(c.seedKey)!;
      const pollenId = c.pollenKey ? idByKey.get(c.pollenKey)! : null;
      const [crossing] = await tx`
        insert into pollenia.crossings (user_id, seed_parent_id, pollen_parent_id, cross_date, notes)
        values (${user.uid}::uuid, ${seedId}::uuid, ${pollenId}, ${c.crossDate}, ${IMPORT_NOTE})
        returning id
      `;
      const [harvest] = await tx`
        insert into pollenia.seed_harvests (user_id, crossing_id, notes, task_dismissed_at)
        values (${user.uid}::uuid, ${crossing.id}::uuid, ${IMPORT_NOTE}, now())
        returning id
      `;
      const [sowing] = await tx`
        insert into pollenia.sowings (user_id, seed_harvest_id, notes, task_dismissed_at)
        values (${user.uid}::uuid, ${harvest.id}::uuid, ${IMPORT_NOTE}, now())
        returning id
      `;
      for (const childKey of c.childKeys) {
        await tx`
          update pollenia.plants set origin_sowing_id = ${sowing.id}::uuid
          where id = ${idByKey.get(childKey)!}::uuid and user_id = ${user.uid}::uuid
        `;
      }
    }
  });

  return json({ ok: true, dry_run: false, summary }, 201);
}
