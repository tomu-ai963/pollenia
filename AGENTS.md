# AGENTS.md — Pollenia

植物の交配・育種記録を管理し、SNS的に共有できるアプリ。
育種の系統記録がフリマ出品時の信頼性・付加価値になる「趣味→収益化」導線が差別化の核。
設計の詳細は `README.md` / `_docs/`（datamodel.md, api.md）を必ず先に読むこと。

## 技術スタック

- 配信: Cloudflare Workers 1つ（`worker/`）。画面 `frontend/`（静的・ビルドなし）は `[assets]` で同じ Worker から配信
- DB: **Neon**（Postgres + pgvector）。Worker からは Hyperdrive（`--caching-disabled`）経由の postgres.js
- 認証: `@tomu-ai/workers-auth` v0.3.1 の deviceAuth（メールコード → 信頼済み端末 + PIN。Cookie・同一オリジン）。
  登録は誰でも可。メール送信は Resend（tomu-ai.dev）
- 写真: Cloudflare R2（`pollenia-photos`。閲覧は Worker が署名した `/photos/<token>`）
- AI: Anthropic API（`worker/src/lib/ai/`）/ 課金: Stripe（月額 ¥300。AI 機能の有料ゲート）

2026-10 に tomu-system の Supabase から切り出した（Supabase Auth / Storage / 共有 Auth レルムはもう使わない）。

## セキュリティ規約

絶対に守るセキュリティ事項（後退厳禁）は `.claude/rules/security.md`。
`worker/src/**/*.ts` を触るときに自動で読み込まれる。

## コーディング規約

- knowledge-rag / contract-review と同じ流儀（`lib/http.ts` / `lib/error-response.ts` 形式、
  エラーは固定文言 + コード + request_id、詳細はログのみ）
- マイグレーションは `db/migrations/` の連番。`worker/scripts/migrate.mjs` が適用し
  `public.schema_migrations` で管理（適用済みファイルは書き換えない）
- シークレットはコード・wrangler.toml に書かない（ローカル `.dev.vars` / リポジトリ直下 `.env`、本番 `wrangler secret put`）
- `npx wrangler deploy` は必ず `worker/` で実行する（ルートで実行すると別 Worker が作られる）

## ローカル開発

```bash
cd worker && npm install
npm run db:up && npm run db:migrate   # docker の Postgres（127.0.0.1:55435）
npm run dev                           # http://localhost:8787（MOCK_MAIL=1 でログインコードはログに出る）
npm run typecheck && npm test
```

## フェーズ

- **Phase 1（実装済み）**: 認証・profiles 登録、plants/crossings/seed_harvests/sowings の CRUD、
  写真（R2・署名URL）、系統樹（関数経由）、公開系統ページ
- **Phase 2（実装済み）**: コミュニティ（posts/follows/likes/comments）。フィードは Worker の2段階クエリ
- **Phase 3（AI 実装済み）**: 育種相談AI（`POST /api/ai/consult`）・出品文生成（`POST /api/ai/listing`）
- **Phase 4（課金 実装済み）**: Stripe 月額サブスク ¥300、AI 機能の有料ゲート（402）。
  残り: 写真からの特徴診断、傾向分析
