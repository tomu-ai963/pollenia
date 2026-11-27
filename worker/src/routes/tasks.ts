import { uuidArrayLiteral, type Sql } from '../lib/db';
import { json } from '../lib/http';
import { errorResponse } from '../lib/error-response';
import type { AuthedUser } from '../lib/auth';
import { asDateStr, isUuid } from '../lib/validate';
import { buildTasks, TASK_KINDS, type Task, type TaskKind, type TaskSource } from '../lib/tasks';
import { TASKS_MAX_PER_KIND } from '../constants';

// 「次の作業」一覧 API（0004_next_tasks.sql）。交配・採種・播種は所有者のみのデータなので、
// すべてのクエリを検証済み uid で絞る。日付は ::text で YYYY-MM-DD のまま返す
// （postgres.js は date を Date＝日時にしてしまう）。
//
// - GET   /api/tasks              … 作業の一覧
// - PATCH /api/tasks/:kind/:id    … 予定日・種の使用期限の設定、一覧から外す / 戻す

// GET /api/tasks
export async function handleListTasks(sql: Sql, user: AuthedUser): Promise<Response> {
  return json({ tasks: await loadTasksFor(sql, user.uid) });
}

// 利用者 1 人分の作業（週1メール scheduled.ts からも使う）。uid は検証済みのもの（セッションか cron の対象）
export async function loadTasksFor(sql: Sql, uid: string): Promise<Task[]> {
  const [harvest, sow, germination] = await Promise.all([
    sql`
      select 'harvest' as kind, c.id as record_id, c.id as crossing_id,
             c.seed_parent_id, c.pollen_parent_id,
             c.cross_date::text as since_date, c.expected_harvest_date::text as planned_date,
             null::text as sow_by_date, null::int as count, null::text as first_germination_date
      from pollenia.crossings c
      where c.user_id = ${uid}::uuid and c.task_dismissed_at is null
        and not exists (
          select 1 from pollenia.seed_harvests h
          where h.crossing_id = c.id and h.user_id = ${uid}::uuid
        )
      order by c.created_at desc
      limit ${TASKS_MAX_PER_KIND}
    `,
    sql`
      select 'sow' as kind, h.id as record_id, c.id as crossing_id,
             c.seed_parent_id, c.pollen_parent_id,
             h.harvest_date::text as since_date, h.planned_sowing_date::text as planned_date,
             h.sow_by_date::text as sow_by_date, h.seed_count as count,
             null::text as first_germination_date
      from pollenia.seed_harvests h
      join pollenia.crossings c on c.id = h.crossing_id and c.user_id = ${uid}::uuid
      where h.user_id = ${uid}::uuid and h.task_dismissed_at is null
        and not exists (
          select 1 from pollenia.sowings s
          where s.seed_harvest_id = h.id and s.user_id = ${uid}::uuid
        )
      order by h.created_at desc
      limit ${TASKS_MAX_PER_KIND}
    `,
    sql`
      select 'germination' as kind, s.id as record_id, c.id as crossing_id,
             c.seed_parent_id, c.pollen_parent_id,
             s.sowing_date::text as since_date, s.expected_germination_date::text as planned_date,
             null::text as sow_by_date, s.sowing_count as count,
             s.first_germination_date::text as first_germination_date
      from pollenia.sowings s
      join pollenia.seed_harvests h on h.id = s.seed_harvest_id and h.user_id = ${uid}::uuid
      join pollenia.crossings c on c.id = h.crossing_id and c.user_id = ${uid}::uuid
      where s.user_id = ${uid}::uuid and s.task_dismissed_at is null
        and s.germination_count is null
      order by s.created_at desc
      limit ${TASKS_MAX_PER_KIND}
    `,
  ]);
  const sources = [...harvest, ...sow, ...germination] as unknown as TaskSource[];

  const parentIds = [
    ...new Set(sources.flatMap((s) => [s.seed_parent_id, s.pollen_parent_id]).filter((x): x is string => !!x)),
  ];
  const plants = parentIds.length
    ? await sql`
        select id, name from pollenia.plants
        where id = any(${uuidArrayLiteral(parentIds)}::uuid[]) and user_id = ${uid}::uuid
      `
    : [];
  const names = new Map(plants.map((p) => [p.id as string, p.name as string]));
  return buildTasks(sources, names);
}

function isTaskKind(v: string): v is TaskKind {
  return (TASK_KINDS as readonly string[]).includes(v);
}

// 日付の項目: 未指定 → 触らない / null → 消す / YYYY-MM-DD → 設定。それ以外は不正。
function parseDateField(body: Record<string, unknown>, key: string): { ok: boolean; set: boolean; value: string | null } {
  if (body[key] === undefined) return { ok: true, set: false, value: null };
  if (body[key] === null) return { ok: true, set: true, value: null };
  const v = asDateStr(body[key]);
  return v ? { ok: true, set: true, value: v } : { ok: false, set: false, value: null };
}

// PATCH /api/tasks/:kind/:id
// Request: { due_date?: date|null, sow_by_date?: date|null（sow のみ）, dismissed?: boolean }
export async function handleUpdateTask(
  req: Request,
  sql: Sql,
  user: AuthedUser,
  kind: string,
  recordId: string,
): Promise<Response> {
  if (!isTaskKind(kind) || !isUuid(recordId)) return errorResponse('NOT_FOUND');
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return errorResponse('VALIDATION_ERROR', { publicMessage: 'JSON ボディが必要です。' });

  const due = parseDateField(body, 'due_date');
  if (!due.ok) return errorResponse('VALIDATION_ERROR', { publicMessage: 'due_date は YYYY-MM-DD で指定してください。' });
  const sowBy = parseDateField(body, 'sow_by_date');
  if (!sowBy.ok) {
    return errorResponse('VALIDATION_ERROR', { publicMessage: 'sow_by_date は YYYY-MM-DD で指定してください。' });
  }
  if (sowBy.set && kind !== 'sow') {
    return errorResponse('VALIDATION_ERROR', { publicMessage: '種の使用期限は播種の作業にだけ設定できます。' });
  }
  if (body.dismissed !== undefined && typeof body.dismissed !== 'boolean') {
    return errorResponse('VALIDATION_ERROR', { publicMessage: 'dismissed は true / false で指定してください。' });
  }

  const dueColumn = {
    harvest: 'expected_harvest_date',
    sow: 'planned_sowing_date',
    germination: 'expected_germination_date',
  }[kind];
  const patch: Record<string, unknown> = {};
  if (due.set) patch[dueColumn] = due.value;
  if (sowBy.set) patch.sow_by_date = sowBy.value;
  if (body.dismissed !== undefined) patch.task_dismissed_at = body.dismissed ? new Date() : null;
  if (Object.keys(patch).length === 0) {
    return errorResponse('VALIDATION_ERROR', { publicMessage: '更新項目がありません。' });
  }

  // 表名は kind から固定の文字列で選ぶ（利用者の入力を識別子に使わない）
  const rows =
    kind === 'harvest'
      ? await sql`
          update pollenia.crossings set ${sql(patch)}
          where id = ${recordId}::uuid and user_id = ${user.uid}::uuid
          returning id
        `
      : kind === 'sow'
        ? await sql`
            update pollenia.seed_harvests set ${sql(patch)}
            where id = ${recordId}::uuid and user_id = ${user.uid}::uuid
            returning id
          `
        : await sql`
            update pollenia.sowings set ${sql(patch)}
            where id = ${recordId}::uuid and user_id = ${user.uid}::uuid
            returning id
          `;
  if (rows.length === 0) return errorResponse('NOT_FOUND');
  return json({ ok: true, kind, id: rows[0].id });
}
