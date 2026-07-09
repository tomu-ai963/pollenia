# Pollenia データモデル

マイグレーション: `supabase/migrations/0001_init.sql`（実体）、`0002_rls.sql`（RLS）、
`0003_community.sql`、`0004_plant_traits.sql`、`0005_ai.sql`（AI: pgvector + ai_chunks + ai_usage_events）

## テーブル一覧

```
profiles ──┬─ plants ──────────┐
           ├─ crossings ←──────┤ seed_parent / pollen_parent（自家受粉可・父不明NULL可）
           ├─ seed_harvests → crossings
           ├─ sowings → seed_harvests
           │    ↑ plants.origin_sowing_id（実生の個体昇格。NULL=導入株）
           ├─ plant_photos → plants
           ├─ posts（crossing_id 任意）
           ├─ follows / likes / comments
```

## 初期案からの設計変更（判断の記録）

| 変更 | 理由 |
|---|---|
| 全記録テーブルに `user_id` を追加 | 所有者なしでは RLS も公開制御も成立しない。子テーブルにも非正規化して持たせ、RLS/クエリの JOIN を回避 |
| `seedlings` テーブル廃止 → `plants.origin_sowing_id` | seedlings は plant_id リンク以外の情報を持たず、テーブルとして冗長。昇格は plants 作成時に sowing を指すだけ |
| `plants.type`（親株/実生株）廃止 | `origin_sowing_id IS NULL` で導出可能。二重管理はズレの元 |
| `crossings.pollen_parent_id` を NULL 許容 | 自然交雑・父不明は園芸で頻出。母木（seed_parent）のみ必須 |
| 自家受粉（両親同一）を許容 | 実際の育種操作として正当 |
| `plants` は soft delete（deleted_at）+ FK は RESTRICT | 系統記録はユーザー資産。親個体の物理削除で他人の見る系統樹が壊れることを防ぐ |
| `sowings.germination_count` を初期から追加 | 有料機能「発芽率グラフ」の元データ。後から足すと過去データが欠損する |
| `photo_url` → `plant_photos` テーブル + `storage_path` | 個体写真は成長記録として複数枚が自然。URL でなくパス保存（署名付きURLを都度発行） |
| `species` カラム追加 | 検索軸として必要。まず自由入力、需要が出たらマスタ化 |
| 全テーブルに created_at / updated_at | 標準装備（updated_at はトリガーで自動更新） |

## 系統樹の取得

- 1世代 = plants → sowings → seed_harvests → crossings の4段 JOIN のため、
  `plant_parents` ビュー（child → 両親の crossing を1行に平坦化）を挟んで再帰CTEを単純化。
- `get_ancestors(plant_id, max_depth)` / `get_descendants(plant_id, max_depth)` を RPC として提供。
  - `path uuid[]` でサイクル打ち切り（データ不正で無限ループしない）
  - 無料プランの世代制限（1〜2世代）は Worker が `max_depth` に渡すだけで実現
- crossings の `seed_parent_id` / `pollen_parent_id` 両方に個別インデックス（再帰は両方向を辿る）。

## 可視性モデル

- `visibility` ENUM: `public` / `followers` / `private`。plants と posts が持つ。
- crossings / seed_harvests / sowings 自体は可視性を持たない（所有者のみ）。
  他人に見せる系統は RPC が plants.visibility で刈り込んで返す。
  理由: 片親 private・片親 public の交配を行単位ポリシーで正しく表現できないため、
  「見せる単位は個体（plant）」に寄せる。

## AI（Phase 3・0005_ai.sql）

- `ai_chunks` … RAG 検索対象。ユーザー自身の plants / crossings / seed_harvests / sowings を
  正規化テキスト + 埋め込み（`vector(1536)`）で保持。`(user_id, source_type, source_id)` 一意。
  `source_type` は CHECK で 4 種に限定（posts / comments を参照範囲に含めない方針を物理的に担保）。
  同期はチャット時の遅延同期（`content_hash` = SHA-256 で差分検知）。
  ベクトルインデックスは張らない（検索は必ず user_id で絞った後の少量データの seq scan で十分。
  スケール時に ivfflat 等を検討）。
- `ai_usage_events` … AI 呼び出しの利用ログ（kind: consult / listing）。レート制限
  （回/分・回/日）の count 元 + コスト把握。
- どちらも RLS 有効・ポリシー無し（deny-all）を維持。PostgREST 非露出・Worker 経由のみ。

## 将来の拡張候補（今はやらない）

- species マスタテーブル化・タグ
- posts への写真添付（post_photos。plant_photos と同じ形）
- 通知テーブル（フォロー・いいね・コメント時）
- 有料プラン管理（profiles.plan ではなく subscriptions テーブルを推奨。課金導入時に設計）
