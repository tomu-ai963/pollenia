// 系統カード画像（出品写真用）。個体の名前・写真・特性と、両親・祖父母の系統図を
// 1080×1080 の PNG に描く（端末内の canvas。サーバーには送らない）。
//
// URL・QR は入れない: フリマの出品画像では外部サイトへの誘導が禁止されていることがあり、
// 規約に触れると損をするのは出品者のため。入れるのは「Pollenia 育種記録」の表記だけ。

export const CARD_SIZE = 1080;

const BLOOM = { spring: '春', early_summer: '初夏', summer: '夏', autumn: '秋', winter: '冬' };

/** 特性 → カードに載せる行（空の項目は出さない） */
export function traitLines(traits = {}) {
  const lines = [];
  if (traits.bloom_season) lines.push(`開花時期　${BLOOM[traits.bloom_season] ?? traits.bloom_season}`);
  if (traits.fragrance_strength !== undefined && traits.fragrance_strength !== null) {
    lines.push(`香りの強さ　${traits.fragrance_strength} / 5`);
  }
  if (traits.fragrance_type) lines.push(`香りの系統　${traits.fragrance_type}`);
  if (traits.plant_height_cm !== undefined && traits.plant_height_cm !== null) {
    lines.push(`草丈　${traits.plant_height_cm} cm`);
  }
  if (traits.flower_size_cm !== undefined && traits.flower_size_cm !== null) {
    lines.push(`花のサイズ　${traits.flower_size_cm} cm`);
  }
  return lines;
}

/**
 * 系統図の 1 枠: { kind: 'plant', name, species } / 'unknown'（父不明）/ 'hidden'（非公開）/ 'none'（記録なし）
 * nodes に無い ID は名前を出さない（lineage-render.js と同じ扱い）。
 */
function slot(nodes, id, edge, role) {
  if (id) {
    const n = nodes[id];
    if (!n) return { kind: 'hidden' };
    return { kind: 'plant', name: n.name, species: n.species ?? null };
  }
  if (!edge) return { kind: 'none' };
  if (edge.has_hidden_parent) return { kind: 'hidden' };
  return role === 'pollen' ? { kind: 'unknown' } : { kind: 'none' };
}

/** 祖先方向の { edges, nodes } → 両親と祖父母（母の母・母の父・父の母・父の父） */
export function buildPedigree(entryId, { edges, nodes }) {
  const byChild = new Map(edges.map((e) => [e.plant_id, e]));
  const parentsOf = (id) => {
    const e = id ? byChild.get(id) : undefined;
    return {
      seed: slot(nodes, e?.seed_parent_id ?? null, e, 'seed'),
      pollen: slot(nodes, e?.pollen_parent_id ?? null, e, 'pollen'),
      seedId: e?.seed_parent_id ?? null,
      pollenId: e?.pollen_parent_id ?? null,
      self: !!e && !!e.seed_parent_id && e.seed_parent_id === e.pollen_parent_id,
    };
  };
  const p = parentsOf(entryId);
  const m = parentsOf(p.seedId);
  const f = parentsOf(p.pollenId);
  return {
    hasParents: p.seed.kind !== 'none' || p.pollen.kind !== 'none',
    self: p.self,
    mother: p.seed,
    father: p.pollen,
    grand: [m.seed, m.pollen, f.seed, f.pollen],
  };
}

/** 幅に収まるよう末尾を「…」で切る。measure(text) は描画幅を返す関数 */
export function fitText(text, maxWidth, measure) {
  if (measure(text) <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(`${text.slice(0, mid)}…`) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
}

/** 保存するファイル名（OS で使えない文字を外す） */
export function cardFileName(plantName) {
  const safe = String(plantName).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().slice(0, 60) || 'plant';
  return `${safe}_系統カード.png`;
}

// ---- 描画 ----------------------------------------------------------------

const FONT = '"Zen Maru Gothic", "Hiragino Sans", "Noto Sans JP", "Yu Gothic", sans-serif';
const C = {
  bg: '#fdf8ec',
  card: '#ffffff',
  ink: '#4a4230',
  muted: '#a89a7e',
  line: '#e8dcc0',
  mint: '#dff2ea',
  mintInk: '#4fa588',
  pink: '#fbe3e8',
  pinkInk: '#c0687c',
};

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function text(ctx, s, x, y, { size, weight = 400, color = C.ink, max, align = 'left' }) {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(max ? fitText(s, max, (t) => ctx.measureText(t).width) : s, x, y);
}

const SLOT_TEXT = { unknown: '父不明', hidden: '非公開', none: '記録なし' };

function drawSlot(ctx, s, x, y, w, h, role, tone) {
  roundRect(ctx, x, y, w, h, 16);
  ctx.fillStyle = s.kind === 'plant' ? tone.bg : C.bg;
  ctx.fill();
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 2;
  ctx.stroke();
  const pad = 20;
  text(ctx, role, x + pad, y + 34, { size: 22, color: tone.ink, weight: 700 });
  if (s.kind === 'plant') {
    text(ctx, s.name, x + pad, y + (s.species ? h / 2 + 14 : h / 2 + 24), { size: 32, weight: 700, max: w - pad * 2 });
    if (s.species) text(ctx, s.species, x + pad, y + h / 2 + 52, { size: 22, color: C.muted, max: w - pad * 2 });
  } else {
    text(ctx, SLOT_TEXT[s.kind], x + pad, y + h / 2 + 24, { size: 28, color: C.muted });
  }
}

function connector(ctx, fromX, fromY, toX, toYs) {
  const midX = (fromX + toX) / 2;
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.lineTo(midX, fromY);
  for (const ty of toYs) {
    ctx.moveTo(midX, fromY);
    ctx.lineTo(midX, ty);
    ctx.lineTo(toX, ty);
  }
  ctx.stroke();
}

function drawCover(ctx, img, x, y, size) {
  const s = Math.min(img.naturalWidth, img.naturalHeight);
  const sx = (img.naturalWidth - s) / 2;
  const sy = (img.naturalHeight - s) / 2;
  ctx.save();
  roundRect(ctx, x, y, size, size, 24);
  ctx.clip();
  ctx.drawImage(img, sx, sy, s, s, x, y, size, size);
  ctx.restore();
}

function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null); // 写真が読めなくてもカードは作る
    img.src = url;
  });
}

/**
 * カードを描いて PNG の Blob を返す。
 * plant: { name, species, traits, origin_sowing_id }、photoUrl: 同一オリジンの署名 URL（無ければ null）
 */
export async function renderLineageCard({ plant, photoUrl, lineage, today }) {
  const canvas = document.createElement('canvas');
  canvas.width = CARD_SIZE;
  canvas.height = CARD_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('画像を作れませんでした。');
  await document.fonts?.ready;

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, CARD_SIZE, CARD_SIZE);
  roundRect(ctx, 30, 30, CARD_SIZE - 60, CARD_SIZE - 60, 36);
  ctx.fillStyle = C.card;
  ctx.fill();

  // 見出し（長い名前はまず文字を小さくし、それでも収まらなければ … で切る）
  const titleW = CARD_SIZE - 140;
  const titleSize =
    [60, 52, 46, 40].find((size) => {
      ctx.font = `700 ${size}px ${FONT}`;
      return ctx.measureText(plant.name).width <= titleW;
    }) ?? 40;
  text(ctx, plant.name, 70, 130, { size: titleSize, weight: 700, max: titleW });
  const sub = [plant.species, plant.origin_sowing_id ? '自家実生' : null].filter(Boolean).join('　/　');
  if (sub) text(ctx, sub, 70, 180, { size: 30, color: C.muted, max: CARD_SIZE - 140 });

  // 写真と特性・系統図の高さから、見出しとフッターの間で縦の中央に置く
  const img = photoUrl ? await loadImage(photoUrl) : null;
  const traits = traitLines(plant.traits);
  const ped = buildPedigree(plant.id, lineage);
  const photoSize = 360;
  const traitsH = traits.length ? 92 + (Math.min(traits.length, 6) - 1) * 52 + 20 : 0;
  const topH = img ? photoSize : traitsH;
  // 系統図の高さ = 見出しまでの 20 + 見出し 24 + 枠（祖父母 4 段で 306。導入株の 1 行は 90）
  const treeH = ped.hasParents ? 20 + 24 + 306 : 20 + 24 + 90;
  const gap = topH ? 40 : 0;
  const areaTop = 210;
  const areaBottom = 975; // フッター（1020）の上に余白を残す
  const topY = areaTop + Math.max(0, (areaBottom - areaTop - (topH + gap + treeH)) / 2);
  let traitX = 70;
  if (img) {
    drawCover(ctx, img, 70, topY, photoSize);
    traitX = 70 + photoSize + 40;
  }
  const traitW = CARD_SIZE - 70 - traitX;
  if (traits.length) {
    text(ctx, '特性', traitX, topY + 36, { size: 24, weight: 700, color: C.mintInk });
    traits.slice(0, 6).forEach((line, i) => {
      text(ctx, line, traitX, topY + 92 + i * 52, { size: 30, max: traitW });
    });
  }

  // 系統図（両親 → 祖父母）
  const treeY = topY + topH + gap + 20;
  text(ctx, ped.self ? '系統（自家受粉）' : '系統', 70, treeY, { size: 24, weight: 700, color: C.mintInk });
  const boxTop = treeY + 24;
  const colW = 440;
  const x1 = 70;
  const x2 = CARD_SIZE - 70 - colW;
  const pH = 140;
  const gH = 66;
  const gGap = 8;
  if (!ped.hasParents) {
    text(ctx, '導入株（親の記録なし）', x1, boxTop + 70, { size: 30, color: C.muted });
  } else {
    const mY = boxTop;
    const fY = boxTop + pH + 20;
    drawSlot(ctx, ped.mother, x1, mY, colW, pH, '母（種子親）', { bg: C.pink, ink: C.pinkInk });
    drawSlot(ctx, ped.father, x1, fY, colW, pH, '父（花粉親）', { bg: C.mint, ink: C.mintInk });
    const roles = ['母の母', '母の父', '父の母', '父の父'];
    const gYs = [0, 1, 2, 3].map((i) => boxTop + i * (gH + gGap) + (i >= 2 ? 20 - gGap + 6 : 0));
    ped.grand.forEach((g, i) => {
      const tone = i % 2 === 0 ? { bg: C.pink, ink: C.pinkInk } : { bg: C.mint, ink: C.mintInk };
      drawGrand(ctx, g, x2, gYs[i], colW, gH, roles[i], tone);
    });
    connector(ctx, x1 + colW, mY + pH / 2, x2, [gYs[0] + gH / 2, gYs[1] + gH / 2]);
    connector(ctx, x1 + colW, fY + pH / 2, x2, [gYs[2] + gH / 2, gYs[3] + gH / 2]);
  }

  // フッター
  text(ctx, `Pollenia 育種記録　${today}`, CARD_SIZE - 70, CARD_SIZE - 60, { size: 22, color: C.muted, align: 'right' });

  return await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('画像を作れませんでした。'))), 'image/png');
  });
}

// 祖父母の枠（1行に役割と名前）
function drawGrand(ctx, s, x, y, w, h, role, tone) {
  roundRect(ctx, x, y, w, h, 14);
  ctx.fillStyle = s.kind === 'plant' ? tone.bg : C.bg;
  ctx.fill();
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 2;
  ctx.stroke();
  text(ctx, role, x + 18, y + h / 2 + 8, { size: 20, weight: 700, color: tone.ink });
  const label = s.kind === 'plant' ? s.name : SLOT_TEXT[s.kind];
  text(ctx, label, x + 110, y + h / 2 + 10, {
    size: 26,
    weight: s.kind === 'plant' ? 700 : 400,
    color: s.kind === 'plant' ? C.ink : C.muted,
    max: w - 128,
  });
}
