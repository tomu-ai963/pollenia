// Pollenia アプリ本体（Phase 1: 記録・系統樹）。
// 認証は supabase-js（Auth のみ使用。DB は Worker API 経由 — フロントから直接読まない）。
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CONFIG } from './config.js';
import { api, ApiError } from './api.js';
import { renderAncestors, renderDescendants } from './lineage-render.js';
import { initCommunity, openMyProfile, loadCrossingOptions } from './community.js';

const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);

let session = null;
let plants = [];

function token() {
  return session?.access_token ?? null;
}

function show(id, visible) {
  $(id).classList.toggle('hidden', !visible);
}

function setError(id, err) {
  $(id).textContent = err
    ? err instanceof ApiError
      ? `${err.message}（${err.code}）`
      : String(err.message ?? err)
    : '';
}

// ---- タブ切り替え -----------------------------------------------------------

const TABS = ['timeline', 'records', 'profile'];

function switchTab(name) {
  for (const t of TABS) {
    $(`tab-${t}`).classList.toggle('hidden', t !== name);
    $(`tabbtn-${t}`).classList.toggle('active', t === name);
  }
}

$('tabbtn-timeline').onclick = () => switchTab('timeline');
$('tabbtn-records').onclick = () => switchTab('records');
// プロフィールタブは自分のプロフィールを開く（他人のは投稿者名クリックで遷移）
$('tabbtn-profile').onclick = () => openMyProfile();

// ---- 認証・登録 -----------------------------------------------------------

async function refreshSession() {
  const { data } = await supabase.auth.getSession();
  session = data.session;
  if (!session) {
    show('auth-card', true);
    show('app-area', false);
    $('who').textContent = '';
    return;
  }
  try {
    const { profile } = await api.me(token());
    $('who').textContent = profile.display_name;
    show('auth-card', false);
    show('register-card', false);
    show('app-area', true);
    switchTab('timeline');
    initCommunity({ token, me: profile, switchTab });
    await Promise.all([loadPlants(), loadCrossings()]);
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) {
      // JWT は有効だが Pollenia 未登録 → 登録カードを出す
      show('auth-card', false);
      show('register-card', true);
      show('app-area', false);
    } else {
      setError('auth-error', e);
    }
  }
}

$('btn-signup').onclick = async () => {
  setError('auth-error', null);
  const { error } = await supabase.auth.signUp({
    email: $('auth-email').value,
    password: $('auth-password').value,
  });
  if (error) return setError('auth-error', error);
  await refreshSession();
};

$('btn-signin').onclick = async () => {
  setError('auth-error', null);
  const { error } = await supabase.auth.signInWithPassword({
    email: $('auth-email').value,
    password: $('auth-password').value,
  });
  if (error) return setError('auth-error', error);
  await refreshSession();
};

$('btn-signout').onclick = async () => {
  await supabase.auth.signOut();
  await refreshSession();
};

$('btn-register').onclick = async () => {
  setError('register-error', null);
  try {
    await api.register(token(), $('register-name').value);
    await refreshSession();
  } catch (e) {
    setError('register-error', e);
  }
};

// ---- 個体 -----------------------------------------------------------------

async function loadPlants() {
  ({ plants } = await api.listPlants(token()));
  const list = $('plant-list');
  list.replaceChildren();
  for (const p of plants) {
    const div = document.createElement('div');
    div.className = 'plant-item';
    const info = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = p.name;
    info.appendChild(name);
    const badge = document.createElement('span');
    badge.className = `badge ${p.visibility}`;
    badge.textContent = p.visibility;
    info.appendChild(badge);
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = [p.species, p.origin_sowing_id ? '自家実生' : '導入株']
      .filter(Boolean)
      .join(' / ');
    info.appendChild(meta);
    div.appendChild(info);

    const btns = document.createElement('div');
    const detail = document.createElement('button');
    detail.className = 'small ghost';
    detail.textContent = '詳細・系統';
    detail.onclick = () => openDetail(p.id);
    btns.appendChild(detail);
    if (p.visibility === 'public') {
      const share = document.createElement('button');
      share.className = 'small ghost';
      share.textContent = '公開URL';
      share.onclick = () => {
        const url = new URL('public.html', location.href);
        url.searchParams.set('id', p.id);
        navigator.clipboard?.writeText(url.toString());
        alert(`公開URLをコピーしました:\n${url}`);
      };
      btns.appendChild(share);
    }
    const del = document.createElement('button');
    del.className = 'small danger';
    del.textContent = '削除';
    del.onclick = async () => {
      if (!confirm(`「${p.name}」を削除しますか？（記録は残ります）`)) return;
      await api.deletePlant(token(), p.id);
      await loadPlants();
    };
    btns.appendChild(del);
    div.appendChild(btns);
    list.appendChild(div);
  }

  // 交配フォームの親候補
  for (const selId of ['cross-seed', 'cross-pollen']) {
    const sel = $(selId);
    sel.replaceChildren();
    if (selId === 'cross-pollen') {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '（父不明 / 自然交雑）';
      sel.appendChild(opt);
    }
    for (const p of plants) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      sel.appendChild(opt);
    }
  }
}

// 記録タブの構造化フィールド → traits オブジェクト。空欄はキーごと含めない。
// 未知キーが将来増えても壊れないよう、ここは既知キーだけを素直に組み立てる。
function collectPlantTraits() {
  const traits = {};
  const bloom = $('plant-bloom-season').value;
  if (bloom) traits.bloom_season = bloom;
  const strength = $('plant-fragrance-strength').value;
  if (strength !== '') traits.fragrance_strength = Number(strength);
  const fragType = $('plant-fragrance-type').value.trim();
  if (fragType) traits.fragrance_type = fragType;
  const height = $('plant-height-cm').value;
  if (height !== '') traits.plant_height_cm = Number(height);
  const flower = $('plant-flower-size-cm').value;
  if (flower !== '') traits.flower_size_cm = Number(flower);
  return traits;
}

function resetPlantForm() {
  $('plant-name').value = '';
  $('plant-species').value = '';
  $('plant-notes').value = '';
  $('plant-bloom-season').value = '';
  $('plant-fragrance-strength').value = '';
  $('plant-fragrance-type').value = '';
  $('plant-height-cm').value = '';
  $('plant-flower-size-cm').value = '';
}

$('btn-create-plant').onclick = async () => {
  setError('plant-error', null);
  try {
    const body = {
      name: $('plant-name').value,
      visibility: $('plant-visibility').value,
    };
    if ($('plant-species').value.trim()) body.species = $('plant-species').value;
    if ($('plant-notes').value.trim()) body.notes = $('plant-notes').value;
    const traits = collectPlantTraits();
    if (Object.keys(traits).length) body.traits = traits;
    await api.createPlant(token(), body);
    resetPlantForm();
    await loadPlants();
  } catch (e) {
    setError('plant-error', e);
  }
};

// ---- 個体詳細・写真・系統樹 -------------------------------------------------

async function openDetail(plantId) {
  show('detail-card', true);
  setError('detail-error', null);
  try {
    const { plant, photos } = await api.getPlant(token(), plantId);
    $('detail-title').textContent = `${plant.name}${plant.species ? `（${plant.species}）` : ''}`;
    $('detail-card').dataset.plantId = plant.id;

    const ph = $('detail-photos');
    ph.replaceChildren();
    for (const photo of photos) {
      if (!photo.url) continue;
      const img = document.createElement('img');
      img.src = photo.url;
      img.alt = photo.caption ?? '';
      img.title = photo.caption ?? '';
      ph.appendChild(img);
    }

    await loadLineage(plant.id, 'up');
    $('detail-card').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    setError('detail-error', e);
  }
}

async function loadLineage(plantId, direction) {
  const data = await api.lineage(token(), plantId, direction);
  const container = $('lineage-tree');
  if (direction === 'up') renderAncestors(container, plantId, data);
  else renderDescendants(container, plantId, data);
}

$('btn-lineage-up').onclick = () => loadLineage($('detail-card').dataset.plantId, 'up');
$('btn-lineage-down').onclick = () => loadLineage($('detail-card').dataset.plantId, 'down');

$('btn-upload-photo').onclick = async () => {
  setError('detail-error', null);
  const plantId = $('detail-card').dataset.plantId;
  const file = $('photo-file').files[0];
  if (!file) return setError('detail-error', new Error('ファイルを選択してください。'));
  try {
    const { upload } = await api.createPhoto(token(), plantId, {
      content_type: file.type,
      caption: $('photo-caption').value.trim() || undefined,
    });
    // Worker が発行した署名URLへ直接アップロード（Storage の認可は署名トークンが担う）
    const { error } = await supabase.storage
      .from('pollenia-photos')
      .uploadToSignedUrl(upload.path, upload.token, file);
    if (error) throw error;
    await openDetail(plantId);
  } catch (e) {
    setError('detail-error', e);
  }
};

// ---- 交配・採種・播種 --------------------------------------------------------

async function loadCrossings() {
  const { crossings } = await api.listCrossings(token());
  const list = $('crossing-list');
  list.replaceChildren();
  for (const c of crossings) {
    const div = document.createElement('div');
    div.className = 'plant-item';
    const info = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = `${c.seed_parent_name ?? '?'} × ${c.pollen_parent_name ?? '（父不明）'}`;
    info.appendChild(title);
    const meta = document.createElement('div');
    meta.className = 'meta';
    const harvestSummary = c.harvests
      .map((h) => {
        const sowings = h.sowings
          .map((s) => `播種${s.sowing_count ?? '?'}・発芽${s.germination_count ?? '-'}`)
          .join(' / ');
        return `採種${h.seed_count ?? '?'}粒${sowings ? `（${sowings}）` : ''}`;
      })
      .join('、');
    meta.textContent = [c.cross_date, harvestSummary].filter(Boolean).join(' — ');
    info.appendChild(meta);
    div.appendChild(info);

    const btns = document.createElement('div');
    const addHarvest = document.createElement('button');
    addHarvest.className = 'small ghost';
    addHarvest.textContent = '採種を記録';
    addHarvest.onclick = async () => {
      const seedCount = prompt('採種数（粒）:');
      if (seedCount === null) return;
      await api.createHarvest(token(), c.id, {
        harvest_date: new Date().toISOString().slice(0, 10),
        seed_count: Number(seedCount) || 0,
      });
      await loadCrossings();
    };
    btns.appendChild(addHarvest);
    if (c.harvests.length > 0) {
      const addSowing = document.createElement('button');
      addSowing.className = 'small ghost';
      addSowing.textContent = '播種を記録';
      addSowing.onclick = async () => {
        const count = prompt('播種数（粒）:');
        if (count === null) return;
        const latest = c.harvests[c.harvests.length - 1];
        await api.createSowing(token(), latest.id, {
          sowing_date: new Date().toISOString().slice(0, 10),
          sowing_count: Number(count) || 0,
        });
        await loadCrossings();
      };
      btns.appendChild(addSowing);
    }
    div.appendChild(btns);
    list.appendChild(div);
  }
}

$('btn-create-crossing').onclick = async () => {
  setError('crossing-error', null);
  try {
    const body = { seed_parent_id: $('cross-seed').value };
    if ($('cross-pollen').value) body.pollen_parent_id = $('cross-pollen').value;
    if ($('cross-date').value) body.cross_date = $('cross-date').value;
    if ($('cross-notes').value.trim()) body.notes = $('cross-notes').value;
    await api.createCrossing(token(), body);
    await Promise.all([loadCrossings(), loadCrossingOptions()]);
  } catch (e) {
    setError('crossing-error', e);
  }
};

refreshSession();
