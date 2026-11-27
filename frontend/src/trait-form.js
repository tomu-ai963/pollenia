// 特性の入力欄（個体の登録・編集フォーム）。ジャンルに応じて trait-spec.js の項目から作る。
import { GENRES, traitsForGenre } from './trait-spec.js';

/** ジャンルの選択肢を入れる（先頭は「未設定」= その他と同じ項目） */
export function fillGenreSelect(select) {
  select.replaceChildren();
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '未設定';
  select.appendChild(none);
  for (const g of GENRES) {
    const o = document.createElement('option');
    o.value = g.value;
    o.textContent = g.label;
    select.appendChild(o);
  }
}

/** ジャンルの項目で入力欄を作り直す。values は今の値（編集のとき） */
export function renderTraitFields(container, genre, values = {}) {
  container.replaceChildren();
  for (const spec of traitsForGenre(genre)) {
    const wrap = document.createElement('div');
    const label = document.createElement('label');
    label.textContent = spec.unit && spec.unit !== '/ 5' ? `${spec.label}（${spec.unit}）` : spec.label;
    let input;
    if (spec.type === 'enum') {
      input = document.createElement('select');
      const none = document.createElement('option');
      none.value = '';
      none.textContent = '未選択';
      input.appendChild(none);
      for (const o of spec.values) {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        input.appendChild(opt);
      }
    } else if (spec.type === 'int' && spec.max - spec.min <= 10) {
      // 0〜5 のような小さい範囲は選択式
      input = document.createElement('select');
      const none = document.createElement('option');
      none.value = '';
      none.textContent = '未選択';
      input.appendChild(none);
      for (let i = spec.min; i <= spec.max; i++) {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = String(i);
        input.appendChild(opt);
      }
    } else {
      input = document.createElement('input');
      if (spec.type === 'text') {
        input.maxLength = spec.max;
      } else {
        input.type = 'number';
        input.min = String(spec.type === 'int' ? spec.min : 0);
        input.max = String(spec.max);
        input.step = spec.type === 'int' ? '1' : '0.1';
        input.inputMode = spec.type === 'int' ? 'numeric' : 'decimal';
      }
    }
    input.dataset.trait = spec.key;
    input.dataset.type = spec.type;
    const v = values?.[spec.key];
    input.value = v === undefined || v === null ? '' : String(v);
    label.htmlFor = input.id = `${container.id}-${spec.key}`;
    wrap.append(label, input);
    container.appendChild(wrap);
  }
}

/**
 * 入力欄 → traits。空欄はキーごと入れない。
 * keep: 今のジャンルで出していない項目の値（ジャンルを変えても、入力済みの値を消さない）
 */
export function readTraitFields(container, keep = {}) {
  const shown = new Set();
  const traits = {};
  for (const el of container.querySelectorAll('[data-trait]')) {
    const key = el.dataset.trait;
    shown.add(key);
    const raw = el.value.trim();
    if (raw === '') continue;
    traits[key] = el.dataset.type === 'int' || el.dataset.type === 'number' ? Number(raw) : raw;
  }
  for (const [k, v] of Object.entries(keep ?? {})) {
    if (!shown.has(k) && v !== null && v !== undefined) traits[k] = v;
  }
  return traits;
}
