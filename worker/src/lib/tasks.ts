// 「次の作業」の組み立て（routes/tasks.ts から使う。DB に依存しない部分）。
//
// 作業は記録の状態から導く（0004_next_tasks.sql）:
//   harvest     … 交配して採種がまだ
//   sow         … 採種して播種がまだ
//   germination … 播種して発芽数が未記録
//
// 並び順: 期日のあるものを期日の早い順に先へ、期日の無いものは起点の日（交配日・採種日・播種日）が
// 古い順に後ろへ。期日が過ぎたかどうかは利用者の暦（タイムゾーン）で決まるので、画面側で判定する。

export type TaskKind = 'harvest' | 'sow' | 'germination';
export const TASK_KINDS: readonly TaskKind[] = ['harvest', 'sow', 'germination'];

export interface TaskSource {
  kind: TaskKind;
  /** 作業の元になる記録の ID（harvest → crossings.id / sow → seed_harvests.id / germination → sowings.id） */
  record_id: string;
  crossing_id: string;
  seed_parent_id: string;
  pollen_parent_id: string | null;
  /** 起点の日（YYYY-MM-DD）。交配日・採種日・播種日 */
  since_date: string | null;
  /** 利用者が付けた予定日 */
  planned_date: string | null;
  /** 種の使用期限（sow のみ） */
  sow_by_date: string | null;
  /** 採種数（sow）・播種数（germination） */
  count: number | null;
  /** 記録済みの初発芽日（germination のみ。発芽を記録するとき上書きしないため） */
  first_germination_date: string | null;
}

export interface Task extends TaskSource {
  seed_parent_name: string | null;
  pollen_parent_name: string | null;
  /** 期日 = 予定日と種の使用期限のうち早いほう（どちらも無ければ null） */
  due_date: string | null;
}

/** YYYY-MM-DD 同士は文字列の比較で日付の前後になる */
function earlier(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

export function buildTasks(sources: readonly TaskSource[], names: ReadonlyMap<string, string>): Task[] {
  const tasks: Task[] = sources.map((s) => ({
    ...s,
    seed_parent_name: names.get(s.seed_parent_id) ?? null,
    pollen_parent_name: s.pollen_parent_id ? (names.get(s.pollen_parent_id) ?? null) : null,
    due_date: earlier(s.planned_date, s.sow_by_date),
  }));
  return tasks.sort((a, b) => {
    if (a.due_date && b.due_date) return a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0;
    if (a.due_date) return -1;
    if (b.due_date) return 1;
    // 期日なし: 起点の日が古いもの（長く放っておかれているもの）から。起点の日も無いものは最後
    if (a.since_date && b.since_date) return a.since_date < b.since_date ? -1 : a.since_date > b.since_date ? 1 : 0;
    if (a.since_date) return -1;
    if (b.since_date) return 1;
    return 0;
  });
}
