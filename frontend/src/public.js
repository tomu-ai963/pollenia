// 認証不要の公開ページ。Worker の /public/plants/:id を叩くだけで、
// 返るのは visibility=public のノードのみ（可視性フィルタは RPC 側で完結）。
import { api } from './api.js';
import { renderAncestors, renderDescendants } from './lineage-render.js';

const $ = (id) => document.getElementById(id);
const plantId = new URLSearchParams(location.search).get('id');

try {
  if (!plantId) throw new Error('URL に ?id=<個体ID> が必要です。');
  const { plant, photos, ancestors, descendants } = await api.publicPlant(plantId);
  document.title = `Pollenia — ${plant.name}`;
  $('plant-title').textContent = plant.name + (plant.species ? `（${plant.species}）` : '');
  $('plant-owner').textContent = `育種者: ${plant.owner_name}`;
  for (const photo of photos) {
    if (!photo.url) continue;
    const img = document.createElement('img');
    img.src = photo.url;
    img.alt = photo.caption ?? '';
    $('plant-photos').appendChild(img);
  }
  renderAncestors($('ancestors'), plant.id, ancestors);
  renderDescendants($('descendants'), plant.id, descendants);
} catch (e) {
  $('plant-title').textContent = '表示できません';
  $('page-error').textContent = e.message ?? String(e);
}
