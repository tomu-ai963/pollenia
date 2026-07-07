// 系統樹の描画（アプリ内・公開ページ共用）。
// API の { edges, nodes } を受け取り、ネストした <ul> ツリーを組み立てる。
// nodes に無い ID（＝非可視）は絶対に描画しない。has_hidden_parent は
// 「非公開の親あり」の注記としてのみ表示する（api.md）。

function nodeLabel(nodes, plantId, role) {
  const n = nodes[plantId];
  const el = document.createElement('span');
  el.className = 'node';
  if (!n) {
    // ここに来るのは想定外（可視IDのみ edges に載る）が、来ても ID を出さない
    el.innerHTML = '<span class="hidden-parent">（非公開）</span>';
    return el;
  }
  if (n.photo_url) {
    const img = document.createElement('img');
    img.src = n.photo_url;
    img.alt = '';
    el.appendChild(img);
  }
  if (role) {
    const r = document.createElement('span');
    r.className = 'role';
    r.textContent = role;
    el.appendChild(r);
  }
  const name = document.createElement('span');
  name.textContent = n.name + (n.deleted ? '（削除済み）' : '');
  el.appendChild(name);
  if (n.species) {
    const sp = document.createElement('span');
    sp.className = 'sp';
    sp.textContent = n.species;
    el.appendChild(sp);
  }
  return el;
}

function hiddenNote() {
  const s = document.createElement('span');
  s.className = 'hidden-parent';
  s.textContent = '🔒 非公開の親があります';
  return s;
}

// 祖先方向: edges は「子 → 両親」。entryId から親を再帰的に展開する。
export function renderAncestors(container, entryId, { edges, nodes }) {
  const edgeByChild = new Map(edges.map((e) => [e.plant_id, e]));
  const root = document.createElement('div');
  root.className = 'tree';

  function renderPlant(plantId, role, visited) {
    const li = document.createElement('li');
    li.appendChild(nodeLabel(nodes, plantId, role));
    const e = edgeByChild.get(plantId);
    if (e && !visited.has(plantId)) {
      visited.add(plantId);
      const ul = document.createElement('ul');
      if (e.seed_parent_id) ul.appendChild(renderPlant(e.seed_parent_id, '母', visited));
      if (e.pollen_parent_id) ul.appendChild(renderPlant(e.pollen_parent_id, '父', visited));
      if (e.has_hidden_parent) {
        const hli = document.createElement('li');
        hli.appendChild(hiddenNote());
        ul.appendChild(hli);
      }
      if (ul.childNodes.length) li.appendChild(ul);
      visited.delete(plantId);
    }
    return li;
  }

  const ul = document.createElement('ul');
  ul.appendChild(renderPlant(entryId, null, new Set()));
  root.appendChild(ul);
  container.replaceChildren(root);
  if (edges.length === 0) {
    const p = document.createElement('p');
    p.className = 'notice';
    p.textContent = '交配由来の親の記録はありません（導入株）。';
    container.appendChild(p);
  }
}

// 子孫方向: edges の各行は「子とその両親」。entryId を親に持つ子を再帰的に展開する。
export function renderDescendants(container, entryId, { edges, nodes }) {
  const childrenByParent = new Map();
  for (const e of edges) {
    for (const pid of [e.seed_parent_id, e.pollen_parent_id]) {
      if (!pid) continue;
      if (!childrenByParent.has(pid)) childrenByParent.set(pid, []);
      childrenByParent.get(pid).push(e);
    }
  }
  const root = document.createElement('div');
  root.className = 'tree';

  function renderPlant(plantId, visited) {
    const li = document.createElement('li');
    li.appendChild(nodeLabel(nodes, plantId, null));
    const children = childrenByParent.get(plantId) ?? [];
    if (children.length && !visited.has(plantId)) {
      visited.add(plantId);
      const ul = document.createElement('ul');
      const seen = new Set();
      for (const e of children) {
        if (seen.has(e.plant_id)) continue;
        seen.add(e.plant_id);
        ul.appendChild(renderPlant(e.plant_id, visited));
      }
      li.appendChild(ul);
      visited.delete(plantId);
    }
    return li;
  }

  const ul = document.createElement('ul');
  ul.appendChild(renderPlant(entryId, new Set()));
  root.appendChild(ul);
  container.replaceChildren(root);
  if (edges.length === 0) {
    const p = document.createElement('p');
    p.className = 'notice';
    p.textContent = 'この個体から生まれた系統の記録はありません。';
    container.appendChild(p);
  }
}
