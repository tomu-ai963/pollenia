// 発芽率の集計（記録タブ）。交配ごとは無料、親ごとの比較は有料プラン。
// 名前は利用者の入力なので、すべて textContent で描く。
import { api, ApiError } from './api.js';

const $ = (id) => document.getElementById(id);

/** 0〜1 の率 → 「67%」。記録が無い（null）は「—」 */
export function formatRate(rate) {
  return rate === null || rate === undefined ? '—' : `${Math.round(rate * 100)}%`;
}

/** 交配の表示名（app.js の交配一覧と同じ書き方） */
export function crossingLabel(c) {
  const seed = c.seed_parent_name ?? '?';
  if (c.pollen_parent_id && c.pollen_parent_id === c.seed_parent_id) return `${seed} 🌼 自家受粉`;
  return `${seed} × ${c.pollen_parent_name ?? '（父不明）'}`;
}

/** 集計 1 件の補足（「20粒中15本・発芽まで平均12日・未記録1件」） */
export function statsDetail(s) {
  const parts = [];
  if (s.sown > 0) parts.push(`${s.sown}粒中${s.germinated}本`);
  if (s.avg_days_to_germination !== null) parts.push(`発芽まで平均${s.avg_days_to_germination}日`);
  if (s.pending_sowings > 0) parts.push(`発芽未記録${s.pending_sowings}件`);
  return parts.join('・');
}

function rateRow(label, stats) {
  const row = document.createElement('div');
  row.className = 'germ-row';
  const head = document.createElement('div');
  head.className = 'germ-head';
  const name = document.createElement('span');
  name.textContent = label;
  const rate = document.createElement('strong');
  rate.textContent = formatRate(stats.rate);
  head.append(name, rate);
  const bar = document.createElement('div');
  bar.className = 'germ-bar';
  const fill = document.createElement('span');
  fill.style.width = `${Math.round((stats.rate ?? 0) * 100)}%`;
  bar.appendChild(fill);
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = statsDetail(stats);
  row.append(head, bar, meta);
  return row;
}

let deps = { isSubscribed: () => false, switchTab: () => {} };

export function initGermination(d) {
  deps = d;
  $('btn-germ-to-plan').onclick = () => deps.switchTab('ai');
}

function setError(err) {
  $('germ-error').textContent = err
    ? err instanceof ApiError
      ? `${err.message}（${err.code}）`
      : String(err.message ?? err)
    : '';
}

export async function loadGermination() {
  setError(null);
  try {
    const { overall, crossings } = await api.germination();
    $('germ-overall').textContent =
      overall.sowings === 0
        ? 'まだ播種の記録がありません。交配記録一覧の「播種を記録」「発芽を記録」から入力すると、ここに発芽率が出ます。'
        : `全体: ${formatRate(overall.rate)}（${statsDetail(overall) || '発芽数の記録待ち'}）`;
    const list = $('germ-crossings');
    list.replaceChildren(...crossings.map((c) => rateRow(crossingLabel(c), c)));
    await loadParents(overall.sowings > 0);
  } catch (e) {
    setError(e);
  }
}

async function loadParents(hasData) {
  const list = $('germ-parents');
  list.replaceChildren();
  const subscribed = deps.isSubscribed();
  $('germ-parents-locked').classList.toggle('hidden', subscribed);
  if (!subscribed || !hasData) return;
  try {
    const { parents } = await api.germinationParents();
    for (const p of parents) {
      const name = p.name ?? '（削除した個体）';
      if (p.as_seed) list.appendChild(rateRow(`${name}（母木として）`, p.as_seed));
      if (p.as_pollen) list.appendChild(rateRow(`${name}（花粉親として）`, p.as_pollen));
    }
  } catch (e) {
    // 加入状態が画面の表示とずれていた（解約直後など）→ 案内を出す
    if (e instanceof ApiError && e.status === 402) {
      $('germ-parents-locked').classList.remove('hidden');
      return;
    }
    setError(e);
  }
}
