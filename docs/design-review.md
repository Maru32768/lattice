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
8. **block ID の安定性。** `id INTEGER PRIMARY KEY`（VACUUM で変わらない）と `text_hash` を持たせる。再抽出のときは `text_hash` が一致する block の id を再利用し、それ以外は新規にする。`translations` も `source_hash` を持つので、原文が変わったことを検出できる。ID 再利用は §6 で実装した（`store::replace_blocks`）。
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
- **翻訳対象。** 訳先の言語ですでに書かれている prose は送らない（日本語の訳なら日本語が優勢な block、英語の訳ならそれ以外）。code / pre / nav / header / footer、`translate="no"` は対象外（aside は記事中の囲み記事が本文なので訳す）。訳先の言語は §16 を参照。
- **訳し直す（G29）。** Reader の ⋯ と、全部訳し終えたときの翻訳状況の横に「訳し直す」を置く。`translate::retranslate` が、記事の prose block の hash と今の訳先の key に一致する `segment_translations` の行を消し（FTS の行は trigger で消える）、translate job を積み直す。job は全 block を未翻訳として見るので cache を通らない。provider は chain のまま（この実行だけ別の provider を選ぶことはしない）。訳文が 50 block を超えるときだけ確認ダイアログを出す。
  - cache は本文 1 つにつき 1 つなので、同じ段落を持つほかの記事とページ表示も新しい訳になる（記事ごとに訳を持たせると、ページ表示や検索と共有する今の設計が崩れる）。別の訳先（英訳、専門用語モード、追加の指示）の行は消さない。
  - 訳し直しの途中で失敗すると、その記事は訳のない block が残る（古い訳には戻らない）。job は従来どおり backoff して再試行し、「続きを翻訳」も使える。翻訳 job の実行中は「訳し直す」を押せない（実行中の job は積み直せず、消した分が訳されないまま終わるため）。

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
- **Metadata filter。** `lexical_search` / `scan_embeddings` / `search::search` は記事 ID の集合（`Option<&[i64]>`）で絞り込める。`None` のときの SQL は従来と同じで、全体検索は遅くならない。今は対話ペインだけが使い、検索ボックスにはまだ出していない。

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

### Markdown の取り込み（G48）

- **入口。** インポート画面の「Markdown」タブ（サイドバーの ＋、パレットの「Markdown を取り込む」、空のライブラリのカードからも開く）。ファイル（.md / .markdown）か貼り付けたテキストを 1 つの記事にし、取り込んだら Reader で開く。変換は `crates/lattice-core/src/markdown.rs`（pulldown-cmark）。
- **IR への変換。** 見出し・段落・リスト（深さ・番号付き、タスクリストは ☑ / ☐）・引用・コード（fence の言語）・表・画像・リンク・インラインコードを、HTML の抽出と同じ block にする。強調は平文にする。リンクは http(s) だけ残し、相対リンクは平文。HTML タグ（インライン・ブロックとも）と YAML front matter は捨てる（untrusted）。タイトルは最初の H1（文書の先頭なら本文からは除く）、なければファイル名、なければ最初の行。
- **URL のない記事。** `original_url` / `normalized_url` を `local:md/<本文の sha256>`（BOM・改行コードを揃え、前後の空白を除いた本文）、`domain` を空にする。同じ本文を取り込み直すと同じ記事を返す（重複しない）。snapshot には Markdown の原文を `content_type = 'text/markdown'` で保存し、再抽出は原文を変換し直す（タイトルが H1 でなければ今のタイトルを保つ）。`thin` にはならない（短いメモはそれで全文）。UI は `isLocal` で見分け、Page を無効にし（tooltip で理由）、「再試行」「描画して取り込み直す」を出さず、サイト名を「ローカル」と表示する。`openPage` に local の URL が来たら Reader を開く（`v`・一覧から Page で開く・引用のどれでも）。
- **画像。** http(s) の画像は通常の画像 job で保存する（Referer は送らない）。相対パスの画像は、ファイルから取り込んだときだけ、そのファイルのフォルダから読む。ファイルは backend が開くダイアログで選ぶので、webview がパスを渡すことはない（`import_markdown_file`。`tauri-plugin-dialog` は Rust からだけ使い、JS の権限は付けない）。パスは `file:` URL としてフォルダに join し（`%20` などを解く）、フォルダの外（`../`・絶対パス）は読まない。中身がラスター画像で、画像の上限（1 枚・記事あたり）に収まるものだけを `article_images` に原文の相対パスで保存する。読めなかったものと貼り付けたときの相対パス、`data:` URL の画像は代替テキストを表示する。
- **取り込んだ後。** URL の記事と同じく embed・分類 job を積み、翻訳も同じように使える。

### 運用（設定・バックアップ・ログ）

- **モデル選択。** 翻訳と要約に使う provider とモデルを、最大 3 つの fallback として設定画面で選ぶ（§6）。`settings` テーブル（migration 8）に保存する。
- **バックアップ（§17）。** `VACUUM INTO` で、稼働中でも整合したコピーを `app_data/backups/lattice-<unix秒>.db` に書き出す。重要なデータはすべてこの 1 ファイルに入っている。書き出しに成功したら、`lattice-<数字>.db` という名前の通常ファイルだけを対象に、新しい順に「残す世代数」（`backup.keep_generations`、既定 30、設定画面で変更）を超えた分を削除する（`crates/lattice-core/src/backup.rs`）。同じフォルダにある R2 の一時ファイル（`r2-upload-*`）などには触れない。削除に失敗してもバックアップ自体は成功として返し、警告を表示する。
- **ログ（§25 Observability）。** `tauri-plugin-log` で `app_log_dir/lattice.log` と stdout に出力する。job の失敗は job・記事・試行回数を記録し、`processing_jobs` にも `last_error` / `attempt_count` / 時刻が残る。

### R2 への自動バックアップ（F10）

§1 の表では Cloudflare を不採用としたが、バックアップ先としての R2 だけはユーザーの要望で採用した。ローカルの SQLite が system of record である点は変わらない（R2 には gzip 済みのコピーを置くだけで、読み戻しは手動）。

| 対象 | ファイル |
|---|---|
| bucket・lifecycle（Terraform） | `infra/r2/`（手順と復元方法は `infra/r2/README.md`） |
| アップロード・SigV4・設定・スケジューラ | `crates/lattice-core/src/r2.rs` |
| 世代の選択（ローカルと共通） | `crates/lattice-core/src/backup.rs` |
| Tauri commands（`r2_status` / `r2_save` / `r2_clear_secret` / `r2_backup_now`） | `src-tauri/src/lib.rs` |
| 設定画面 | `src/R2BackupSection.tsx` |

- **流れ。** 専用の接続で `Store::backup_to`（`VACUUM INTO` → `secret.*` を削除）→ gzip → R2 にアップロード → 一時ファイルを削除 → 古い世代を削除。コピーは別接続で取るので、数 GB の DB でもアプリの store の lock を握らない。コピーと圧縮は `spawn_blocking` で行う。
- **アップロード。** S3 互換 API（`https://<account_id>.r2.cloudflarestorage.com`、path-style、region `auto`）。64 MiB 以下は 1 回の PUT、それより大きければ multipart upload（64 MiB の part を順に読み、ファイル全体はメモリに載せない）。失敗時は abort を試み、取り残しは lifecycle rule が 7 日で破棄する。
- **SigV4 は手書き。** AWS SDK は入れない。HMAC-SHA256 も既存の `sha2` で数行で書いた。AWS の S3 ドキュメントのテストベクタ 3 件で検証している。
- **object key。** `lattice/<端末名>/lattice-<UTC 時刻>.db.gz`。端末名は `COMPUTERNAME` / `HOSTNAME` から英数字だけを取る。複数台から同じ bucket に置ける。時刻は固定幅の `YYYYMMDDTHHMMSSZ` なので、key を文字列で並べると時系列順になる。
- **設定。** `settings` テーブルの `r2.*`（有効・Account ID・bucket・Access Key ID・間隔・残す世代数・最終成功時刻・最終エラー・最終の世代削除エラー）と `secret.r2_secret_access_key`。Account ID・bucket・Access Key ID・Secret・間隔・世代数はすべて設定画面から変更できる。UI には Secret の値を返さず `has_secret` だけを返す。Secret は「削除」で消せ、消すと自動バックアップも無効にする（Secret なしでは動かないため）。Account ID（32 桁 hex）と bucket 名は URL に入るので保存時に検証する。
- **スケジュール。** 起動時に spawn したタスクが 15 分ごとに確認し、最終成功から間隔（既定 24 時間）が過ぎていれば実行する。時刻は DB に保存するので再起動をまたいでも続く。失敗したら 1 時間は再試行しない。同時に 2 本は走らない（手動実行と重なったらエラーを返す）。
- **保持は世代数。** 日数で消すと、しばらくアプリを動かさなかっただけで全部消えうる（ECR の lifecycle policy の「イメージ数」と同じ考え方を採った）。R2 の lifecycle rule は経過日数でしか消せないので、アプリが消す。アップロードに成功したあと、ListObjectsV2（SigV4、`continuation-token` でページを辿る）で `lattice/<端末名>/` を一覧し、`object_key` と同じ形の key だけを残して文字列の降順に並べ、今回の key を 1 世代目として数えたうえで「残す世代数」（`r2.keep_generations`、既定 30、最小 1）を超えた分を DeleteObject で 1 件ずつ消す（DeleteObjects は Content-MD5 が要るので使わない）。今回の key は時計がずれていても消さない。他の端末の prefix や別の名前のオブジェクトには触れない。一覧・削除に失敗してもバックアップは成功のままで、`r2.last_prune_error` に記録して設定画面に警告を出し、次回成功時に消える。XML は要素の切り出しを手で行い、文字参照の解決だけ既存の依存（feed-rs 経由で入っている `quick-xml`）の `unescape` を使う。lifecycle rule は止まった multipart upload の破棄（7 日）だけを残す。
- **API キー。** アプリ用の R2 アクセスキーは dashboard で作る（Secret を Terraform の state に残さないため）。手順は `infra/r2/README.md`。

### セキュリティ境界

- **アプリ UI（main webview）には記事の HTML を一切入れない。** Reader が受け取るのは IR（JSON）だけで、React の text node として描画する。
- **元ページは別の child webview（`browser`）に表示する。** これはリモート origin なので、capability `browser-overlay` で許可しているのは `overlay_config`・`overlay_translate`・`overlay_snapshot`・`overlay_history`・`overlay_key` だけ（`build.rs` で全コマンドの permission を生成している）。ほかのコマンドはページ側から呼べないことを実機で確認した（例: `db_path not allowed on ... webview "browser"`）。app UI 用の capability は `webviews: ["main"]` かつ local origin に限定している。
- `overlay_translate` は、ユーザーが翻訳を ON にしている間だけ、browser webview からの呼び出しにだけ応答する。件数（24 件まで）とサイズ（1 断片 20KB まで）にも上限がある。ページ側の script が呼べてしまう点は許容しており、その影響は LLM の使用量に限られる（CLI は tool なしで実行する）。
- **LLM の出力は untrusted HTML として扱う。** overlay は sanitize（許可した inline タグ、http(s) の link、イベントハンドラの除去）してから差し込む。
- **browser webview は http(s) 以外に遷移しない**（`on_navigation`）。新しいウィンドウを開くリンクは同じ webview で開く。
- main webview の CSP は `default-src 'self'` で、Reader はリモート画像を読み込まない（保存した画像は `data:` URL で表示する。§14）。

### 未実装（意図的）

JS で描画するページの Index 追加（今はサーバーから再取得した HTML を抽出する）、bulk import の同一ホスト宛て並列数の制限、検索の metadata filter、reranker、re-extract コマンド（block ID の再利用も含む）、画像の保存。

## 6. LLM provider と Fallback chain（F2〜F4。実装済み）

```
domain（segments / translate / summarize / overlay）→ LlmChain（LlmProvider）
 → 1 → 2 → 3 の順に試す: Claude CLI / Codex CLI / OpenAI API / Gemini API / Anthropic API
 → 答えた provider と model を Completion に載せ、派生データの provider / model に記録
```

| 対象 | ファイル |
|---|---|
| Chain・設定の読み書き・API キー | `crates/lattice-core/src/chain.rs` |
| Codex CLI adapter（`codex exec --json --output-schema`） | `crates/lattice-core/src/codex.rs` |
| OpenAI API adapter（Responses API、strict JSON schema） | `crates/lattice-core/src/openai.rs` |
| Gemini API adapter（`generateContent`、`responseJsonSchema`） | `crates/lattice-core/src/gemini.rs` |
| Anthropic API adapter（Messages API、`output_config.format` の JSON schema） | `crates/lattice-core/src/anthropic.rs` |
| 共通（strict schema 変換、HTTP エラーの分類） | `crates/lattice-core/src/llm.rs` |
| Tauri commands（`get_llm_settings` / `set_llm_chain` / `set_api_key`） | `src-tauri/src/lib.rs` |
| 設定 UI | `src/ModelSettings.tsx` |

- **Chain も `LlmProvider` を実装する。** domain 側は provider が 1 つでも chain でも同じコードで動く。`LlmProvider` は object-safe でないので、provider は enum（`AnyLlm`）で持つ。
- **Fallback の条件。** どのエラー（`Unavailable` / `Failed` / `Malformed`）でも次の entry に進む。usage limit・認証・timeout など `Malformed` 以外で失敗した entry は 5 分間だけ順番を最後に回す（in-memory。全 entry が後回しなら設定順にすべて試す）。全滅したときは各 entry のエラーをつないで返し、job は従来どおり backoff する。
- **記録する provider。** `Completion.provider` に実際に答えた provider（`claude-cli` / `codex-cli` / `openai-api` / `gemini-api` / `anthropic-api`）を入れ、`segment_translations` / `summaries` に記録する。CLI が model を返さないとき（Codex）は設定した model を記録する。翻訳は snippet（= 行）ごとに、その snippet を返した呼び出し（batch か個別の再試行）の provider / model を記録する（`segments::Origin`）。fallback で再試行だけ別の entry が答えても、行ごとに正しい provider が残る。長い unit の re-split は行の provider を変えない（unit の分割と大半の訳は元の呼び出しのもの）。
- **Anthropic API。** `x-api-key` と `anthropic-version: 2023-06-01` で `/v1/messages` を呼ぶ。非 streaming なので `max_tokens` は 16000。HTTP 401 / 403 / 429 / 529（overloaded）は `Unavailable` として次の entry へ進む（529 の扱いは他の API と共通の `post_json`）。`stop_reason` が `refusal` なら `Failed`、`max_tokens` なら `Malformed`。thinking block は読み飛ばし、text block の JSON だけを使う。
- **設定。** `settings.llm_chain` に `[{kind, model}]` の JSON で保存する。未保存なら旧 `claude_model` を 1 つ目（Claude CLI）として読む。保存すると chain を作り直す（job runner は同じ `Arc` を共有したまま、`RwLock` の中身だけ差し替える）。
- **API キー。** `secret.openai_api_key` / `secret.gemini_api_key` / `secret.anthropic_api_key` に保存し、バックアップからは除かれる（`backup_to`）。未設定なら環境変数 `OPENAI_API_KEY` / `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` を使う。UI に返すのはキーの有無と出所（保存／環境変数）だけ。キーがない entry は `Unavailable` になり次へ進む。
- **Untrusted input（§25）。** どの adapter にも tool を渡さない。Codex は user config・rules・web search・shell などの tool feature をすべて無効にし、read-only sandbox・空の一時ディレクトリ・`--ephemeral` で動かす。指示は prompt 引数、記事テキストは stdin（`<stdin>` block）で渡す。API は structured output だけを使う（Anthropic は forced tool ではなく `output_config.format` の JSON schema。tools は送らない）。
- **Reasoning effort（G45）。** chain の各段に任意の `effort`（`llm::Effort`: low / medium / high / xhigh / max）を持たせ、`settings.llm_chain` の JSON に、指定したときだけ書く（ない段は provider の既定。G45 より前に保存した chain もそのまま読める）。渡し方は Claude CLI が `--effort`（`claude --help` の 2.1.303 で確認し、`-p` で受け付けることを実際の呼び出しで確認）、Codex CLI が `-c model_reasoning_effort=…`（未指定は従来どおり `low`。翻訳や要約に深い推論は要らず、usage limit のある CLI を速く回すため）、OpenAI API が `reasoning.effort`、Anthropic API が `output_config.effort`（structured output の `format` と同じ object）、Gemini API が `generationConfig.thinkingConfig.thinkingLevel`。どの provider も対応するので、設定画面では全段に effort の select を出す。選べる値は provider ごとに `ProviderKind::efforts` で決め（Gemini は多くのモデルに共通する low / medium / high だけ）、保存時にそれ以外を拒む。モデルが対応しない値（古いモデルや `gpt-reserve` など）は API が 400 を返し、その段は失敗として次の段に進む。モデルごとの対応表は持たない（モデル ID を自由に入力できるので網羅できない）。
- **モデルの選択肢。** Claude は alias（haiku / sonnet / opus）、Codex は `~/.codex/models_cache.json` にある ID、OpenAI API は既定を `gpt-6-luna`、Gemini API は既定を `gemini-flash-latest`、Anthropic API は既定を `claude-opus-5-5`（選択肢に `claude-sonnet-5-5` / `claude-haiku-5-5`）にした。どれも「その他」でモデル ID を直接入力できる（F2 の修正。選択状態を model 値と別に持つ）。

### 未実装（意図的）

API の usage（token 数）の記録、entry ごとの timeout 設定、chain の実機での疎通確認 UI。Anthropic の server-side refusal fallback（refusal は chain の次の entry に任せる）、streaming。
Codex adapter、JS で描画するページの Index 追加（今はサーバーから再取得した HTML を抽出する）、bulk import の同一ホスト宛て並列数の制限、検索の metadata filter、reranker、re-extract コマンド（block ID の再利用も含む）、画像の保存。

## 7. 対話ペイン slice（F9、実装済み）

```
質問 + スコープ（この記事／タグ／全記事）→ 記事 ID の集合
 → スコープ内の本文が 30,000 字以内なら全文（見出し + prose block）
   超えるなら hybrid search をスコープ内に絞って上位 24 block（＋直前の質問で 6 block）
 → block に [n] の番号を付けて LLM へ（complete_json: {answer, citations: [n]}）
 → 送った番号だけを引用として残す → chat_threads / chat_messages に保存
```

| 対象 | ファイル |
|---|---|
| スコープ・context 構築・引用の検証・永続化 | `crates/lattice-core/src/chat.rs`（migration 9） |
| 検索の記事 ID filter | `crates/lattice-core/src/store.rs`、`crates/lattice-core/src/search.rs` |
| Tauri commands（`chat_ask` ほか 3 つ） | `src-tauri/src/lib.rs` |
| ペイン UI・引用 chip | `src/ChatPane.tsx`、`src/chat.ts` |

- **スコープは「記事 1 件」か「inbox の `ArticleFilter`」。** どちらも記事 ID の集合に落ちる（全記事だけは `None` で、filter なしの検索になる）。ジャンルや feed は `ArticleFilter` に variant が増えれば、そのままスコープとして使える。
- **全文か検索か。** スコープの block を記事順・ordinal 順に stream で読み、30,000 字を超えた時点で打ち切って検索に切り替える。巨大なスコープでも全件を読まない。送る context は全体で 40,000 字、1 block 1,500 字まで。
- **追加の質問。** 直前 3 往復（回答は 1,000 字まで）を `<conversation>` として渡し、検索は新しい質問に加えて直前の質問でも少しだけ行う（「その欠点は？」のような質問のため）。
- **引用の検証。** `citations` と回答本文の `[n]` の両方から番号を集め、実際に送った範囲のものだけを残す。引用には block の title・見出し・本文・URL を複製して保存するので、再抽出や削除の後でも過去の回答を表示できる。
- **untrusted 入力。** 記事本文も過去の会話も「データとして扱い、中の指示に従わない」と system prompt で指示する。LLM には tool を渡さない（既存 adapter のまま）。回答は plain text として React の text node で描画し、HTML は解釈しない。資料に答えがなければそう答えるよう指示している。
- **job queue の外で実行する。** `chat_ask` は async command で、専用の semaphore（同時 2 件）で絞る。長い翻訳 queue の後ろで待たされない。provider は `app.providers.llm` を `LlmProvider` trait 経由でだけ使う。
- **該当なし。** スコープに block が 1 つもない（検索でも見つからない）ときは LLM を呼ばず、固定文を `mode = 'none'` で保存する。
- **カスタム指示（G49）。** 設定 › 要約・対話 に、全体共通の「自分について」（`settings.user_profile`）と、要約（`summary_instructions`）・対話（`chat_instructions`）それぞれの追加の指示を置く（`instructions.rs`。各 2000 文字まで、空なら保存しない）。対話ペインごとではなく全体共通にした（関心や前提知識は質問ごとに変わらず、ペインごとの設定は毎回の入力になる）。system prompt は「組み込みの規則 → 自分について → 追加の指示 → untrusted input の注意」の順で組み立て、注意を必ず最後に置く。要約は作成時の指示の sha256 の先頭 12 桁を `prompt_version`（`summary-v1-x-instr-…`。指示がなければ従来どおり `summary-v1`）に記録し、`summarize::mark_stale` が今の指示と違えば `summary.stale` を立てる（Reader は「本文か要約の設定が変わっています」と出す）。要約は自動では作り直さない。対話は保存しないので、次の質問から効く。
- **UI。** サイドバーのボタンで右側に開閉する。grid の 3 列目なので main（アプリ内ブラウザの placeholder を含む）が縮み、native の browser webview は ResizeObserver で placeholder に追従する。引用 chip を押すと、Reader がその記事を表示中ならその block へ scroll し、それ以外は検索結果と同じく `openPage(url, block の本文)` でページを開いてその block へ移動する。

## 8. 自動分類・RSS・一覧表示（実装済み。roadmap F5〜F8）

```
保存（save_url / ingest job）→ 自動分類が ON なら classify job
classify job → 待機中の classify job を最大 20 件まとめて claim → 1 回の LLM 呼び出し → ジャンル 1 つ + タグ最大 3 つ
feed 登録 / 30 分ごと / 起動時 / 「すべて更新」→ 未見の entry URL → ingest::enqueue_urls → ingest job（記事に feed_id を付ける）
```

| 対象 | ファイル |
|---|---|
| 分類 job（prompt・batch・手動ジャンルの保護） | `crates/lattice-core/src/classify.rs` |
| RSS / Atom collector（`feed-rs` で解析、条件付き GET、poll） | `crates/lattice-core/src/feeds.rs` |
| スキーマ（`genres`・`classifications`・`feeds`・`feed_items`、`articles.genre_id / genre_source / feed_id`）、並び順 | `crates/lattice-core/src/store.rs`（migration 10, 11） |
| 一覧（一覧／フィード／ジャンルの切替、並び順） | `src/ArticleList.tsx`、`src/groups.ts` |
| フィード管理・ジャンル編集・設定 | `src/FeedsView.tsx`、`src/GenreField.tsx`、`src/ClassifySettings.tsx` |

- **ジャンルは記事に 1 つ。** 既定は Database / Distributed Systems / Linux / Networking / Programming Languages / Security / Web / AI/ML / DevOps / Hardware / Career / Other。prompt に既存のジャンル一覧を渡し、合うものがなければ新しいジャンルを作らせる。名前は大文字小文字を区別せずに照合するので、「database」は Database に統合される。
- **手動の選択は上書きしない。** Reader で選ぶと `genre_source = 'manual'` になり、自動分類はジャンルを変えない（タグの追加だけ行う）。Reader の「自動分類」を押すと固定を外して分類し直す。空にすると未分類に戻る。
- **タグは追加だけ。** 分類が提案したタグ（最大 3 つ）を付け、ユーザーのタグは消さない。
- **batch。** job は記事単位のまま（状態・再試行・backoff は従来どおり）だが、1 回の実行で待機中の classify job を最大 20 件 claim して 1 回の CLI 呼び出しで分類し、それぞれの job を個別に完了させる。数千件の bulk import でも CLI の起動は 1/20 になる。入力は記事ごとにタイトル・ドメイン・要約（なければ冒頭の本文 1200 字）。
- **派生データとして記録する。** 結果は毎回 `classifications` に provider / model / prompt_version 付きで残す。
- **自動分類の設定**（`settings.auto_classify`、既定 ON）と「未分類をすべて分類」は設定画面にある。
- **RSS の初回取り込みは最新 20 件。** 全記事を載せる feed を登録しても数百件を取り込まないようにする。残りは取り込み済みとして `feed_items` に記録し、以降の poll では新しく現れた entry だけを取り込む。entry は公開日時の新しい順に並べてから数える。
- **poll は UI から独立している。** 起動時と 30 分ごとに全 feed を順に取得する（ETag / Last-Modified で条件付き GET）。失敗は feed ごとに `last_error` に記録し、他の feed は続行する。poll は URL を登録するだけで、記事の取得は既存の network runner が行う。
- **登録時にすぐ取得する。** 新しく登録した URL が feed として読めなければ登録しない。OPML は `xmlUrl` 属性を抜き出して 1 件ずつ登録する。
- **feed を削除しても記事は残す**（`feed_id` が NULL になり「手動追加」に入る）。
- **一覧の表示モード。** 「一覧」（従来どおり）、「フィード」（手動追加 → 各 feed → その中でジャンル → 記事）、「ジャンル」（ジャンル → 記事、未分類は最後）。最近追加／未読／お気に入り／タグの絞り込みはそのまま効き、絞り込んだ結果をグループ化する（件数も絞り込み後）。記事は 1 回の query で取り、グループ化はクライアントで行う。開いたグループの記事だけを描画する。
- **並び順。** 追加日時（新しい順／古い順）と公開日時（新しい順。日付のない記事は最後）。`articles_published_at` index を追加した。

### 未実装（意図的）

feed 単位の取り込み件数・間隔の設定、表示モードと並び順の保存（再起動で既定に戻る）。feed の自動検出、ジャンルの改名・統合 UI、entry の日付で `published_at` を補うことは §14 で実装した。

## 9. 取り込みの改善（F1・F11・同一ホスト制限・再抽出）

| 対象 | ファイル |
|---|---|
| store を触る command を main thread から外す | `src-tauri/src/lib.rs` |
| 読み込み中の表示・即時の選択状態 | `src-tauri/src/browser.rs`（`Visibility`）、`src/App.tsx`、`src/BrowserView.tsx` |
| 描画後の DOM の保存 | `src/overlay/index.ts`（`snapshot`）、`browser.rs`（`snapshot` / `overlay_snapshot`）、`ingest::save_rendered` |
| 同一ホストの並列制限 | `Store::claim_next_job` |
| 再抽出と block ID の再利用 | `ingest::reextract`、`store::replace_blocks`、`src/Reader.tsx` |

§5「未実装（意図的）」のうち、JS で描画するページの Index 追加、bulk import の同一ホスト宛て並列数の制限、re-extract コマンド（block ID の再利用を含む）はこの節で実装した。

- **記事一覧クリックで固まる（F1）の原因。** Tauri 2 では `async` でない command は main（UI）thread で実行される。`list_articles`・`get_article`・`article_for_url` などは同期 command で、store の唯一の `Mutex<Connection>` を取る。この lock は bulk import の 4 本の runner（snapshot の deflate と block の挿入を含む transaction）、embed runner、検索の `scan_embeddings`、`VACUUM INTO` も取るので、その間 main thread が待ち、ウィンドウ全体（ページの webview も）が止まっていた。→ store を触る command はすべて `async` か `#[tauri::command(async)]` にした（tokio の thread で lock を待つ）。`browser_hide` / `browser_set_bounds` は順序を保つために同期のまま（どちらも store を触らない）。`set_claude_model` は F3 の設定 UI で作り直されるので、この slice では触っていない。
- **体感の原因（F1）。** クリックしてから新しいページの `ContentLoading` までイベントがなく、前のページが表示されたままだった。一覧の選択状態も、読み込み完了後の `article_for_url` で初めて変わっていた。→ クリックした行をその場で選択状態にする。アプリから開いたページは、読み込みが終わる（`NavigationCompleted`）まで webview を隠し、下の placeholder にスピナーを出す。webview を表示するかは `Visibility { wanted, loading }`（UI が browser view を表示しているか、開いたページが読み込み中か）で決める。ページ内のリンク遷移では隠さない。
- **描画後の DOM の保存（F11）。** 「Index に追加」は `save_page` になった。Rust が nonce を作って browser webview で `window.__lattice.snapshot(nonce)` を eval し、overlay が `document.documentElement.outerHTML` を `overlay_snapshot` で返す。訳文を表示中の文は、取得の間だけ原文に戻す（訳文が本文として保存されないように）。`overlay_snapshot` は、呼び出し元が browser webview であること、未処理の要求の nonce と一致すること、サイズが 20MB（`fetch::MAX_BODY`）以下であることを確認する。URL はページの申告ではなく webview の現在の URL を使う。5 秒以内に返らなければ、従来どおりサーバーから取得する。snapshot は `content_type = 'text/html; source=webview'` で保存し、以降は通常の抽出・block 化と同じ経路を通る。
  - nonce はページから読めるので秘密ではない（要求と応答の対応付けにだけ使う）。ページは自分の DOM を自由に書き換えられるので、偽の HTML を返されても影響はそのページの保存内容に限られる。要求していない保存は受け付けない。
- **本文が短い記事の表示。** 抽出した文字数を `articles.text_length` に保存し（migration 12。既存行は blocks から backfill する）、300 文字未満を `thin` とする。一覧に「本文が短い」、Reader に案内を出し、ブラウザでは「描画後のページで保存」ボタンで保存し直せる。取得・抽出に失敗した記事も同じボタンで保存できる（bot を拒否するサイトにも使える）。bulk import・RSS の記事は §13 の裏描画で自動的に描画し直す。
- **同一ホストの並列制限。** `claim_next_job` は、同じ `articles.domain` の ingest job が running の間、そのホストの ingest job を飛ばして別ホストの job を取る。1 つの UPDATE 文なので runner 間で競合しない。ホストは正規化後の host そのもので、`www.` の有無は別ホストとして扱う。
- **再抽出と block ID の再利用。** `reextract_article` は最新の snapshot から抽出し直す（ネットワークを使わず、snapshot を増やさず、canonical による記事の統合もしない）。`save_fetched` は blocks を全置換せず、`text_hash` が一致する旧 block の id を出現順に再利用する（重複テキストは順に対応付ける）。旧行を負の ordinal に退避してから並べ替えるので、`UNIQUE (article_id, ordinal)` に衝突しない。`heading_id` は新しい並びで付け直し、使われなかった旧 block は削除する（embedding は cascade で消える）。再利用した block の embedding と検索結果はそのまま有効。見出しだけが変わった block の embedding（見出しを前置している）は古いままになるが、本文の hash が同じなので再計算しない。

## 10. 処理状況と JSON エクスポート（§4.6・§17・§25）

| 対象 | ファイル |
|---|---|
| ジョブの集計・一覧・再実行・取り消し | `crates/lattice-core/src/job_status.rs`、`src/JobsView.tsx` |
| runner の起こし分け | `src-tauri/src/lib.rs`（`wake`） |
| `(status, type, next_run_at)` index | `crates/lattice-core/src/store.rs`（migration 13） |
| JSON エクスポート | `crates/lattice-core/src/export.rs`、`src/SettingsView.tsx` |

- **状態は 4 つ。** 待機（pending で実行可能）、再試行待ち（pending で `next_run_at` が未来）、実行中、失敗（`MAX_ATTEMPTS` に達して自動再試行が止まったもの）。succeeded は数えない。集計は `(status, type, next_run_at)` の covering index だけで済み、表の行を読まない。一覧は失敗と再試行待ちを終了時刻の新しい順に 200 件まで返す（件数は集計の方にある）。
- **再実行は enqueue と同じ操作。** `status = 'pending', next_run_at = NULL`（running は除く）で、`attempt_count` は残す。`Store::enqueue_job` が dedup key の既存 job に対して行うのと同じなので、再実行は 1 回だけ試し、失敗すればまた「失敗」に戻る（自動の backoff を最初からやり直さない）。種類から `LLM_JOBS` / `LOCAL_JOBS` / `NET_JOBS` を引いて該当する runner を起こす。「失敗をすべて再実行」（種類ごとにも可）は失敗と再試行待ちの両方を対象にする。
- **classify の batch でも動く。** job は記事単位なので、再実行した job は通常どおり pending になり、次の classify 実行が最大 20 件をまとめて claim する（test で確認）。
- **取り消しは job の削除。** pending と failed だけ消せる（running は終わるのを待つ）。dedup key ごと消えるので、後で同じ処理を頼めば新しい job ができる。ingest job を取り消すと記事は「取得中」のまま残る。
- **画面の更新。** `article-changed`（runner が job ごとに送る）を 1 秒にまとめて読み直し、さらに表示中は 10 秒ごとに読み直す（backoff の期限切れはイベントにならないため）。
- **エクスポートの形式。** `app_data/exports/lattice-export-<UTC>.jsonl.gz`。1 行 1 JSON の gzip で、1 行目が `{"format": "lattice-export/1", "exported_at"}`、続いて `feed`、`article`、`chat_thread` の行。記事はメタデータ（`ArticleRow` と同じ項目: タグ・ジャンル・`feed_id` を含む）、blocks（kind・text・inlines・attrs、block ごとに target language ごとの最新の訳を provider / model / prompt_version 付きで）、要約（履歴すべて、`stale` 付き）。対話は thread ごとに messages（引用・scope・provider を含む）。記事を 1 件ずつ読んで書くので、10^5 件でもメモリに載せない。書き終えてから rename するので、途中で失敗しても壊れたファイルは残らない。
- **含めないもの。** settings 全体（API キー・R2 の secret のほか、LLM の設定も）、取得した HTML の snapshot、embedding、jobs、分類の履歴。snapshot と embedding は DB のバックアップにある。
- **一貫性。** store の lock は記事ごとに取り直す（エクスポート中も UI と job が止まらない）。そのためエクスポート中に変わったデータは半端に入りうる。

### 未実装（意図的）

エクスポートからの import（復元は DB バックアップで行う）、一覧の種類での絞り込みとページング、succeeded の履歴表示、エクスポートの進捗表示と保存先の選択、エクスポートの自動実行。

## 11. ジャンル・フィードの範囲指定（対話・検索）

| 対象 | ファイル |
|---|---|
| ジャンル・フィードの絞り込み、記事 ID だけの query | `store::ArticleFilter`（`Genre` / `Feed`）、`filter_cond`、`Store::article_ids` |
| 対話の範囲 | `chat::Store::scope_articles`、`src/ChatPane.tsx` |
| 検索の範囲 | `search_blocks`（`filter`）、`src/App.tsx` |
| 範囲の選択肢 | `src/scopes.ts`、`src/FilterOptgroups.tsx` |

- **絞り込みの種類。** `ArticleFilter` に `Genre { name }`（`null` は未分類）と `Feed { id }`（`null` は手動追加）を追加した。条件は `filter_cond` の 1 か所で組み立て、一覧（`list_articles_sorted`）と `article_ids` が共有する。ジャンル名は `genres.name` の `COLLATE NOCASE` で照合する。
- **範囲は記事 ID の集合。** `article_ids` は `All` なら `None`（制限なし）を返すので、絞り込まない検索・対話は従来どおりの速い経路を通る。それ以外は `SELECT id` だけを取る（以前の対話は一覧と同じ全列を読んでいた）。集合が空なら、検索は 0 件、対話はモデルを呼ばずに「見つかりませんでした」と答える。
- **選択肢。** 対話はこの記事／全記事／ジャンル／フィード／タグ、検索は全記事／未読／お気に入り／ジャンル／フィード／タグ。ジャンル・フィード・タグは `<optgroup>` に分ける。記事が 0 件のジャンル（初期ジャンル）は出さない。未分類と手動追加は件数を数えずに常に出す。`<select>` の値は filter の JSON。検索結果を表示中に範囲を変えると、同じ語で検索し直す。

### 未実装（意図的）

一覧で開いているグループ（フィード → ジャンルの組み合わせ）を範囲にすること（1 つの `ArticleFilter` では表せない。複合条件が必要になったら filter を AND の列にする）、範囲の選択の保存、サイドバーの絞り込みボタンへのジャンル・フィードの追加（表示モードのグループで代わりになる）。

## 12. 難易度推定と専門用語を残す翻訳（§3 UC7・§8）

| 対象 | ファイル |
|---|---|
| 難易度（classify job の schema・prompt、手動指定） | `crates/lattice-core/src/classify.rs` |
| スキーマ（`articles.difficulty / difficulty_source`、`classifications.difficulty`）、難易度順 | `crates/lattice-core/src/store.rs`（migration 14） |
| 翻訳モード（prompt・cache key） | `crates/lattice-core/src/segments.rs`、`crates/lattice-core/src/translate.rs` |
| Tauri commands（`set_difficulty` / `get_translate_keep_terms` / `set_translate_keep_terms`） | `src-tauri/src/lib.rs` |
| UI | `src/DifficultyField.tsx`、`src/TranslationSettings.tsx`、`src/ArticleList.tsx`、`src/Reader.tsx` |

- **難易度は classify job で一緒に出す。** §4.6 の `estimate_difficulty` を別 job にせず、分類と同じ入力（タイトル・ドメイン・要約か冒頭 1200 字）・同じ batch（最大 20 件で 1 回の LLM 呼び出し）で返させる。入力が同じなので、別 job にすると LLM 呼び出しが倍になるだけになる。prompt_version は `classify-v2`。
- **尺度。** 1〜5 の整数（入門／初級／中級／上級／専門）。「その分野が専門ではない現役のソフトウェアエンジニア」にとっての難しさで判定させる。範囲外や欠落は保存しない（未判定のまま）。結果は `classifications.difficulty` にも provider / model 付きで残す。
- **手動の指定はジャンルと同じく固定する。** Reader の meta 行の select で選ぶと `difficulty_source = 'manual'` になり、自動分類は上書きしない。「未判定」に戻すと固定も外れる。「自動分類」ボタンはジャンルと難易度の両方の固定を外して分類し直す。
- **難易度がない記事も分類の対象にする。** 保存後の自動分類と「未分類をすべて分類」は、ジャンルか難易度のどちらかがない記事を queue に入れる。この slice より前に分類した記事も「未分類をすべて分類」で難易度が付く（ジャンルの固定とタグの追加だけの規則は従来どおり）。
- **表示。** 一覧の各記事に小さな badge（上級・専門は accent 色）、並び順に「難易度順（やさしい順）」（未判定は最後）。難易度での絞り込みは入れていない。
- **専門用語を英語のまま残す（既定 ON、`settings.translate_keep_terms`、OFF のときだけ `off` を保存）。** ON は「技術用語・略語・固有名詞は英語のまま、周りだけ訳す」、OFF は「定着した訳語があれば訳す（略語と製品名はそのまま）」を prompt に入れる。re-split の prompt にも同じ規則を入れる。prompt_version は `segments-v2`。
- **cache はモードごとに分ける。** モードを `target_language` の値に含める: ON は従来どおり `ja`、OFF は `ja-x-translated-terms`（`segments::target_key`）。`segment_translations`・`get_article` の訳文 join・`hit_details`・`untranslated_blocks`・translate job の params と dedup key はこの値をそのまま使うので、SQL は変えていない。FTS は言語で絞らないので、両方の訳文が検索に効く。
  - 既存の `ja` の行（segments-v1。prompt は「技術用語はエンジニアがわかる形で」）は ON の cache として使い続ける。全記事の再翻訳を避けるための判断で、v1 の訳文には訳語にした用語が混じりうる。
  - job は queue に入れた時点のモードを params に持つので、実行前に設定を変えても混ざらない。
  - 設定を切り替えると、Reader には新しいモードの訳文だけが出る（なければ未翻訳と表示され、「日本語に翻訳」で作る）。元に戻せば前の訳文が出る。ページ表示の overlay も次の翻訳要求から新しいモードを使う（表示中のページの訳文はそのまま）。
- chat は訳文を使わないので `TARGET_LANGUAGE` のまま。

### 未実装（意図的）

難易度での絞り込み、ユーザーの習熟度に合わせた推定（Phase 3 の personalization でこの値を入力にする）、訳文の強制再生成（cache を無視して訳し直す）、用語集（ユーザー定義の「訳さない語」）。

## 13. JS ページの裏描画（bulk import・RSS）

| 対象 | ファイル |
|---|---|
| render job の投入・保存・失敗の記録 | `crates/lattice-core/src/render.rs`、`jobs.rs`（ingest の後） |
| 非表示 webview の runner | `src-tauri/src/renderer.rs` |
| label ごとの snapshot nonce | `browser.rs`（`Snapshots` / `snapshot_of` / `overlay_snapshot`） |
| DOM が落ち着くまで待つ | `src/overlay/dom.ts`（`settle`）、`src/overlay/index.ts`（`snapshot`） |
| 手動操作と設定 | `src/Reader.tsx`（`RenderAction`）、`src/RenderSettings.tsx` |

§9 では、描画後の DOM を保存できるのはユーザーが開いたページだけだった。bulk import と RSS の記事はサーバーの HTML しか取得しないので、SPA の記事は `thin` のまま残っていた。

- **いつ描画するか。** ingest job（bulk import と RSS）と `save_url` の後で、取得に成功し、抽出に失敗したか 300 文字未満の記事に `render` job を 1 件積む（dedup key は `render:{id}`）。設定「JS ページを自動で描画」（`settings.auto_render`、既定は on）で止められる。Reader の「描画して取り込み直す」は設定に関係なく job を積む。
- **ループしない。** 自動投入は、記事の最新 snapshot がサーバーから取得したものである場合に限る。描画結果を保存すると最新 snapshot が `source=webview` になるので、描画結果がまだ短くても次の job は積まれない。描画の後に投入を判定する箇所もない。描画の試行は取得 1 回につき最大 1 回で、もう一度試すには再取得するか手動で操作する。
- **runner。** render job は専用の runner が 1 件ずつ処理する（他の runner の job type には含めないので、取得・LLM・embed を止めない）。job ごとに main window の子 webview（label `renderer`）を新しく作り、終わったら閉じる。`on_navigation` は http(s) 以外を拒否するので、about:blank に戻すことはできない。作り直す方式にしたのはそのためで、前のページの DOM やスクリプトが次の job に残ることもない。webview はウィンドウのクライアント領域の外（-20000, -20000）に 1280×900 で置く。`hide()` を使わないのは、非表示のページでタイマーや描画が止まらないようにするため。webview の作成・eval・close は tokio の thread から行う（§9 の deadlock は main thread で webview を作る場合に起きる）。
- **待ち方。** 読み込み完了（`PageLoadEvent::Finished`）を最大 12 秒待つ。その後 `window.__lattice.snapshot(nonce, {quietMs: 1500, maxMs: 6000})` を eval する。overlay は MutationObserver で DOM の変更が 1.5 秒止まるまで待ち（最大 6 秒）、`outerHTML` を返す。Rust 側の待ち時間は最大 8 秒で、1 件あたりの合計は約 20 秒に収まる。
- **保存。** `render::finish` は、描画結果を通常の経路（`store_fetched`、`content_type = 'text/html; source=webview'`、block ID の再利用、canonical による統合）で保存し、embed と自動分類を積む。保存の前に一度抽出し、抽出に失敗した場合と、本文が現在より長くならない場合（cookie 同意画面だけ、など）は保存しない。そのため描画で記事が悪くなることはない。理由は記事の `last_error` に記録し（取得・抽出の状態は変えない）、Reader の案内に表示する。job は成功として終える（ストレージのエラーだけが job の失敗になり、再試行される）。
- **セキュリティ。** `renderer` には browser と同じ `browser-overlay` capability だけを与える（overlay_config / overlay_translate / overlay_snapshot）。pop-up は拒否する。`overlay_config` は browser 以外には常に `enabled: false` を返し、`overlay_translate` は従来どおり browser webview 以外を拒否するので、裏のページから翻訳の LLM 呼び出しは起きない。snapshot の要求は webview の label ごとに 1 件まで（`Snapshots`）。応答を受け付けるのは、呼び出し元の label の未処理の要求で、nonce が一致する場合だけ。ユーザーが browser で行う「Index に追加」と裏の描画は互いの要求を上書きしない。cookie は browser と共有するので、ログインが必要なページはユーザーのセッションで描画される。

### 未実装（意図的）

裏で描画するページの音声のミュート（WebView2 の COM API が必要）、クライアント側リダイレクト（`location.href = …`）で読み込みが 2 回起きるページへの対応（最初の読み込み完了で待ち始めるので、DOM を取れずに失敗することがある）、描画の並列化。

## 14. 画像の保存（§6・§1/§2.2 URL 切れ・§26-10）

| 対象 | ファイル |
|---|---|
| ダウンロード・検証・保存・配信・設定 | `crates/lattice-core/src/images.rs` |
| スキーマ（`images` / `article_images` / GC trigger） | `crates/lattice-core/src/store.rs`（migration 15） |
| job の投入（抽出のたび） | `crates/lattice-core/src/ingest.rs`（`extract_into`） |
| Tauri commands（`article_image` / `get_image_settings` / `set_image_settings`） | `src-tauri/src/lib.rs` |
| 表示と設定 | `src/Reader.tsx`（`ImageBlock`）、`src/ImageSettings.tsx` |

- **保存先は SQLite。** `images(hash, mime, bytes)` は中身の sha256 を主キーにし、記事をまたいで重複を除く。`article_images(article_id, src, hash, error)` は記事が参照する画像 URL ごとに 1 行で、保存できなかった理由も残す。1 ファイルのバックアップ（§17）と R2 にそのまま入る。
- **block ID ではなく (記事, URL) で対応づける。** 再抽出では block を text（画像なら alt。空のことが多い）の hash で照合するので、画像 block の ID は入れ替わりうる。URL で引けば、ID の再利用とは関係なく対応が正しく保たれる。
- **job。** 抽出のたび（取得・再抽出・描画後の保存・「描画後のページで保存」）に、画像 block か対応行がある記事へ `images` job を 1 件積む（dedup key `images:{id}`）。network runner（4 本）が処理し、1 記事の画像は 1 枚ずつ取得する。同一ホスト制限（§9）を ingest と共有し、同じドメインの記事の ingest / images job は同時に 1 本だけ走る。起動時と、設定をオンにしたときに、まだ試していない画像 URL を持つ記事の job を積む（バックフィル）。
- **取得の制限。** http(s) のみ、`fetch::client()`（private address を拒否）を使い、Referer に記事の URL を付ける（hotlink を拒むサイトのため）。Content-Type は `image/*`・`application/octet-stream`・なしだけを受け付け、SVG は拒否する。1 枚の上限は設定（既定 5 MB、1〜20 MB）で、`Content-Length` と受信中の両方で確かめる。記事 1 件あたりは 30 MB まで。保存する形式は header ではなく magic number で判定する（PNG・JPEG・GIF・WebP・AVIF）。SVG は script を持てるので保存せず、Reader ではリンクのままにする。
- **失敗。** 404・形式違い・サイズ超過・private address などは理由を記録し、再試行しない。timeout・5xx・429 は記録せずに job を失敗させるので、backoff 付きで再試行される（§4.6）。
- **配信。** `article_image(block_id)` が `data:` URL を返す。main webview の CSP（`img-src 'self' data:`）は変えない。custom URI scheme（`lattice-img://`）は使わなかった。scheme は browser / renderer の webview（リモートのページ）からも引けるので、「この画像を保存しているか」がページ側から分かってしまう。command なら capability で main webview だけに限られる。Reader は IntersectionObserver で画面の近く（600px 以内）に来た画像だけを取りに行くので、画像の多い記事でも最初の表示は重くならない。base64 で 1.33 倍になるが、1 枚 5 MB までなら問題にならない。未保存の画像は従来どおりプレースホルダとリンクを表示し、job が進むと取り直す。
- **GC。** `article_images` の行が消えると、trigger が、どの行からも参照されなくなった `images` の行を消す。記事の削除（canonical による統合を含む）は cascade で、再抽出で消えた画像は images job の最初に対応行を消すことで処理される。
- **エクスポート。** JSON（§17）には bytes を入れず、画像 block に `image_hash` を付ける。bytes はバックアップにある。
- **設定。** 「画像を保存する」（`settings.save_images`、既定は on）と「1 枚あたりの上限」（`settings.image_max_mb`）。オフにしても保存済みの画像は消さない。

### DB サイズの見積もり

技術記事の画像は 1 件あたり 3〜8 枚、1 枚 50〜300 KB（スクリーンショットの PNG は 1 MB 前後）が多い。1 記事あたり 0.5〜2 MB とすると、10^4 記事で 5〜20 GB、10^5 記事で 50〜200 GB になりうる。圧縮した snapshot（1 記事あたり数十〜百数十 KB）よりずっと大きく、DB の大半は画像になる。画像はすでに圧縮されているので、R2 へのバックアップの gzip もほとんど効かない。上限（1 枚 5 MB・1 記事 30 MB）と設定のオフで抑える。

### 未実装（意図的）

縮小・再エンコード（範囲外）、`srcset` / `<picture>` から適切な解像度を選ぶこと（今は抽出した `src` だけ）、遅延読み込み用の `data-src`、画像だけを消して容量を空ける操作、記事あたりの上限の設定化。

## 15. フィードの自動検出・ジャンル管理・サイドバーの絞り込み

| 対象 | ファイル |
|---|---|
| 自動検出（`discover`・`feed_links`）、entry の日付 | `crates/lattice-core/src/feeds.rs` |
| `feed_items.published_at`（migration 16）、抽出時の補完 | `crates/lattice-core/src/store.rs`（`save_fetched`） |
| ジャンルの改名・統合・削除 | `crates/lattice-core/src/classify.rs`（`rename_genre` / `delete_genre`）、`src/GenreSettings.tsx`（設定画面） |
| Tauri commands（`discover_feeds` / `rename_genre` / `delete_genre`） | `src-tauri/src/lib.rs` |
| 登録 UI・候補の選択 | `src/FeedsView.tsx` |
| サイドバーのジャンル・フィード絞り込み | `src/App.tsx` |

- **自動検出。** 「登録」はまず `discover_feeds` を呼ぶ。URL そのものが feed として読めればそれを使う。読めなければ HTML として `<link rel="alternate" type="application/rss+xml | atom+xml | feed+json" href>` を探す（rel・type は大文字小文字を区別しない。href はリダイレクト後の URL を基準に解決し、http(s) 以外と重複は捨てる）。1 つもなければ同じホストの `/feed`・`/rss.xml`・`/atom.xml`・`/index.xml` を順に試し、最初に読めたものを使う。取得はすべて `fetch::client()` と `check_public` を通る（private アドレスには行かない）。
- **候補が複数なら選ばせる。** 1 件ならそのまま登録し、複数なら一覧を出して 1 件ずつ「登録」できる（登録したものは一覧から消える）。0 件ならそう表示する。`<link>` の候補は登録時に従来どおり取得し、読めなければ登録しない。feed の URL を直接入れた場合は検出と登録で 2 回取得する（登録時だけなので許容した）。OPML の読み込みは feed の URL なので検出を通さない。
- **entry の日付で `published_at` を補う。** entry の公開日時（なければ更新日時）を UTC の ISO 8601 で `feed_items.published_at` に記録する。抽出で `published_at` を決めるとき、ページに日付がなければ記事の feed（`articles.feed_id`）の entry の日付を使う（`coalesce`）。ページの日付があればそちらを優先する。feed に載る前に抽出済みで日付のない記事は、取り込み時に埋める。再抽出しても entry の日付は残る。この slice より前に記録した `feed_items` には日付がないので、既存の記事は補わない。
- **ジャンルの改名と統合は 1 つの操作。** 設定画面の「ジャンル」に全ジャンルと件数を並べ、名前を書き換えて「名前を変更」する。既存のジャンル名（大文字小文字を区別しない）にすると「統合」になり、記事をそのジャンルに移して元のジャンルを消す。記事の `genre_source` はそのまま（Reader で選んだジャンルは統合先で手動のまま固定され、自動のものは自動のまま）。分類の prompt は既存のジャンル一覧を渡すので、新しい名前は次の分類から使われる。`classifications` の履歴は当時の名前のまま残す。
- **削除は記事のないジャンルだけ。** 記事のあるジャンルは統合で片付ける。初期ジャンルも削除できる。
- **サイドバーの絞り込み。** 最近追加／未読／お気に入りの隣に「ジャンル・フィード…」の select を置き、ジャンル（記事のあるもの・未分類）かフィード（手動追加・各 feed）を 1 つ選んで一覧を絞る（`ArticleFilter::Genre` / `Feed`）。表示モード（一覧・フィード・ジャンル）とグループの開閉はそのまま使える。グループ見出しのクリックは開閉のままにした（見出しに 2 つの操作を載せない）。

### 未実装（意図的）

統合の取り消し、`<link>` の候補の事前検証、`<a href>` で張られた feed の検出、改名で消えたジャンルを選んでいる絞り込みの自動解除（一覧が空になるので選び直す）。

## 16. フィードバック対応

| 対象 | ファイル |
|---|---|
| 訳先の言語（`Target`・`is_japanese`・英訳の prompt） | `crates/lattice-core/src/segments.rs`、`translate.rs`、`store.rs`（`article_is_japanese`・`hit_details`） |
| ページの訳先 | `src/overlay/logic.ts`（`pageTarget`）、`src/overlay/index.ts` |

- **日本語の記事は英語に訳す。** 記事の言語は、`articles.language`（ページが宣言した言語）があればそれで、なければ先頭 20 個の prose block のテキストで決める（CJK が優勢なら日本語）。日本語なら訳先は `en`、それ以外は従来どおり `ja`。訳先は `segments::Target`（言語と専門用語モード）で表し、その `key()` を `target_language` として cache・Reader の join・検索結果の訳文・translate job の params と dedup key に使う。英語への訳の既定モードの key は `en`。言語は保存せず、`get_article`・`translate_article`・検索のたびに決める（`hit_details` は記事ごとに決める）。
  - 宣言された言語がテキストと食い違っても宣言を優先する。中国語の記事は宣言がなければ日本語と判定され、英語に訳される。
  - 英語への訳の専門用語モード: オン（既定）は「定着した英語の用語を使う（ラテン文字で書かれた用語はそのまま）」、オフは「専門用語より平易な英語を優先する（略語と製品名はそのまま）」を prompt に入れる。訳元の言語は、英語への訳なら日本語、それ以外は英語として prompt に書く。
  - Reader の混在は「訳文の割合」になり、日本語の記事では英語の割合になる。「日本語に翻訳」は記事の訳先に合わせて「英語に翻訳」と表示する。
  - ページ表示の overlay も、`<html lang>` があればそれで、なければ最初に見つけた 30 個の block のテキストでページの言語を決め、日本語のページは英語に訳す（`overlay_translate` の `target`。`en` 以外は日本語として扱う）。訳先の言語ですでに書かれた block は送らない。
- **分類のバックフィル。** 自動分類が入る前に保存した記事には classify job がない。起動時、自動分類がオンなら、ジャンルか難易度がなく classify job を一度も持たなかった抽出済みの記事に job を積む（`classify::enqueue_missing`。dedup key `classify:{id}` で `ON CONFLICT DO NOTHING`）。「未分類をすべて分類」と違って既存の job は再投入しないので、失敗した分類や結果の出なかった分類を起動のたびに LLM に送り直すことはない。
- **翻訳の追加の指示。** 設定「翻訳」の「追加の指示」（`settings.translate_instructions`、2000 文字まで、空なら保存しない）を、翻訳と re-split の prompt の末尾（信頼しない入力についての注意の直前）に「ユーザーからの追加の指示」として付ける。記事の翻訳もページ表示の overlay も同じ prompt を通るので両方に効く。`Target` が指示を持ち、`key()` に指示の sha256 の先頭 12 桁を `-x-instr-` で付けるので、指示を変えると別の cache になる（空の指示は従来の key のまま）。translate job は params に key と指示の本文を持ち、queue に入れたときの指示で訳す。設定画面には、指示が拡張する組み込みの prompt（英語→日本語、現在の専門用語モード）を読み取り専用で表示する。
- **記事の削除。** `Store::delete_article`（command `delete_article`）が記事と、そこから派生したものを 1 transaction で消す。snapshot・block（FTS の行と embedding も）・job・タグ付け・要約・分類履歴・画像の対応行は FK の cascade で消え、どの記事も使わなくなった画像の bytes は既存の trigger が消す。訳文の cache（`segment_translations`）は記事から独立しているので、消す記事の block の hash のうち、他の記事の block が使っていないものだけを消す（FTS の行は trigger で消える。ページ表示でしか使っていない訳は記事を消すと失われる）。どの記事も使わなくなったタグも消す。残すもの: `feed_items`（残さないとフィードの次の取得で同じ記事を取り込み直す）、対話の回答（引用は block のテキストをコピーして持つので表示でき、引用元を開くと記事がないためページで開く）。実行中の job が消した記事に書き込もうとしても FK で失敗するだけで、job は失敗として記録される。
  - UI: Reader の ⋯ に「記事を削除…」、ページ表示で Index 済みのときの ⋯ に「Index から削除…」。どちらも確認ダイアログ（`src/ConfirmDialog.tsx`。`alertdialog`、初期フォーカスは「キャンセル」、Tab はダイアログ内を巡回、Esc と背景のクリックでキャンセル、キーはアプリのショートカットに届かない、ネイティブの webview は隠す）を通す。削除後は文書を閉じて一覧を読み直す。
- **アプリ内ブラウザ。**
  - ページを切り替えると前のページが一瞬見えていた。原因は 2 つ。(1) Page 表示に入ると UI の `browser_set_bounds`（同期 command）が非同期の `browser_open` より先に走り、読み込み済み扱いのままの前のページを表示していた。`BrowserView` は open の応答までは bounds を送らない。(2) 読み込み中は `hide()` していたが、非表示の WebView2 は描画を止めるので、表示し直した瞬間に前のページの最後のフレームが出る。読み込み中は隠さずにウィンドウ外（-20000, -20000。renderer と同じ）に置き、描画を続けさせる。読み込み中の扱いは、アプリから開いたときだけでなく、ページ内のリンク・戻る・進む・再読み込みを含むすべての読み込み（`PageLoadEvent::Started` から `Finished` まで）に広げた。その間は下の placeholder が「読み込み中…」を出す。読み込みが完了しない遷移（ダウンロードなど `Finished` が来ない場合）ではページが出ないままになりうる（実機では未確認）。
  - 戻る・進むは、履歴がない方向を disabled にする。`browser-page` イベントの `can_go_back` / `can_go_forward` は、Windows では WebView2 の `CanGoBack` / `CanGoForward` を読む。ページの Navigation API（`navigation.canGoBack`）は同じ origin の履歴しか数えないので、別サイトから移ってきたページでは「戻れない」と答えてしまう。overlay は読み込み時と同一文書内の遷移（`currententrychange`）で `overlay_history` を呼び、それがイベントを出し直すきっかけになる（Windows 以外では overlay の値をそのまま使う）。読み込み開始時と、API がないときは両方有効のままにする。`overlay_history` はリモートのページから呼べるが、browser webview からの呼び出しだけを受け付け、ツールバーのボタンの状態しか変えない。
  - overlay は aside を訳す対象に含める（`SKIP` から外した。nav / header / footer は従来どおり除く）。抽出でも、Readability（dom_smoothie）はすべての `<aside>` と「sidebar」のような class を持つ要素を boilerplate として消すので、本文（`article` / `main` / `[role=main]` / `[itemprop=articleBody]`）の中の aside は parse の前に `<div>` にし、その中の class / id を外す（code と pre の class は言語を持つので残す）。本文の外の aside は従来どおり消える。`EXTRACTION_VERSION` は 2。
  - ページ上の訳文の点線の下線をやめた（hover の背景と吹き出しは残す）。
  - URL バー（G36）。URL をクリックすると入力欄になり、URL 全体を選択する。Enter で開き（IME の変換確定の Enter は除く）、Esc とフォーカスが外れたときは表示に戻す。入力の解釈は `src/engines.ts` の `toNavigation`: `http(s)://` で始まればその URL、空白がなくホストらしい（`localhost`・IP・英字の TLD で終わるドット区切り。ポートとパスが続いてもよい）なら `https://` を付けたもの、それ以外は検索エンジンの URL の `%s` に `encodeURIComponent` した入力を入れたもの。`javascript:` や `file:` などは検索語になるので、開くのは常に http(s)（`browser.rs` の `is_http` も従来どおり）。`v1.2` のような数字の TLD は検索、`node.js` のような英字の TLD はホストとして開く（公開 TLD の一覧は持たない）。開くのは `openPage` なので、アプリから開くときと同じく保存済みの記事の判定などが走る。検索エンジンは設定「ブラウザ」で選び、ショートカットと同じく UI の localStorage（`lattice.searchEngine`）に置く（DB のバックアップには入らない）。カスタムは `%s` を含む http(s) の URL で、使えない間は DuckDuckGo を使う。ホームはエンジンのトップページ（カスタムは URL の origin）。
  - ページにフォーカスがある間のショートカット（G50）。native webview がキーを受け取るので、overlay が window の keydown を capture で拾い、アプリのショートカットなら `overlay_key` で送る。アプリは `browser-key` を受けて自分の keydown と同じ操作を実行する。送るキーは UI が `pageKeys(bindings)` で作り、`browser_set_keys` で backend に置く（overlay は `overlay_config` の応答で受け取り、変更は eval で届く）。振り分け（`routeKey`）: 入力欄でも動く操作の Ctrl / Alt キー（`Ctrl+K`・`Ctrl+B`）は入力欄からも送り、ページの handler とブラウザの既定動作を止める。ほかのキーは入力欄（input・textarea・select・contenteditable）の外でだけ送る。修飾なしのキーは、ページの handler が走り終わってから（`setTimeout`）`defaultPrevented` でなければ送る（ページが自分の `/` や j を持つサイトではページを優先する。capture の時点ではページの handler はまだ走っていない）。Enter・Esc・矢印・Space などの名前付きキーは修飾なしなら送らない（ページの操作・スクロールに使う）。`Ctrl+B` を送ったあとは `PREFIX_MS` の間、次のキーを無条件に送る。アプリ側では、ページ由来のキーは文書ペインから押したものとして扱い（ペイン移動の起点は文書ペイン、アプリ内で最後にフォーカスのあった要素は blur する）、パレット・検索・Reader / Page 切り替え・ペイン移動のときは `setFocus` で main webview にキーボードを戻す。`overlay_key` もリモートのページから呼べるが、browser webview から、表示中（読み込み中でない）の間だけ受け付ける。ページが自分でアプリのショートカットを押せてしまう点は許容する（できることはユーザーのキー操作と同じ）。
- **favicon。** フィード（フィード画面の表・サイドバー）、記事の行、Reader の meta 行で、名前の左にサイトのアイコンを出す（`src/Favicon.tsx`。16px、角丸 3px。アイコンがない間はドメインの頭文字を中立色の四角で出す）。取得はバックエンドだけで行う（main webview の CSP は `img-src 'self' data:` のまま）。
  - 保存先は `favicons(domain, mime, bytes, error, fetched_at)`（migration 17）。取得できなかった理由も 1 行として残す。`favicon(domain)` command は保存済みのアイコンを `data:` URL で返し、行がないか 1 週間より古ければ `favicon` job（network runner、記事を持たない job。dedup key `favicon:{domain}`）を積む。古い行は再取得が終わるまでそのまま返す。job が終わると `favicon-changed`（ドメイン）を emit し、UI はそのドメインだけを聞き直す。UI はドメインごとの Promise を module 内に持つので、1,000 行の一覧でも呼び出しはドメインごとに 1 回になる（harness で確認）。ドメインは「初めて見たとき」＝UI が初めて聞いたときに取得する（取り込み時には積まない）。
  - 取得の順序: そのドメインの記事の最新 snapshot の `<link rel~=icon href>`、snapshot がない（またはリンクがない）ときはサイトの root（`https://{domain}/`）の HTML のリンク、最後に `/favicon.ico`。最初に取得できたものを保存する。取得は記事画像の `download`（`check_public` で private address を拒否、Content-Type と magic number の検査、受信中のサイズ確認）を通し、上限は 1 MB。SVG は保存しない。ICO を magic number の判定に加えた（記事画像でも ICO を保存するようになる）。timeout・5xx・429 だけのときは何も保存せず job を失敗させ、backoff で再試行する。ほかの失敗は理由を保存し、1 週間後に聞かれるまで再取得しない。root は https だけを試す。

- **タスクバーの未読数（G46）。** Windows には badge の API がないので、未読数を描いた画像をウィンドウの overlay icon にする（`src-tauri/src/badge.rs`。他の OS は `set_badge_count`）。画像は 16 px × 表示倍率の accent 色の円に、3×5 px の数字を整数倍で白く描く（ぼけない）。100 件以上は「99+」、0 件なら消す。未読数は UI が既に数えている `counts.unread` を、変わってから 500 ms 待って `set_unread_badge` で渡す（既読にしていくと続けて変わるため）。backend は最後の数を覚えていて、設定「タスクバー」でオフ（`settings.taskbar_badge = 'off'`、既定はオン）にすると消し、オンに戻すとその数を出す。

## 17. 取得できない記事とフィードの表示名・アイコン

| 対象 | ファイル |
|---|---|
| entry の title・本文の保存、失敗した記事の取り直し | `crates/lattice-core/src/feeds.rs`（`parse`・`import`） |
| フィードの本文での取り込み | `crates/lattice-core/src/ingest.rs`（`store_fetch_result`・`from_feed`） |
| 取得を拒否された記事の裏描画 | `crates/lattice-core/src/render.rs`（`enqueue_if_auto`） |
| スキーマ、URL の正規化のやり直し | `crates/lattice-core/src/store.rs`（migration 18, 19）、`url_norm.rs` |
| 表示名・アイコン | `crates/lattice-core/src/feeds.rs`（`rename`・`set_icon`・`icon`）、`src/FeedsView.tsx`（`FeedEditor`）、`src/Favicon.tsx` |
| 表示 | `src/Reader.tsx` |

- **きっかけ。** Medium がホストするフィード（例: `techblog.netflix.com/feeds/posts/default` → `medium.com/feed/netflix-techblog`）の記事は、ブラウザ以外の取得に 403 を返す（bot 対策。ブラウザの user agent の curl でも 403）。記事はすべて「取得失敗」になり、タイトルも URL のままだった。フィードには entry の title と、`content:encoded` に本文の HTML 全体が入っている。
- **entry の保存。** `feed_items` に `title` と `content`（deflate した HTML）を足した（migration 18）。本文は RSS の `content:encoded`・Atom の `content` と、HTML の `description` / `summary` のうち長い方で、タグを除いた文字数が 500 未満なら抜粋として保存しない。poll のたびに、取り込み済みの entry も含めて title と本文を上書きする（フィードが本文を載せなくなっても、保存済みの本文は残す）。migration 18 はすべてのフィードの ETag / Last-Modified を消すので、更新後の最初の poll は 304 にならず、以前の entry にも本文が入る。
- **フィードの本文で取り込む。** 記事の取得に失敗したとき（HTTP のエラーも通信の失敗も）と、取得したページの抽出が失敗するか 300 文字未満（bot 判定のページなど）だったときに、その記事の entry に本文があれば、それを `<title>` 付きの HTML に包んで通常の経路（抽出・block 化・画像 job）に通す。ページと同じく untrusted な入力として扱う。snapshot は `content_type = 'text/html; source=feed'` で保存し、URL は記事の元の URL のまま。タイトルは entry の title をそのまま使う（Readability は「… — Part II」をダッシュで切ってサイト名とみなす）。取得のエラーは `last_error` に残す。`ArticleRow.from_feed`（最新 snapshot がフィードの本文）で Reader が「フィードの本文から取り込みました」と理由を出し、「再試行」「描画して取り込み直す」を置く。
  - 既にページから十分な本文を取れている記事（最新 snapshot がフィード以外で 300 文字以上）は上書きしない。フィードの本文は、現在の本文より長いときだけ保存する（最新 snapshot がフィードなら取り直す）。
  - `upsert_pending` は、最新 snapshot がフィードの本文なら「まだ取得が必要」と返す。そのため Reader の「再試行」や URL の保存し直しは元ページを取り直す。取り直しも失敗すれば同じ本文が入り直す（block ID は変わらない）。
- **本文がなければ裏描画。** `render::enqueue_if_auto` は、取得が 401・403・429・5xx で失敗した記事にも render job を積む（404・410 と通信の失敗は積まない）。WebView2 なら bot 判定を通ることがある。Reader の「描画して取り込み直す」は取得に失敗した記事でも押せる。
- **タイトル。** 抽出していない記事（取得中・失敗）の `title` は entry の title を表示する（`ARTICLE_COLS` の coalesce。記事の行は書き換えない）。抽出してもページに title がなければ entry の title を保存する（`published_at` と同じ扱い）。
- **既に失敗した記事。** poll で entry の本文が初めて保存されたとき、その entry の記事が取得か抽出に失敗していれば ingest job を積み直す。job は取得をやり直し、失敗すればフィードの本文を使う。本文が初めて現れたときだけなので、何度 poll しても積み直すのは 1 回だけ。
- **URL の正規化。** Medium はフィードのリンクに `?source=rss----<id>---4` を付けるので、`source` の値が `rss` で始まるときは正規化で落とす（他の `source` は意味を持ちうるので残す）。保存済みの `articles.normalized_url` / `canonical_url` と `feed_items.normalized_url` は migration 18 の中で Rust の `normalize` で付け直す（`RENORMALIZE_AT`）。新しい形が既に使われている行は `UPDATE OR IGNORE` で元のまま残る。
- **実際のデータで確認。** ユーザーの DB の読み取り専用の複製（`VACUUM INTO`）で、migration の後に feed 2 を poll すると、取得に失敗していた 10 件（id 30〜39）の ingest job が積み直され、job はすべて 403 の後にフィードの本文で取り込んだ（35〜145 block、entry の title）。記事は増えず、2 回目の poll は何も積まなかった。
- **実際のフィードで確認。** `https://medium.com/feed/netflix-techblog` は 10 entry で、すべてに本文があり（HTML 12〜36 KB、抽出後 10,000〜30,000 文字、35〜145 block）、記事ページは 403 を返した（使い捨ての example で取得・解析・抽出した）。

- **フィードの表示名。** フィード画面の各行の「編集」で、表示名（`feeds.custom_title`、migration 19、200 文字まで）を付けられる。空にするか「元に戻す」でフィード本来の名前（`feeds.title`。poll で更新され続ける）に戻る。表示名は `ARTICLE_COLS` の `feed_title`（`coalesce(custom_title, title, url)`）とフィード一覧の並び順に入るので、記事の行・Reader・グループ・スコープ名・検索の絞り込みに効く。`FeedRow` を直接表示する箇所（サイドバー、パレット、対話と検索のスコープ選択）は `groups.ts` の `feedName` を通す。
- **フィードのアイコン。** 同じ編集欄で画像ファイル（1 MB まで）を選ぶと `feeds.icon` / `icon_mime` に保存する。形式は拡張子や申告ではなく中身で決める（ラスターは記事画像と同じ magic number の判定、SVG は UTF-8 で先頭 4 KB に `<svg` があるもの）。SVG は script を持てるが、UI は `data:` URL の `<img>` でしか表示しない（`<img>` の SVG では script が動かない。harness で確認）。`feed_icon(id)` command が `data:` URL を返し、`Favicon` は `feed` を渡されるとそれを優先して、なければサイトの favicon を出す。サイドバー・フィード画面の表・そのフィードの記事の行・Reader の meta 行で使う。変更後は `feedIconChanged` がそのフィードの cache だけを消す。「サイトのアイコンに戻す」で消す。
  - サイドバーのフィードには右クリックのメニューを付けていない（アプリにコンテキストメニューの仕組みがない）。編集はフィード画面（サイドバーの「管理」）から行う。

### 未実装（意図的）

poll と ingest job の競合: entry の本文は job を積んだ後に保存するので、その間に job が走ると（数 ms）本文なしで失敗する。poll のたびに「本文があるのにフィード本文を使わずに失敗した記事」を積み直すので、次の poll で回復する。

## 18. 品質（静的解析・テスト・CI。G39・G40・G42）

| 対象 | ファイル |
|---|---|
| Rust の整形と lint | `rustfmt.toml`、`mise.toml`（`lint`） |
| TypeScript の lint | `oxlint.config.ts`、`package.json`（`lint`） |
| E2E | `e2e/`（`mock.ts`・`fixtures.ts`・`setup.ts`・`harness.ts`・`*.spec.ts`）、`playwright.config.ts` |

- **rustfmt。** それまで整形していなかった。`max_width = 160` と `use_small_heuristics = "Max"` は、幅 100〜180 と heuristics を試して、整形で変わる行が最も少なかった組み合わせ（671 行）。`mise run lint` は `cargo fmt --check` を含む。
- **clippy（`-D warnings`、`--all-targets`）。** 指摘はすべて直した（`allow` はなし）。`search.rs` の `Ordered` は `PartialOrd` を derive して `Ord` だけ手で書いていたので、`PartialEq`・`PartialOrd` も `total_cmp` に揃えた（NaN でも等価と順序が食い違わない）。
- **oxlint（type-aware、`oxlint-tsgolint`）。** correctness と suspicious に加えて、hooks の規則（`rules-of-hooks`・`exhaustive-deps`）、promise の規則（`no-floating-promises`・`no-misused-promises`・`await-thenable`）、`no-unsafe-*`、`switch-exhaustiveness-check`（`default` のある switch は網羅とみなす）。type-aware でも 10 秒かからない。`tsc --noEmit` は従来どおり `npm run build` にある。
  - 外した規則と理由は `oxlint.config.ts` に書いた。React Compiler 向けの規則（アプリは compiler を使わない）、DOM の型の絞り込み（`e.target as HTMLElement`）を咎める `no-unsafe-type-assertion`、新しい配列にしか使っていない `no-array-sort`、スタイルだけの規則。
  - `no-misused-promises` は JSX の属性（`onClick={async …}`）を対象外にした。React は handler の戻り値を使わず、handler の中の非同期処理は `act` / `run` が catch してエラーを表示する。
  - 指摘のほとんどは、自分で catch する関数（`refresh`・`act`・`load` など）の Promise を投げっぱなしにしているもので、`void` を付けて意図を示した。実際に catch されていなかったのは、フィードのアイコンのファイル読み込み（`file.arrayBuffer()`）だけで、保存と同じ `act` の中に移した。localStorage の最近の検索は配列の文字列だけを読む。
  - `exhaustive-deps` の 8 か所は、依存を意図して絞っている effect（開いたときに 1 回、`seq` ごとに 1 回など）なので、理由を付けて行ごとに止めた。
- **E2E（mock IPC）。** アプリ本体（Rust）は起動しない。`e2e/vite.config.ts` がアプリの Vite 設定のまま `e2e/index.html` を port 1430 で配信し、`e2e/setup.ts` が `mockWindows("main")` と `mockIPC`（event も mock）を入れてから `src/main.tsx` を読む。実データにも実ネットワークにも触れない。
  - mock backend は `e2e/mock.ts` の `handlers`（command 名 → 関数）1 つ。引数と戻り値に `src/api.ts` の型を付けたので、型が変わると `tsc -p e2e` が失敗する。`e2e/commands.test.ts`（`npm test` で走る）は `api.ts` の `invoke("…")` を抜き出して `handlers` と突き合わせ、足りない command と余った command を名指しする。window / webview plugin の command（タイトルバー、ページからのショートカット）は `pluginHandlers`。
  - 状態を持つ: 既読・お気に入り・タグ・ジャンル・削除・取り込みは mock の中の記事の複製を書き換え、次の `list_articles` に出る。ページを読み直すと fixtures に戻る。結果は JSON の往復と同じく複製して返す。
  - 検索は「原文に語があれば全文、訳文にだけあれば意味、両方なら両方」と決めた。本物の意味検索ではないが、一致の種類での絞り込みとグループ化を決定的に試せる。
  - 時計は `page.clock.setFixedTime` で固定する（最近追加の件数が日付に依存するため）。
  - `harness.ts` の `app` fixture は、mock が答えない command を呼んだとき、ページの例外、`console.error` のどれかがあればテストを失敗させる。spec は見た目ではなく役割・ラベル・件数・呼ばれた command で確かめる（スクリーンショット比較はしない）。
  - 見つけた点: タグなどの facet を初めて選ぶと、popover を閉じたときにフォーカスが chip に戻らない（選ぶ前の chip ボタンが選択済みの chip に置き換わり、戻す先の要素が消える）。spec ではこの点を確かめていない。
- **単体テストの追加。** job の backoff（2・4・8・16 分の後に失敗）、取得 job だけが同じホストの取得を待つこと、実行中の job は取り消しも再実行もできないこと、1 回の poll で同じ記事が 2 度出ても 1 件だけ積むこと、overlay の sanitize が大文字や制御文字で隠した `javascript:` を落とすこと、キー設定を既定に戻すと override が消えること、ペイン移動が端で止まること。どれも、対象のコードを壊すとそのテストだけが失敗することを確かめた。
- **CI。** `.github/workflows/ci.yml` は windows-latest の 1 job。アプリを Windows で開発しているので Windows だけで走らせる（semantic search の ONNX Runtime が MSVC 14.40 以降を要る。README）。Node と Rust は `jdx/mise-action` が `mise.toml` の版を入れ、各コマンドは `mise exec --` で走らせる（ローカルと同じ解決）。clippy と rustfmt は toolchain の profile に頼らず `rustup component add` で入れる。手順は `mise run lint` と `mise run test` と `npm run e2e` を分けたもので、どの段で落ちたかがログで分かる。cache は `Swatinem/rust-cache`（`target` と cargo の registry）、npm の cache、Playwright のブラウザ（`package-lock.json` の hash で鍵を作る）。同じ ref の古い実行は取り消す。

