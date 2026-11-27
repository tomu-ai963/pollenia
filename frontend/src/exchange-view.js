// 交換の希望（譲ります・探しています）の表示。投稿の描画（community.js の renderPost）から使う。
// 名前などは利用者の入力なので textContent で描く。
import { api } from './api.js';

export const KIND_LABEL = { seed: '種', pollen: '花粉' };

/** 交換の中身の 1 行（「種・Rosa・期限 2027-03-01」） */
export function exchangeMeta(x) {
  return [KIND_LABEL[x.kind] ?? null, x.species, x.use_by ? `期限 ${x.use_by}` : null].filter(Boolean).join('・');
}

/** 投稿に付ける交換の枠。本人の投稿なら「受付を終える / 再開する」ボタンも付ける */
export function renderExchangeBox(post, isMine) {
  const x = post.exchange;
  const box = document.createElement('div');
  box.className = `exchange-box ${x.type === 'offer' ? 'offer' : 'want'}`;
  const title = document.createElement('div');
  const tag = document.createElement('strong');
  tag.textContent = x.type === 'offer' ? '🌱 譲ります' : '🔎 探しています';
  const label = document.createElement('span');
  label.textContent = ` ${x.label}`;
  title.append(tag, label);
  const status = document.createElement('span');
  status.className = 'exchange-status';
  const paint = () => {
    status.textContent = x.status === 'open' ? '受付中' : '終了';
    status.classList.toggle('closed', x.status !== 'open');
  };
  paint();
  title.appendChild(status);
  box.appendChild(title);
  const meta = exchangeMeta(x);
  if (meta) {
    const m = document.createElement('div');
    m.className = 'meta';
    m.textContent = meta;
    box.appendChild(m);
  }
  if (isMine) {
    const btn = document.createElement('button');
    btn.className = 'small ghost';
    const paintBtn = () => (btn.textContent = x.status === 'open' ? '受付を終える' : '受付を再開する');
    paintBtn();
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const r = await api.updateExchange(post.id, x.status === 'open' ? 'closed' : 'open');
        x.status = r.status;
        paint();
        paintBtn();
      } finally {
        btn.disabled = false;
      }
    };
    box.appendChild(btn);
  }
  return box;
}
