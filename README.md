# Pollenia

植物の交配・育種記録を管理し、SNS的に共有できるアプリ。
育種の系統記録がフリマ出品時の信頼性・付加価値になる「趣味→収益化」導線が差別化の核。

## 技術スタック

| レイヤ | 技術 |
|---|---|
| 配信 | Cloudflare Workers（1つの Worker で画面 `frontend/` の静的配信と API を兼ねる） |
| DB | Neon（PostgreSQL + pgvector）。Worker からは Hyperdrive 経由の postgres.js |
| 認証 | `@tomu-ai/workers-auth` の deviceAuth（メールコード → 信頼済み端末 + PIN。Cookie） |
| メール | Resend（送信元ドメイン tomu-ai.dev） |
| ストレージ | Cloudflare R2（バケット `pollenia-photos`。閲覧は Worker が署名した URL） |
| AI | Anthropic API（有料プランのみ） |
| 課金 | Stripe（月額サブスク ¥300） |

2026-10 に tomu-system の Supabase（`pollenia` スキーマの間借り・Supabase Auth・Storage）から
切り出した。ユーザーがいなかったのでデータ移行はしていない。

## ディレクトリ構成

```
pollenia/
├── README.md
├── AGENTS.md            # エージェント向け作業規約
├── docker-compose.yml   # ローカル Postgres（pgvector:pg17、127.0.0.1:55435）
├── _docs/
│   ├── datamodel.md     # ER設計と設計判断の記録
│   └── api.md           # Worker API 仕様
├── db/
│   ├── init/            # ローカル DB の初期化（所有者ロール・pgvector）
│   └── migrations/      # 0001_schema.sql 形式の連番（worker/scripts/migrate.mjs が適用）
├── worker/
│   ├── wrangler.toml    # [assets]=../frontend、R2、Hyperdrive
│   ├── package.json
│   ├── .dev.vars.example
│   ├── scripts/         # setup-local / migrate / dev
│   ├── src/
│   │   ├── index.ts     # Hono のルーティング（認証・DB 接続のミドルウェア）
│   │   ├── env.ts       # 環境変数の型
│   │   ├── constants.ts
│   │   ├── lib/         # auth.ts / mail.ts / photos.ts / db.ts / http.ts / error-response.ts
│   │   │   └── ai/      # Phase 3: embeddings / context / rag / anthropic / rate-limit
│   │   ├── routes/      # plants.ts / records.ts / lineage.ts / posts.ts / follows.ts / ai.ts / billing.ts
│   │   └── services/    # lineage.ts
│   └── test/
└── frontend/            # 静的ファイル（ビルドなし）。Worker の [assets] として配信
    ├── _headers         # CSP などのレスポンスヘッダ
    ├── index.html
    ├── public.html      # 公開系統ページ（/public?id=...）
    └── src/
```

## ローカル開発

前提: Docker Desktop が起動していること（手動起動が要ることがある）。

```bash
cd worker && npm install
npm run db:up        # .env（DB パスワード）と .dev.vars の不足キーを生成し、Postgres を起動
npm run db:migrate   # db/migrations を適用（public.schema_migrations で管理）
npm run dev          # http://localhost:8787（画面も API も同じ URL）
npm run typecheck && npm test
```

- ログインコードは `MOCK_MAIL=1` で wrangler dev のログに出る（`localhost` / `127.0.0.1` からのリクエストのみ）
- Cookie は `__Host-` + `Secure`。Chrome / Edge / Firefox は `http://localhost` でも受け取る
- DB を作り直すときは `npm run db:reset`（ボリュームごと削除）→ `db:up` → `db:migrate`
- 適用済みのマイグレーションは書き換えない（sha256 が変わると migrate.mjs が止まる）。変更は新しい番号で足す

## 本番の構成と初回セットアップ（すべてとむの確認を取ってから実行）

```
1. Neon: プロジェクト pollenia を作成し、SQL Editor で `create extension if not exists vector;`
2. マイグレーション: DATABASE_URL を環境変数で渡して `npm run db:migrate -- --allow-remote`
3. Hyperdrive: `npx wrangler hyperdrive create pollenia-neon --caching-disabled --connection-string=...`
   （Neon の直接接続 = -pooler なし）→ wrangler.toml の id を差し替え
4. R2: `npx wrangler r2 bucket create pollenia-photos`
5. secret: DEVICE_AUTH_SECRET / RESEND_API_KEY / MAIL_FROM / ANTHROPIC_API_KEY / OPENAI_API_KEY /
   STRIPE_*（SUCCESS/CANCEL/PORTAL_RETURN の URL は https://pollenia.tomu-ai.dev 基準）
6. deploy（worker/ で実行）→ Custom Domain `pollenia.tomu-ai.dev` を付与
7. Stripe の Webhook URL を https://pollenia.tomu-ai.dev/api/billing/webhook に変更
8. 旧構成の片付け: tomu-system の `pollenia` スキーマ・`pollenia_worker` ロール・`pollenia-` バケット、
   旧 Hyperdrive 設定（pollenia-db）、Pages プロジェクト pollenia
```

## 運用の掟

1. **Worker はスキーマ所有者ロールで接続し、認可は Worker が担う**。全テーブルは RLS 有効・ポリシー無し
   （deny-all）で、所有者以外のロール（将来 Neon の Data API 等を有効化した場合の匿名・認証ロール）に
   対する最終防衛線。ポリシーを足すときは Worker の認可と二重管理になる点に注意。
2. **有効なセッション ≠ Pollenia ユーザー**。メールコードを通っただけで表示名を登録していない
   `pollenia.users` 行がありうる。API は必ず `pollenia.profiles` 行の存在で判定する（`lib/auth.ts`）。
3. **Pollenia のテーブル・関数・ENUM は `pollenia` スキーマ**。`public` には workers-auth の `auth_*` と
   `schema_migrations` だけを置く。
4. **関数の EXECUTE は PUBLIC から revoke**（definer 関数を所有者以外が直接呼べないように）。
   ビュー `plant_parents` は `security_invoker = true` を維持する。
5. **公開系統ページ（匿名シェア URL）は `get_ancestors/get_descendants` を `p_viewer => NULL` で呼ぶ**。
   これらの関数は viewer から見えるノードだけを返し、非可視の親は ID を伏せて `has_hidden_parent`
   フラグのみ立てる。Worker は返却された可視 `plant_id` にだけ名前・写真を join すること
   （生の plant_id 全件を join すると非公開個体の名前・写真が漏れる）。
6. **写真の閲覧 URL は可視性判定を通した後でだけ署名する**（`/photos/*` 自体は認証を要求しない）。
   R2 のキーは Worker が採番し、Content-Type は許可リストから Worker が決める。
7. **workers-auth の pg ストアの前提を崩さない**: 1リクエスト1接続、Hyperdrive は `--caching-disabled`、
   読み取りレプリカに向けない。SDK を上げたら `db/migrations/0002_workers_auth.sql` を原本から作り直す
   （`worker/test/migrations.test.ts` が検知する）。

## ロードマップ

- **Phase 1（MVP）**: 認証、個体・交配・採種・播種の記録、写真、系統樹表示、公開系統ページ（シェアURL）
- **Phase 2**: コミュニティ（投稿・フォロー・いいね・コメント）、followers 可視性、フィード
- **Phase 3（AI 実装済み）**: 育種相談AI（自分の記録のみを RAG 参照）・出品文生成（メルカリ/ヤフオク）。
  無料開放期間として全ユーザーに開放。残り: 課金基盤（Stripe）、写真からの特徴診断、傾向分析、全世代系統樹の制限解除
