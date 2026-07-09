// AI相談チャット + 出品文生成（Phase 3）。
// 会話履歴はクライアント側（このモジュールのメモリ）にだけ保持し、サーバーへは
// 直近 HISTORY_MAX ターンのみ送る（Worker 側も同じ上限で検証する）。
// 描画はすべて textContent（innerHTML 直挿し禁止 — _docs/api.md のフロント実装への注意）。
import { api, ApiError } from './api.js';

const $ = (id) => document.getElementById(id);

// Worker 側 AI_HISTORY_MAX_TURNS と揃える。
const HISTORY_MAX = 12;

let tokenFn = null;
let history = []; // {role: 'user'|'assistant', content: string}
let sending = false;

function setError(id, err) {
  $(id).textContent = err
    ? err instanceof ApiError
      ? `${err.message}（${err.code}）`
      : String(err.message ?? err)
    : '';
}

function appendChatMessage(role, content) {
  const div = document.createElement('div');
  div.className = `ai-msg ${role}`;
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = role === 'user' ? 'あなた' : 'AI';
  const body = document.createElement('div');
  body.className = 'body';
  body.textContent = content;
  div.appendChild(who);
  div.appendChild(body);
  const log = $('ai-chat-log');
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

async function sendConsult() {
  if (sending) return;
  const message = $('ai-message').value.trim();
  if (!message) return;
  setError('ai-error', null);

  sending = true;
  $('btn-ai-send').disabled = true;
  appendChatMessage('user', message);
  $('ai-message').value = '';
  const pending = appendChatMessage('assistant', '考え中…');

  try {
    // 送る履歴は「今回の message を含まない」直近ターン（Worker と同じ契約）。
    const { answer } = await api.aiConsult(tokenFn(), message, history.slice(-HISTORY_MAX));
    pending.querySelector('.body').textContent = answer || '（回答を生成できませんでした）';
    history.push({ role: 'user', content: message });
    history.push({ role: 'assistant', content: answer || '' });
    // メモリ上の履歴も伸ばしすぎない（次回送信分 + 余裕）。
    if (history.length > HISTORY_MAX * 2) history = history.slice(-HISTORY_MAX);
  } catch (e) {
    pending.remove();
    setError('ai-error', e);
  } finally {
    sending = false;
    $('btn-ai-send').disabled = false;
  }
}

async function generateListing() {
  const plantId = $('detail-card').dataset.plantId;
  if (!plantId) return;
  setError('listing-error', null);
  $('listing-copied').textContent = '';
  const btn = $('btn-generate-listing');
  btn.disabled = true;
  btn.textContent = '生成中…';
  try {
    const { listing } = await api.aiListing(tokenFn(), plantId, $('listing-marketplace').value);
    $('listing-title').value = listing.title;
    $('listing-body').value = listing.body;
    $('listing-result').classList.remove('hidden');
  } catch (e) {
    setError('listing-error', e);
  } finally {
    btn.disabled = false;
    btn.textContent = '出品文を生成';
  }
}

function copyToClipboard(text, label) {
  navigator.clipboard?.writeText(text).then(() => {
    $('listing-copied').textContent = `${label}をコピーしました`;
  });
}

export function initAi({ token }) {
  tokenFn = token;

  $('btn-ai-send').onclick = sendConsult;
  $('btn-ai-clear').onclick = () => {
    history = [];
    $('ai-chat-log').replaceChildren();
    setError('ai-error', null);
  };

  $('btn-generate-listing').onclick = generateListing;
  $('btn-copy-listing-title').onclick = () => copyToClipboard($('listing-title').value, '商品名');
  $('btn-copy-listing-body').onclick = () => copyToClipboard($('listing-body').value, '本文');
}

// 個体詳細を開き直したときに前の個体の生成結果を残さない（app.js の openDetail から呼ぶ）。
export function resetListingUi() {
  $('listing-result').classList.add('hidden');
  $('listing-title').value = '';
  $('listing-body').value = '';
  $('listing-copied').textContent = '';
  setError('listing-error', null);
}
