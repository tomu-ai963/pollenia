// 発芽率の集計（GET /api/analytics/germination*）。DB から引いた播種行を Worker 内で集計する。
//
// 数え方:
// - 発芽率の分母・分子に入れるのは「播種数 > 0 かつ 発芽数が記録済み」の播種だけ。
//   発芽数が未記録の播種は、まだ結果が出ていないもの（pending_sowings）として別に数える
//   （0 発芽として数えると、まいたばかりの交配の発芽率が不当に低く出る）
// - 発芽数が播種数を超える入力は、播種数で頭打ちにする（率が 100% を超えない）
// - 発芽までの日数は、播種日・初発芽日がどちらもあり、0 日以上のものの平均

export interface SowingForStats {
  sowing_count: number | null;
  germination_count: number | null;
  /** first_germination_date - sowing_date（SQL の date 同士の差。どちらか無ければ null） */
  days_to_germination: number | null;
}

export interface GerminationStats {
  /** 播種の記録数（発芽が未記録のものを含む） */
  sowings: number;
  /** 発芽数が未記録の播種の数 */
  pending_sowings: number;
  /** 発芽率の分母（記録済みの播種の播種数の合計） */
  sown: number;
  /** 発芽率の分子 */
  germinated: number;
  /** germinated / sown（0〜1）。記録済みの播種が無ければ null */
  rate: number | null;
  /** 播種から初発芽までの平均日数（小数1桁）。データが無ければ null */
  avg_days_to_germination: number | null;
}

export function summarizeSowings(rows: readonly SowingForStats[]): GerminationStats {
  let pending = 0;
  let sown = 0;
  let germinated = 0;
  let daysSum = 0;
  let daysN = 0;
  for (const r of rows) {
    const s = r.sowing_count;
    const g = r.germination_count;
    if (g === null || g === undefined) {
      pending++;
    } else if (s !== null && s !== undefined && s > 0) {
      sown += s;
      germinated += Math.min(g, s);
    }
    const d = r.days_to_germination;
    if (d !== null && d !== undefined && d >= 0) {
      daysSum += d;
      daysN++;
    }
  }
  return {
    sowings: rows.length,
    pending_sowings: pending,
    sown,
    germinated,
    rate: sown > 0 ? germinated / sown : null,
    avg_days_to_germination: daysN > 0 ? Math.round((daysSum / daysN) * 10) / 10 : null,
  };
}

export interface SowingWithParents extends SowingForStats {
  crossing_id: string;
  seed_parent_id: string;
  pollen_parent_id: string | null;
}

/** 交配ごとにまとめる（行の順序を保つ。最初に現れた交配から並ぶ） */
export function groupByCrossing(rows: readonly SowingWithParents[]): Map<string, SowingWithParents[]> {
  const map = new Map<string, SowingWithParents[]>();
  for (const r of rows) {
    const list = map.get(r.crossing_id);
    if (list) list.push(r);
    else map.set(r.crossing_id, [r]);
  }
  return map;
}

export interface ParentStats {
  plant_id: string;
  /** 母木（種子親）としての交配の成績 */
  as_seed: GerminationStats | null;
  /** 花粉親としての交配の成績（自家受粉は母木・花粉親の両方に入る） */
  as_pollen: GerminationStats | null;
}

/** 親個体ごとにまとめる。父不明（pollen_parent_id = null）の交配は母木側にだけ入る */
export function groupByParent(rows: readonly SowingWithParents[]): ParentStats[] {
  const seed = new Map<string, SowingWithParents[]>();
  const pollen = new Map<string, SowingWithParents[]>();
  const push = (m: Map<string, SowingWithParents[]>, k: string, r: SowingWithParents) => {
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  };
  for (const r of rows) {
    push(seed, r.seed_parent_id, r);
    if (r.pollen_parent_id) push(pollen, r.pollen_parent_id, r);
  }
  const ids = new Set([...seed.keys(), ...pollen.keys()]);
  const out: ParentStats[] = [];
  for (const id of ids) {
    const s = seed.get(id);
    const p = pollen.get(id);
    out.push({
      plant_id: id,
      as_seed: s ? summarizeSowings(s) : null,
      as_pollen: p ? summarizeSowings(p) : null,
    });
  }
  // 記録済みの播種数が多い親から（比べる意味のある親が上に来る）
  const weight = (x: ParentStats) => (x.as_seed?.sown ?? 0) + (x.as_pollen?.sown ?? 0);
  return out.sort((a, b) => weight(b) - weight(a));
}
