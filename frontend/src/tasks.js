// 「次の作業」（記録タブの一番上）。作業は記録の状態から Worker が導く（GET /api/tasks）。
// ここでは予定日・種の使用期限を付けたり、一覧から外したり、その場で記録したりする。
// 名前は利用者の入力なので、すべて textContent で描く。
import { api, ApiError } from './api.js';
import { localToday, recordGermination, recordHarvest, recordSowing } from './record-actions.js';

const $ = (id) => document.getElementById(id);

/** YYYY-MM-DD 同士の日数の差（b - a） */
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** 期日の状態: overdue（過ぎた）/ soon（7日以内）/ later / null（期日なし） */
export function dueStatus(due, today) {
  if (!due) return null;
  const d = daysBetween(today, due);
  return d < 0 ? 'overdue' : d <= 7 ? 'soon' : 'later';
}

/** 期日の表示（「今日」「あと3日」「5日過ぎ」） */
export function dueLabel(due, today) {
  const d = daysBetween(today, due);
  if (d === 0) return '今日';
  return d > 0 ? `あと${d}日` : `${-d}日過ぎ`;
}

const KIND_LABEL = { harvest: '採種', sow: '播種', germination: '発芽の確認' };
const SINCE_LABEL = { harvest: '交配から', sow: '採種から', germination: 'まいてから' };

/** 作業の見出し（「採種: A × B」「播種: A × （父不明）（50粒）」） */
export function taskTitle(t) {
  const seed = t.seed_parent_name ?? '?';
  const pair =
    t.pollen_parent_id && t.pollen_parent_id === t.seed_parent_id
      ? `${seed} 🌼 自家受粉`
      : `${seed} × ${t.pollen_parent_name ?? '（父不明）'}`;
  const count = t.count === null || t.count === undefined ? '' : `（${t.count}粒）`;
  return `${KIND_LABEL[t.kind]}: ${pair}${count}`;
}

let deps = { onRecorded: async () => {} };

export function initTasks(d) {
  deps = d;
}

function setError(err) {
  $('tasks-error').textContent = err
    ? err instanceof ApiError
      ? `${err.message}（${err.code}）`
      : String(err.message ?? err)
    : '';
}

async function run(fn) {
  setError(null);
  try {
    await fn();
  } catch (e) {
    setError(e);
  }
}

function dateField(labelText, value, onChange) {
  const wrap = document.createElement('label');
  wrap.className = 'task-date';
  const span = document.createElement('span');
  span.textContent = labelText;
  const input = document.createElement('input');
  input.type = 'date';
  input.value = value ?? '';
  input.onchange = () => run(() => onChange(input.value || null));
  wrap.append(span, input);
  return wrap;
}

function taskItem(t, today) {
  const item = document.createElement('div');
  const status = dueStatus(t.due_date, today);
  item.className = `task-item${status ? ` ${status}` : ''}`;

  const title = document.createElement('strong');
  title.textContent = taskTitle(t);
  const meta = document.createElement('div');
  meta.className = 'meta';
  const parts = [];
  if (t.due_date) parts.push(`期日 ${t.due_date}（${dueLabel(t.due_date, today)}）`);
  if (t.since_date) parts.push(`${SINCE_LABEL[t.kind]}${Math.max(0, daysBetween(t.since_date, today))}日`);
  if (t.sow_by_date && t.sow_by_date !== t.due_date) parts.push(`種の期限 ${t.sow_by_date}`);
  meta.textContent = parts.join('・') || '予定日を入れると、期日の近い順に並びます';

  const controls = document.createElement('div');
  controls.className = 'task-controls';
  const record = document.createElement('button');
  record.className = 'small';
  record.textContent = { harvest: '採種を記録', sow: '播種を記録', germination: '発芽を記録' }[t.kind];
  record.onclick = () =>
    run(async () => {
      const done =
        t.kind === 'harvest'
          ? await recordHarvest(t.record_id)
          : t.kind === 'sow'
            ? await recordSowing(t.record_id)
            : await recordGermination({
                id: t.record_id,
                sowing_date: t.since_date,
                sowing_count: t.count,
                germination_count: null,
                first_germination_date: t.first_germination_date,
              });
      if (done) await deps.onRecorded(); // 記録が増えると、この作業は一覧から消える
    });
  controls.appendChild(record);

  controls.appendChild(
    dateField('予定日', t.planned_date, async (v) => {
      await api.updateTask(t.kind, t.record_id, { due_date: v });
      await loadTasks();
    }),
  );
  if (t.kind === 'sow') {
    controls.appendChild(
      dateField('種の期限', t.sow_by_date, async (v) => {
        await api.updateTask(t.kind, t.record_id, { sow_by_date: v });
        await loadTasks();
      }),
    );
  }

  const dismiss = document.createElement('button');
  dismiss.className = 'small ghost';
  dismiss.textContent = '外す';
  dismiss.onclick = () =>
    run(async () => {
      // 結実しなかった交配・まかない種など。記録そのものは消さない
      if (!confirm(`「${taskTitle(t)}」を次の作業から外しますか？（記録は残ります）`)) return;
      await api.updateTask(t.kind, t.record_id, { dismissed: true });
      await loadTasks();
    });
  controls.appendChild(dismiss);

  item.append(title, meta, controls);
  return item;
}

export async function loadTasks() {
  setError(null);
  try {
    const { tasks } = await api.tasks();
    const today = localToday();
    const list = $('task-list');
    list.replaceChildren(...tasks.map((t) => taskItem(t, today)));
    const overdue = tasks.filter((t) => dueStatus(t.due_date, today) === 'overdue').length;
    $('tasks-summary').textContent =
      tasks.length === 0
        ? 'いまやる作業はありません。交配を記録すると、採種・播種・発芽の確認がここに順番に出ます。'
        : `${tasks.length}件${overdue ? `（期日を過ぎたもの ${overdue}件）` : ''}`;
    // タブにも期日を過ぎた件数を出す（記録タブを開かなくても気づけるように）
    $('tabbtn-records').textContent = overdue ? `記録（${overdue}）` : '記録';
  } catch (e) {
    setError(e);
  }
}
