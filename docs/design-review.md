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

### 追加スキーマ（translations / processing_jobs は migration 2 で実装済み。FTS と embeddings は migration 3、summaries は migration 7）

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

## 3. 翻訳 slice（実装済み。Mazelingo 方式）

翻訳アルゴリズムと表示は Mazelingo（MIT, © 2026 Yeq6X）を移植した。移植したコードのファイル冒頭に出典を記載している。

```
末端 block の inline HTML 断片（属性は除去、a[href] は残す、画像などは ⟦n⟧）
 → LLM: 断片を「読みの単位」（文。長い文は節）に分割し、単位ごとに HTML を保ったまま翻訳
 → 1:1 で照合（重複・不正・範囲外は破棄）→ 欠けた断片は 1 件ずつ再試行
 → 長すぎる単位（CJK は 45 字、それ以外は 140 字を超えるもの）は再分割を 1 回だけ依頼。連結すると元の HTML に完全に戻る場合だけ採用
 → segment_translations（本文の正規化テキストの hash をキーとするキャッシュ）
```

| 対象 | ファイル |
|---|---|
| 読みの単位での翻訳（prompt・照合・再試行・再分割） | `crates/lattice-core/src/segments.rs` |
| Provider 境界（汎用の structured JSON 補完） | `crates/lattice-core/src/llm.rs` |
| Claude CLI adapter | `crates/lattice-core/src/claude.rs` |
| 記事単位の翻訳 job（Reader 用の事前翻訳） | `crates/lattice-core/src/translate.rs`、`jobs.rs` |
| ページ overlay | `src/overlay/`（`dom.ts`、`logic.ts`、`index.ts`） |

- **キャッシュは本文の hash 1 つで共有する。** hash は `segments::source_hash`（タグを除き、⟦n⟧ を除き、空白を正規化したテキストの sha256）で、`blocks.text_hash` と一致する。ページ上の overlay で訳した段落は、Index に追加した記事の Reader と全文検索にそのまま使われ、記事単位の翻訳 job の結果も overlay で使われる（実機で確認済み）。記事から独立しているので、再抽出しても訳は失われない。
- **途中で失敗しても失われない。** batch ごとに保存するので、再試行で送るのは未翻訳の分だけになる。provider が全滅した batch は job を失敗させて backoff する。
- **表示言語の割り当て。** block ごとに、単位数 × `percent` の数だけを日本語にする。どの単位を日本語にするかは、ページ URL と本文から作る seed で決める（同じページを開き直しても同じ混在になる）。
- **操作。** 300ms hover すると吹き出しにもう一方の言語を表示し、吹き出しをクリックするとその文を反転する。Reader（抽出テキスト）でも同じ操作にした（block 単位。キーボードでは Enter で切り替える）。
- **翻訳対象。** 英語の prose だけを訳す（日本語が優勢な block は送らない）。code / pre / nav / header / footer / aside、`translate="no"` は対象外。

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
| Tauri commands・アプリ内ブラウザ | `src-tauri/src/lib.rs`、`src-tauri/src/browser.rs` |
| Reader | `src/Reader.tsx` |

### Bulk import

- 貼り付けたテキストか、読み込んだファイル（URL 一覧、bookmarks HTML、CSV、JSON、Markdown）から http(s) の URL を抜き出す（`ingest::extract_urls`）。順序は保ち、正規化した URL で重複を除く。
- 各 URL を pending の記事として登録し、`ingest` job を投入する。job は 4 本の network runner が並列に処理する（翻訳や embedding とは別の runner）。
- 取得や抽出に失敗した URL は記事側に記録し（一覧に「失敗」と表示）、全体の処理は止めない。取得に成功した記事には embed job を投入する。

### 運用（設定・バックアップ・ログ）

- **モデル選択。** 翻訳と要約に使う provider とモデルを、最大 3 つの fallback として設定画面で選ぶ（§6）。`settings` テーブル（migration 8）に保存する。
- **バックアップ（§17）。** `VACUUM INTO` で、稼働中でも整合したコピーを `app_data/backups/lattice-<unix秒>.db` に書き出す。重要なデータはすべてこの 1 ファイルに入っている。
- **ログ（§25 Observability）。** `tauri-plugin-log` で `app_log_dir/lattice.log` と stdout に出力する。job の失敗は job・記事・試行回数を記録し、`processing_jobs` にも `last_error` / `attempt_count` / 時刻が残る。

### セキュリティ境界

- **アプリ UI（main webview）には記事の HTML を一切入れない。** Reader が受け取るのは IR（JSON）だけで、React の text node として描画する。
- **元ページは別の child webview（`browser`）に表示する。** これはリモート origin なので、capability `browser-overlay` で許可しているのは `overlay_config` と `overlay_translate` の 2 つだけ（`build.rs` で全コマンドの permission を生成している）。ほかのコマンドはページ側から呼べないことを実機で確認した（例: `db_path not allowed on ... webview "browser"`）。app UI 用の capability は `webviews: ["main"]` かつ local origin に限定している。
- `overlay_translate` は、ユーザーが翻訳を ON にしている間だけ、browser webview からの呼び出しにだけ応答する。件数（24 件まで）とサイズ（1 断片 20KB まで）にも上限がある。ページ側の script が呼べてしまう点は許容しており、その影響は LLM の使用量に限られる（CLI は tool なしで実行する）。
- **LLM の出力は untrusted HTML として扱う。** overlay は sanitize（許可した inline タグ、http(s) の link、イベントハンドラの除去）してから差し込む。
- **browser webview は http(s) 以外に遷移しない**（`on_navigation`）。新しいウィンドウを開くリンクは同じ webview で開く。
- main webview の CSP は `default-src 'self'` で、Reader はリモート画像を読み込まない。

### 未実装（意図的）

JS で描画するページの Index 追加（今はサーバーから再取得した HTML を抽出する）、bulk import の同一ホスト宛て並列数の制限、検索の metadata filter、reranker、re-extract コマンド（block ID の再利用も含む）、画像の保存。

## 6. LLM provider と Fallback chain（F2〜F4。実装済み）

```
domain（segments / translate / summarize / overlay）→ LlmChain（LlmProvider）
 → 1 → 2 → 3 の順に試す: Claude CLI / Codex CLI / OpenAI API / Gemini API
 → 答えた provider と model を Completion に載せ、派生データの provider / model に記録
```

| 対象 | ファイル |
|---|---|
| Chain・設定の読み書き・API キー | `crates/lattice-core/src/chain.rs` |
| Codex CLI adapter（`codex exec --json --output-schema`） | `crates/lattice-core/src/codex.rs` |
| OpenAI API adapter（Responses API、strict JSON schema） | `crates/lattice-core/src/openai.rs` |
| Gemini API adapter（`generateContent`、`responseJsonSchema`） | `crates/lattice-core/src/gemini.rs` |
| 共通（strict schema 変換、HTTP エラーの分類） | `crates/lattice-core/src/llm.rs` |
| Tauri commands（`get_llm_settings` / `set_llm_chain` / `set_api_key`） | `src-tauri/src/lib.rs` |
| 設定 UI | `src/ModelSettings.tsx` |

- **Chain も `LlmProvider` を実装する。** domain 側は provider が 1 つでも chain でも同じコードで動く。`LlmProvider` は object-safe でないので、provider は enum（`AnyLlm`）で持つ。
- **Fallback の条件。** どのエラー（`Unavailable` / `Failed` / `Malformed`）でも次の entry に進む。usage limit・認証・timeout など `Malformed` 以外で失敗した entry は 5 分間だけ順番を最後に回す（in-memory。全 entry が後回しなら設定順にすべて試す）。全滅したときは各 entry のエラーをつないで返し、job は従来どおり backoff する。
- **記録する provider。** `Completion.provider` に実際に答えた provider（`claude-cli` / `codex-cli` / `openai-api` / `gemini-api`）を入れ、`segment_translations` / `summaries` に記録する。CLI が model を返さないとき（Codex）は設定した model を記録する。1 つの batch の中で再試行が別の provider に回った場合も、記録するのは最初に答えた provider だけ（従来の model と同じ扱い）。
- **設定。** `settings.llm_chain` に `[{kind, model}]` の JSON で保存する。未保存なら旧 `claude_model` を 1 つ目（Claude CLI）として読む。保存すると chain を作り直す（job runner は同じ `Arc` を共有したまま、`RwLock` の中身だけ差し替える）。
- **API キー。** `secret.openai_api_key` / `secret.gemini_api_key` に保存し、バックアップからは除かれる（`backup_to`）。未設定なら環境変数 `OPENAI_API_KEY` / `GEMINI_API_KEY` を使う。UI に返すのはキーの有無と出所（保存／環境変数）だけ。キーがない entry は `Unavailable` になり次へ進む。
- **Untrusted input（§25）。** どの adapter にも tool を渡さない。Codex は user config・rules・web search・shell などの tool feature をすべて無効にし、read-only sandbox・空の一時ディレクトリ・`--ephemeral` で動かす。指示は prompt 引数、記事テキストは stdin（`<stdin>` block）で渡す。API は structured output だけを使う。
- **モデルの選択肢。** Claude は alias（haiku / sonnet / opus）、Codex は `~/.codex/models_cache.json` にある ID、OpenAI API は既定を `gpt-6-luna`、Gemini API は既定を `gemini-flash-latest` にした。どれも「その他」でモデル ID を直接入力できる（F2 の修正。選択状態を model 値と別に持つ）。

### 未実装（意図的）

API の usage（token 数）の記録、entry ごとの timeout 設定、chain の実機での疎通確認 UI。
