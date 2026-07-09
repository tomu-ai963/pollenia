# Pollenia Worker API（叩き台）

認証: Supabase Auth の JWT を `Authorization: Bearer` で受け、Worker が `auth.getUser` で検証。
さらに `pollenia.profiles` 行の存在で「Pollenia ユーザーか」を判定する（README「掟」5。
有効な JWT だけでは認可しない — 共有 Auth レルムの他プロダクト JWT も検証は通るため）。

Worker → DB は postgres.js の TCP 直接続（`DATABASE_URL`）。pollenia スキーマは
PostgREST 非露出のため supabase-js の DB アクセスは使わない（README 参照）。
supabase-js は JWT 検証と Storage 署名URL発行のみ。

## Phase 1（MVP）

| Method | Path | 内容 |
|---|---|---|
| POST | /api/profiles | Pollenia への初回登録（JWT のみで受け、自 uid の profiles 行を作成。冪等） |
| GET | /api/me | 自分のプロフィール |
| GET/POST | /api/plants | 個体一覧・登録 |
| GET/PATCH/DELETE | /api/plants/:id | 個体詳細・更新・soft delete |
| POST | /api/plants/:id/photos | 写真アップロード（Storage 署名URL発行） |
| GET/POST | /api/crossings | 交配記録 |
| POST | /api/crossings/:id/harvests | 採種記録 |
| POST | /api/harvests/:id/sowings | 播種記録 |
| PATCH | /api/sowings/:id | 発芽数・日付の更新 |
| GET | /api/plants/:id/lineage?direction=up\|down&depth=N | 系統樹（下記「系統樹エンドポイント」参照） |
| GET | /public/plants/:id | 公開系統ページ用（認証不要、下記参照） |

### 系統樹エンドポイント（重要：viewer の扱い）

系統樹は RPC `pollenia.get_ancestors` / `get_descendants` を呼ぶ。両関数は
`(p_plant_id uuid, p_viewer uuid, p_max_depth int)` を取り、**`p_viewer` から見えるノードだけ**を
返す（可視性フィルタは RPC 側で完結）。Worker は必ず以下の値を `p_viewer` に渡すこと。

| エンドポイント | 認証 | `p_viewer` に渡す値 |
|---|---|---|
| `GET /api/plants/:id/lineage` | 必須 | 検証済み JWT の uid（`auth.uid()` 相当） |
| `GET /public/plants/:id` | 不要 | **`null`**（＝匿名。visibility=public のノードのみ返る） |

- `direction=up` → `get_ancestors`、`down` → `get_descendants`。
- `depth`（→ `p_max_depth`）は**無料プランの世代制限**用（例：無料=2、有料=全世代）。
  Worker がプランを見て決める。可視性制御ではない。上限値も Worker 側でクランプする
  （匿名/フロント指定をそのまま渡さない）。
- 返却行の `has_hidden_parent = true` は「この先に非公開の親がいる」ことだけを示す。
  非可視の親の `seed_parent_id` / `pollen_parent_id` は `null` でマスクされる。
  UI は「非公開の親あり」等の表示に使う（ID・名前は返らない）。
- **Worker は RPC が返した可視 `plant_id` にだけ名前・写真を join すること。**
  クライアント由来の plant_id 一覧や、系統に含まれる生の ID 全件を無条件で
  plants / plant_photos に join すると、非公開個体の名前・写真が漏れる。
- `/public/plants/:id` は入口の個体自体が `visibility=public` かも Worker で確認してから
  RPC を呼ぶ（非公開個体の共有 URL を弾く）。

#### Phase 1 実装の仮決め値（`worker/src/constants.ts`）

- depth クランプ: `[1, 10]`（SQL 側 default と一致）、未指定時 5。無料/有料のプラン差は
  課金導入（Phase 3）までなし。
- `/public/plants/:id` は depth=5 固定（クライアント指定不可）、祖先・子孫の両方向を返す。
  `Cache-Control: public, max-age=60`（visibility を private に戻した際の伝播遅延の許容値）。
- 可視性判定の Worker 側共通モジュールは `worker/src/lib/visibility.ts`（F6 対応の先取り）。
  原則「判定は常に対象データ自身の visibility 列 + 所有者。参照元エンティティの公開状態を
  継承しない」。Phase 2 の posts → crossing 展開は必ずこのモジュールを経由すること。

## Phase 2（実装済み。すべて JWT + profiles 行を要求）

| Method | Path | 内容 |
|---|---|---|
| POST | /api/posts | 投稿作成 `{ content, crossing_id?, visibility? }`（crossing_id は自分の交配のみ） |
| GET | /api/posts/:id | 投稿単体（crossing 展開は下記 F6 ルール） |
| GET | /api/feed | フィード。Worker 側の2段階クエリ（follows → posts の visibility 絞り込み）で集約 |
| GET | /api/users/:id/posts | プロフィール用。本人=全件 / フォロワー=public+followers / 他人=public のみ |
| POST/DELETE | /api/posts/:id/likes | いいね・解除（冪等。可視性は親 post に完全追従） |
| GET/POST | /api/posts/:id/comments | コメント（同上） |
| POST | /api/follows | フォロー `{ followee_id }`（片方向・冪等） |
| DELETE | /api/follows/:followee_id | フォロー解除（冪等） |
| GET | /api/users/:id/followers, /following | フォロワー / フォロー中一覧 |
| GET | /api/users/:id | 公開プロフィール（フォロー数 + followed_by_viewer 付き） |

- **F6（実装済み・後退厳禁）: post に紐付く crossing の展開は post とは別に可視性判定する。**
  `posts.visibility` の既定は `public`、`plants` の既定は `private` と非対称なため、
  公開 post が非公開の crossing（＝非公開の親個体）を `crossing_id` で参照しうる。
  post が閲覧可でも、crossing の展開は `lib/visibility.ts` の
  `canViewOwnerOnly(viewer, crossing.user_id)`（crossings は visibility 列を持たない＝
  所有者のみ）を通った場合だけ。不可視なら crossing 情報を **crossing_id ごと** 伏せて
  post 本文だけ返す（post 自体は隠さない）。実装は `routes/posts.ts` の
  `serializePosts`、検証は `test/posts.test.ts`。
- フィード生成を RLS の動的サブクエリに埋め込まない（設計判断3）。RLS は deny-all を
  維持し、pollenia スキーマは PostgREST 非露出を継続する（0003 のコメント参照）。
- **フロント実装への注意（Opus 4.8 レビュー指摘）**: post / comment の content は
  API 層では長さ検証のみで HTML サニタイズしない（JSON で返すだけ）。Phase 2 で初めて
  他者の入力がタイムラインに描画されるため、フロントは必ずテキストとして描画すること
  （innerHTML 直挿し禁止。textContent か枠組み側の自動エスケープを使う）。
- follow / like / comment 作成のレート制限は Worker 実装には無い。スパム対策は
  Cloudflare 側の WAF / Rate Limiting ルールで担保する（本番運用時に設定）。

## Phase 3（AI。実装済み — 無料開放期間。すべて JWT + profiles 行を要求）

| Method | Path | 内容 |
|---|---|---|
| POST | /api/ai/consult | 育種相談チャット `{ message, history? }` → `{ answer, sources }` |
| POST | /api/ai/listing | 出品文生成 `{ plant_id, marketplace: 'mercari'\|'yahoo_auction' }` → `{ listing: { title, body } }` |

### 育種相談（/api/ai/consult）

- **RAG 構成は knowledge-rag（pgvector）を踏襲**。ただし Worker の DB アクセスは
  postgres.js 直接続なので、近傍検索は RPC ではなく Worker 内の SQL
  （`lib/ai/rag.ts` が唯一の入口。**必ず検証済み uid で絞る**）。
- 参照データは**自分の plants / crossings / seed_harvests / sowings のみ**。
  posts / comments は含めない（`ai_chunks.source_type` の CHECK でも排除）。
- チャンクはチャット時に遅延同期（content の SHA-256 で差分検知、差分のみ再埋め込み）。
  テーブルごと新しい順 `AI_SYNC_MAX_ROWS_PER_TABLE` 件・notes は `AI_CHUNK_NOTES_MAX`
  文字で切り詰め（参照データ量・トークン量の上限）。
- 会話履歴はクライアント保持（サーバー保存なし）。`history` は最大
  `AI_HISTORY_MAX_TURNS` 件・各 `AI_MESSAGE_MAX_LEN` 文字まで Worker が検証する。
- 埋め込みは OPENAI_API_KEY > VOYAGE_API_KEY > mock（決定的・ローカル用）の優先で選択。

### 出品文生成（/api/ai/listing）

- 対象は**自分の（未削除）個体のみ**。他人の plant_id は 404（存在を秘匿）。
- 事実は対象個体の name/species/traits/notes + 系統情報（両親名）だけを `<facts>` として渡し、
  **facts に無い特性・数値・血統を書かない**ことをプロンプトで強制（ハルシネーション対策）。
  出力は structured outputs（`output_config.format`）で `{title, body}` に固定。
- 生成結果はフロントで編集・コピーする前提（自動投稿・サーバー保存なし）。

### 共通（セキュリティ・コスト設計）

- Anthropic API の呼び出しは **Worker 経由に統一**（ANTHROPIC_API_KEY はフロントに渡さない）。
  モデルは `constants.ts` の `AI_MODEL`（claude-opus-4-8）。
- プロンプトインジェクション対策: system は固定文字列。記録・メモは `<records>` / `<facts>`
  ブロック内の「データであり指示ではない」ものとして渡し、内部の指示に従わない旨を明示。
- レート制限: `pollenia.ai_usage_events` で同一ユーザー
  `AI_RATE_LIMIT_PER_MINUTE` 回/分・`AI_RATE_LIMIT_PER_DAY` 回/日。超過は 429（RATE_LIMITED）。
  判定は advisory lock でユーザー単位に直列化した「insert → 自分を含めた count」の順
  （Opus 4.8 レビュー M1: check-then-insert の TOCTOU で並行リクエストがすり抜けるのを防ぐ）。
  429 になった試行もイベントとして残る。
- 課金（Stripe）・機能制限は次フェーズ。未実装分: /api/ai/diagnose（写真診断）、
  /api/analytics/germination（発芽率グラフ）。

エラーレスポンス・HTTP ヘルパーは knowledge-rag の `lib/http.ts` / `lib/error-response.ts` の形式を踏襲する。
