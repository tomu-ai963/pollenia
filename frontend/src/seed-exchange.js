// 種・花粉の在庫（記録タブ）と交換の希望（タイムラインタブ）。
// 在庫は自分だけのデータ。「交換に出す」と、その時点の名前・種類・属種・期限だけが公開の投稿になる。
// 名前・本文は利用者の入力なので、すべて textContent で描く。
import { api, ApiError } from './api.js';
import { renderPost } from './community.js';
import { KIND_LABEL } from './exchange-view.js';
import { localToday } from './record-actions.js';

const $ = (id) => document.getElementById(id);

// 農林水産省の品種登録ホームページ（登録品種かどうかを調べられる）
export const VARIETY_DB_URL = 'https://www.hinshu2.maff.go.jp/';

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** 使用期限の表示（「期限切れ」「期限まであと 12 日」「期限 2027-03-01」） */
export function useByText(useBy, today) {
  if (!useBy) return null;
  const d = daysBetween(today, useBy);
  if (d < 0) return `期限切れ（${useBy}）`;
  if (d <= 30) return `期限まであと ${d} 日`;
  return `期限 ${useBy}`;
}

function setError(id, err) {
  $(id).textContent = err
    ? err instanceof ApiError
      ? `${err.message}（${err.code}）`
      : String(err.message ?? err)
    : '';
}

// ---- 在庫（記録タブ） ---------------------------------------------------------

function offerForm(stock) {
  const form = document.createElement('div');
  form.className = 'offer-form hidden';
  const label = document.createElement('label');
  label.textContent = '本文（送り方・条件・ひとことなど）';
  const text = document.createElement('textarea');
  text.maxLength = 5000;
  text.placeholder = '例: 10粒ずつ、3名さまに。送料だけご負担ください。コメントでご連絡を。';
  const check = document.createElement('label');
  check.className = 'check-inline';
  const box = document.createElement('input');
  box.type = 'checkbox';
  const span = document.createElement('span');
  span.textContent =
    '登録品種（種苗法）ではないこと、または育成者の許諾があることを確かめました。登録品種の種苗を許諾なく譲ることは法律で禁じられています。';
  check.append(box, span);
  const note = document.createElement('p');
  note.className = 'notice';
  const link = document.createElement('a');
  link.href = VARIETY_DB_URL;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = '農林水産省の品種登録ホームページ';
  note.append(link, document.createTextNode(' で、登録品種かどうかを調べられます。交配親が登録品種の実生も、扱いに注意してください。'));
  const send = document.createElement('button');
  send.textContent = '交換に出す（公開されます）';
  send.onclick = async () => {
    setError('stocks-error', null);
    send.disabled = true;
    try {
      await api.createExchange({ type: 'offer', stock_id: stock.id, content: text.value, confirm_variety: box.checked });
      form.classList.add('hidden');
      text.value = '';
      box.checked = false;
      $('stocks-notice').textContent = `「${stock.label}」を交換に出しました。タイムラインタブの「種・花粉の交換」に載ります。`;
      await loadExchange();
    } catch (e) {
      setError('stocks-error', e);
    } finally {
      send.disabled = false;
    }
  };
  form.append(label, text, check, note, send);
  return form;
}

function stockItem(stock, today) {
  const item = document.createElement('div');
  item.className = 'plant-item stock-item';
  const info = document.createElement('div');
  const name = document.createElement('strong');
  name.textContent = stock.label;
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = KIND_LABEL[stock.kind] ?? stock.kind;
  info.append(name, badge);
  const meta = document.createElement('div');
  meta.className = 'meta';
  const useBy = useByText(stock.use_by, today);
  meta.textContent = [
    stock.species,
    stock.quantity === null || stock.quantity === undefined ? null : `${stock.quantity}${stock.kind === 'seed' ? '粒' : ''}`,
    stock.collected_on ? `採取 ${stock.collected_on}` : null,
    useBy,
  ]
    .filter(Boolean)
    .join('・');
  if (stock.use_by && daysBetween(today, stock.use_by) < 0) meta.classList.add('expired');
  info.appendChild(meta);
  if (stock.notes) {
    const notes = document.createElement('div');
    notes.className = 'meta';
    notes.textContent = stock.notes;
    info.appendChild(notes);
  }

  const btns = document.createElement('div');
  const form = offerForm(stock);
  const offer = document.createElement('button');
  offer.className = 'small ghost';
  offer.textContent = '交換に出す';
  offer.onclick = () => form.classList.toggle('hidden');
  const del = document.createElement('button');
  del.className = 'small danger';
  del.textContent = '削除';
  del.onclick = async () => {
    if (!confirm(`在庫「${stock.label}」を削除しますか？（交換に出した投稿は残ります）`)) return;
    setError('stocks-error', null);
    try {
      await api.deleteSeedStock(stock.id);
      await loadStocks();
    } catch (e) {
      setError('stocks-error', e);
    }
  };
  btns.append(offer, del);
  item.append(info, btns);
  const wrap = document.createElement('div');
  wrap.append(item, form);
  return wrap;
}

export async function loadStocks() {
  setError('stocks-error', null);
  try {
    const { stocks } = await api.seedStocks();
    const today = localToday();
    $('stock-list').replaceChildren(...stocks.map((s) => stockItem(s, today)));
    $('stocks-empty').classList.toggle('hidden', stocks.length > 0);
  } catch (e) {
    setError('stocks-error', e);
  }
}

async function addStock() {
  setError('stocks-error', null);
  const num = (id) => ($(id).value.trim() === '' ? undefined : Number($(id).value));
  const body = {
    kind: $('stock-kind').value,
    label: $('stock-label').value,
    species: $('stock-species').value.trim() || undefined,
    quantity: num('stock-quantity'),
    collected_on: $('stock-collected').value || undefined,
    use_by: $('stock-use-by').value || undefined,
    notes: $('stock-notes').value.trim() || undefined,
  };
  try {
    await api.createSeedStock(body);
    for (const id of ['stock-label', 'stock-species', 'stock-quantity', 'stock-collected', 'stock-use-by', 'stock-notes']) {
      $(id).value = '';
    }
    await loadStocks();
  } catch (e) {
    setError('stocks-error', e);
  }
}

// ---- 交換の希望（タイムラインタブ） ----------------------------------------------

let exchangeType = 'offer';
let exchangeOffset = 0;

async function loadExchange(more = false) {
  setError('exchange-error', null);
  if (!more) exchangeOffset = 0;
  try {
    const { posts } = await api.exchange(exchangeType, exchangeOffset);
    const list = $('exchange-list');
    if (!more) list.replaceChildren();
    list.append(...posts.map(renderPost));
    exchangeOffset += posts.length;
    $('exchange-empty').classList.toggle('hidden', list.childElementCount > 0);
    $('btn-exchange-more').classList.toggle('hidden', posts.length < 20);
  } catch (e) {
    setError('exchange-error', e);
  }
}

function switchExchange(type) {
  exchangeType = type;
  $('btn-exchange-offer').classList.toggle('active', type === 'offer');
  $('btn-exchange-want').classList.toggle('active', type === 'want');
  $('want-form').classList.add('hidden');
  loadExchange();
}

async function createWant() {
  setError('exchange-error', null);
  try {
    await api.createExchange({
      type: 'want',
      label: $('want-label').value,
      kind: $('want-kind').value || null,
      species: $('want-species').value.trim() || null,
      content: $('want-content').value,
    });
    for (const id of ['want-label', 'want-species', 'want-content']) $(id).value = '';
    $('want-form').classList.add('hidden');
    switchExchange('want');
  } catch (e) {
    setError('exchange-error', e);
  }
}

export function initSeedExchange() {
  $('btn-add-stock').onclick = addStock;
  $('btn-exchange-offer').onclick = () => switchExchange('offer');
  $('btn-exchange-want').onclick = () => switchExchange('want');
  $('btn-exchange-more').onclick = () => loadExchange(true);
  $('btn-want-open').onclick = () => $('want-form').classList.toggle('hidden');
  $('btn-want-create').onclick = createWant;
  loadStocks();
  loadExchange();
}
