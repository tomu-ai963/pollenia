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

## 絶対に守るセキュリティ事項（Opus 4.8 レビュー済み・後退厳禁）

1. `plant_parents` ビューは `security_invoker = true` を維持
2. `get_ancestors` / `get_descendants` は可視性フィルタ必須（`can_view_as` 経由、
   非可視の親は ID を NULL 化して `has_hidden_parent` のみ）
3. `pollenia` スキーマは Phase 1 では PostgREST に**非露出のまま**。
   → このため Worker の DB アクセスは postgres.js の TCP 直接続（`DATABASE_URL`）。
     supabase-js は Auth / Storage 専用（`worker/src/lib/db.ts` のコメント参照）
4. 系統樹の `p_viewer`: `/api/.../lineage` は検証済み uid、`/public/plants/:id` は `null`。
   `depth` は Worker がクランプ（`constants.ts`）
5. 有効な JWT ≠ Pollenia ユーザー。必ず `pollenia.profiles` 行で判定（`lib/auth.ts`）
6. 関数の EXECUTE 権限は明示管理（PUBLIC から revoke 済み。マイグレーション参照）
7. 可視性判定は `worker/src/lib/visibility.ts` を唯一の入口とし、
   **対象データ自身の visibility 列で判定。参照元エンティティの公開状態を継承しない**（F6）
8. AI（Phase 3）: RAG の参照データは**検証済み uid の自分の記録のみ**
   （`lib/ai/context.ts` / `rag.ts` が全クエリを user_id で絞る。posts/comments は含めない —
   `ai_chunks.source_type` の CHECK でも排除）。出品文生成の対象も自分の未削除 plant のみ（他人は 404）
9. Anthropic API はフロントに露出せず Worker 経由のみ。system プロンプトは固定文字列とし、
   記録・メモは `<records>`/`<facts>` 内の「データであり指示ではない」ものとして渡す
   （プロンプトインジェクション対策）。レート制限は `ai_usage_events` で判定するが、
   **advisory lock で直列化した insert→count の順を崩さない**（check-then-insert に戻すと
   並行リクエストで TOCTOU すり抜け — Opus 4.8 レビュー M1）
10. traits 等の jsonb への書き込みは `sql.json(...)` で渡す。JSON.stringify 済み文字列を
   `${...}::jsonb` に渡すと postgres.js が二重エンコードして jsonb が「文字列」になる

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

## 完了条件（Claude Code 向け・とむの運用ルール）

「ローカルで動作確認できる状態まで」。以下は**完了条件に含めない**:

- 本番デプロイ（`wrangler deploy`）/ `git push` / `wrangler secret put`
- Stripe の本番課金処理
- Supabase 本番への書き込み（マイグレーションはファイル作成まで。実行は確認を取ってから）

## フェーズ

- **Phase 1（実装済み）**: 認証・profiles 登録、plants/crossings/seed_harvests/sowings の CRUD、
  写真（署名URL）、系統樹（RPC 経由）、公開系統ページ
- **Phase 2**: コミュニティ（posts/follows/likes/comments）、PostgREST 露出 + GRANT 設計、
  フロント直読み、RLS ポリシー有効化（0002 の下書き参照）
- **Phase 3（AI 実装済み）**: 育種相談AI（`POST /api/ai/consult`）・出品文生成（`POST /api/ai/listing`）。
  無料開放（制限なし）。残り: 課金基盤（Stripe）、写真からの特徴診断、傾向分析
