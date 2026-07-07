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

## Phase 2

| Method | Path | 内容 |
|---|---|---|
| GET/POST | /api/posts | フィード・投稿（下記の crossing 展開に注意） |
| POST/DELETE | /api/posts/:id/likes | いいね |
| GET/POST | /api/posts/:id/comments | コメント |
| POST/DELETE | /api/users/:id/follow | フォロー |
| GET | /api/users/:id | 公開プロフィール |

- **post に紐付く crossing の展開は post とは別に可視性判定すること。**
  `posts.visibility` の既定は `public`、`plants` の既定は `private` と非対称なため、
  公開 post が非公開の crossing（＝非公開の親個体）を `crossing_id` で参照しうる。
  post が閲覧可でも、`crossing_id` の交配詳細・親個体名を展開する際は必ず
  `can_view(crossing.user_id, ...)` や親 plants の可視性を別途チェックし、
  不可視なら crossing 情報を伏せて post 本文だけ返す（閲覧者へ非公開系統を漏らさない）。

## Phase 3（有料）

- POST /api/ai/consult — 育種相談（knowledge-rag の RAG 構成を流用、ユーザー自身の記録をコンテキスト化）
- POST /api/ai/listing — 出品文生成（メルカリ・ヤフオク向け）
- POST /api/ai/diagnose — 写真からの特徴診断・自動メモ化
- GET /api/analytics/germination — 発芽率グラフ（sowings.germination_count / sowing_count 集計）

エラーレスポンス・HTTP ヘルパーは knowledge-rag の `lib/http.ts` / `lib/error-response.ts` の形式を踏襲する。
