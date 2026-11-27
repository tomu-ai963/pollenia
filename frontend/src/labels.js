// QR ラベル印刷ページ（labels.html）。
// 自分の個体を選んで、直リンク（/?plant=<id>）の QR + 名前を並べたシートを印刷する。
// QR は端末内で生成する（外部サービスに個体 ID を送らない）。
import { api, ApiError } from './api.js';
import { plantLinkUrl, qrPath } from './plant-link.js';

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const QR_MARGIN = 2; // 読み取りに要る余白（クワイエットゾーン）。モジュール単位

let plants = [];
const selected = new Set();

function setError(err) {
  $('labels-error').textContent = err
    ? err instanceof ApiError
      ? `${err.message}（${err.code}）`
      : String(err.message ?? err)
    : '';
}

function qrSvg(text) {
  const { size, d } = qrPath(text);
  const full = size + QR_MARGIN * 2;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `${-QR_MARGIN} ${-QR_MARGIN} ${full} ${full}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'QR コード');
  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('x', String(-QR_MARGIN));
  bg.setAttribute('y', String(-QR_MARGIN));
  bg.setAttribute('width', String(full));
  bg.setAttribute('height', String(full));
  bg.setAttribute('fill', '#fff');
  svg.appendChild(bg);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000');
  svg.appendChild(path);
  return svg;
}

function renderSheet() {
  const sheet = $('label-sheet');
  sheet.replaceChildren();
  for (const p of plants) {
    if (!selected.has(p.id)) continue;
    const label = document.createElement('div');
    label.className = 'plant-label';
    label.appendChild(qrSvg(plantLinkUrl(location.origin, p.id)));
    const text = document.createElement('div');
    text.className = 'plant-label-text';
    const name = document.createElement('strong');
    name.textContent = p.name; // 利用者の入力なので textContent で描く
    text.appendChild(name);
    if (p.species) {
      const sp = document.createElement('span');
      sp.textContent = p.species;
      text.appendChild(sp);
    }
    label.appendChild(text);
    sheet.appendChild(label);
  }
  $('btn-print').disabled = selected.size === 0;
}

function renderPicker() {
  const list = $('label-plant-list');
  list.replaceChildren();
  if (plants.length === 0) {
    const p = document.createElement('p');
    p.className = 'notice';
    p.textContent = 'まだ個体が登録されていません。記録タブで個体を登録してください。';
    list.appendChild(p);
    return;
  }
  for (const p of plants) {
    const row = document.createElement('label');
    row.className = 'check-inline';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = selected.has(p.id);
    box.onchange = () => {
      if (box.checked) selected.add(p.id);
      else selected.delete(p.id);
      renderSheet();
    };
    row.appendChild(box);
    const span = document.createElement('span');
    span.textContent = p.species ? `${p.name}（${p.species}）` : p.name;
    row.appendChild(span);
    list.appendChild(row);
  }
}

$('label-size').onchange = () => {
  const sheet = $('label-sheet');
  sheet.classList.remove('size-small', 'size-medium', 'size-large');
  sheet.classList.add(`size-${$('label-size').value}`);
};

$('btn-select-all').onclick = () => {
  for (const p of plants) selected.add(p.id);
  renderPicker();
  renderSheet();
};

$('btn-select-none').onclick = () => {
  selected.clear();
  renderPicker();
  renderSheet();
};

$('btn-print').onclick = () => window.print();

async function init() {
  try {
    ({ plants } = await api.listPlants());
    // 記録画面の「この個体のラベル」から来たとき（?id=）はその個体だけを選んでおく
    const only = new URLSearchParams(location.search).get('id');
    for (const p of plants) if (!only || p.id === only) selected.add(p.id);
    renderPicker();
    renderSheet();
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
      setError(new Error('ログインが必要です。トップページからログインしてから開いてください。'));
    } else {
      setError(e);
    }
    $('btn-print').disabled = true;
  }
}

init();
