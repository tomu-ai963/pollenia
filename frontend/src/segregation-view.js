// 形質の分離（記録タブ・有料）。GET /api/analytics/segregation の表示。
// 名前・値は利用者の入力なので textContent で描く。
import { api, ApiError } from './api.js';

const $ = (id) => document.getElementById(id);

/** 1 項目の要約（「ピンク 5・白 3（8本）」「45〜90 cm・平均 70.2（6本）」） */
export function statText(s) {
  if (s.type === 'number') {
    const unit = s.unit ? ` ${s.unit}` : '';
    const range = s.min === s.max ? `${s.min}${unit}` : `${s.min}〜${s.max}${unit}`;
    return `${range}・平均 ${s.avg}（${s.recorded}本）`;
  }
  return `${s.counts.map((c) => `${c.value} ${c.n}`).join('・')}（${s.recorded}本）`;
}

function parentLine(role, p) {
  const div = document.createElement('div');
  div.className = 'meta';
  div.textContent = p
    ? `${role}: ${p.name}${p.traits.length ? `（${p.traits.map((t) => `${t.label} ${t.text}`).join('・')}）` : ''}`
    : `${role}: 不明`;
  return div;
}

function crossingBlock(c) {
  const box = document.createElement('div');
  box.className = 'seg-crossing';
  const title = document.createElement('strong');
  const seed = c.seed_parent?.name ?? '?';
  title.textContent = `${c.self ? `${seed} 🌼 自家受粉` : `${seed} × ${c.pollen_parent?.name ?? '（父不明）'}`}　子 ${c.offspring} 本`;
  box.appendChild(title);
  if (c.cross_date) {
    const d = document.createElement('span');
    d.className = 'meta';
    d.textContent = `　${c.cross_date}`;
    title.after(d);
  }
  box.appendChild(parentLine('母', c.seed_parent));
  if (!c.self) box.appendChild(parentLine('父', c.pollen_parent));
  const table = document.createElement('dl');
  table.className = 'seg-table';
  if (c.traits.length === 0) {
    const p = document.createElement('p');
    p.className = 'notice';
    p.textContent = '子の特性がまだ記録されていません。';
    box.appendChild(p);
  }
  for (const s of c.traits) {
    const dt = document.createElement('dt');
    dt.textContent = s.label;
    const dd = document.createElement('dd');
    dd.textContent = statText(s);
    table.append(dt, dd);
  }
  if (c.traits.length) box.appendChild(table);
  return box;
}

export async function loadSegregation(subscribed) {
  $('seg-error').textContent = '';
  $('seg-locked').classList.toggle('hidden', subscribed);
  $('seg-list').replaceChildren();
  $('seg-empty').classList.add('hidden');
  if (!subscribed) return;
  try {
    const { crossings } = await api.segregation();
    $('seg-list').replaceChildren(...crossings.map(crossingBlock));
    $('seg-empty').classList.toggle('hidden', crossings.length > 0);
  } catch (e) {
    if (e instanceof ApiError && e.status === 402) {
      $('seg-locked').classList.remove('hidden');
      return;
    }
    $('seg-error').textContent = e instanceof ApiError ? `${e.message}（${e.code}）` : String(e.message ?? e);
  }
}
