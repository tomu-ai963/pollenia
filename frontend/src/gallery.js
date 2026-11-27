// 公開ギャラリー（ログイン不要）。GET /public/gallery が返すのは、visibility = public で
// 本人が「ギャラリーに載せる」を選んだ個体だけ。名前・表示名は利用者の入力なので textContent で描く。
import { api } from './api.js';

const $ = (id) => document.getElementById(id);
let nextOffset = 0;

/** 公開系統ページへのリンク */
export function publicPlantHref(id) {
  return `/public?id=${encodeURIComponent(id)}`;
}

function galleryItem(item) {
  const a = document.createElement('a');
  a.className = 'gallery-item';
  a.href = publicPlantHref(item.id);
  if (item.photo_url) {
    const img = document.createElement('img');
    img.src = item.photo_url;
    img.alt = item.name;
    img.loading = 'lazy';
    a.appendChild(img);
  }
  const body = document.createElement('div');
  body.className = 'gallery-item-body';
  const name = document.createElement('strong');
  name.textContent = item.name;
  body.appendChild(name);
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = [item.species, item.is_seedling ? '自家実生' : null, item.owner_name]
    .filter(Boolean)
    .join(' · ');
  body.appendChild(meta);
  a.appendChild(body);
  return a;
}

async function loadMore() {
  $('gallery-error').textContent = '';
  $('btn-gallery-more').disabled = true;
  try {
    const { items, next_offset } = await api.gallery(nextOffset);
    $('gallery-grid').append(...items.map(galleryItem));
    const empty = nextOffset === 0 && items.length === 0;
    $('gallery-empty').classList.toggle('hidden', !empty);
    nextOffset = next_offset;
    $('btn-gallery-more').classList.toggle('hidden', next_offset === null);
  } catch (e) {
    $('gallery-error').textContent = e.message ?? String(e);
  } finally {
    $('btn-gallery-more').disabled = false;
  }
}

if (typeof document !== 'undefined' && $('gallery-grid')) {
  $('btn-gallery-more').onclick = loadMore;
  loadMore();
}
