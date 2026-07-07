# Pollenia

植物の交配・育種記録を管理し、SNS的に共有できるアプリ。
育種の系統記録がフリマ出品時の信頼性・付加価値になる「趣味→収益化」導線が差別化の核。

## 技術スタック

| レイヤ | 技術 |
|---|---|
| フロントエンド | Cloudflare Pages（静的） |
| バックエンド | Cloudflare Workers |
| DB | Supabase (PostgreSQL) — tomu-system プロジェクトの `pollenia` スキーマに間借り |
| 認証 | Supabase Auth |
| ストレージ | Supabase Storage（バケット名は `pollenia-` prefix 必須） |
| AI | Anthropic API（有料プランのみ） |

## ディレクトリ構成

```
pollenia/
├── README.md
├── AGENTS.md            # エージェント向け作業規約（他プロジェクトと同様）
├── _docs/
│   ├── product.md       # プロダクト仕様・プラン設計
│   ├── datamodel.md     # ER設計と設計判断の記録
│   └── api.md           # Worker API 仕様
├── supabase/
│   ├── config.toml
│   └── migrations/      # 0001_init.sql 形式の連番（contract-review と同じ流儀）
├── worker/
│   ├── wrangler.toml
│   ├── package.json
│   ├── tsconfig.json
│   ├── .dev.vars.example
│   ├── src/
│   │   ├── index.ts     # ルーティングのみ
│   │   ├── env.ts       # 環境変数の型と検証
│   │   ├── constants.ts
│   │   ├── lib/         # supabase.ts / auth.ts / http.ts / error-response.ts
│   │   ├── routes/      # plants.ts / records.ts / lineage.ts / posts.ts / social.ts
│   │   └── services/    # lineage.ts、将来 ai/（knowledge-rag の RAG 構成を流用）
│   └── test/
└── frontend/            # Cloudflare Pages（他プロジェクトと同じ静的構成）
    ├── index.html
    └── src/
```

## セットアップ

```bash
# マイグレーション適用（tomu-system プロジェクトに対して）
# ※ supabase CLI の migration 履歴は tomu-system 本体と共有になるため、
#    pollenia のマイグレーションは psql で直接適用し、このリポジトリで履歴管理する
psql "$TOMU_SYSTEM_DB_URL" -f supabase/migrations/0001_init.sql
psql "$TOMU_SYSTEM_DB_URL" -f supabase/migrations/0002_rls.sql

# Worker
cd worker && npm install
cp .dev.vars.example .dev.vars   # SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / DATABASE_URL を埋める
npm run dev

# Storage: private バケット `pollenia-photos` を作成しておく（写真アップロードに必要）
```

**Phase 1 では `pollenia` を PostgREST の Exposed schemas に追加しないこと。**
露出すると deny-all RLS でも関数/ビュー経由でバイパスされうる（下記「掟」6 参照）。
フロント直読みを解禁する Phase 2 で、テーブル/ビュー/関数ごとの明示 GRANT 設計とセットで露出する。

このため Worker からの `pollenia` スキーマへの DB アクセス（テーブル・RPC）は
**postgres.js**で行う。supabase-js の DB アクセスは PostgREST 経由であり、
非露出スキーマは service_role でも呼べない（service_role がバイパスするのは RLS で
あってスキーマ露出ではない）ため使わない。supabase-js は Auth の JWT 検証
（`auth.getUser`）と Storage の署名URL発行にのみ使う。

接続経路は **Cloudflare Hyperdrive** バインディング（`worker/wrangler.toml`）:

```
ローカル: wrangler dev が localConnectionString（supabase start の 54322）を
          HYPERDRIVE.connectionString として注入（本番と同一コードパス）
本番:     wrangler hyperdrive create で作成した設定（接続情報は Cloudflare 側にのみ保存。
          origin は Supabase の Direct connection 推奨 — wrangler.toml のコメント参照）
予備:     バインディングが無い環境は DATABASE_URL 直接続にフォールバック（lib/db.ts）
```

## 間借り運用の掟（将来の独立切り出しのため）

1. **`auth.users` への FK は `pollenia.profiles` の1箇所だけ**。業務テーブルは必ず profiles を参照する。
2. **public スキーマのテーブル・関数・ENUM を一切参照しない**。すべて `pollenia.` 内で完結させる。
3. **Storage バケットは `pollenia-` prefix**。tomu-system のバケットと混在させない。
4. **マイグレーションはこのリポジトリで管理**し、tomu-system の migration 履歴に混ぜない。
5. **有効な JWT ≠ Pollenia ユーザー**。tomu-system は Auth レルム（auth.users・JWT シークレット）を
   全テナントで共有するため、B2B 側（contract-review 等）のために発行された JWT も同一プロジェクトなら
   検証を通る。Worker は「Supabase JWT が有効」で認可せず、`pollenia.profiles` 行の存在（＋必要なら
   アプリ固有クレーム）で判定すること。
6. **`pollenia` を Phase 1 で PostgREST に露出しない**。露出＋grant があると、
   deny-all RLS でも (a) ビューが `security_invoker` 未指定だと RLS バイパス、(b) 関数の
   既定 PUBLIC EXECUTE 経由で anon が直接呼べる、の二経路で認可層（Worker）を迂回されうる。
   マイグレーション側で `security_invoker=true`・PUBLIC からの `revoke execute` を施した上で、
   露出は Phase 2 に GRANT 設計とともに先送りする。
7. **公開系統ページ（匿名シェア URL）は `get_ancestors/get_descendants` を `p_viewer => NULL` で呼ぶ**。
   これらの RPC は viewer から見えるノードだけを返し、非可視の親は ID を伏せて `has_hidden_parent`
   フラグのみ立てる。Worker は返却された可視 `plant_id` にだけ名前・写真を join すること
   （生の plant_id 全件を join すると非公開個体の名前・写真が漏れる）。
8. 切り出し時の手順（想定）:
   - `pg_dump --schema=pollenia` でスキーマごとダンプ → 新プロジェクトにリストア
   - 切り出し先も Supabase 前提（`can_view`/`can_view_as` が `auth.uid()` に依存。`pg_dump --schema`
     は `auth` スキーマを含めないため、`auth.uid()` が存在する環境へ復元する）
   - Auth ユーザーは Admin API でエクスポート/インポート（UUID を維持すれば profiles との整合が保たれる）
   - Storage は `pollenia-` バケットのオブジェクトをコピー
   - Worker の接続先 URL / キーを差し替え

## ロードマップ

- **Phase 1（MVP）**: 認証、個体・交配・採種・播種の記録、写真、系統樹表示、公開系統ページ（シェアURL）
- **Phase 2**: コミュニティ（投稿・フォロー・いいね・コメント）、followers 可視性、フィード
- **Phase 3**: 課金基盤、AI機能（育種相談・出品文生成・特徴診断）、傾向分析、全世代系統樹の制限解除
