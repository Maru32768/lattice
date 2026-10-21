# ドキュメント監査（2026-10-22）

対象: `README.md`・`README.ja.md`・`docs/guide.md`・`docs/guide.ja.md`。コードから機能を洗い出し、4 つの文書と突き合わせた。修正はコミット `017bb2d`（guide の 2 ファイルのみ。README は差異なし）。

## 機能の一覧

| 機能 | コードの場所 | 文書 |
|---|---|---|
| 画面構成（タイトルバー・ナビ・一覧・文書エリア・対話ペイン、幅の調整） | `App.tsx`, `Nav.tsx`, `Splitter.tsx`, `layout.ts` | あり |
| 空のライブラリの案内 | `App.tsx` FirstRun | あり（修正） |
| URL の保存・正規化・重複判定 | `ingest.rs`, `url_norm.rs`, `Palette.tsx` | あり（修正） |
| 閲覧中のページを Index に追加 | `BrowserView.tsx`, `browser.rs` | あり |
| フィード登録・検出・一括登録・定期更新（起動時＋30 分、初回 20 件） | `feeds.rs`, `FeedsView.tsx` | あり（修正） |
| フィードのフォルダ・並べ替え（ドラッグ、Alt+↑↓） | `feed_folders.rs`, `NavFolders.tsx`, `FeedFoldersCard.tsx` | あり |
| フィードの表示名・アイコン | `FeedsView.tsx` | あり |
| 取り込みフィルタ（ルール・最短文字数・LLM 判定・除外された記事） | `feed_filter.rs`, `FeedFilterEditor.tsx` | あり（修正） |
| OPML の読み込み・書き出し | `feeds.rs`, `lib.rs` | あり |
| 一括インポート（URL 一覧・Markdown・PDF、グループ指定） | `ImportView.tsx`, `markdown.rs`, `pdf.rs` | あり（修正） |
| JS ページの自動描画・手動描画 | `render.rs`, `renderer.rs` | あり（修正） |
| Reader / Page の切り替え、⋯ メニュー、再抽出 | `Reader.tsx`, `BrowserView.tsx`, `articleMenu.ts` | あり |
| アプリ内ブラウザ（URL バー・検索エンジン・印刷） | `BrowserView.tsx`, `browser.rs`, `overlay/` | あり |
| 表示言語（原文・混在・訳文、割合、段落ごとの切り替え） | `mixed.ts`, `Reader.tsx`, `overlay/logic.ts` | あり（修正） |
| 翻訳（自動・手動・残り・訳し直し・失敗時の表示） | `translate.rs`, `Reader.tsx` | あり（修正） |
| 要約 | `summarize.rs`, `Reader.tsx` Summary | あり（修正） |
| 検索結果の一致の移動 | `Reader.tsx` | あり（修正） |
| フォーカスモード・戻る/進む（50 件） | `App.tsx`, `history.ts` | あり |
| タブ・ペイン分割・Ctrl+B プレフィックス | `TabStrip.tsx`, `DocArea.tsx`, `panes.ts`, `keys.ts` | あり |
| 別ウィンドウ（タブ・対話）・ドラッグで切り離し | `windows.ts`, `popout.rs`, `tabdrag.rs` | あり（修正） |
| ジャンル・タグ・難易度（自動分類と手動修正） | `classify.rs`, `Reader.tsx`, `GenreSettings.tsx` | あり（修正） |
| 重要度（自分について、「重要」一覧、付け直し） | `relevance.rs`, `RelevanceSettings.tsx` | あり |
| グループ（コレクション） | `groups.ts`, `NavGroups.tsx`, `GroupPicker.tsx` | あり |
| 既読・お気に入り・一覧・絞り込み・並び順・まとめて操作 | `library.ts`, `ListPane.tsx`, `FacetPopover.tsx`, `selection.ts` | あり |
| 右クリックメニュー | `articleMenu.ts` | あり |
| Index から削除 | `store.rs`, `ConfirmDialog.tsx` | あり |
| hybrid 検索・検索方式・範囲・最近の検索 | `search.ts`, `SearchPane.tsx`, `embed.rs` | あり（修正） |
| コマンドパレット（`#` `@` `g:` `>` `?`、URL、コマンド） | `Palette.tsx` | あり（修正） |
| 対話（範囲・引用・保存・Vim キー・別ウィンドウ） | `ChatPane.tsx`, `chat.ts`, `chat.rs`, `scopes.ts` | あり（修正） |
| 理解度チェック（クイズ） | `QuizPanel.tsx`, `QuizCard.tsx`, `quiz.rs` | あり |
| 単語の登録・単語帳・CSV 書き出し | `vocab.ts`, `VocabView.tsx`, `VocabCard.tsx` | あり（修正） |
| 今日の復習（SM-2、読み上げ） | `QuizReview.tsx`, `speech.ts`, `quiz.rs` | あり |
| バックグラウンドのジョブ（12 種類・状態・再試行・取り消し） | `JobsView.tsx`, `jobs.rs`, `job_status.rs` | あり（修正） |
| 設定: AI プロバイダ（5 種、3 段のフォールバック、API キー） | `ModelSettings.tsx`, `chain.rs` | あり |
| 設定: 翻訳・要約と対話・自動分類・重要度・ジャンル・取り込みと JS 描画・取り込みフィルタ・画像・復習・表示言語・ショートカット・ブラウザ・タスクバー | 各 `*Settings.tsx`, `SettingsView.tsx` | あり（修正） |
| 設定: バックアップ・R2・エクスポート・ログと保存場所・アップデート | `BackupSection.tsx`, `R2BackupSection.tsx`, `ExportSection.tsx`, `StorageSection.tsx`, `Update.tsx` | あり（修正） |
| キーボードショートカット（変更可能な 28 操作＋固定キー） | `keys.ts`, `ShortcutSettings.tsx` | あり（修正: Alt+↑↓ を追加） |
| CLI（search/get/list/summary/tags/genres/feeds/jobs/ask/save/tag/read/favorite/mcp、`--scope`） | `crates/lattice-cli/src/main.rs`, `ops.rs`, `mcp.rs` | あり（修正） |
| データの保存場所・ポータブル版・データの移動 | `location.rs`, `StorageSection.tsx` | あり（修正） |
| AI プロバイダに送るもの・記事の内容を信頼しない仕組み | `claude.rs`, `codex.rs`, `fetch.rs`, `feed_filter.rs` | あり（修正） |

## 見つけた差異と修正

guide.md と guide.ja.md の両方に同じ修正を入れた。README.md / README.ja.md は内容がコードと合っており、互いにも一致していたので変更なし。

| # | 箇所 | 差異 | 修正 |
|---|---|---|---|
| 1 | 画面の構成 | 「ライブラリ・設定・処理状況が一覧と文書エリアの場所に出る」とあったが、設定はナビの場所も使い、ライブラリは一覧と文書エリアそのもの | 対象の画面を列挙し直し、設定はナビの場所も使うと記述 |
| 2 | 画面の構成 | 「AI プロバイダを設定するまで案内が出る」とあったが、案内は常に出る | 「案内も出る」と条件を外した（コード側の疑いにも記載） |
| 3 | URL を保存する | 「トラッキング用のパラメータを外す」とあったが、外すのは重複判定用のキーだけで、記事の URL には残る | 「パラメータを無視して比べる」に変更 |
| 4 | フィードを探す | 「URL がフィードならそれを使う」「候補が複数あれば選ぶ」とあったが、常に候補を出し、ボタンを押すまで登録しない | 候補から選んで押す、と変更 |
| 5 | フォルダ | 「追加先のフォルダ」は aria-label だけで、画面上の表示は「フォルダなし」。フォルダがあるときだけ出る | メニューの見え方と出る条件を記述 |
| 6 | 取り込みフィルタ・AI に送るもの | LLM 判定はタイトルと抜粋に加えて URL も送る | 2 か所に URL を追加 |
| 7 | ファイルを取り込む | 「どのタブにも Collections の欄」とあったが、欄はタブの上に 1 つで、表示は Collection | 「タブの上の Collection の欄」に変更 |
| 8 | Markdown | タイトルになるのはレベル 1 の見出し（`# `）だけ | 明記 |
| 9 | JS ページ | 空の抽出は「本文が短い」ではなく「抽出失敗」。「本文が短い」は 300 文字未満。401/403/429/5xx で取得を断られたときも自動描画する | 両方の印と 300 文字の基準、拒否時の自動描画を追加 |
| 10 | 表示する言語 | 「アドレスと本文から選ぶ」のは Page 表示だけで、Reader は均等に散らす | Reader と Page を分けて記述 |
| 11 | 表示する言語 | 「選択はすべての記事とページに効く」とあったが、Reader と Page 表示は別々の選択を持ち、起動時は Reader が混在 70%、Page が原文 | 別々であることと初期値を記述 |
| 12 | 1 つの段落だけ切り替える | ホバーの吹き出しは「混在・訳文」に限らず、訳してある段落ならどのモードでも出る。端の印でも切り替わる | 変更 |
| 13 | 記事を翻訳する | 失敗時、ツールバーにはエラー文でなく「· 失敗」が出て、エラーは本文の上の注記に出る | 変更 |
| 14 | 要約 | 要約欄は 1 行目だけ出て、押すと開く。開いた要約のボタンは「作り直す」で、「要約を作り直す」は ⋯ メニュー | 両方を記述 |
| 15 | 一致を見る | 「前の一致」「次の一致」は aria-label で、見えるのは ↑ ↓ のボタン | 変更 |
| 16 | ペインの分割 | ペインの中央・端に落とせるのは、ドラッグを始めたウィンドウの中だけ | 条件を追加 |
| 17 | 別ウィンドウ | 30 ピクセルで離れるのは列の上下方向。ペインに分割したウィンドウではウィンドウの外に出たとき | 変更 |
| 18 | ジャンル | ジャンルはメニューでなく入力欄（候補付き）。新しい名前でジャンルを作る | 変更 |
| 19 | 検索 | 「検索方式」は Hybrid・全文・意味の 3 つ。「全文 + 意味」は結果ごとの一致の表示 | 変更 |
| 20 | 検索 | モデルは「最初の検索のとき」でなく、最初に必要になったとき（たいていは最初の記事の embed ジョブ）にダウンロードする | 変更 |
| 21 | パレット | 「表示言語: 原文」「表示言語: 訳文」のコマンドが一覧になかった | 追加 |
| 22 | 対話 | 「1 記事 4 箇所まで」は最初の選び方で、余裕があれば同じ記事から足す（`diversify`） | 変更 |
| 23 | 単語 | 下線は Reader だけで、Page 表示には出ない | 「Reader の本文の中」に変更 |
| 24 | 単語帳 | ⋯ メニューに「出典へ」が抜けていた。下線の設定はこの PC だけの設定 | 追加 |
| 25 | ジョブ | 処理状況の画面は種類を ID（`ingest` など）で表示し、名前はホバーで出る | 表に ID を併記し、説明を追加（コード側の疑いにも記載） |
| 26 | ジョブ | 「失敗したジョブが再試行する」は状態名と食い違う（失敗すると「再試行待ち」になり、5 回で「失敗」）。「取り消し」は「待機」には出ず、「再試行待ち」と「失敗」だけ | 状態の流れと取り消しの対象を変更 |
| 27 | ブラウザ設定 | 検索エンジンはこの PC だけの設定 | 追記 |
| 28 | エクスポート | 登録した単語はエクスポートに入らない | 含まないものに追加し、単語帳の CSV を案内（コード側の疑いにも記載） |
| 29 | ログ・保存場所 | ポータブル版には「変更…」がない | 追記 |
| 30 | アップデート | ポータブル版のバーは「リリースノート」の代わりに「ダウンロードページ」で、「更新して再起動」はない | 追記 |
| 31 | ショートカット | 変更可能な操作「フィードやフォルダを上へ/下へ移動（サイドバー）」（`Alt+↑`/`Alt+↓`）が表になかった | 表に追加 |
| 32 | ショートカット | guide.ja.md にだけ「`[` `]` は日本語の記事では英語の割合」の一文があった。guide.md にだけ「これらのキーは変更できません」があった | 両方に揃えた |
| 33 | 固定キー | メニューキー・`Shift+F10` はナビのフィードのフォルダでも効く | 場所に追加 |
| 34 | CLI | `feeds` の text 出力にフォルダの ID は出ない（JSON だけ） | 変更 |
| 35 | CLI | `save --run` の後でアプリに残るのは分類と描画だけでなく、重要度と自動翻訳も | 変更 |
| 36 | データ | この PC だけの設定に「最近の検索」と「Page 表示の要約ボタン」が抜けていた | 追加 |

合計 36 件（guide.md と guide.ja.md に同じ内容で反映）。

## コード側の疑い

文書は意図した動作を書いていると判断し、文書は直していないもの、または仕様の確認が要るもの。

1. **難易度を「未判定」に戻しても再推定されない。** `classify::set_difficulty(None)` は値と固定を外すだけで、分類ジョブを積まない。完了済みのジョブが `processing_jobs` に残るため、起動時の backfill（`ON CONFLICT DO NOTHING`）でも積まれない。guide と `reader.difficultyHint` はどちらも「もう一度推定する」と書いている（`crates/lattice-core/src/classify.rs:148-160`, `73-77`）。
2. **メインウィンドウの位置と大きさを覚えない。** 保存と復元は pop-out（`doc-*`, `chat`）だけで、メインは毎回 `tauri.conf.json` の 1200×800（`src-tauri/src/popout.rs:53-87, 165-171`）。guide は「ウィンドウの位置と大きさは保存され」と書いている。
3. **対話の引用は Ctrl+クリック・中クリックで新しいタブに開かない。** `Cite` は修飾キーを見ず、`openCitation` は常にアクティブなタブに開く（`src/ChatPane.tsx:16,33`, `src/App.tsx:548-553`）。パレットも中クリックは効かない（`Palette.tsx:282`）。guide は一覧・パレット・検索結果・引用の全部で効くように書いている。
4. **Claude CLI のプロバイダは空の一時フォルダで動かない。** `cmd.current_dir(std::env::temp_dir())` でシステムの TEMP そのもの（空ではない）を使う。Codex は専用の `%TEMP%\lattice-codex` を使う（`crates/lattice-core/src/claude.rs:61`, `codex.rs:65,83`）。guide の安全性の説明は「空の一時フォルダ」。
5. **選んだデータフォルダが消えていると、空のライブラリをそこに作る。** 既定の場所に戻るのは `create_dir_all` が失敗したとき（ドライブがないなど）だけ。親フォルダが残っていれば空のフォルダと新しい `lattice.db` を作り、警告も出ない。CLI は `lattice.db` の有無を確かめている（`crates/lattice-core/src/location.rs:90-96`, `src-tauri/src/lib.rs:1071-1072`, `crates/lattice-cli/src/main.rs:64-66`）。guide は「見つからないか使えないと既定の場所で起動する」と書いている。
6. **処理状況の画面がジョブの種類を内部 ID で表示する。** en.ts / ja.ts に名前（「取得」「Fetch」など）があるのに、表と絞り込みボタンには `ingest` などの ID を出し、名前は title 属性だけ（`src/JobsView.tsx:119,141,153`）。文書は ID を併記する形で合わせたが、名前を出すのが意図ならコードの修正が要る。
7. **`Ctrl+B` `x` はペインが 1 つでも効き、全タブを閉じる。** 「ペインを閉じる」ボタンはペインが 1 つのときは出ないので、キーとボタンが食い違う（`src/App.tsx:971-973`, `src/layout.ts:131-138`, `src/TabStrip.tsx:135`）。
8. **検索の範囲のメニューにフォルダと「重要」がない。** 一覧がフォルダか「重要」のときに `/` で検索すると、範囲はそれのまま絞られるが、メニューに該当がなく別の表示になる（`src/SearchPane.tsx:27-42`, `src/App.tsx:456-470`）。
9. **Reader の翻訳中の表示に英語の " block" が直書き。** 日本語の UI でも "block" と出る（`src/Reader.tsx:281`）。
10. **`s` と `m` が一覧のカーソルではなく、開いている記事に効く。** 一覧のフッターは j/k の横にこのキーを出している（`src/App.tsx:1007-1008`, `src/ListPane.tsx:261-264`）。意図どおりかの確認が要る。
11. **対話の回答とクイズの問題は、表示言語に関係なく常に日本語。** `chat.rs:134-139`（"Write the answer in Japanese"）、`quiz.rs:91-92`。英語 UI の利用者向けに仕様として決めるか、文書に書くかの判断が要る（文書には未記載のまま）。
12. **エクスポートに登録した単語が入らない。** `export.rs` は単語・用例・復習の状態を書き出さない。モジュールのコメント（"so none of it lives only in this database"）と食い違う（`crates/lattice-core/src/export.rs:2`）。文書は「含まない」と明記する形で合わせた。
13. **CLI でグループの ID を調べる手段がない。** `--scope group:ID` はあるが、グループを一覧するコマンドがない（`crates/lattice-cli/src/ops.rs`）。
14. **CLI `get --blocks` は `--format text` では効かない。** text 出力は常に本文をつないだものになる（`crates/lattice-cli/src/ops.rs:216-240`）。文書は「block を ID 付きで出す」のまま。
15. **空のライブラリの案内が、プロバイダを設定した後も出る。** `FirstRun` はプロバイダの有無を見ない（`src/App.tsx:102`）。文書は条件を外す形で合わせた。設定済みなら隠すのが意図ならコードの修正が要る。
16. **UI の説明文が古い・不正確**（文書ではなく en.ts / ja.ts の問題）。
    - `chatSettings.budgetDesc` が「1 記事 4 箇所まで」のまま（実際は余裕があれば足す）。
    - `jobsView.classifyAbout` の説明にタグがない。
    - `translationSettings.onSwitchDesc` が "Mixed or Translation"（ボタンは "Translated"）。
    - `classifySettings.unclassifiedDesc` が「ジャンルのない記事」だけ（実際は難易度のない記事も）。
17. **MCP のエラー結果には「信頼できない内容」の注記が付かず、25,000 文字の上限は注記を含み、切り詰めの印の分だけ少し超える**（`crates/lattice-cli/src/mcp.rs:74-87`）。実害は小さいが、文書の「すべての結果の先頭に注記」とは厳密には違う。
18. **プライベートアドレスへのアクセス拒否は、システムのプロキシがあるとき IP の直書きしか見ない**（`crates/lattice-core/src/fetch.rs:18` の shortcut コメント）。文書の範囲（画像・アイコン・フィード検出）より広く全取得に効くが、プロキシ下ではホスト名の解決先を確かめない。

## 確かめていないこと

- アプリを動かしての確認はしていない。すべてコードを読んで判断した。
- 「Web ページにフォーカスがあるとき Alt+←/→ とマウスのボタンはページの履歴」は WebView2 の既定の動作に頼っており、明示的な処理は見つからなかった（文書はそのまま）。
- ブラウザの capability（「ごく一部の Lattice の機能しか呼べない」）と、ページに戻す訳文のサニタイズの中身は確かめていない。
