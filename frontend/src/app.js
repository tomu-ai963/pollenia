// Pollenia アプリ本体（Phase 1: 記録・系統樹）。
// 認証は supabase-js（Auth のみ使用。DB は Worker API 経由 — フロントから直接読まない）。
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CONFIG } from './config.js';
import { api, ApiError } from './api.js';
import { renderAncestors, renderDescendants } from './lineage-render.js';
import { initCommunity, openMyProfile, loadCrossingOptions } from './community.js';
import { initAi, resetListingUi } from './ai.js';

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

const TABS = ['timeline', 'records', 'ai', 'profile'];

function switchTab(name) {
  for (const t of TABS) {
    $(`tab-${t}`).classList.toggle('hidden', t !== name);
    $(`tabbtn-${t}`).classList.toggle('active', t === name);
  }
}

$('tabbtn-timeline').onclick = () => switchTab('timeline');
$('tabbtn-records').onclick = () => switchTab('records');
$('tabbtn-ai').onclick = () => switchTab('ai');
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
    initAi({ token });
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
    // トグル: すでにこの個体の詳細が開いていれば閉じる、そうでなければ開く。
    detail.onclick = () => toggleDetail(p.id);
    btns.appendChild(detail);
    const edit = document.createElement('button');
    edit.className = 'small ghost';
    edit.textContent = '編集';
    edit.onclick = () => openPlantEdit(p);
    btns.appendChild(edit);
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

  // 交配フォーム（登録・編集）の親候補。花粉親セレクトには「父不明」を先頭に。
  for (const selId of ['cross-seed', 'cross-pollen', 'edit-cross-seed', 'edit-cross-pollen']) {
    const sel = $(selId);
    sel.replaceChildren();
    if (selId.endsWith('cross-pollen')) {
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

// ---- 個体編集 -------------------------------------------------------------

let editingPlantId = null;

function openPlantEdit(p) {
  editingPlantId = p.id;
  setError('plant-edit-error', null);
  show('plant-edit-success', false);
  $('edit-plant-name').value = p.name ?? '';
  $('edit-plant-species').value = p.species ?? '';
  $('edit-plant-visibility').value = p.visibility ?? 'private';
  $('edit-plant-notes').value = p.notes ?? '';
  const t = p.traits ?? {};
  $('edit-plant-bloom-season').value = t.bloom_season ?? '';
  $('edit-plant-fragrance-strength').value = t.fragrance_strength ?? '';
  $('edit-plant-fragrance-type').value = t.fragrance_type ?? '';
  $('edit-plant-height-cm').value = t.plant_height_cm ?? '';
  $('edit-plant-flower-size-cm').value = t.flower_size_cm ?? '';
  show('plant-edit-card', true);
  reveal($('plant-edit-card'));
  $('plant-edit-card').scrollIntoView({ behavior: 'smooth' });
}

// PATCH は全項目を送る＝フォームの現在値で丸ごと置換する（空欄は null / traits は {}）。
$('btn-save-plant').onclick = async () => {
  setError('plant-edit-error', null);
  show('plant-edit-success', false);
  if (!editingPlantId) return;
  const name = $('edit-plant-name').value.trim();
  if (!name) return setError('plant-edit-error', new Error('名前は必須です。'));
  try {
    await api.updatePlant(token(), editingPlantId, {
      name,
      species: $('edit-plant-species').value.trim() || null,
      visibility: $('edit-plant-visibility').value,
      notes: $('edit-plant-notes').value.trim() || null,
      traits: collectTraits('edit-plant-'),
    });
    show('plant-edit-success', true);
    await loadPlants();
  } catch (e) {
    setError('plant-edit-error', e);
  }
};

$('btn-cancel-plant-edit').onclick = () => show('plant-edit-card', false);
$('btn-plant-edit-close').onclick = () => show('plant-edit-card', false);

// 開閉時のフェード＋スライドイン（styles.css の @keyframes reveal）。
// アニメーションを再トリガするため、一旦クラスを外して強制リフローを挟む。
function reveal(el) {
  el.classList.remove('revealing');
  void el.offsetWidth;
  el.classList.add('revealing');
}

// 構造化フィールド → traits オブジェクト。空欄はキーごと含めない。
// 未知キーが将来増えても壊れないよう、ここは既知キーだけを素直に組み立てる。
// prefix で登録フォーム（'plant-'）と編集フォーム（'edit-plant-'）を共用する。
function collectTraits(prefix) {
  const val = (suffix) => $(`${prefix}${suffix}`).value;
  const traits = {};
  const bloom = val('bloom-season');
  if (bloom) traits.bloom_season = bloom;
  const strength = val('fragrance-strength');
  if (strength !== '') traits.fragrance_strength = Number(strength);
  const fragType = val('fragrance-type').trim();
  if (fragType) traits.fragrance_type = fragType;
  const height = val('height-cm');
  if (height !== '') traits.plant_height_cm = Number(height);
  const flower = val('flower-size-cm');
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
    const traits = collectTraits('plant-');
    if (Object.keys(traits).length) body.traits = traits;
    await api.createPlant(token(), body);
    resetPlantForm();
    await loadPlants();
  } catch (e) {
    setError('plant-error', e);
  }
};

// ---- 個体詳細・写真・系統樹 -------------------------------------------------

// 詳細カードのトグル: 同じ個体が開いていれば閉じ、そうでなければ開く。
function toggleDetail(plantId) {
  const card = $('detail-card');
  if (!card.classList.contains('hidden') && card.dataset.plantId === plantId) {
    closeDetail();
  } else {
    openDetail(plantId);
  }
}

function closeDetail() {
  show('detail-card', false);
  $('detail-card').dataset.plantId = '';
}

$('btn-detail-close').onclick = () => closeDetail();

async function openDetail(plantId) {
  show('detail-card', true);
  reveal($('detail-card'));
  setError('detail-error', null);
  try {
    const { plant, photos } = await api.getPlant(token(), plantId);
    $('detail-title').textContent = `${plant.name}${plant.species ? `（${plant.species}）` : ''}`;
    $('detail-card').dataset.plantId = plant.id;
    resetListingUi(); // 前に開いた個体の出品文を残さない

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
    // 自家受粉（両親同一）は専用表示。それ以外は「母木 × 花粉親（父不明）」。
    const isSelf = c.pollen_parent_id && c.pollen_parent_id === c.seed_parent_id;
    title.textContent = isSelf
      ? `${c.seed_parent_name ?? '?'} 🌼 自家受粉`
      : `${c.seed_parent_name ?? '?'} × ${c.pollen_parent_name ?? '（父不明）'}`;
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
    const editCross = document.createElement('button');
    editCross.className = 'small ghost';
    editCross.textContent = '編集';
    editCross.onclick = () => openCrossingEdit(c);
    btns.appendChild(editCross);
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

    // 削除（物理削除・カスケード）。紐づく採種・播種があれば件数を明示して警告する。
    const del = document.createElement('button');
    del.className = 'small danger';
    del.textContent = '削除';
    del.onclick = async () => {
      setError('crossing-error', null);
      const label = title.textContent;
      const sowingCount = c.harvests.reduce((n, h) => n + h.sowings.length, 0);
      const warn = c.harvests.length
        ? `\n\n紐づく採種${c.harvests.length}件・播種${sowingCount}件も一緒に削除されます。`
        : '';
      if (!confirm(`交配記録「${label}」を削除しますか？この操作は取り消せません。${warn}`)) return;
      try {
        await api.deleteCrossing(token(), c.id);
        await Promise.all([loadCrossings(), loadCrossingOptions()]);
      } catch (e) {
        setError('crossing-error', e);
      }
    };
    btns.appendChild(del);

    div.appendChild(btns);
    list.appendChild(div);
  }
}

// 自家受粉チェック時は花粉親セレクトを無効化（花粉親＝母木として送るため選択不要）。
function applySelfState(prefix) {
  const self = $(`${prefix}-self`).checked;
  const pollen = $(`${prefix}-pollen`);
  pollen.disabled = self;
  pollen.parentElement.classList.toggle('disabled', self);
}

$('cross-self').onchange = () => applySelfState('cross');
$('edit-cross-self').onchange = () => applySelfState('edit-cross');

$('btn-create-crossing').onclick = async () => {
  setError('crossing-error', null);
  try {
    const seed = $('cross-seed').value;
    const body = { seed_parent_id: seed };
    // 自家受粉: 花粉親＝母木。通常: 選択された花粉親（未選択は父不明で省略）。
    if ($('cross-self').checked) body.pollen_parent_id = seed;
    else if ($('cross-pollen').value) body.pollen_parent_id = $('cross-pollen').value;
    if ($('cross-date').value) body.cross_date = $('cross-date').value;
    if ($('cross-notes').value.trim()) body.notes = $('cross-notes').value;
    await api.createCrossing(token(), body);
    $('cross-self').checked = false;
    applySelfState('cross');
    $('cross-notes').value = '';
    await Promise.all([loadCrossings(), loadCrossingOptions()]);
  } catch (e) {
    setError('crossing-error', e);
  }
};

// ---- 交配記録の編集 -------------------------------------------------------

let editingCrossingId = null;

function openCrossingEdit(c) {
  editingCrossingId = c.id;
  setError('crossing-edit-error', null);
  show('crossing-edit-success', false);
  const isSelf = c.pollen_parent_id && c.pollen_parent_id === c.seed_parent_id;
  $('edit-cross-seed').value = c.seed_parent_id;
  $('edit-cross-self').checked = !!isSelf;
  $('edit-cross-pollen').value = isSelf ? '' : (c.pollen_parent_id ?? '');
  $('edit-cross-date').value = c.cross_date ?? '';
  $('edit-cross-notes').value = c.notes ?? '';
  applySelfState('edit-cross');
  show('crossing-edit-card', true);
  reveal($('crossing-edit-card'));
  $('crossing-edit-card').scrollIntoView({ behavior: 'smooth' });
}

// PATCH は全項目を送る＝現在値で丸ごと置換（花粉親なしは null＝父不明として明示）。
$('btn-save-crossing').onclick = async () => {
  setError('crossing-edit-error', null);
  show('crossing-edit-success', false);
  if (!editingCrossingId) return;
  try {
    const seed = $('edit-cross-seed').value;
    await api.updateCrossing(token(), editingCrossingId, {
      seed_parent_id: seed,
      pollen_parent_id: $('edit-cross-self').checked
        ? seed
        : $('edit-cross-pollen').value || null,
      cross_date: $('edit-cross-date').value || null,
      notes: $('edit-cross-notes').value.trim() || null,
    });
    show('crossing-edit-success', true);
    await Promise.all([loadCrossings(), loadCrossingOptions()]);
  } catch (e) {
    setError('crossing-edit-error', e);
  }
};

$('btn-cancel-crossing-edit').onclick = () => show('crossing-edit-card', false);
$('btn-crossing-edit-close').onclick = () => show('crossing-edit-card', false);

refreshSession();
