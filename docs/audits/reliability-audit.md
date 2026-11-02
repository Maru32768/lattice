# Lattice の信頼性・障害耐性の監査 (2026-11-03)

対象は `master` の `dd4191a` (0.2.0)。本番コードは変更していない。追加したのは再現テスト `crates/lattice-core/tests/reliability_audit.rs` とこの文書だけ。

## 0. 方法と表記

- ジョブキュー・SQLite ストア・ジョブの起動と終了は自分で読み、取り込み (ネットワーク)・LLM・バックアップと保存場所・Tauri シェルの 4 領域は並行して別のレビューアに読ませた。レビューアの指摘は、この文書に載せたものはすべて該当コードを読み直して確かめた。読み直せなかったものは載せていない。
- 既存の設計判断は `docs/design-review.md` と照合した。意図された挙動は指摘にせず §6 にまとめた。設計で触れていない帰結だけを指摘にした。
- 確認の度合いを 3 段階で書く。
  - **テストで再現**: `reliability_audit.rs` のテストが今のコードで失敗する (期待する挙動を assert している)。
  - **読解で確認**: 実行経路をコード上で最後まで追えた。発生条件が外部 (OS・SQLite・相手のサーバ・モデル) に依存する部分は「推測」と明記する。
  - **推測**: 実行時の挙動に依存し、確かめられていない。
- 重要度
  - **致命的**: 利用者の操作なしにライブラリの内容やバックアップが失われる。
  - **高**: 利用者のデータが壊れる・起動できなくなる・処理が止まって自力で戻せない・有料の LLM 呼び出しを繰り返し無駄にする。
  - **中**: 条件が限られるか、再起動や操作で戻せる不整合・停滞。
  - **低**: 見た目の古さ・小さなリーク・性能。

### 再現テストの実行

```bash
mise exec -- cargo test -p lattice-core --test reliability_audit -- --ignored
```

10 件のテストはすべて `#[ignore]` 付きで、通常の `cargo test` では走らない (CI は緑のまま)。各テストは修正後に期待する挙動を assert しているので、今は全件が失敗する。指摘を直したらそのテストの `#[ignore]` を外すと回帰テストになる。F7 の 1 件は SQLite の busy timeout を待つので約 20 秒かかる。F8 は Windows 専用。

2026-11-03 の実行結果 (要点):

| テスト | 指摘 | 失敗のメッセージ |
|---|---|---|
| `articles_that_share_a_bogus_canonical_url_are_not_merged` | F1 | `two different posts saved, the library has ["https://blog.example.com/posts/1"]` |
| `merging_a_refetched_article_into_an_existing_one_keeps_the_users_data` | F1 | `left: ([], false, None, 0)` / `right: (["to-read"], true, Some("the part about write skew"), 1)` |
| `a_queued_fetch_does_not_undo_a_newer_save` | F3 | `left: ("failed", "ok")`, `last error: network.blocked` |
| `a_failed_backup_leaves_no_copy_with_api_keys` | F5 | `...\backups\lattice-12.db is left behind with the API key` |
| `a_job_that_takes_the_process_down_stops_being_retried` | F6 | `still claimed at every start after 9 attempts` (`left: "running"`) |
| `a_job_whose_finish_cannot_be_written_does_not_stay_running` | F7 | `the job stays running, and retry and enqueue are no-ops until restart` |
| `a_second_process_does_not_rerun_a_job_another_one_is_running` | F7 | `job 1 is claimed a second time while the first process runs it` |
| `a_cli_call_in_flight_does_not_outlive_the_app` | F8 | `the child (pid …) is still running after its parent exited` |
| `translations_already_returned_are_saved_when_an_earlier_batch_fails` | F9 | `2 answered calls, 0 of 24 paragraphs saved` |
| `a_provider_outage_is_not_multiplied_by_the_batch_size` | F10 | `13 calls for one batch of 12 while the provider is down` |

## 1. 指摘の一覧

| ID | 重要度 | 内容 | 確認 |
|---|---|---|---|
| F1 | 致命的 | canonical URL による統合が、別の記事と利用者のタグ・メモ・グループを消す | テストで再現 |
| F2 | 致命的 | 保存場所のフォールバック中に R2 の世代管理が本物のライブラリのバックアップを消していく | 読解で確認 |
| F3 | 高 | 待機中の取得 job が、利用者が後から保存した内容を上書きする | テストで再現 |
| F4 | 高 | DB を開けないと、起動のたびに何も表示せず終了する (中断したフォルダ移動で起きる) | 読解で確認 |
| F5 | 高 | 失敗したローカルバックアップが API キー入りのまま残り、世代に数えられる | テストで再現 |
| F6 | 高 | プロセスごと落ちる job は試行回数の上限が効かず、起動のたびに再実行される | テストで再現 |
| F7 | 高 | `running` に持ち主がなく、取り残された job は再起動まで止まり、別プロセスの job は二重に実行される | テストで再現 |
| F8 | 高 | アプリを終了しても `claude` / `codex` の子プロセスが動き続ける | テストで再現 |
| F9 | 高 | 翻訳で 1 batch が全滅すると、返ってきた後続の batch の訳を捨てる | テストで再現 |
| F10 | 高 | provider の障害時、1 batch が 1 + N 回の呼び出しに増え、並列数の上限も外れる | テストで再現 |
| F11 | 中 | 分類・重要度の batch で 1 記事の失敗が最大 20 件の job を巻き込む | 読解で確認 |
| F12 | 中 | 翻訳の照合が形だけを見ており、取り違えた訳が全記事共通のキャッシュに入る | 読解で確認 (発生は推測) |
| F13 | 中 | アプリと CLI/MCP が同時に初回起動するとマイグレーションが衝突する | 読解で確認 |
| F14 | 中 | 読んでから書く transaction が別プロセスの書き込みで即座に SQLITE_BUSY になる | 読解で確認 (SQLite の仕様) |
| F15 | 中 | 画像 job に時間の上限がなく、その間同じホストの取り込みが止まる | 読解で確認 |
| F16 | 中 | URL 保存の取得中にアプリを閉じると、記事が「取得中」のまま残る | 読解で確認 |
| F17 | 中 | 実行中の job への enqueue が捨てられ、後追いがない | 読解で確認 |
| F18 | 中 | 単語の意味を手で入れても、実行中の LLM job が上書きする | 読解で確認 |
| F19 | 中 | フィードが 304 を返し続けると、フィード本文への切り替えが再試行されない | 読解で確認 |
| F20〜F27 | 低 | 他ウィンドウの表示が古い、cooldown の巻き添え、MCP が古いライブラリを見続ける、ほか | 読解で確認 |

修正の優先順は F1 → F2 と F4 (同じ起動処理で直す) → F6・F7 (同じ job の所有権の問題) → F5 → F3 → F8 → F9・F10。

## 2. アーキテクチャとデータフロー

### 構成

- `lattice-core`: ドメインのロジック。`Store` は `Mutex<Connection>` 1 本の SQLite (WAL、`busy_timeout=5000`、`foreign_keys=ON`。`store.rs:510-531`)。すべての読み書きがこの mutex を通る。
- `src-tauri`: setup で `Store` を開き、ランナーを起動する (`lib.rs:1199-1320`)。
- `lattice-cli`: 同じ DB を別プロセスとして開く (`lattice-cli/src/main.rs:53-68`)。`save --run` と MCP の `save` は自分のプロセスで job を実行する (`ops.rs:324-343`)。
- バックアップ (ローカル・R2) は DB を別の接続で開き、`VACUUM INTO` で複製する (`backup.rs:52-54`、`r2.rs:228-236`)。

### 主なデータフロー

1. **取り込み**: URL → `upsert_pending` で記事行 (`fetch_status = pending`) → 取得 (`fetch.rs`、30 秒・20 MB の上限) → 抽出 (`extract.rs`、深さ 256 で切る) → `save_snapshot` が snapshot と blocks を 1 transaction で保存し、canonical URL が既存の記事を指せば今の行を消して統合 (`store.rs:648-719`) → 画像・埋め込み・分類・重要度・要約・翻訳・描画の job を積む (`jobs.rs:228-237`)。経路は 3 つ。パレットの保存は取得をその場で行う (`ingest::save_url`)。一括インポートとフィードは `ingest` job を積む。ブラウザからの保存は描画済みの DOM を直接保存する (`save_rendered`)。
2. **job キュー**: `processing_jobs` (`dedup_key` が UNIQUE)。`enqueue_job` は既存の job を pending に戻すが、`running` の job には何もしない (`store.rs:970-978`)。`claim_job` は 1 つの `UPDATE … RETURNING` で取り、`attempt_count` を 1 増やす。ingest と images は同じドメインの job が running なら飛ばす (`store.rs:996-1020`)。`finish_job` が失敗回数に応じて backoff し、5 回目で `failed` にする (`store.rs:1023-1041`)。起動時に `recover_running_jobs` がすべての `running` を `pending` に戻す (`store.rs:981-983`、`lib.rs:1233`)。
3. **LLM**: ドメインのコードが prompt を作り、`LlmChain` (最大 3 つの provider、5 分の cooldown。`chain.rs`) が CLI (`claude.rs`/`codex.rs`、子プロセス、600 秒) か API (`llm.rs:109`、600 秒) を呼ぶ。結果はドメインのコードが検証して保存する。翻訳は本文の hash をキーにした全記事共通のキャッシュ (`segment_translations`)。
4. **バックアップと保存場所**: ローカルは `lattice-<unix 秒>.db` を残す世代数まで。R2 は 15 分ごとに期限を確かめ、`lattice/<端末名>/` の下に上げて古い世代を消す (`r2.rs:186-198`、`r2.rs:333-345`)。保存場所は `data-location.json` で選び、選んだフォルダに `lattice.db` がなければ既定のフォルダに戻る (`location.rs:117-130`)。

### 非同期・並行の境界 (アプリ内の常駐タスク)

| タスク | 対象 | 数 | panic の扱い | 起点 |
|---|---|---|---|---|
| `run_worker` | 要約・分類・quiz・単語・重要度・フィード判定 | 1 | `catch_unwind` (`jobs.rs:166-170`) | `lib.rs:1270` |
| `run_worker` | 埋め込み | 1 | 同上 | 同上 |
| `run_worker` | ingest・images・favicon | 4 (`NET_WORKERS`) | 同上 | 同上 |
| `run_translate_worker` | 翻訳 | 最大 8 (並列実行数、`Gate` で共有) | 同上 | `lib.rs:1289` |
| `run_foreground` | 画面の記事の翻訳・要約・quiz | 1 | 同上 | `lib.rs:1306` |
| `renderer::run` | 描画 (隠し WebView) | 1 | **なし** (`renderer.rs:47-67`) | `lib.rs:1309` |
| `r2::run_scheduler` | R2 バックアップ | 1 | なし | `lib.rs:1311` |
| `feeds::poll_forever` | フィードの巡回 (30 分) | 1 | **なし** (`feeds.rs:343-348`) | `lib.rs:1314` |

このほか対話 (同時 2)、Page 表示の翻訳 (overlay、semaphore) が LLM を呼ぶ。

### 永続化と外部呼び出しの境界

- **プロセス内**: `Store` の mutex が書き込みを直列化する。`MutexGuard` は `!Send` なので、spawn した future の中で `.await` をまたいで持つとコンパイルが通らない。ロックを持ったまま await する誤りは型で防がれている。
- **プロセス間**: アプリ・CLI・MCP サーバ・2 つ目のアプリが同じ DB を開きうる。調停は SQLite のロックと `busy_timeout` だけ。single-instance の仕組みはない (`lib.rs:1190-1193` のプラグインは dialog・updater・autostart)。
- **外部**: HTTP 取得 (30 秒)、LLM の CLI (600 秒、`kill_on_drop`)、LLM の API (600 秒)、R2 (接続 30 秒、1 リクエスト 15 分)、埋め込みモデルのダウンロード (約 470 MB)、隠し WebView (12 + 8 秒)。

## 3. 境界ごとの失敗モード

| 境界 | 失敗 | 現状の扱い | 指摘 |
|---|---|---|---|
| HTTP 取得 | timeout・接続拒否・4xx/5xx | 記事に記録し job は成功。Reader の再試行で取り直す | F3, F16, F19 |
| HTTP 取得 | 巨大な本文・深い入れ子 | 20 MB の上限、深さ 256 で切る | 問題なし |
| 抽出・描画 | panic | job ランナーは捕捉、描画ランナーとフィード巡回は捕捉しない | F6 |
| LLM | 利用上限・認証・障害 | job を失敗させ backoff、chain は 5 分 cooldown | F10, F20 |
| LLM | 内容に起因する拒否・出力上限 | 他の失敗と同じ扱い | F9, F11, F20 |
| LLM | 形は正しいが中身が違う出力 | 形だけ検証 | F12 |
| LLM の CLI | ハング・パイプ詰まり | 600 秒の timeout、stdout/stderr を並行に読む | 問題なし |
| LLM の CLI | アプリの終了 | 子プロセスは殺されない | F8 |
| job | ハンドラの失敗 | backoff して 5 回で failed | 問題なし |
| job | ハンドラ中のプロセス終了 | 起動時に pending へ戻すだけ | F6, F7 |
| job | `finish_job` の書き込み失敗 | 250 ms 間隔で 3 回試して諦める | F7 |
| job | 実行中の enqueue | 捨てる | F17, F18 |
| SQLite (プロセス間) | 書き込みの競合 | `busy_timeout` 5 秒 | F7, F13, F14 |
| SQLite | 新しいスキーマ・破損 | `Store::open` がエラー | F4 |
| バックアップ | 複製・掃除の途中の失敗 | 最終名のまま残る | F5 |
| 保存場所 | 選んだフォルダが使えない | 既定のフォルダで起動し設定画面に警告 | F2 |
| 保存場所 | コピーの中断 | 途中のファイルが残る | F4 |

## 4. 指摘の詳細

### F1. canonical URL による統合が、別の記事と利用者のデータを消す (致命的・テストで再現)

**発生条件** (どちらか)

1. 全ページの `<link rel="canonical">` がサイトのトップを指すサイト (設定の誤りとして珍しくなく、SPA のテンプレートの既定にもある) の記事を 2 件以上保存する。一括インポートやフィードで起きやすい。
2. 取得に失敗した記事行に、利用者がタグ・お気に入り・メモ・グループを付ける。後で再試行すると取得でき、そのページの canonical が既に保存済みの記事を指していた。

**影響**

- 条件 1: 2 件目以降の記事は保存されずに消え、1 件目に解決される。同じサイトから 50 件を一括インポートすると 1 件しか残らない。どの記事が消えたかは画面に出ない。
- 条件 2: 失敗していた行に付けたタグ・お気に入り・メモ・グループの所属が消え、残る記事にも移らない。

**証拠**

- `store.rs:657-674`。統合の判定は「保存中の行がまだ抽出されていない」「canonical が既存の行の `canonical_url` か `normalized_url` に一致する」だけで、canonical の妥当性も内容の一致も見ない。

  ```rust
  "SELECT id FROM articles WHERE id != ?1 AND extraction_status = 'ok'
   AND (canonical_url = ?2 OR normalized_url = ?2)
   AND (SELECT extraction_status FROM articles WHERE id = ?1) IS NOT 'ok' LIMIT 1",
  ...
  tx.execute("DELETE FROM articles WHERE id = ?1", [id])?;
  ```

- 削除は `article_tags`・`article_notes`・`group_articles` に cascade する (`db/migrations/00029_article_notes.sql`、`00022_groups.sql`)。
- 統合を「まだ抽出されていない行」に限ったのは、利用者のデータを持つ記事を消さないためだった (`store.rs:657-658` のコメント)。ただし取得に失敗した行もこの条件に入り、利用者はそこにデータを付けられる。
- 設計 (`design-review.md` §2 の 9) は canonical による統合を選んだが、誤った canonical には触れていない。

**再現**: `articles_that_share_a_bogus_canonical_url_are_not_merged` は、トップを canonical にした別内容の 2 記事を保存すると 1 件しか残らないことを示す。`merging_a_refetched_article_into_an_existing_one_keeps_the_users_data` は、失敗した行に付けた 4 種類のデータがすべて消えることを示す。

**既存テスト**: `stores_blocks_and_dedups` は正しい統合だけを見ている。

**修正候補**

- canonical がサイトのトップ (パスが `/`) か、取得した URL と別ホストなら統合しない。
- 統合の前に抽出した本文の `content_hash` (またはタイトル) が既存の記事と一致することを確かめる。一致しなければ canonical を記録するだけにする。
- 消す行にタグ・メモ・グループ・お気に入り・既読があれば、残す記事へ移してから消す (同じ transaction で `INSERT OR IGNORE … SELECT`)。

**トレードオフ**: 内容の一致を条件にすると、本文が少し違う AMP 版や追跡パラメータ付きの URL が統合されず重複として残る。重複は利用者が消せるが、消えた記事は戻らない。重複に倒す方が安全。

### F2. 保存場所のフォールバック中に、R2 の世代管理が本物のバックアップを消していく (致命的・読解で確認)

**発生条件**: R2 バックアップを有効にしてから保存場所を移した。その後、選んだフォルダが使えなくなった (外付け・ネットワークドライブが起動時にまだつながっていない、ドライブが壊れた)。

**影響**: 移動元のフォルダには移動時点の古い DB が R2 の設定と古い `r2.last_success` ごと残っている。フォールバックした起動ではその古い DB が開き、R2 のスケジューラがすぐに期限切れと判断して古いライブラリを上げ、同じ端末の接頭辞の下で最も古い世代 (本物のライブラリ) を消す。既定の 24 時間間隔なら 1 日 1 世代ずつ入れ替わり、30 日 (既定の世代数) で本物のライブラリの R2 上のコピーがなくなる。ドライブが壊れた場合、R2 が最後のコピーである。フォールバックの警告は 設定 › 保存場所とログ にしか出ない。

**証拠**

- `location.rs:117-130`: 選んだフォルダに `lattice.db` がなければ、警告を付けて既定のフォルダで続ける。
- `src-tauri/src/location.rs:45-46`: 移動は元のフォルダを変えず、消さない。
- `lib.rs:1311`: `r2::run_scheduler` は `loc.warning` に関係なく起動する。
- `r2.rs:177-183` (`due`): 有効で設定が揃い、最後の成功から間隔が過ぎていれば実行する。
- `r2.rs:226`、`r2.rs:296-298`: 接頭辞は `lattice/<端末名>/` で、ライブラリを区別しない。
- `r2.rs:342-343`: その接頭辞の下の世代を `keep` を超えた分だけ消す。

**再現**: 本番コードを変えずに書けるテストはない (`location::detect_at` が非公開で、スケジューラの起動は `src-tauri` の setup にある)。手順は、R2 を設定したライブラリを別フォルダへ移す → 移動先の `lattice.db` を消すかドライブを外す → 起動して 15 分待つ → R2 の `lattice/<端末名>/` に古いライブラリの世代が増え、最古の世代が消える。

**既存テスト**: `settings_hide_secret_and_drive_schedule` は `due` だけ、保存場所のテストはフォールバックだけを見ている。

**修正候補**

- `loc.warning` があるときは R2 のスケジューラを起動せず、手動の「今すぐバックアップ」も確認を挟む (最小の修正)。
- ライブラリごとにランダムな ID を設定に持たせ、R2 の接頭辞に含める。同じ PC の 2 つのライブラリ (「既存のデータに切り替え」や開発ビルドが同じ bucket を指す場合) が互いの世代を消すことも防げる。フォールバックした古い DB は同じ ID を持つので、こちらだけでは F2 は防げない。

**トレードオフ**: スケジューラを止めると、フォールバック中の (本当に既定のフォルダで使い続けている) 利用者のバックアップも止まる。警告を出し続ける前提で、止める方が損失が小さい。

### F3. 待機中の取得 job が、利用者が後から保存した内容を上書きする (高・テストで再現)

**発生条件**: 一括インポートやフィードで `ingest` job が待機している (ホストごとに 1 件ずつなので、同じサイトの記事が多いと長く待つ)。その間に利用者が同じページをアプリ内ブラウザで開いて「Index に追加」した (描画済みの DOM を保存)。その後に待機していた job が動く。

**影響**

- サーバがエラーを返す (bot 対策の 403、timeout) と、正しく保存された記事が `fetch_status = failed` になる。
- サーバが JS 前の薄い HTML を返すと、描画した本文が薄い本文で置き換わる。消えた block の埋め込みも消える。最新の snapshot がサーバの HTML になるので、「再抽出」では戻らない。

**証拠**

- `ingest.rs:25-28`: `process` は記事の状態を見ずに取り直す。

  ```rust
  pub async fn process(store: &Store, client: &HttpClient, article_id: i64) -> Result<i64, String> {
      let url = store.article_url(article_id)...;
      fetch_into(store, client, article_id, &url).await
  }
  ```

- `ingest.rs:172-177` (`save_rendered`) は待機中の job を残す。
- `store.rs:627-630` (`record_fetch_failure`) と `store.rs:675-688` は、既存の内容の良し悪しを見ずに状態と blocks を書き換える。

**再現**: `a_queued_fetch_does_not_undo_a_newer_save`。URL を積み、ブラウザからの保存をしてから、積んだ job を実行する。既定のネットワーク方針が 127.0.0.1 を拒否するので、サーバのエラーとして働く。結果は `("failed", "ok")`。

**既存テスト**: `rendered_save_replaces_thin_extraction_and_reextract_keeps_ids` は逆の順序 (取得の後に描画) だけを見ている。

**修正候補**: `process` の先頭で、`upsert_pending` と同じ「まだ取得が必要か」(抽出が ok でなく、または最新の snapshot がフィードの本文) を確かめ、不要なら何もせず成功で終える。取り込みの各経路はすでにこの条件で積んでいるので、待機中に状態が変わった場合だけを止める。

### F4. DB を開けないと、起動のたびに何も表示せず終了する (高・読解で確認)

**発生条件** (どれか)

- データフォルダのコピー (設定 › 保存場所) が途中で止まった。コピーは共有の接続で `VACUUM INTO` を実行し、その間 store の mutex を持つ (`store.rs:581-584`、`src-tauri/src/location.rs:47-48`)。大きなライブラリでは時間がかかり、待ちきれずにウィンドウを 2 回閉じると、2 回目は保存を待たずに閉じて `app.exit(0)` に進む (`popout.rs:325-346`)。
- 選んだフォルダの DB が新しい版の Lattice で書かれた (共有ドライブを別の PC と使う)、またはアプリを古い版に戻した (`store.rs:513-515`)。
- 起動時に別プロセスが 5 秒を超えて書き込みのロックを持っていた、または F13 の衝突。

**影響**

- setup の `Store::open(&path)?` (`lib.rs:1227`) のエラーは Tauri の中で `panic!("Failed to setup app: {e}")` になる (tauri 2.12.4 `app.rs:1443-1444`)。release は `windows_subsystem = "windows"` (`main.rs:2`) で、panic hook もない (リポジトリに `set_hook` はない)。利用者には何も表示されず、ウィンドウも出ない。毎回同じ。
- 途中で止まったコピーは最終名の `lattice.db` のまま残る。もう一度移そうとすると `has_data` は存在だけを見て真になり (`lib.rs:1005`、`lib.rs:1018`)、画面は「このフォルダのデータを使う」を勧める。0 バイトのファイルなら空のライブラリとして開き、ライブラリが空になったように見える。途中までのファイルなら上の無言の終了になる。
- 戻すには `data-location.json` を手で消すしかない。`docs/guide.md` はフォルダがない場合しか説明していない。

**証拠**: 上に挙げた行のほか、`location.rs:121-122` (選んだフォルダは `lattice.db` が「ファイルとして存在する」ことしか確かめない)。

**再現**: 本番コードを変えずに書けるテストはない。手順は `PRAGMA user_version = 999` を設定した DB を選んだフォルダに置いて release ビルドを起動する。`Store::open` が新しい版を拒むことは既存の `a_database_from_a_newer_build_is_refused_on_open` が確かめている。

**修正候補**

- setup で `Store::open` が失敗したら、選んだフォルダ (`Kind::Custom`) なら既定のフォルダへ `location.unusable` の警告付きで戻る。既定のフォルダならエラーを log に書き、ネイティブのダイアログ (DB のパスとログのフォルダ) を出して終わる。F2 の修正 (フォールバック中は R2 を止める) と一緒に入れる。
- コピーは別の接続で `lattice.db.partial` に `VACUUM INTO` し、フォルダの複製が終わってから `lattice.db` に rename する。失敗したら作ったものを消す。
- `has_data` は存在ではなく、読み取り専用で開いて `user_version` と `quick_check` を確かめる。

### F5. 失敗したローカルバックアップが API キー入りのまま残り、世代に数えられる (高・テストで再現)

**発生条件**: `backup_to` の 2 段目 (秘密の設定を消す `DELETE` か、その後の `VACUUM`) が失敗するか、その間にアプリが終わる。`VACUUM` は DB と同程度の空きを要するので、ディスクの空きが少ないときに起きやすい。

**影響**

- `backups/lattice-<n>.db` が API キーと R2 の secret を含んだまま残る。ガイドは「バックアップに API キーは入らない」と書いている (`docs/guide.md`)。利用者がバックアップのフォルダを同期・共有していると漏れる。
- 失敗したファイルや 0 バイトのファイルも世代として数えられ (`backup.rs:72-78` の `stamp` は名前だけを見る)、残る正常な世代が設定より少なくなる。

**証拠**

- `backup.rs:52-54`: 最終名に直接書き、失敗しても消さない。

  ```rust
  let path = dir.join(&name);
  Store::open(db).and_then(|s| s.backup_to(&path)).map_err(|e| e.to_string())?;
  ```

- `store.rs:587-592`: 複製してから消す 2 段の処理。

  ```rust
  self.copy_to(path)?;
  let copy = Connection::open(path)?;
  copy.execute("DELETE FROM settings WHERE key LIKE ?1 || '%'", [SECRET_PREFIX])?;
  copy.execute_batch("VACUUM")
  ```

**再現**: `a_failed_backup_leaves_no_copy_with_api_keys`。元の DB に「settings の DELETE を拒む trigger」を置く (`VACUUM INTO` が trigger も複製するので、複製の DELETE が失敗する)。ディスクが一杯のときの失敗の代わり。`backup_local` はエラーを返し、`lattice-12.db` は API キー入りで残る。R2 側は一時ファイルを失敗時に消している (`r2.rs:246-247`) が、プロセスが途中で終わると次の R2 実行まで残る (`r2.rs:229-234`)。

**既存テスト**: `backup_prunes_only_old_backups` と `store::tests::settings_and_backup` は成功の経路だけ。

**修正候補**: `lattice-<n>.db.part` (`stamp` が無視する名前) に書く。複製では `PRAGMA secure_delete = ON` にしてから消し、`VACUUM`・`quick_check`・`sync_all` の後に rename する。どこで失敗しても `.part` を消す。

### F6. プロセスごと落ちる job は試行回数の上限が効かず、起動のたびに再実行される (高・テストで再現)

**発生条件**: job の実行中にプロセスが終わり、`finish_job` に届かない。原因は 3 つある。

1. 利用者がアプリを閉じる、Windows の終了、更新の再起動。これは日常的に起こる。
2. stack overflow・メモリ不足・native コード (ONNX Runtime、WebView2) のクラッシュ。Rust では panic にならず abort する。
3. 描画ランナー・フィード巡回での panic。ここは `catch_unwind` がないので、タスクだけが死ぬ。

2 と 3 の具体的な入力は見つけていない (推測)。深い入れ子は抽出が深さ 256 で切り (`extract.rs:80-95`)、PDF は `catch_unwind` している (`pdf.rs:111`)。

**影響**

- 上限 (`MAX_ATTEMPTS = 5`) と backoff は `finish_job` の中だけにある (`store.rs:1023-1041`)。`recover_running_jobs` は無条件に `pending` へ戻し (`store.rs:981-983`)、`claim_job` は `attempt_count` を見ない (`store.rs:1000-1013`)。プロセスを落とす job は、起動のたびに backoff なしで最初に取られる (`ORDER BY j.id`)。原因 2 なら起動直後に毎回落ちる。
- 原因 3 の描画ランナーの場合、ランナーはそのセッションの間いなくなり、job は `running` のままになる。その記事の描画を頼んでも `enqueue_job` が何もしない。次の起動でも同じ job が最初に取られて、また止まる。フィード巡回が panic すると、そのセッションのフィード取得がすべて止まる。
- 原因 1 では、終了で中断されるたびに `attempt_count` だけが増える。その後の本当の失敗では、残りの試行が少ないまま `failed` になる。

**証拠**: 上の行に加えて、`renderer.rs:47-67` (描画は `catch_unwind` なし) と `jobs.rs:166-170` (job ランナーにはある。理由もコメントに書かれている)。

**再現**: `a_job_that_takes_the_process_down_stops_being_retried`。job を取ったまま `Store` を閉じ (プロセスの終了と同じく DB に `running` が残る)、開き直して `recover_running_jobs` と claim を 8 回繰り返す。9 回取られても `running` のまま。

**既存テスト**: `recovers_jobs_left_running` と `a_panicking_handler_leaves_the_job_retryable_instead_of_running` は、回復できることだけを見ている。

**修正候補**

- 回復時に、`attempt_count >= MAX_ATTEMPTS` の `running` は `failed` (理由「実行中に終了した」) にし、それ以外には backoff の `next_run_at` を付ける。
- 描画ランナーとフィード巡回の本体を `AssertUnwindSafe(..).catch_unwind()` で包み、job の終わらせ方 (`finish_job` と SQLITE_BUSY の再試行) を `jobs.rs` と共有する。

**トレードオフ**: 正常な終了による中断も失敗に数えると、長い翻訳が何度も中断されて `failed` になりうる。回復時に `started_at` を見て、短時間で終わったものだけを数える方法もある。

### F7. `running` に持ち主がなく、取り残された job は止まり、別プロセスの job は二重に実行される (高・テストで再現)

**発生条件と影響**

1. **止まる**: `lattice-cli save --run` や MCP の `save` が取得中に終わる (Ctrl+C、MCP のホストの終了)。または `finish_job` が 3 回とも書き込めない (別プロセスが 15 秒を超えて書き込みロックを持つ。ディスクの I/O エラー)。job はアプリを再起動するまで `running` のまま残る。再実行・取り消し・enqueue はすべて `running` を除外するので、利用者は戻せない (`job_status.rs:103`、`job_status.rs:115`、`store.rs:974`)。ingest か images なら、同じドメインの他の記事の取得もすべて止まる (`store.rs:1008-1012`)。フィードと一括インポートがそのサイトだけ黙って進まなくなる。
2. **二重に実行**: アプリは single-instance ではない。2 つ目の起動、またはアプリの起動中に動いていた CLI について、`recover_running_jobs` が他の生きているプロセスの `running` まで `pending` に戻す。両方が同じ job を実行し、LLM の job なら 2 回課金される。`segment_translations` には一意制約がない (`db/master.sql` の `segment_translations`) ので、翻訳の行も重複する。2 つ目のアプリはフィード巡回・描画・R2 のスケジューラも 2 本目を動かす。

**証拠**: `store.rs:981-983`、`lib.rs:1233`、`lib.rs:1190-1193` (single-instance のプラグインがない)、`jobs.rs:181-190` (3 回で諦め、エラーを返すだけ)。

**再現**

- `a_job_whose_finish_cannot_be_written_does_not_stay_running`: 要約の LLM 呼び出しの間に、別の接続が `BEGIN IMMEDIATE` で 22 秒ロックを持つ (CLI/MCP の書き込みの代わり)。要約の保存と `finish_job` の 3 回がすべて失敗し、ロックが外れた後も job は `running` のまま。`job_status::retry` は `None`、`summarize::enqueue` も効かない。
- `a_second_process_does_not_rerun_a_job_another_one_is_running`: 1 つ目のプロセスが job を取った後に 2 つ目が開いて回復すると、同じ job を取れる。

**既存テスト**: なし。`writes_need_the_opt_in` (CLI) は `--run` が最後まで動く場合だけ。

**修正候補**

- `processing_jobs` に持ち主 (プロセスの起動ごとの ID) と `heartbeat_at` を持たせる。回復は「持ち主が自分以外で、heartbeat が一定時間 (NET は 30 秒の上限があるので数分) より古い」ものだけを戻し、起動時だけでなくランナーの待機中にも行う。期限の切れた `running` は再実行・取り消しの対象にする。
- `tauri-plugin-single-instance` で 2 つ目の起動を既存のウィンドウに渡す。

**トレードオフ**: heartbeat の更新は書き込みを増やす。長い LLM job (最大 600 秒) は進捗のたびに更新するか、種類ごとに期限を変える必要がある。

### F8. アプリを終了しても `claude` / `codex` の子プロセスが動き続ける (高・テストで再現)

**発生条件**: LLM の CLI を呼んでいる途中で、アプリが終わる (閉じる、更新、強制終了)。

**影響**: 呼び出し中の CLI (翻訳は最大 8 batch とその個別の再試行、ほかの LLM ランナー、画面の記事の枠、Page 翻訳 3、対話 2) が、ウィンドウなし (`CREATE_NO_WINDOW`) で最後まで動く。利用者のサブスクリプションの使用量を消費し、結果は閉じたパイプに捨てられる。次の起動で同じ job がまた送られる (F6)。

**証拠**

- 後始末は `kill_on_drop(true)` だけ (`claude.rs:64`、`codex.rs:83`)。これは destructor で動く。
- Tauri の `App::run` は `std::process::exit` で終わる (tauri 2.12.4 `app.rs:584-585`、tao 0.37.1 `event_loop.rs:226`)。tokio のランタイムと `Child` は drop されない。
- Windows は親の終了で子を終わらせない。Job Object はリポジトリのどこにもない。
- `lib.rs:1512` は `.run(context)` で、終了時の処理を登録していない。

**再現**: `a_cli_call_in_flight_does_not_outlive_the_app` (Windows)。テストのバイナリ自身を「アプリ」として起動し、tokio の `Command` で `kill_on_drop(true)` の子 (`ping -n 30`) を作ってから `std::process::exit(0)` する。親の終了後も子が `tasklist` に残る。最初の版のテストは `output()` が子の終了まで 30 秒待ったが、これは子が親の stdout のハンドルを継承して生き続けたためで、同じ事実を示していた。

**修正候補**: 起動時に `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` の Job Object を 1 つ作り、spawn した子を入れる。孫プロセス (CLI が起動する node 等) とクラッシュ時も含めて、アプリの終了で終わる。あわせて Codex のスキーマの一時ファイル (`codex.rs:68-69`) を drop で消す (F27)。

### F9. 翻訳で 1 batch が全滅すると、返ってきた後続の batch の訳を捨てる (高・テストで再現)

**発生条件**: 1 つの batch の一括呼び出しと個別の再試行がすべて失敗する。内容に起因する場合 (6000 文字を超える段落は 1 つで 1 batch になり、出力の上限を超える、拒否される、HTTP 400) は毎回同じ batch が失敗する。一時的な障害でも、並列実行数が 2 以上なら後続の batch が先に返っていることがある。

**影響**

- `buffered` は記事の順に結果を出すので、先頭の batch が全滅して `return Err` すると、すでに返ってきて待っている後続の batch の訳を捨てる (課金済み)。
- 再試行では保存済みの block が飛ばされ、失敗する batch がまた先頭に来る。job の 5 回の試行のたびに後続の batch を送り直して捨てる。内容に起因する場合は、その block より後ろの訳は保存されないまま `failed` で終わる。
- Reader で表示を選び直すと失敗した job が積み直され、試行回数も 0 に戻る (`store.rs:973`、`src/reader/mixed.ts`)。そのたびにまた 5 回分を払う。
- `Malformed` は chain の cooldown にならない (`chain.rs:272-275`) ので、毎回 chain のすべての provider を試す。

**証拠**: `translate.rs:349-387`。

```rust
.buffered(parallel);
while let Some((batch, t)) = done.next().await {
    ...
    if rows.is_empty() && let Some(e) = t.error {
        // Provider down or rate-limited: back off instead of hammering (batches in flight are dropped).
        return Err(e.to_string());
    }
    store.insert_segments(&key, PROMPT_VERSION, &rows)...;
```

設計 (§3) は「送っている途中の batch は捨てる (保存済みの batch は残る)」としているが、返ってきて順番を待っている batch と、毎回失敗する block には触れていない。

**再現**: `translations_already_returned_are_saved_when_an_earlier_batch_fails`。6000 文字を超える先頭の段落 (それだけで 1 batch) を常に失敗させ、後ろに 24 段落を置く (12 段落ずつ 2 batch)。並列実行数は 3。後続の 2 batch は呼ばれて答えたが、保存は 0 段落。

**既存テスト**: 全部成功、全部失敗 (`Fake { fail: true }`)、一部欠ける場合だけ。

**修正候補**: batch ごとに返った時点で保存する (`insert_segments` を map の中に移す。表示の順序は `on_progress` だけが気にする)。全滅した batch が出たら新しい batch は送らないが、送った分は保存する。1 つの snippet だけの batch が内容のせいで失敗したら、job を止めずに「訳せなかった block」として扱う (`translate.missingBlocks` で終わる)。

### F10. provider の障害時、1 batch が 1 + N 回の呼び出しに増え、並列数の上限も外れる (高・テストで再現)

**発生条件**: 一括呼び出しがエラーになる (利用上限、認証、障害、timeout)。

**影響**: 一括呼び出しが失敗すると、すべての snippet が「欠けた」扱いになり、`join_all` で 1 件ずつ同時に再試行する。12 段落の batch は 13 回の呼び出しになる。並列実行数の `Gate` は batch を 1 つと数えるので、並列 8 なら最大 96 の同時呼び出しになり、CLI なら同じ数の子プロセスが立つ。各呼び出しが chain の全 entry を試す (cooldown は失敗の後にしか効かない)。利用上限に当たったときに、さらに呼び出しを増やす動きになる。Page 翻訳 (overlay) も 1 リクエストが最大 24 snippet で同じ。

**証拠**: `segments.rs:305-323`。

```rust
match call(provider, &system, &indexed(&all), &all).await {
    Ok(r) => out.results = r,
    Err(e) => out.error = Some(e),
}
let missing: Vec<usize> = all.iter().copied().filter(|&i| out.results[i].is_none()).collect();
let retries = join_all(missing.iter().map(|&i| { ... call(provider, system, &input, &[0]) ... }))
```

設計 (§3) は「1 つの batch の個別の再試行も加わる」と書いているが、provider 全体の障害が N + 1 倍になり並列数の上限を外れることには触れていない。

**再現**: `a_provider_outage_is_not_multiplied_by_the_batch_size`。常に `Unavailable` を返す provider に 12 snippet を渡すと 13 回呼ばれる。

**修正候補**: 一括呼び出しのエラーが `Unavailable` や利用上限・認証なら個別の再試行をしない。個別の再試行は `buffer_unordered(2)` などで同時数を絞る。

### F11. 分類・重要度の batch で、1 記事の失敗が最大 20 件の job を巻き込む (中・読解で確認)

**発生条件**: batch の 1 回の LLM 呼び出しが、1 記事の内容のせいで失敗する (拒否、Gemini の block、HTTP 400。推測)。

**影響**

- エラーが batch のすべての job にコピーされる。全員が同じ backoff で並ぶので、次もまた同じ batch にまとまる。5 回で全員 `failed` になる。
- 先頭以外の job (追加で claim したもの) は、ハンドラが panic すると `catch_unwind` の外にあるため終わらせる人がいない。再起動まで `running` に残る。

**証拠**: `classify.rs:239-262` (`relevance.rs:276-298` も同じ形)。

```rust
let outcome = classify(store, provider, &ids).await;
let result_for = |id: i64| match &outcome { Err(e) => Err(e.clone()), ... };
for j in &extra { ... store.finish_job(j.id, r.err().as_deref()) ... }
```

設計 (§8) は個別に完了させることを決め、全員失敗はテスト `failures_finish_every_batched_job` で意図されている。問題の 1 記事が全員を巻き込むことには触れていない。

**修正候補**: 2 件以上の batch が `Failed` / `Malformed` で失敗したら、半分に分けて再試行するか 1 件ずつ試してから終わらせる。追加の job の終了を drop guard に入れる。

### F12. 翻訳の照合が形だけを見ており、取り違えた訳が全記事共通のキャッシュに入る (中・読解で確認、発生は推測)

**発生条件**: モデルが `i` を取り違える (`i: 0` に 1 番目の訳を返す) か、空の訳を返す。

**影響**: 訳は本文の hash をキーにした共通のキャッシュに入るので、間違った訳が同じ段落を含むすべての記事と Page 翻訳に出る。訳済みと見なされるので再試行されない。

**証拠**: `segments.rs:251-265` の `reconcile` は、`i` が 1 回だけ出ることと `sentences` が空でないことしか確かめない。prompt は「unit の source を並べると snippet に戻る」ことを求めている (`segments.rs:239`) が、検証していない。

**修正候補**: unit の source をつないだ `plain_text` が snippet の `plain_text` と一致し、訳がどれも空でない場合だけ受け入れ、それ以外は `None` (個別に再試行) にする。

### F13. アプリと CLI/MCP が同時に初回起動するとマイグレーションが衝突する (中・読解で確認)

**発生条件**: 更新の直後に、アプリ (サインイン時の自動起動) と MCP のホストが起動する `lattice-cli mcp` が同時に DB を開く。

**影響**: 両方が古い `user_version` を読み、先に書いた方がマイグレーションを済ませる。後の方は同じマイグレーションをもう一度実行して「duplicate column」などで失敗する。アプリが負けると F4 の無言の終了になる。

**証拠**: `store.rs:512` は `user_version` を transaction の外で読み、`store.rs:516-524` は各段を DEFERRED の transaction で実行し、中で読み直さない。

**修正候補**: 各段を `TransactionBehavior::Immediate` で始め、その中で `user_version` を読み直して済んでいれば飛ばす。

### F14. 読んでから書く transaction が、別プロセスの書き込みで即座に SQLITE_BUSY になる (中・読解で確認)

**内容**: rusqlite の `transaction()` は DEFERRED で、コードに `Immediate` は 1 つもない。WAL では、読み取りで始まった transaction の間に別の接続が commit すると、その後の書き込みは `busy_timeout` を待たずに失敗する (SQLITE_BUSY_SNAPSHOT。SQLite の仕様。同梱版で計測はしていない。レビューアは Python の sqlite3 3.40.1 で 0 秒で返ることを確かめた)。

**発生条件**: アプリと CLI/MCP が同時に書く。`save_snapshot` (`store.rs:656-668` で読んでから消す・書く) や quiz の保存が該当する。

**影響**: job は試行を 1 回失い、UI の操作はエラーを出す。データは壊れない。設計 (§23) は WAL と `busy_timeout` で同時書き込みが安全としているが、この場合は含まれない。

**修正候補**: `Store` に `Immediate` で始める書き込み用の transaction のヘルパーを置き、読んでから書く箇所はそれを使う。アプリ内は mutex で直列なので費用はない。

### F15. 画像 job に時間の上限がなく、その間同じホストの取り込みが止まる (中・読解で確認)

**発生条件**: 画像の多い記事で、画像の配信元が応答しない。

**影響**: 画像は 1 枚ずつ取得し、1 枚につき最大 30 秒かかる (`images.rs:135-152`)。timeout は一時的な失敗として記録しないので、5 回の試行のたびに全部を試し直す。images は ingest と同じ「同じドメインは 1 つずつ」の規則に入るので (§14、`store.rs:1008-1012`)、200 枚なら 1 回の試行で約 100 分、その記事のサイトの取り込みが止まる。

**修正候補**: ループ全体に期限を設け (進捗は 1 枚ごとに保存されている)、期限を過ぎたら Err で後に回す。最後の試行でも timeout した画像は失敗として記録する。1 記事の枚数に上限を設ける。

### F16. URL 保存の取得中にアプリを閉じると、記事が「取得中」のまま残る (中・読解で確認)

**内容**: パレットからの保存 (`save_url` コマンド、`lib.rs:80-87`) は、`upsert_pending` で行を作ってからその場で取得する (`ingest.rs:14-22`)。job は積まない。取得 (最大 30 秒) や PDF の解析の間にアプリが終わると、行は `fetch_status = pending` のまま、どの job もない。起動時の掃除は画像・埋め込み・分類・単語・フィード判定を積み直すが、取り込みは積み直さない (`lib.rs:1233-1238`)。一覧は「取得中」を出し続け、「要対応」にも入らない。ingest job を取り消した場合も同じ (§10 に記載あり)。

**修正候補**: 起動時に「pending で job のない記事」の ingest job を積む。または `save_url` も job を積んでから `run_article` で実行する。

### F17. 実行中の job への enqueue が捨てられ、後追いがない (中・読解で確認)

**内容**: `enqueue_job` は `running` の job に何もしない (`store.rs:970-978`)。単語の job だけが終了後に積み直している (`jobs.rs:191-194`)。

**影響の例**

- 画像 job の実行中に再抽出すると、新しい画像の enqueue が捨てられる。実行中の job は古い block から作った一覧で動く (`images.rs:99-126`)。起動時の `enqueue_missing` は `succeeded` の job しか戻さないので、その job が `failed` で終わると新しい画像は取得されない。
- 埋め込み job の実行中に再抽出すると、新しい block は次の起動まで埋め込まれない (起動時の補完で直る)。
- `translate_article(fresh)` (訳し直す) は実行中の確認をしない (`translate.rs:231-235`)。設計 (§3) は UI がボタンを無効にすることに頼っており、その UI の状態はイベントと 10 秒ごとの読み直しで更新される。

**修正候補**: `enqueue_job` が running の job に「積み直し」の印を付け、`finish_job` が印のある job を pending に戻す。単語の job の後追いが一般化される。

### F18. 単語の意味を手で入れても、実行中の LLM job が上書きする (中・読解で確認)

**内容**: pending の単語に意味を手で入れると `ready` になる (`vocab.rs:412-424`、§22)。その間に動いていた単語の job が返ると、`apply` が状態を確かめずに上書きする (`vocab.rs:302-305`、`UPDATE … WHERE id = ?1`)。返答に無かった単語の扱いは `AND state = 'pending'` で守っている (`vocab.rs:261`) ので、片方だけ漏れている。再生成 (`retry`) で手入力を置き換えるのは設計どおりだが、その経路は先に `pending` に戻している。

**修正候補**: `apply` の UPDATE に `AND state = 'pending'` を付ける。

### F19. フィードが 304 を返し続けると、フィード本文への切り替えが再試行されない (中・読解で確認)

**内容**: フィードの取り込みは、記事の ingest job を積んでから `feed_id` とフィードの本文を書く (`feeds.rs:391-400`)。取得がすぐ失敗すると (方針による拒否、接続拒否、DNS)、フィードの本文に切り替える処理が空振りする。§17 はこの競合を「次の巡回で回復する」としているが、回復は `import` の中にしかなく、フィードが 304 を返すと `import` を通らない (`feeds.rs:309`)。ETag に対応したフィードは、新しい記事が出るまでその記事が失敗のまま残る。

**修正候補**: 記事の作成・`feed_id`・`feed_items`・job の積み込みを 1 つの transaction にまとめる。

### F20〜F27. 低

| ID | 内容 | 証拠 | 修正候補 |
|---|---|---|---|
| F20 | 内容に起因するエラー (拒否、HTTP 400、CLI の `is_error`) でも chain の entry が 5 分の cooldown に入り、無関係な job がすべて次の entry (有料の API かもしれない) に回る | `chain.rs:271-275` | 拒否と 400 は cooldown にしない種類のエラーにする |
| F21 | 記事の削除がイベントを出さず、別ウィンドウ (ポップアウト) の一覧とタブに消えた記事が残る | `lib.rs:673-676`、`useDocuments.ts:36-48` は `article-changed` でしか消えた記事を閉じない | 削除後に `article-changed` を emit する |
| F22 | 動いている MCP サーバは保存場所を起動時に 1 回だけ決めるので、移動後も古いライブラリを読み書きする。フォールバックの警告は stderr に出るだけで、MCP のホストでは見えない | `lattice-cli/src/main.rs:53-68` | 呼び出しごとに保存場所を確かめ、変わっていればエラーにする |
| F23 | 画像の本体と記事への対応を別々のロックで書くので、間に記事が消えると本体 (最大 20 MB) が残り、GC の trigger も動かない | `images.rs:160-167` | 1 つの transaction にする。起動時に参照のない画像を消す |
| F24 | データフォルダのコピーは共有の接続で `VACUUM INTO` を実行し、その間すべてのコマンドと job が止まる。snapshot の deflate (最大 50 MB) も transaction の中で行う | `store.rs:581-584`、`store.rs:676-679` | コピーは別の接続で行う (バックアップは既にそうしている)。deflate を `self.conn()` の前に出す |
| F25 | 初めての意味検索は、埋め込みモデル (約 470 MB) のダウンロードが終わるまで mutex を持って待つ。失敗すると検索のたびにやり直す | `embed.rs:70-77` | アプリでもダウンロード前は意味検索を飛ばす (CLI は `is_downloaded` で既にそうしている、`ops.rs:333`) |
| F26 | 並列実行数の上限は job の開始時の値で、コメントの「batch ごとに読む」と違う。実行中の長い記事は設定を下げても遅くならない | `translate.rs:290-292` と `translate.rs:347` | batch の future の中で読む |
| F27 | 細かい後始末: Codex のスキーマの一時ファイルは呼び出しが中断されると残る (`codex.rs:68-69`、`codex.rs:97`)。R2 は起動から 15 分経つまで最初の確認をしない (`r2.rs:190`)。メモは入力から 800 ms 以内にウィンドウを閉じると最後の入力が保存されない (`NotePanel.tsx:8`、`NotePanel.tsx:54-55` は React のアンマウントでしか保存しない)。`browser_hide` は WebView の作成中に来ると記録されず、ページが別のタブの上に残りうる (`browser.rs:573-578`)。`loadView` は古い応答が後から来ると古い表示を残す (`useDocuments.ts:36-48`) | 各行 | drop guard、起動直後の確認、終了要求時の flush、状態の記録、連番での破棄 |

## 5. 問題なしと確認した点

- **ロックを持ったままの await**: `MutexGuard` は `!Send` なので、spawn したタスクの中ではコンパイルが通らない。store に触る同期コマンドもない (同期コマンドは `browser_set_bounds`・`browser_hide`・overlay の一部・`db_path`・`restart_app`・`update_info` だけ)。
- **job の claim**: 1 つの `UPDATE … RETURNING` なので、同じプロセスのランナー同士が同じ job を取ることはない。プロセス間でも SQLite の書き込みロックで直列になる。
- **job ランナーの panic**: `run_claimed` は `catch_unwind` で捕まえ、job を backoff 付きの再試行にする。テスト `a_panicking_handler_leaves_the_job_retryable_instead_of_running` がある。
- **外部呼び出しの timeout**: HTTP 取得 30 秒 (本文の読み込みを含む、`fetch.rs:109-117`)、LLM の API 600 秒、CLI 600 秒 (stdin の書き込みも含む)、R2 は 1 リクエスト 15 分、描画 12 + 8 秒。`wait_with_output` が stdout と stderr を並行に読むので、パイプが詰まって止まることはない。
- **入力の上限**: HTML 20 MB、PDF 50 MB、フィード 10 MB、画像は 1 枚と 1 記事の上限、favicon 1 MB。HTML の深さは 256 で切る (`extract.rs:80-95`、テストあり)。
- **古い内容への結果の書き込み**: 翻訳は本文の hash がキー、要約と quiz は呼び出し前の content hash を保存して stale を判定する、重要度は保存の transaction の中でプロフィールを読み直す (`relevance.rs:359-365`)。
- **翻訳の `Gate`**: `Pass` の Drop で必ず戻るので、エラーや panic で枠が減らない。
- **マイグレーション**: 各段が `user_version` と同じ transaction で commit する。`renormalize_urls` は `UPDATE OR IGNORE` で、行を消さない。
- **エクスポート**: 一時ファイルに書き、`sync_all` してから rename し、失敗時は消す (`export.rs:176-193`)。
- **R2 のアップロード**: 200 で `<Error>` を返す multipart の完了も失敗として扱い (`r2.rs:422-424`)、失敗時は multipart の abort を試みる (`r2.rs:432`)。失敗した実行の一時ファイルは消す (`r2.rs:246-247`)。

## 6. 既知の設計判断として扱ったもの (指摘にしていない)

- 取得の失敗は記事に記録し、job は成功にする。自動の再試行はしない (§10、jobs.rs:229)。
- ingest と images を同じドメインで 1 つずつに制限する (§9、§14)。F15 はこの制限の下で上限のない job が枠を占めることだけを指摘している。
- 翻訳 job の実行中は「訳し直す」を UI で押せなくする (§3)。F17 は Rust 側に確認がないことだけを書いた。
- 選んだ保存場所が使えないときは止めずに既定のフォルダで起動する (§5 G38)。F2・F4 は、その判断が想定していない帰結 (R2 の設定が生きた古い DB、開けない DB) を指摘している。
- 移動の後、再起動までの書き込みは失われる。移動先には API キーも複製する (§5)。
- 分類 batch の失敗を全員に返す (§8)。F11 は 1 記事が全員を巻き込むことを指摘している。
- フィードの判定は失敗したら通す (§25)。
- CLI からのタグ・既読・お気に入りはアプリの表示に即座には出ない (§23)。
- 単語の再生成は手入力の意味も置き換える (§22)。F18 は再生成ではない経路の話。

## 7. 未確認のことと限界

- アプリ本体を起動しての確認はしていない。F2・F4・F13・F16・F19 は読解だけで、Tauri の setup の panic がログに出ないことは、`set_hook` がないことと plugin の構成から判断した (ログのファイルは見ていない)。
- F6 で「プロセスごと落ちる」具体的な入力 (abort するページ、ONNX Runtime や WebView2 のクラッシュ) は見つけていない。描画ランナーとフィード巡回の panic も、dom_smoothie・feed-rs が実際に panic する入力は確かめていない。
- F9・F11・F12 のモデル側の発生条件 (出力上限・拒否・`i` の取り違え) は推測。機構はテストか読解で確かめた。
- F14 の SQLITE_BUSY_SNAPSHOT は SQLite の仕様からの判断で、同梱の SQLite では計測していない。
- 負荷をかけた計測 (mutex の待ち時間、tokio のワーカーの占有) はしていない。F24 の時間は推測。
- フロントエンドは、バックエンドのイベントの扱いと F21・F27 に挙げた箇所だけを見た。overlay の JS、tabdrag の状態遷移は見ていない。
