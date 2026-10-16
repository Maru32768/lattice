# 設計レビュー: 技術選定とデータモデル

要件定義 §26 の「最初に決める事項」に対するレビューと決定事項。各項目の状態は「決定」「暫定」「保留」で示す。

## 1. 技術選定

| 候補 | 判定 | 理由 |
|---|---|---|
| **Tauri 2** | 採用 | Electron に比べて軽量。capability による IPC 権限制御が §25 Security（記事 HTML から native API を呼ばせない）に直接効く。 |
| **Rust** | 採用 | fetch・抽出・SQLite・job runner を UI プロセスから分離できる。ドメインロジックは `crates/lattice-core` に置き、Tauri には依存させない（CLI や bulk import から再利用できる）。 |
| **React + TypeScript** | 採用 | Reader は IR の block 列をコンポーネントとして描画するだけなので、どの UI フレームワークでも成立する。慣れたものを使えばよい。 |
| **SQLite** | 採用 | 要件どおり。`rusqlite`（bundled）を使い、FTS5 は同梱ビルドに含まれる。WAL モードで動かす。 |
| **Cloudflare** | **MVP では不採用** | §1「初期段階ではクラウドサービスを前提としない」、§2.1 と矛盾する。将来の候補として R2 は暗号化 backup／同期先、Workers Cron は remote RSS collector（取得した記事を desktop が pull する）。現時点ではコードも抽象化も入れない。 |

### 選定したライブラリ

| 用途 | 選定 | 状態 | 備考 |
|---|---|---|---|
| 本文抽出 | `dom_smoothie`（Mozilla Readability.js の Rust 移植） | 決定 | 抽出を WebView の JS で行うと untrusted HTML を UI プロセスで扱うことになるため Rust 側で行う。抽出後の HTML は `dom_query` で走査して block 化する。 |
| HTTP | `reqwest` + native-tls | 決定 | Windows では SChannel を使う。rustls/aws-lc は Windows でビルド依存が増えるため避けた。body は 20MB を上限にする。 |
| DB アクセス | `rusqlite`（ORM なし） | 決定 | `PRAGMA user_version` による append-only migration。 |
| LLM 連携 | `claude -p --output-format json` を subprocess で起動する | 暫定 | 次スライスで実装。`LLMProvider` trait はこの時点で導入する（Claude／Codex の 2 実装が確実に必要になる境界のため）。 |
| Vector search | `sqlite-vec` | 保留 | embedding スライスで検証する。`SearchIndex` 境界の裏に隠す。 |
| Embedding model | — | 保留 | ローカル（fastembed／ONNX、多言語 e5 系）か API かは、日英混在検索の精度を測ってから決める。 |
| Node | Volta で 22 に固定（`package.json` の `volta`） | 決定 | Vite 8 は Node 20.19 以上が必要。 |

### 抽象化の方針（§18 への回答）

§18 が挙げる 6 つの interface のうち、**今 trait にするのは 0 個**。

- `ArticleFetcher` / `ContentExtractor` / `ArticleRepository`: 現時点で実装は 1 つだけ。モジュール境界（`fetch.rs` / `extract.rs` / `store.rs`）で十分で、関数シグネチャはすでに差し替えやすい形になっている。
- `LLMProvider`: Claude／Codex の実装を入れるときに trait にする。
- `SearchIndex` / `EmbeddingProvider`: semantic search スライスで導入する。

§18 の「交換可能性が実際に必要な境界だけ抽象化する」を、「2 つ目の実装が現れた時点で抽象化する」と解釈した。

## 2. データモデルレビュー

### 指摘と変更

1. **生 HTML の snapshot が欠けている（重要）。** §1「URL 切れに耐える」と `extraction_version` による再抽出を両立するには、取得した HTML を保持しておく必要がある。→ `snapshots` テーブルを追加した。再抽出はネットワークなしで行える。
   - 規模の見積もり: 1 記事あたり HTML は 100KB〜1MB なので、10^5 記事では数十 GB になりうる。bulk import の前に zstd 圧縮を入れる（コード中に `shortcut:` で記録済み）。
2. **`extraction_status` が Article の定義にない。** §6 では必要とされている。→ `fetch_status` と `extraction_status`（`pending` / `ok` / `failed`）を追加した。失敗した記事も行として残し、同じ URL を再保存すると再試行になる。
3. **§2.3 の線形状態遷移（DISCOVERED→…→ENRICHED）は採用しない。** 翻訳・要約・embedding は互いに独立していて、しかも block 単位で部分的に完了する。単一の status 列では「翻訳 60% 完了、要約は失敗」を表せない。→ Article が持つのは取り込みの状態（fetch / extraction）だけにする。LLM 系の進捗は `processing_jobs` と派生テーブルの有無から導く。
4. **block にインライン構造がない。** `original_text` だけでは link と inline code（`pg_visibility` など、技術記事で重要なもの）が失われる。→ `text`（plain text。検索・翻訳・hash の単位）と `inlines`（JSON。`text` / `code` / `link` の run）に分けた。emphasis は今は text に潰す。
5. **heading level と list の深さがない。** → `attrs` JSON に `level` / `ordered` / `depth` / `lang` / `src` / `rows` を持たせる。kind ごとに列を増やさずに済む。
6. **`normalized_text` 列は不要。** 正規化は FTS の tokenizer と hash の計算時に行えば足りる。列として持つと、同じ内容のデータが 2 つになる。
7. **`parent_heading` → `heading_id`（直前の heading block への FK）。** 検索結果の「Section」表示と block jump にそのまま使える。
8. **block ID の安定性。** `id INTEGER PRIMARY KEY`（VACUUM で変わらない）と `text_hash` を持たせる。再抽出のときは `text_hash` が一致する block の id を再利用し、それ以外は新規にする。`translations` も `source_hash` を持つので、原文が変わったことを検出できる。ID 再利用は翻訳スライスで実装する（今は全置換。`shortcut:` で記録済み）。
   - 同期を入れるときは端末間で ID が衝突するため、`uid TEXT`（UUIDv7）列を追加する。今は入れない。
9. **重複判定で `content_hash` を一意キーにしない。** paywall ページや「記事が見つかりません」ページは同じ hash になり、別々の記事が誤って統合される。→ `normalized_url` を UNIQUE にし、取得後に `canonical_url` で統合する。`content_hash` は index を張るだけで、参考情報として使う。
10. **ProcessingJob に足りないもの。** 次スライスで以下を追加する。
    - `params` JSON（target_language、prompt_version）
    - `dedup_key UNIQUE`（enqueue を冪等にするため）
    - `next_run_at`（usage limit のときの backoff）
    - `locked_at`（crash 後の復旧。起動時に、古い `running` を `pending` に戻す）
    - **job の粒度は article 単位にする。** block 単位で CLI を起動すると、1 記事 100 プロセスになり現実的でない。結果は block 単位で保存する。
11. **FTS の tokenizer。** `unicode61` は日本語を分かち書きできない。`trigram` は日英両方で部分一致でき、`pg_visibility` のような識別子にも強い。その代わり 3 文字未満のクエリ（「索引」など）は LIKE にフォールバックさせる必要がある。→ 検索スライスで `trigram` を第一候補として検証する。原文 block だけでなく翻訳文も index し、日本語で英語記事を検索できるようにする。

### 次スライス以降で追加するスキーマ（案）

```sql
CREATE TABLE translations (
  id INTEGER PRIMARY KEY,
  block_id INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  target_language TEXT NOT NULL,
  text TEXT NOT NULL,
  source_hash TEXT NOT NULL,          -- blocks.text_hash at translation time
  provider TEXT NOT NULL, model TEXT, prompt_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);  -- 表示時は (block_id, target_language) ごとに最新かつ source_hash が一致するものを使う

CREATE TABLE summaries (
  id INTEGER PRIMARY KEY,
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  type TEXT NOT NULL, text TEXT NOT NULL, source_hash TEXT NOT NULL,
  provider TEXT NOT NULL, model TEXT, prompt_version TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE processing_jobs (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL, article_id INTEGER REFERENCES articles(id) ON DELETE CASCADE,
  params TEXT, dedup_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  next_run_at TEXT, locked_at TEXT,
  created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT
);

CREATE VIRTUAL TABLE blocks_fts USING fts5(text, content='blocks', content_rowid='id', tokenize='trigram');
```

## 3. Mixed mode / translation ratio の実装方針（次スライス）

- 表示言語の選択は**純粋関数**にする: `(blocks, translations, ratio) -> Set<block_id>`。DB に状態を持たせない（§UC4「表示のみ切り替え」）。
- 初期の規則: 翻訳済みの prose block のうち、先頭から一定の間隔で `ratio` に相当する割合を選ぶ（偏らないように Bresenham 風に配分する）。
- block ごとのクリック toggle は React の state に持つ（記事を切り替えたらリセットする）。

## 4. Vertical slice（実装済み）

```
URL 入力 → normalize（tracking param 除去）→ dedup → fetch（上限・タイムアウトあり）
 → snapshot 保存 → Readability 抽出 → block 化 → SQLite（1 transaction）→ Reader
```

| 対象 | ファイル |
|---|---|
| IR | `crates/lattice-core/src/ir.rs` |
| 抽出・block 分割 | `crates/lattice-core/src/extract.rs` |
| fetch | `crates/lattice-core/src/fetch.rs` |
| URL 正規化 | `crates/lattice-core/src/url_norm.rs` |
| スキーマ・リポジトリ | `crates/lattice-core/src/store.rs` |
| パイプライン | `crates/lattice-core/src/ingest.rs` |
| Tauri commands | `src-tauri/src/lib.rs` |
| Reader | `src/Reader.tsx` |

### セキュリティ境界

- 記事 HTML は WebView に渡さない。UI が受け取るのは IR（JSON）だけで、React の text node として描画する。`dangerouslySetInnerHTML` は使わない。
- link は http(s) のものだけを残す（`javascript:` などは text に落とす）。クリックするとシステムのブラウザで開き、WebView は遷移しない。
- 厳格な CSP を設定する（`default-src 'self'`）。リモート画像は読み込まない（tracking 対策。画像の保存方式は §26.10 で保留）。
- Tauri capability は `core:default` と `opener:default` のみ。

### 未実装（意図的）

翻訳、要約、LLM 連携、FTS、bulk import、tags／favorite の UI、re-extract コマンド、画像の保存、snapshot の圧縮、`<meta charset>` の判定。
