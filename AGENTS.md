# AGENTS.md — Pollenia

植物の交配・育種記録を管理し、SNS的に共有できるアプリ。
育種の系統記録がフリマ出品時の信頼性・付加価値になる「趣味→収益化」導線が差別化の核。
設計の詳細は `README.md` / `_docs/`（datamodel.md, api.md）を必ず先に読むこと。

## 技術スタック

- フロント: Cloudflare Pages（静的・ビルドなし。`frontend/`）
- API: Cloudflare Workers（TypeScript。`worker/`）
- DB: Supabase Postgres — **tomu-system プロジェクトの `pollenia` スキーマに間借り**
- 認証: Supabase Auth（共有 Auth レルム。README「掟」5 参照）
- AI: Anthropic API（Phase 3・実装済み。`worker/src/lib/ai/`）/ 課金: Stripe（スコープ外）

## セキュリティ規約

絶対に守るセキュリティ事項（Opus 5 レビュー済み・後退厳禁・10項目）は
`.claude/rules/security.md` に移設。`worker/src/**/*.ts` を触るときに自動で読み込まれる。

## コーディング規約

- knowledge-rag / contract-review と同じ流儀（`lib/http.ts` / `lib/error-response.ts` 形式、
  エラーは固定文言 + コード + request_id、詳細はログのみ）
- マイグレーションは `supabase/migrations/` の連番で**このリポジトリ**が管理
  （tomu-system の migration 履歴に混ぜない。適用は psql 直叩き）
- シークレットはコード・wrangler.toml に書かない（ローカル `.dev.vars`、本番 `wrangler secret put`）
- Storage バケットは `pollenia-` prefix、public スキーマには何も置かない

## ローカル開発

```bash
cd worker && npm install
cp .dev.vars.example .dev.vars   # 値を埋める
npm run dev                      # wrangler dev --local
npm run typecheck && npm test
# DB: supabase start（tomu-system リポジトリ側）→ psql でマイグレーション適用
# Storage: `pollenia-photos` バケット（private）を作成しておく
```

## フェーズ

- **Phase 1（実装済み）**: 認証・profiles 登録、plants/crossings/seed_harvests/sowings の CRUD、
  写真（署名URL）、系統樹（RPC 経由）、公開系統ページ
- **Phase 2**: コミュニティ（posts/follows/likes/comments）、PostgREST 露出 + GRANT 設計、
  フロント直読み、RLS ポリシー有効化（0002 の下書き参照）
- **Phase 3（AI 実装済み）**: 育種相談AI（`POST /api/ai/consult`）・出品文生成（`POST /api/ai/listing`）。
  無料開放（制限なし）。残り: 課金基盤（Stripe）、写真からの特徴診断、傾向分析
