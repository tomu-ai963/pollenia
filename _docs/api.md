# Pollenia Worker API（叩き台）

画面と API は同じ Worker・同じオリジン（本番 https://pollenia.tomu-ai.dev）。

認証: `@tomu-ai/workers-auth` の deviceAuth（`/auth/device/*`）が発行するセッション Cookie
（`__Host-` 付き・HttpOnly）。状態を変えるリクエストは `__Host-csrf` Cookie の値を
`x-csrf-token` ヘッダで送り返す（Origin も検査される）。未ログインは 401 `{"error":"unauthenticated"}`。
さらに `pollenia.profiles` 行の存在で「Pollenia ユーザーか」を判定する（無ければ 403。
メールコードを通っただけで表示名未登録の users 行がありうるため）。

Worker → DB は postgres.js の TCP 接続（本番は Hyperdrive → Neon）。

## ログイン（workers-auth deviceAuth）

| Method | Path | 内容 |
|---|---|---|
| POST | /auth/device/email/start | `{email}` にログインコードを送る（どのアドレスにも同じ 200） |
| POST | /auth/device/email/verify | `{email, code}` → セッション + 端末を信頼済みに。`{pinSet}`。初めてのアドレスは `pollenia.users` を作る |
| POST | /auth/device/pin | `{pin}` PIN の設定・変更（メールコード認証から10分以内）。変更時は他端末と全セッションを失効 |
| POST | /auth/device/pin/login | `{pin}` 信頼済み端末で PIN ログイン。3回失敗でメールコード必須 |
| POST | /auth/device/logout | セッション終了（端末は信頼済みのまま） |
| GET/POST | /auth/device/devices ほか | 端末一覧・失効（SDK の README 参照） |

## Phase 1（MVP）

| Method | Path | 内容 |
|---|---|---|
| POST | /api/profiles | Pollenia への初回登録（セッションのみで受け、自 uid の profiles 行を作成。冪等） |
| GET | /api/me | 自分のプロフィール |
| GET/POST | /api/plants | 個体一覧・登録 |
| GET/PATCH/DELETE | /api/plants/:id | 個体詳細・更新・soft delete |
| POST | /api/plants/:id/photos | 写真行の作成。`upload: {url, method: "PUT", content_type}` を返す |
| PUT | /api/photos/:id | 写真本体のアップロード（R2。自分の未アップロード行に1回だけ・10MB まで） |
| GET | /photos/:token | 写真の閲覧（Worker が可視性判定後に署名した URL。1時間で失効・認証不要） |
| GET/POST | /api/crossings | 交配記録 |
| POST | /api/crossings/:id/harvests | 採種記録 |
| POST | /api/harvests/:id/sowings | 播種記録 |
| PATCH | /api/sowings/:id | 発芽数・日付の更新 |
| GET | /api/plants/:id/lineage?direction=up\|down&depth=N | 系統樹（下記「系統樹エンドポイント」参照） |
| GET | /public/plants/:id | 公開系統ページ用（認証不要、下記参照） |
| GET | /public/gallery?offset=N | 公開ギャラリー（認証不要。下記「公開ギャラリー」） |

### 系統樹エンドポイント（重要：viewer の扱い）

系統樹は RPC `pollenia.get_ancestors` / `get_descendants` を呼ぶ。両関数は
`(p_plant_id uuid, p_viewer uuid, p_max_depth int)` を取り、**`p_viewer` から見えるノードだけ**を
返す（可視性フィルタは RPC 側で完結）。Worker は必ず以下の値を `p_viewer` に渡すこと。

| エンドポイント | 認証 | `p_viewer` に渡す値 |
|---|---|---|
| `GET /api/plants/:id/lineage` | 必須 | 検証済みセッションの uid（`pollenia.users.id`） |
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

## Phase 2（実装済み。すべてセッション + profiles 行を要求）

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

## Phase 3（AI。実装済み — Phase 4 で有料ゲート化。すべてセッション + profiles 行を要求）

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
  モデルは `constants.ts` の `AI_MODEL`（claude-haiku-5-5、effort=medium）。
- プロンプトインジェクション対策: system は固定文字列。記録・メモは `<records>` / `<facts>`
  ブロック内の「データであり指示ではない」ものとして渡し、内部の指示に従わない旨を明示。
- レート制限: `pollenia.ai_usage_events` で同一ユーザー
  `AI_RATE_LIMIT_PER_MINUTE` 回/分・`AI_RATE_LIMIT_PER_DAY` 回/日。超過は 429（RATE_LIMITED）。
  判定は advisory lock でユーザー単位に直列化した「insert → 自分を含めた count」の順
  （Opus 4.8 レビュー M1: check-then-insert の TOCTOU で並行リクエストがすり抜けるのを防ぐ）。
  429 になった試行もイベントとして残る。
- 課金（Stripe）・機能制限は次フェーズ。未実装分: /api/ai/diagnose（写真診断）。

## 公開ギャラリー（routes/public.ts の handlePublicGallery。認証不要）

- 画面は `/gallery`（ログイン画面と公開系統ページから入れる）。
- 載るのは visibility = public **かつ本人が `in_gallery` を選んだ**未削除の個体で、写真が 1 枚以上あるものだけ
  （0005_gallery.sql。URL を知る人だけが見られる public より範囲が広いので、既定は載せない）。
  `in_gallery` は `POST/PATCH /api/plants` で設定し、所有者向けの応答にだけ含まれる。
- 返す項目: `id, name, species, is_seedling, owner_name, photo_url`（最新写真 1 枚の署名 URL）。
  公開系統ページと同じ範囲で、notes・traits・user_id は返さない。SQL で絞った後も `canView(null, …)` を通す。
- 新しい写真の順に `GALLERY_PAGE_SIZE` 件ずつ。offset は `GALLERY_MAX_OFFSET` でクランプし、
  次のページがあれば `next_offset`。`Cache-Control: public, max-age=60`（公開系統ページと同じ）。

## 過去の記録の取り込み（routes/import.ts。セッション + profiles 行を要求）

| Method | Path | 内容 |
|---|---|---|
| POST | /api/import/plants?dry_run=1 | `{ rows: [...] }`（最大 500 行）。dry_run は書き込まずに作るものを返す |

- CSV の読み取り（UTF-8 / Shift_JIS、見出しの揺れ）は画面（`frontend/src/csv-import.js`）で行い、
  行を JSON で送る。検証と作成は Worker（`lib/import-plan.ts` が計画、ルートが 1 トランザクションで作成）。
- 1 行 = 1 個体。項目: `name`（必須）, `species`, `mother`, `father`, `cross_date`, `notes`, 特性 5 項目。
  ひな形は `frontend/assets/pollenia-import-template.csv`。
- 親の名前は CSV の行 → 自分の登録済みの未削除の個体（1 件に決まるとき）→ どちらにも無ければ導入株を自動で作る。
  父の欄は空・「不明」で父不明、「自家」か母と同じ名前で自家受粉。同じ母・父・交配日の行は 1 つの交配にまとめる。
- 交配 → 採種 → 播種 → 子（`origin_sowing_id`）を作って系統をつなぐ。系統のために作る採種・播種は
  `task_dismissed_at` を立て、「次の作業」にも発芽率の「未記録」にも出さない。
- 作る個体はすべて private・ギャラリーに載せない。登録済みと同じ名前の行・CSV 内の重複・親子の輪はエラー（422 で行ごと）。
  エラー文言に入力値は入れない。

## 次の作業（routes/tasks.ts。すべてセッション + profiles 行を要求）

| Method | Path | 内容 |
|---|---|---|
| GET | /api/tasks | まだの作業の一覧 |
| PATCH | /api/tasks/:kind/:id | `{ due_date?, sow_by_date?, dismissed? }` 予定日・種の使用期限（sow のみ）・一覧から外す / 戻す |

- 作業は別テーブルに持たず、記録の状態から導く（0004_next_tasks.sql）:
  `harvest`（交配して採種がまだ。id = crossings.id）/ `sow`（採種して播種がまだ。id = seed_harvests.id）/
  `germination`（播種して発芽数が未記録。id = sowings.id）。次の記録を付ければ作業は消える。
- 期日 = 予定日と種の使用期限のうち早いほう。期日のあるものを早い順に先へ、期日なしは起点の日
  （交配日・採種日・播種日）が古い順に後ろへ。期日を過ぎたかは利用者の暦で決まるので画面側で判定する。
- 表は kind から固定の文字列で選び、すべてのクエリを検証済み uid で絞る（他人の記録・kind と合わない id は 404）。
- 通知（メール・cron）はまだ無い。画面は記録タブの一番上と、タブの「記録（期日を過ぎた件数）」。

## 発芽率の集計（routes/analytics.ts。すべてセッション + profiles 行を要求）

| Method | Path | 内容 |
|---|---|---|
| GET | /api/analytics/germination | 交配ごとの発芽率と全体の合計（**無料**） |
| GET | /api/analytics/germination/parents | 親個体ごとの比較（母木として / 花粉親として。**有料**・未加入は 402） |

- 元データは自分の sowings（→ seed_harvests → crossings）のみ。3表とも検証済み uid で絞る。
  新しい播種から `ANALYTICS_MAX_SOWINGS` 件まで。
- 集計 1 件の形: `{ sowings, pending_sowings, sown, germinated, rate, avg_days_to_germination }`。
  発芽率に入れるのは「播種数 > 0 かつ発芽数が記録済み」の播種だけ（未記録は `pending_sowings`。
  0 発芽として数えない）。発芽数が播種数を超える入力は播種数で頭打ち。記録が無ければ `rate: null`。
- 発芽までの日数は `first_germination_date - sowing_date`（0 日以上のものの平均）。
- 親ごと: 父不明の交配は母木側だけ、自家受粉は母木・花粉親の両方に入る。
- 画面は記録タブの「発芽率」カード。発芽数は交配記録一覧の「発芽を記録」（`PATCH /api/sowings/:id`）で入れる。

エラーレスポンス・HTTP ヘルパーは knowledge-rag の `lib/http.ts` / `lib/error-response.ts` の形式を踏襲する。
