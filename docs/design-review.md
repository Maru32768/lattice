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
| LLM 連携 | `claude -p --output-format json --json-schema` を subprocess で起動する | 決定 | ユーザーの既存の CLI ログインを使う。記事本文は untrusted なので、`--tools ""`、`--strict-mcp-config`、`--setting-sources ""` で tool・MCP・設定をすべて無効にし、空の一時ディレクトリで実行する。`LLMProvider` trait は `llm.rs`（テスト用 fake と合わせて実装が 2 つある）。 |
| Job runner | SQLite の `processing_jobs` を、アプリ内の tokio task が直列に処理する。LLM 系（translate）とローカル系（embed）で runner を分ける | 決定 | 起動時に `running` を `pending` に戻す。失敗時は指数 backoff（2, 4, 8… 分）、5 回で `failed`。手動の再実行で backoff を解除する。 |
| Vector search | `embeddings` テーブル（f32 BLOB）を Rust で総当たりして cosine を計算する | 暫定 | 10^5〜10^6 block 程度まではこれで足りる。それを超えたら sqlite-vec か ANN に移す（`Store::scan_embeddings` の 1 箇所を差し替えればよい。`shortcut:` で記録済み）。 |
| Embedding model | multilingual-e5-small（fastembed／ONNX Runtime、384 次元） | 決定 | ローカルで動き、日本語の query と英語の本文をまたいで検索できる。モデル（約 470MB）は初回利用時に `app_data_dir/models` へダウンロードする。`EmbeddingProvider` trait の裏にあり、vector は model ID ごとに保存するので、モデルを替えても古い index と混ざらない。**ビルドには MSVC 14.4x（VS 2022 17.10 以降）が必要**（ONNX Runtime の配布バイナリの要件）。 |
| Hybrid ranking | Reciprocal Rank Fusion（k=60） | 決定 | bm25 と cosine はスケールが違うので、weighted score にすると調整が必要になる。RRF は順位だけで統合できる。 |
| ツール管理 | mise（`mise.toml` で Node / Rust を固定し、`mise run dev` / `mise run test` を提供する） | 決定 | Vite 8 は Node 20.19 以上が必要。パッケージマネージャは npm。 |

### 抽象化の方針（§18 への回答）

§18 が挙げる 6 つの interface のうち、**今 trait にするのは 0 個**。

- `ArticleFetcher` / `ContentExtractor` / `ArticleRepository`: 現時点で実装は 1 つだけ。モジュール境界（`fetch.rs` / `extract.rs` / `store.rs`）で十分で、関数シグネチャはすでに差し替えやすい形になっている。
- `LLMProvider`: 翻訳スライスで trait にした（`llm.rs`）。
- `SearchIndex` / `EmbeddingProvider`: semantic search スライスで導入する。

§18 の「交換可能性が実際に必要な境界だけ抽象化する」を、「2 つ目の実装が現れた時点で抽象化する」と解釈した。

## 2. データモデルレビュー

### 指摘と変更

1. **生 HTML の snapshot が欠けている（重要）。** §1「URL 切れに耐える」と `extraction_version` による再抽出を両立するには、取得した HTML を保持しておく必要がある。→ `snapshots` テーブルを追加した。再抽出はネットワークなしで行える。
   - 規模の見積もり: 1 記事あたり HTML は 100KB〜1MB なので、10^5 記事では数十 GB になりうる。→ migration 4 で deflate 圧縮した（pure Rust の flate2。技術記事の HTML ならおおよそ 1/5〜1/8 になる）。それ以前の行は無圧縮（`encoding = 'identity'`）のまま読める。
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
11. **FTS の tokenizer。** `unicode61` は日本語を分かち書きできない。`trigram` は日英両方で部分一致でき、`pg_visibility` のような識別子にも強い。その代わり 3 文字未満のクエリ（「索引」など）は LIKE にフォールバックさせる必要がある。→ `trigram` を採用した（migration 3）。原文 block と翻訳文の両方を index する。

### 追加スキーマ（translations / processing_jobs は migration 2 で実装済み。summaries は未実装。FTS と embeddings は migration 3）

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

## 3. 翻訳 slice（実装済み）

```
「日本語に翻訳」→ processing_jobs（記事単位、dedup_key で冪等）→ worker
 → 未翻訳の prose block を最大 40 件・6000 文字ずつ Claude CLI へ → batch ごとに translations へ保存
 → `article-changed` event → Reader が再読込（翻訳は batch ごとに順次表示される）
```

| 対象 | ファイル |
|---|---|
| Provider 境界 | `crates/lattice-core/src/llm.rs` |
| Claude CLI adapter | `crates/lattice-core/src/claude.rs` |
| 翻訳 job | `crates/lattice-core/src/translate.rs` |
| Job runner | `crates/lattice-core/src/jobs.rs` |
| 表示言語の選択 | `src/mixed.ts`（テストは `src/mixed.test.ts`） |

- **途中で失敗しても失われない。** batch ごとに commit するので、usage limit で止まっても、再試行で送るのは未翻訳の block だけになる。返ってきた ID は送った batch の中のものだけを受け付ける（モデルが他の block に書き込めないようにするため）。
- **inline code を保護する。** 送信時に `inlines` の code を backtick で囲み、訳文の backtick を Reader で `<code>` に戻す。訳文の link は失われる（原文に toggle すれば辿れる）。
- **表示言語の選択は純粋関数。** `translatedBlockIds(blocks, mode, percent)` は DB に状態を持たない（§UC4）。Mixed mode では、翻訳済みの block 数を基準に `percent` を均等に配分する（先頭に偏らない）。block ごとのクリック toggle（Enter キーでも可）は Reader の state で、記事を切り替えるとリセットされる。
- **翻訳の鮮度。** 表示するのは、`source_hash = blocks.text_hash` を満たす最新の翻訳だけ。原文が変わった block は未翻訳として扱われる。
- **翻訳対象。** heading / paragraph / list_item / blockquote / caption。code・table・image は対象外。

## 4. 検索 slice（実装済み）

```
保存 → embed job（ローカル runner）→ 見出しを付けた prose block を e5 で embedding → embeddings
Query → FTS5 trigram（原文 + 訳文、bm25）─┐
      → e5 query embedding → cosine top-50 ┴→ RRF → block 単位の結果 → クリックで該当 block へ移動
```

| 対象 | ファイル |
|---|---|
| Embedding 境界・e5 adapter・embed job | `crates/lattice-core/src/embed.rs` |
| Hybrid search・RRF | `crates/lattice-core/src/search.rs` |
| FTS・vector の永続化 | `crates/lattice-core/src/store.rs`（migration 3） |
| 結果表示 | `src/SearchResults.tsx`、`src/search.ts` |

- **全文検索。** 3 文字以上の語は trigram の index で MATCH し、3 文字未満の語（「索引」など）は LIKE で絞り込む。入力はすべて quote するので、FTS5 の構文として解釈されない。block や翻訳を削除すると、trigger で index からも消える。
- **意味検索。** prose block に、その block が属する見出しを前置して embedding する（短い list item の文脈を補うため）。e5 の `query:` / `passage:` prefix は adapter 側で付ける。
- **縮退。** モデルが未ダウンロード、オフライン、ロード失敗などで意味検索が使えないときは、全文検索だけで結果を返し、UI にその理由を出す（§2.3 LLM／モデル非依存）。
- **Backfill。** 起動時に、現在のモデルの embedding が欠けている記事へ embed job を投入する。既存記事の取り込みと、モデルを切り替えたときの再 index を兼ねる。
- **Metadata filter**（read／domain など）は未実装。`lexical_search` / `scan_embeddings` に条件を足す形で追加できる。

## 5. 取り込み slice（実装済み）

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

要約、Codex adapter、検索の metadata filter、reranker、モデル選択などの設定 UI（今は CLI の既定モデル）、bulk import、tags／favorite の UI、re-extract コマンド（block ID の再利用も含む）、画像の保存、ファイルへのログ出力（今は stderr と `processing_jobs` の `last_error` / `attempt_count`）。
