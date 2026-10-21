# 2. 壊すつもりで使う（break-it レビュー）2026-10-22

現行アプリを初回起動から順に、主要ユーザーフローごとに「壊すつもりで」操作し、friction / ambiguity / unnecessary state / failure recovery を記録した。後半で局所修正ではなく情報設計上の原因にまとめ直す。`docs/roadmap.md` で「後」「将来」になっている項目は再報告していない。

タグの意味:

- **[friction]** 目的の操作に余計な手数・待ち・推測が要る
- **[ambiguity]** 画面が今の状態・次に起きることを言っていない、または複数の意味に読める
- **[unnecessary state]** ユーザーが背負わされている不要な状態（残る下書き、意味のない選択肢、戻らない設定）
- **[failure recovery]** 失敗したときに、何が失敗し、どこで、どう直すかが分からない

## 1. 実施環境とデータ保護の手順

| 項目 | 内容 |
|---|---|
| ビルド | `master` 31f5604、`mise exec -- npm run tauri dev`（target/debug/lattice.exe、Vite 1420） |
| OS / ロケール | Windows 11 Home、`Get-Culture` = en-US（UI は英語で起動。これは正しい挙動） |
| 画面 | 既定ウィンドウ 1200×800 |
| LLM | 既定チェーン（Claude CLI、ログイン済み）。API キーは入力していない。R2 設定は触っていない |

**データ保護**

1. 起動していた `target\debug\lattice.exe`（PID 62332）を停止。
2. `%APPDATA%\dev.lattice.app\lattice.db` / `-wal` / `-shm` / `backups\` を `C:\Users\maru3\AppData\Local\Temp\lattice-backup-20261022\` にコピーし、MD5 が一致することを確認（db `4563c97b…`、wal `347b186f…`）。`models\`（約 465 MB）と `data-location.json`（存在せず）はコピー対象外。
3. 隔離: `location.rs` のポータブル判定を使い、`target\debug\portable` マーカーを置いて起動。DB・WebView2 プロファイル・ログ・モデルはすべて `target\debug\data\` に作られ、ユーザーの DB には一切触れていない（空の DB からの初回起動になる）。
4. 操作方法: Computer use（`request_access`）は 2 回とも拒否されたため、`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` で起動し、Playwright を CDP で接続して実アプリの DOM をクリック・入力・スクリーンショットした。バックエンドは本物（Rust、ジョブ、Claude CLI）。Page 表示の webview も別ターゲットとして確認した。
5. 終了時: `portable` マーカーと `target\debug\data\` を削除。ユーザー DB の MD5 を再確認し、バックアップと一致（変更なし）。アプリを通常モード（`npm run tauri dev`）で起動し直した。
6. **注意（私の副作用）**: 2 回目の再起動時に `taskkill /IM node.exe` を実行し、このマシンの **node.exe を全部** 止めてしまった（Vite だけを狙うつもりだった）。他の開発サーバーや別セッションの node プロセスが巻き込まれた可能性がある。Lattice のデータへの影響はない。
7. 外部送信: フィード取得（blog.rust-lang.org、this-week-in-rust.org）、rfc-editor.org / example.com の取得、Claude CLI 経由の分類・翻訳（example.com と rustup 記事 1 本）・要約 1 回・対話 1 問。

スクリーンショット: `C:\Users\maru3\AppData\Local\Temp\claude\C--Users-maru3-IdeaProjects-lattice\b04bc010-9521-4bfd-a55c-1ecb5d60904a\scratchpad\shots\`（01〜113、本文中の番号はこれ）。一時フォルダなのでリポジトリには入れていない。

## 2. フローごとの記録

### 2.1 初回起動・空状態（shot 01）

- **[unnecessary state]** 記事 0 件なのに、一覧ヘッダに「Genre / Tag / Source / Difficulty / Importance / Status」のファセット chip、「Date added, newest first」、「Select」、「Clear Esc」がすべて出る。押しても意味がない。
- **[ambiguity]** 文書エリアの案内に「Translation, summaries and classification need an AI provider — set one up」とあるが、実際は **既定チェーンが Claude CLI**（`chain.rs::load_config`）で、何も設定せずに分類・翻訳・要約・対話が動いた（最初の記事に「Networking」が付いた）。ユーザーは「自分の Claude サブスクリプションで裏で LLM が走っている」ことを知らされない。逆に `claude` がない PC では、すべての LLM ジョブが 5 回ずつ失敗して Jobs に溜まる。
- **[ambiguity]** 「Status」chip だけ破線（`class="chip dashed"`）で、他の chip と見た目が違う理由が画面にない。
- 良い点: 「Add your first article」の 4 枚のカードと、Ctrl K の案内は分かりやすい。

### 2.2 URL の追加（パレット）: 有効・無効・重複・到達不能（shot 02〜08）

再現: `Ctrl+K` → URL を貼る → `Ctrl+Enter`。

- **[friction]** 有効 URL（rfc9293）を追加した直後、一覧は 1.5 秒以上「No articles yet」のまま。キューに入ったことを示すものが一覧にも文書エリアにもない（shot 03）。取得が終わると突然 Reader に記事が開く。
- **[ambiguity]** パレットから追加した記事は **自動で開かれて既読** になる（Unread 0 のまま）。一方、一括インポートやフィード経由は未読。同じ「追加」なのに経路で「未読」の意味が変わる。
- **[ambiguity]** 無効 URL `htp:/not a url` は URL 扱いされず「Hybrid search for …」になり、`Ctrl+Enter` で **検索画面へ遷移**し「Recent searches」に残る（shot 04, 05）。「URL として読めない」とは一言も出ない。
- **[ambiguity]** 重複（同じ URL + `?utm_source=x`）: パレットが「Open in Reader · Saved」と「Add to Index (import)」を両方出す。`Ctrl+Enter`（Add）でも既存記事が開くので結果は同じだが、2 つの違いが説明されない（shot 06）。
- **[failure recovery]** 到達不能ホスト: 記事行が作られ、一覧に「Fetch failed」、Reader に「Could not fetch the page / request failed: error sending request for url (…): No such host is known. (os error 11001)」と **OS の生エラー**（shot 08）。
  - この失敗は **Jobs に出ない**（ingest の Failed は 0、shot 09）。`jobs.rs` のコメントどおり「取得失敗は記事に記録、ジョブは成功扱い」だが、Jobs 画面のヘッダは「失敗は 5 回まで自動再試行」と言っており、取得失敗は自動再試行されない。復旧経路は Reader の「Retry」だけ。
  - **[unnecessary state]** 失敗記事はタイトル = URL、favicon「N」の行として「Recently added」「All articles」に残り、「Status › Needs attention」でしか集められない。

### 2.3 一括インポート（shot 10〜14）

再現: ツール › Bulk import → 6 行（有効 2、既存 1、junk 1、`ftp://` 1、到達不能 1）を貼る → Import。

- **[ambiguity]** 結果は「Queued 3 of 4 URLs for fetching · 1 already saved」。`not-a-url at all` と `ftp://example.com/file` の 2 行は **黙って捨てられた**（6 行中 4 行が URL と数えられた理由も出ない）。
- **[unnecessary state]** 送信後もテキストエリアに全文が残り、Import ボタンが有効のまま（shot 13）。もう一度押せば再キュー（既存扱い）になる。結果の 1 行から、取り込んだ記事や Jobs へ飛ぶ手段がない。
- **[failure recovery]** 画面を離れると下書きが消える（フィード管理の複数行入力でも同じ現象を確認。shot 35 で入力値が空）。
- Jobs では `embed` が「Pending 4 / Running 1」になるだけで、**初回の埋め込みモデル（約 465 MB）のダウンロードが始まっている**ことはどこにも出ない。

### 2.4 記事を読む: Reader / Page / 翻訳（shot 16〜22, 42, 92〜98）

- **[ambiguity]** Reader の既定モードが **「Mixed 70%」**（`App.tsx:231`）で、訳が 1 つもない記事でも Mixed がハイライトされ、本文は原文、右端に「Translate」ボタン（shot 16, 42）。Page の既定は「Original」（`App.tsx:206`）で、Reader と Page で既定が違う。
- **[ambiguity]** 「Translated」を選んだまま別の未翻訳記事を開いても原文のまま（shot 27, 42）。H1 の「表示を切り替えたら自動で翻訳」は「切り替え」でしか発火しない。モードが「表示の選択」なのか「翻訳を頼む操作」なのかが読めない。
- **バグ** Translated 表示で example.com の **中国語の段落だけ訳されない**（かな・漢字を含む＝日本語と見なす H18 の判定が中国語に当たる）。しかもツールバーは「Translate again」（全部訳済み扱い）になる（shot 20）。一覧の「Translating 0/7」と Reader の「Translating 0 / 6 block」で件数が食い違う（shot 19）。
- **[friction]** Page 表示のツールバーは既定幅（文書ペイン約 560 px）で溢れ、URL 欄が `https://e` で切れる（shot 21、G15 の横スクロール）。Reader では「Reader / Page」が文字ボタン、Page ではアイコンだけになり同じ部品に見えない。
- **[friction]** 対話ペインを開くと 1200 px では Reader が約 360 px、一覧ヘッダの注記「Not rated: "About you" is empty」が 5 行に折れる（shot 57, 63, 84）。
- **[ambiguity]** RFC 8446（本文が `<pre>` の RFC テキスト）はタイトルが URL のまま、Reader に「Translate」ボタンが **出ない**（shot 92）。なぜ翻訳できないかの説明がない。
- **[ambiguity]** 要約と対話の回答は表示言語が English でも **常に日本語**（`chat.rs` / `summarize.rs` の prompt に固定）。英語で質問しても日本語で返る（shot 69）。
- 良い点: 検索一致へのジャンプと「Search match」ハイライト（shot 27）、ペイン分割、フォーカスモードは期待どおり。実行中の翻訳ジョブは **アプリを kill して再起動しても再開**した（shot 100〜103、Running のまま 20 秒後に 12/28）。

### 2.5 キーボード操作（shot 16, 17, 23〜25, 53, 54）

- `j` `k` `Enter` `s` `m` `f` `v` `/` `Ctrl+\` `Ctrl+B x` `Ctrl+W` `Ctrl+T` は期待どおり。
- **[friction]** 「Select」モードは **Esc で抜けられない**（「Done」のみ。shot 54）。
- **[ambiguity]** Esc はファセットを消すが並び順・グループは残る（「Clear Esc」の隣に並び順があるので、Esc で戻ると思う）。
- ショートカット設定: 「Previous item」に `j` を足すと両方の行に「j is also assigned to …」が出る（良い）。ただし警告付きのまま即保存される。

### 2.6 整理: フィード・フォルダ・ジャンル・タグ・コレクション（shot 29〜41, 55〜63）

**フィード管理**

- Find（サイト URL → 候補 → Add and import the latest 20）は分かりやすい。
- **[ambiguity]** Find の失敗（到達不能）は、Find 欄ではなく **Folders カードの下・表の上**に赤文字で出て、入力を変えても消えない（shot 32, 33）。
- **[ambiguity]** 複数行貼り付けで `not a feed` を含めて「Subscribe to 3 feeds」。登録済みフィードを含めても結果は「Added 2 of 3 · failed: not a feed」で、重複は "Added" と数えられる。
- **[failure recovery]** 画面を離れると入力欄の内容が消える（shot 35）。
- **[ambiguity]** フォルダ外のフィードにフォーカスして `Alt+↑` を押すと、並べ替えではなく上のフォルダ **に入る**（仕様どおりだが、意図せずフォルダに吸い込まれる）。

**記事タイトル**

- **バグ** フィード経由の記事タイトルがページ `<title>` 由来で「Announcing rustup 1.29.1 | Rust Blog」「This Week in Rust 670 · This Week in Rust」になり、直下のソース行「Rust Blog」と二重表示（shot 42）。フィードの entry title は「Announcing rustup 1.29.1」と綺麗（`feed.xml` を確認）。

**ジャンル**

- **[unnecessary state]** 設定 › Genres に **0 件のシードジャンルが 8 個**（AI/ML, Career, Database, DevOps, …）並び、ナビには出ない（shot 41）。ナビと設定で「ジャンルの一覧」が違う。
- Reader のジャンル chip はクリックで select になり、横に「Auto-classify」が出る。分かる。

**タグ**

- 既存タグ `iana` をもう一度追加しても無反応（成功も重複も言わない）。

**コレクション**

- **[ambiguity]** 「+ New」で作った直後、空のコレクションが「No articles match these filters / Remove one of them: Audit → All articles → 19 articles」と、**フィルタ不一致**として表示される（shot 56）。空のコレクションに「記事を入れる」導線がない。
- **バグ（用語）** 重複名は文書エリア上部のバナーに「There is already a **group** named "audit"」（shot 57）。UI は Collection、日本語 UI は「グループ」、backend は group。

**一覧の並び順・グループ・ファセット**（shot 43〜52）

- **[ambiguity]** Group で「Source」を選ぶと **Source → Genre の二段**になる（F7 の仕様）が、メニューは「None / Source / Genre」の単一選択に見える。
- **[unnecessary state]** 「About you」が空でも「Most important first」と「Importance」ファセットが出る。選ぶと「Not rated: "About you" is empty」の注記が出るだけ。
- **バグ** Importance ファセットの「Not rated」が **0**（実際は 19 件すべて未判定。shot 51）。
- 再起動すると並び順・グループは既定に戻る（ペイン幅は保存される）。

### 2.7 検索・パレット（shot 26〜28, 107, 108）

- ハイブリッド検索の結果・スコープ・ファセット要約は良い。
- `>` のコマンド一覧、`rust` 入力時の「Filter by tag / Hybrid search / Chat about the tag / Source / Folder / Articles / Tags / Sources」の混在は情報量が多いが、見出しで区切られている。
- **[unnecessary state]** 無効 URL（2.2）が「Recent searches」に残る。

### 2.8 対話ペイン（shot 67〜69）

- **[friction]** Scope の select が **48 項目のフラットなリスト**（記事・コレクション・ジャンル・ソース・フォルダ・全タグ）。タグが増えるほど伸びる。
- **[ambiguity]** 英語で質問 → 日本語の回答（2.4）。回答の下に「claude-opus-5-5 · Answered from the full articles · 1 citation」は良い。
- 対話ペインは設定・Jobs 画面に移っても開いたまま残り、設定画面の幅を奪う（2.9 のレイアウト崩れの原因）。

### 2.9 ジョブ・失敗・復旧（shot 09, 14, 85〜89, 95〜103）

- **[ambiguity]** Jobs の「Type」は内部名（`ingest` `embed` `favicon` `vocab` `relevance`）。ガイドの表は「Fetch / Search index / Site icons / Word meanings / Importance」で、画面と文書で名前が違う（ⓘ の tooltip だけが橋渡し）。日本語 UI でも内部名のまま（shot 111）。
- **[failure recovery]** 失敗の置き場が 2 系統。取得失敗は記事（Jobs に出ない、自動再試行なし、Retry は Reader）。LLM 失敗は Jobs（記事側は「Summary failed: provider unavailable: OpenAI API key is not set」と赤字だけで Retry は無い。shot 84）。
- **[failure recovery]** AI providers で Step 1 を「OpenAI API」にしてキー未設定のまま Save → 「Models saved」とだけ出る（「Key: Not set」の pill はあるが警告ではない。shot 82）。壊れたチェーンは、次のジョブが失敗して初めて分かる。
- **[ambiguity]** 「Retry now」を押すと裏では再実行されて再失敗した（ログに attempt 1 が 2 回）が、画面は「Attempts 1/5 · Next in 1 minute · Waiting to retry」のまま（shot 86）。押した効果が見えない。
- 良い点: チェーンを Claude CLI に戻して Retry → 成功し「No jobs running or failed」。実行中ジョブは再起動後に再開（2.4）。
- **[friction]** Jobs の表は対話ペインを開くと Note 列が 1 語ずつ折れる（shot 85）。

### 2.10 設定（shot 70〜82, 110）

- **バグ（レイアウト）** AI providers で対話ペインを開いた 1200 px 幅だと、モデルと effort の select が **幅 0 の ▾ 2 つ**になり操作できない（shot 82）。
- Backup「Backup created: <path>」、Export「Exported: <path>」は明快。Export のファイル名とログの時刻は UTC（`20261021T170447Z`、ローカルは 10/22 02:04）。
- 「Settings」を押すと最後に見たセクション（Genres）が開く。初回ユーザーが AI providers に辿り着く導線は空状態のリンクだけ。
- 表示言語は即時切替（良い）。ただし日本語 UI では Collections が「グループ」、英語では「Collections」、エラー文は「group」。

### 2.11 今日の復習・単語帳（shot 64, 65）

- 空状態の説明（「Answer the quiz … Add to review」「Select an English word … Save word」）は次の行動を言っていて良い。
- 復習カード・単語登録の実操作は、LLM 呼び出しを増やさないため未実施。

## 3. 情報設計上の原因

上の記録を、局所修正ではなく情報アーキテクチャの問題として 6 つにまとめる。

### R1. 「記事の処理状態」のモデルが 1 つに決まっていない

説明する発見: 2.2（取得失敗が Jobs に出ない／自動で既読）、2.3（embed の実体が見えない）、2.4（Mixed なのに原文、Translating の件数不一致）、2.9（失敗の置き場が 2 系統、Retry now の無反応）、2.6 の「Needs attention」。

取得・描画・埋め込み・分類・翻訳・要約は、ある記事に対する **一本のパイプライン** なのに、画面上は「記事の属性（Fetch failed / Translating 0/7 / Summary failed）」と「ジョブ表（type × state）」の 2 つの独立した投影になっていて、同じ失敗が片方にしか現れない。ユーザーは「この記事は今どこまで進んでいて、何が止まっていて、どこで直すか」を 2 箇所を往復して推測する。

方向: 記事ごとに「取得 → 本文 → 索引 → 分類 → 翻訳 → 要約」の段階と各段階の状態（未・実行中・待ち再試行・失敗・済み）を 1 つの状態オブジェクトとして定義し、一覧の行・Reader のヘッダ・Jobs の行はそれを粒度違いで見せるだけにする。失敗の「再試行」も同じオブジェクトの操作にすれば Reader からも Jobs からも同じ結果になる。

### R2. AI プロバイダの「準備状態」が一級の概念になっていない

説明する発見: 2.1（設定していないのに動く／「set one up」と言われる）、2.9（キー無しで Save できる、失敗して初めて分かる）、2.4（claude が無い環境で全ジョブが 5 回失敗する構造）。

チェーンは「設定値」として保存されるだけで、「今このチェーンは使えるか（CLI が入っているか、キーがあるか、5 分間の sit-out 中か）」という状態がどこにも表示されず、空状態の文言は設定の有無すら見ていない。

方向: プロバイダごとに「準備 OK / キー未設定 / CLI 未検出 / 一時停止中」を持ち、設定画面・空状態の案内・Jobs の失敗行・Reader の「Summarize」ボタンの disabled 理由が同じ状態を参照する。既定で Claude CLI を使うなら、その事実と課金先を初回に明示する（または既定を「未設定」にして空状態の案内と一致させる）。

### R3. 入力の「受理／拒否／変換」が画面ごとにばらばら

説明する発見: 2.2（無効 URL が検索に化ける、重複の Add と Open）、2.3（2 行が黙って消える、下書きが残る／消える）、2.6（Find のエラー位置、`not a feed` を 3 feeds と数える、重複フィードが Added、タグ重複が無反応、コレクション重複エラーの位置と用語）。

URL・フィード URL・タグ・コレクション名・複数行テキストという「ユーザーが打ち込む入力」に対して、何を受理し、何を捨て、何に読み替えたかを返す共通の形がない。あるものは別の意味に読み替え（検索）、あるものは黙って捨て、あるものは離れた場所にエラーを出し、下書きの寿命も画面ごとに違う。

方向: 入力フォーム共通の「レシート」（受理 N 件、捨てた M 行とその理由、既存 K 件へのリンク、結果へのリンク）を 1 部品にし、入力欄の直下に出す。下書きは画面を離れても保持（または送信で確実に消す）。パレットの URL 判定は「URL らしいが不正」を検索と区別して言う。

### R4. 「言語」が 4 層に分かれていて、合成結果が説明されない

説明する発見: 2.4（Reader 既定 Mixed、Page 既定 Original、Translated なのに原文、中国語が訳されない、要約・回答が常に日本語）、2.10（表示言語を変えても回答言語は変わらない）。

表示言語（UI）／記事の訳先（ja↔en の固定ルール）／回答・要約の言語（prompt 固定の日本語）／表示モード（original・mixed・translated、かつ Reader と Page で別の既定）が独立に決まり、「今見えているものはどの言語で、なぜか」を画面が説明しない。モード切替が「表示を変える」のか「翻訳ジョブを積む」のかも文脈依存。

方向: 「学習言語ペア（母語・学習言語）」を設定の一箇所で定義し、訳先・回答言語・要約言語はそこから導出する。表示モードは「訳がある部分の見せ方」に限定し、「訳がない」は別の状態（翻訳ボタン／進捗）として常に同じ場所に出す。Reader と Page の既定を揃える。

### R5. 用語とラベルの出所が 3 系統（UI カタログ・backend `msg!`・外部データ）

説明する発見: 2.6（group / Collection / グループ、`<title>` 由来の「… | Rust Blog」）、2.9（`ingest` / `embed` と Fetch / Search index）、2.2（OS の生エラー文、タイトル = URL）、2.6（0 件のシードジャンル）。

同じ概念が、UI の i18n カタログ、Rust 側のメッセージ、ページやフィードから拾った文字列の 3 つの経路で画面に出て、それぞれ別の名前を名乗る。

方向: ドメイン用語表（collection、feed、folder、fetch、index…）を 1 つにし、UI・backend の `msg!`・ガイド・CLI がそれを参照する。外部由来の文字列（タイトル、エラー）は表示前に必ず自前の語彙に写像する層を通す（entry title 優先、site suffix 除去、エラー種別→定型文）。

### R6. 幅と優先度の設計がない（ペインが互いに領域を奪い合う）

説明する発見: 2.4（Page ツールバー溢れ、Reader 360 px、注記の折り返し）、2.9（Jobs の Note 列）、2.10（AI providers の select が幅 0）。

既定 1200 px で、ナビ・一覧・文書・対話の 4 ペインに加え、設定・Jobs の管理画面まで同じ横並びに入り、どのペインが縮むか・最小幅・畳む順番が決まっていない。

方向: ペインごとに最小幅と「足りないときに畳む順」を決め（例: 対話を開いたら一覧を自動で閉じる、管理画面では対話を畳む）、ツールバーは優先度付きで溢れた項目を ⋯ に送る。

## 4. 局所的で明らかな修正 と 仕様の議論が要るもの

### 4.1 明らかな修正（バグ・明確な直し方）

1. フィード経由の記事タイトル: フィード entry の title を優先する／ページ `<title>` の site suffix（` | Rust Blog`、` · This Week in Rust`）を落とす（2.6）。
2. 中国語の段落が訳されず、かつ「Translate again」になる: かな（ひらがな・カタカナ）を含むときだけ日本語扱いにし、漢字のみは対象にする（2.4）。
3. Importance ファセットの「Not rated」が常に 0（2.6）。
4. コレクション重複エラーの「group」→ collection / コレクションに統一（backend `msg!` の訳）（2.6）。
5. AI providers のモデル／effort の select が狭幅で幅 0 になる（`min-width` と折り返し）（2.10）。
6. 一覧ヘッダの「Not rated: "About you" is empty」の折り返し（注記を 1 行にするか tooltip へ）（2.4）。
7. 「Select」モードを Esc で抜ける（2.5）。
8. 一括インポート／複数行フィード追加の送信後に入力欄を消す、または画面を離れても下書きを保持する（2.3, 2.6）。
9. 「Retry now」の後に attempts / next / state を更新する（手動再試行で attempt を進める）（2.9）。
10. 一括インポート／複数行追加で無視した行数と理由を結果に出す（`ftp://`、URL でない行）（2.3, 2.6）。
11. Find のエラーを Find 欄の直下に出し、入力変更で消す（2.6）。
12. 一覧の「Translating 0/7」と Reader の「0 / 6 block」の件数を同じ計算にする（2.4）。
13. 空状態（0 件）ではファセット・並び順・Select・Clear を出さない（2.1）。
14. 取得失敗の OS 生エラー（`os error 11001`）を「ホストが見つかりません」などの定型文に写像する（2.2）。
15. 本文が翻訳対象ブロックを持たない記事（`<pre>` だけの RFC）で、Translate が出ない理由を表示する（2.4）。
16. Jobs の Type に表示名（Fetch / Search index …）を出し、内部名は tooltip か副題にする（2.9）。

### 4.2 仕様の議論が要るもの

- 既定の AI プロバイダを暗黙の Claude CLI にしたまま、空状態の文言をどうするか（R2）。
- パレットから追加した記事を自動で開く＝既読にする挙動を残すか（R1）。
- Reader の既定モードを Mixed にするか、Page と揃えるか。「Translated を選んだまま未翻訳記事を開いたとき」に翻訳を始めるか（R4）。
- 取得失敗を Jobs にも載せるか（自動再試行の対象にするか）（R1）。
- 要約・回答の言語を表示言語または設定に従わせるか（R4）。
- Group「Source」を自動で Source → Genre の二段にするか（2.6）。
- 対話 Scope の構造（階層化・検索可能化）（2.8）。
- `Alt+↑` でフォルダ外のフィードが隣のフォルダに入る挙動（2.6）。
- Esc の「戻る」範囲に並び順・グループを含めるか（2.5）。
- 0 件のシードジャンルを設定に見せ続けるか（2.6）。
- 対話ペインを開いたときにどのペインを畳むか（R6）。
