# ロードマップ（未実装項目）

要件定義と 2026-10-17 時点の実装を突き合わせた未実装項目の一覧。実装済みの内容は `docs/design-review.md` を参照。

状態: **済** は実装済み（`docs/design-review.md` の該当節を参照）、**進行中** は着手済み、**次** は次に着手する、**後** は MVP 後でよい、**将来** は Phase 2 以降。

## 1. 使ってみての要望（2026-10-17）

| # | 項目 | 状態 | 方針 |
|---|---|---|---|
| F1 | 記事一覧クリック時に固まる | 済 | クリックした記事を即座に選択状態にし、ページの読み込み中はローディングを表示する。 |
| F2 | 「その他のモデル」が選べない | 済 | `SettingsView` の select が `custom` を選んでも preset 値のまま戻るバグ。F3 の設定 UI で作り直す。 |
| F3 | モデルの Fallback（最大 3 つ） | 済 | provider + model の組を 3 つまで並べ、1 つ目が usage limit などで失敗したら 2 つ目を使う。`LlmProvider` を実装する chain として作るので、domain 側は変わらない。 |
| F4 | Codex CLI / OpenAI API / Gemini API | 済 | §9。adapter を追加する。API key は DB の `settings` に `secret.` 接頭辞で保存し、バックアップからは除く。 |
| F5 | 自動分類 | 済 | LLM の `classify` job（§4.6）。記事にジャンルを付ける。ジャンルは既存ジャンルを優先して再利用させ、ユーザーが変更できる。 |
| F6 | RSS / Atom | 済 | §13。feed を登録し、定期的に取得して新着を ingest job に流す。 |
| F7 | 2 つの表示モード | 済 | 「feed ごと → その中でジャンルごと」と「ジャンルごと」を切り替える。 |
| F8 | 追加日時ソート | 済 | 一覧の並び順を 追加日時（新しい順／古い順）・公開日時 から選べるようにする。 |
| F9 | LLM との対話ペイン | 済 | NotebookLM のように、保存した記事を根拠に回答し、根拠の block を引用・ジャンプできる。スコープ（この記事／タグ／ジャンル／feed／全体）を指定する。全体のときは hybrid search で上位 block だけを渡す。 |
| F10 | Cloudflare R2 への自動バックアップ | 済 | bucket などは `infra/` の Terraform で管理する。アプリは S3 互換 API で `VACUUM INTO` のコピーを圧縮してアップロードする。API キーはユーザーが後で設定する。 |
| F11 | JS で描画するページの保存 | 済 | アプリ内ブラウザで開いているページは描画後の DOM を保存する（済）。bulk import / RSS の記事は非表示 webview で描画する（済）。 |

## 2. 使ってみての要望（2026-10-20）

UI 全面改修（4 層モデル: scope・facet・一覧・文書）のあとで出た要望。G1〜G27 は今回の改修で対応する（**進行中**）。G28 以降は後で着手する。

| # | 項目 | 状態 | 方針 |
|---|---|---|---|
| G1 | 日本語の記事が全部日本語で表示される | 進行中 | 記事の言語を判定し、日本語の記事は英語に訳す。混在 N% は「もう一方の言語」の割合になる。アプリ内ブラウザも同じ。 |
| G2 | 手動追加の記事がジャンル分類されない | 進行中 | 自動分類の導入前に保存した記事に classify job がなかった。起動時に未分類の記事を分類キューに入れる。 |
| G3 | タグ等の popover が一瞬左上に出る | 進行中 | 描画前に位置を決める。 |
| G4 | ペイン幅をドラッグで調節 | 進行中 | nav・一覧・文書・対話の間に区切りを置き、幅を保存する。 |
| G5 | Page 表示で切り替えると前のページが一瞬見える | 進行中 | 遷移中は native webview を隠し、読み込み後に表示する。 |
| G6 | アプリアイコン | 進行中 | 格子のアイコンを作り、ウィンドウ・タスクバー・アプリ左上で使う。 |
| G7 | Page 表示で select を開くとページが真っ白になる | 進行中 | popover を一覧ペイン内に収め、webview と重なるときだけ隠す。 |
| G8 | 戻る / 進むを履歴がないときは無効に | 進行中 | ページから `canGoBack` / `canGoForward` を通知する。 |
| G9 | ショートカットの変更・1 つの操作に複数キー | 進行中 | 操作とキーの対応を 1 つの表にし、設定画面で編集する。 |
| G10 | 文書ペインのない画面で対話を開くと右に余白 | 進行中 | 管理画面が残りの幅を使う。 |
| G11 | README（英語・日本語） | 進行中 | 先頭で言語を切り替える。他人が使う前提でセットアップと設定を書く。 |
| G12 | フィード・記事に favicon | 進行中 | backend がドメインごとに取得して DB に保存し、`data:` URL で渡す。 |
| G13 | 矢印キーで移動 | 進行中 | j/k と同じ操作にする。 |
| G14 | tmux と同じキーでペイン移動 | 進行中 | `Ctrl+B` の後に矢印・h/j/k/l・o。 |
| G15 | Page のツールバーがはみ出すと右側を押せない | 進行中 | はみ出したら横スクロール。 |
| G16 | 開いている記事を選ぶと再読み込みされる | 進行中 | 同じ記事・同じ表示なら何もしない。 |
| G17 | 既読の条件 | 進行中 | 開いたら既読にするが、scope か facet を変えるまでは未読一覧に残す。 |
| G18 | 記事の削除（Index から削除） | 進行中 | 確認ダイアログつき。記事にぶら下がるデータをすべて消す。 |
| G19 | AI プロバイダの順序をドラッグで変更 | 進行中 | dnd-kit。 |
| G20 | `aside` が翻訳されない | 進行中 | アプリ内ブラウザの翻訳対象から外していた。記事中の補足ボックスは本文として扱う。 |
| G21 | 訳したセンテンスの点線が邪魔 | 進行中 | 点線をやめ、hover の背景だけ残す。 |
| G22 | select の文字が上寄せ | 進行中 | 上下中央にする。 |
| G23 | popover を開いているときは j/k で中を移動 | 進行中 | 開いている間はグローバルなキー操作を止める。 |
| G24 | j/k で選ぶ → Enter で開く | 進行中 | 一覧にカーソルを持ち、Enter で開く。 |
| G25 | 翻訳プロンプトを UI で調節 | 進行中 | 設定 › 翻訳 に「追加の指示」。指示を変えたら訳をキャッシュから使わない。 |
| G26 | カスタムタイトルバー | 進行中 | ウィンドウの枠を消し、アプリが描くタイトルバーにする。 |
| G27 | 環境変数を mise で管理 | 進行中 | `mise.local.toml`（git 管理外）に API キーを書く。 |
| G28 | 英語レベル（CEFR A1〜C2） | 後 | レベルを設定し、翻訳に使う。案: 翻訳時に各文がレベルを超えるかを LLM に判定させ、混在モードに「レベル基準」を足す。または訳文の語彙・注釈をレベルに合わせる。 |
| G29 | 再翻訳 | 済 | Reader の ⋯ と、全部訳し終えたときの翻訳状況の横に「訳し直す」。今の訳先（cache key）の訳をこの記事の段落の分だけ消して translate job を積み直す。50 block を超えるときだけ確認する。 |
| G30 | ライセンス表記 | 済 | `LICENSE`（MIT）と `THIRD_PARTY_NOTICES.md`（Mazelingo の MIT 表記、同梱フォントの OFL）。依存ライブラリのライセンス一覧の自動生成は G41 と一緒に行う。 |
| G31 | 論文 PDF の取り込み | 済 | インポート画面の「PDF」タブでファイルから、`application/pdf` を返す URL（arXiv の `…/pdf/…` など）は通常の保存・一括インポート・フィードから取り込む。`pdf-extract` の文字位置から 2 段組の読み順・running header とページ番号の除去・タイトルと著者・見出し・段落（行末ハイフンの結合）・キャプション・参考文献を組み立てる（`pdf.rs`）。原本を snapshot に保存して再抽出はオフライン。URL の PDF は Page で WebView2 の viewer、ファイルの PDF は `local:pdf/<sha256>` で Page なし（design-review §5）。 |
| G32 | 理解度チェックのクイズと間隔反復 | 済 | LLM job `quiz`（要約と同じ provider chain、本文は untrusted、出力は検証してから保存）が記事ごとに 3〜8 問（記述式と 4 択、答え・1 行の解説・出典 block）を作る。「自分について」を反映し、本文か「自分について」が変わると stale。Reader の「理解度チェック」で右に開くパネルで解き、出典 block へ移動できる。最後に「復習に追加」すると、その回の答えを 1 回目として SM-2（Anki 方式）で間隔を空ける。ナビの「今日の復習」（期限のカード数を badge）で 1 枚ずつ出題し、評価ごとの次の間隔を表示、最後に集計。カード・記事単位で外せる。設定 › 復習 で 1 日の新規・復習の上限、最短間隔（既定 1 日、分単位まで）、最長間隔（既定 365 日）。バックアップ（DB）と JSON エクスポートに入る（`quiz.rs`・`srs.rs`、design-review §19）。 |
| G33 | ブラウザのタブ | 済 | 各ペインの上にタブ列（題名とファビコン、×、middle クリックで閉じる、ドラッグで並べ替え・別ペインへ移動、+ でパレット）。Reader の記事も Page の URL もタブ。一覧・パレット・検索一致・引用はフォーカスされたペインのアクティブなタブに開き、Ctrl / middle クリックと `Ctrl+T` は新しいタブに開く。`Ctrl+W` 閉じる、`Ctrl+Tab` / `Ctrl+Shift+Tab` 切り替え。Page タブごとに webview（`browser-<tab>`）を持ち、隠れたタブの webview は 3 つまで画面外に残す（切り替え即時・履歴とスクロールが残る）。レイアウトは localStorage に保存し起動時に復元する（design-review §19）。 |
| G34 | Page ペインの分割 | 済 | 文書領域は split（横 / 縦、比率）と pane の木（`src/layout.ts`、純粋な操作と単体テスト）。タブ列の分割ボタン、`Ctrl+\` 右・`Ctrl+-` 下、プレフィックス後の `%` / `"` / `x`。区切りはドラッグ・矢印キーで比率を変え、ダブルクリックで均等に。空になったペインは消え、子が 1 つの split は畳む。フォーカスされたペインに枠。`Ctrl+B` の ← → ↑ ↓ は矩形の隣のペインへ（上下に分けたペインにも）。各ペインの Page はそれぞれ webview を持ち、overlay・翻訳・ショートカット転送も webview ごとに動く（design-review §19）。 |
| G35 | 技術書の取り込み | 将来 | G31 の延長。 |
| G36 | URL バーから検索 | 済 | Page のツールバーの URL をクリックすると全体を選択した入力欄になり、Enter で開く・Esc で戻す。`http(s)://` で始まる入力はそのまま、ホストらしい入力（`example.com/x`・`localhost:3000`・IP）は `https://` を付けて開き、それ以外は検索する（`toNavigation`）。設定「ブラウザ」で検索エンジン（DuckDuckGo（既定）・Google・Bing・Brave Search・Kagi・`%s` を含むカスタム URL）を選ぶ。再読み込みの隣にホームボタン（エンジンのトップページ）。 |
| G37 | 更新通知とアプリ内アップデート | 済 | `tauri-plugin-updater` が GitHub の公開済み release の `latest.json` を読む。起動時と 設定 › アップデート の「更新を確認」で確認し、新しい版があればタイトルバーの下にバー（版・リリースノート（Page 表示で開く）・「更新して再起動」・「後で」）を出す。ダウンロードの進み具合を表示し、署名を確かめて NSIS インストーラーを passive で実行する（インストーラーがアプリを閉じて新しい版を起動する）。公開鍵は `tauri.conf.json` に置き、placeholder のままなら確認せず「設定されていません」と表示する。鍵の作り方と secret は `docs/release.md`。 |
| G38 | データ保存先の変更 | 済 | 既定は `%APPDATA%\dev.lattice.app` のまま。exe の隣に `portable`（または `lattice.portable`）があれば、DB・バックアップ・エクスポート・モデル・ログ・WebView2 のプロファイルを exe の隣の `data` に置く（portable zip はこのファイル入り）。設定 › ログ・保存場所 の「変更…」で Rust 側のダイアログからフォルダを選び、DB を `VACUUM INTO`（API キーも含む）で、backups・exports・models をコピーし、既定のフォルダの `data-location.json` に記録して再起動を促す。既にデータがあるフォルダはコピーせずに切り替える。元のデータは消さない。記録が読めない・フォルダが作れないときは既定の場所で起動し、設定画面に理由を出す（`src-tauri/src/location.rs`）。 |
| G39 | 単体テスト・E2E テストの強化 | 済 | `e2e/`: Vite が本物のフロントエンドを `@tauri-apps/api/mocks` の上で配信し、Playwright（Chromium）が操作する。mock backend は `e2e/mock.ts` の 1 つの表（`src/api.ts` の全 command と window / webview plugin）で、サンプルデータは 40 記事・6 フィード・訳文・Markdown 記事・検索・job・対話。spec は一覧の scope・facet と件数、タグの popover、j/k と Enter、Ctrl+K、検索、Reader の表示言語と block の反転、削除の確認、設定、ショートカットの変更、ペイン幅の保存（22 件、約 25 秒）。`api.ts` の command を mock が答えないと `npm test` が失敗する。単体テストは job の backoff・同一ホスト制限・実行中の job の取り消し・feed の重複 entry・overlay の sanitize・キー設定・ペイン移動に追加（design-review §18）。 |
| G40 | CI でテスト | 済 | `.github/workflows/ci.yml`: master への push と PR で、windows-latest・`jdx/mise-action`（`mise.toml` の版）・cargo と npm と Playwright のブラウザの cache の上で、overlay のビルド、rustfmt、clippy、Rust のテスト、`npm test`、oxlint、型チェックとビルド、E2E を順に実行する。失敗時は Playwright のレポートを artifact に残す（design-review §18）。 |
| G41 | リリースフロー | 済 | バージョンは `package.json`・`package-lock.json`・workspace の `Cargo.toml`（両 crate が継承、`tauri.conf.json` は持たない）・`Cargo.lock` にあり、`npm run bump -- <x.y.z>` で揃え、`npm test` がずれを検出する。`CHANGELOG.md`（Keep a Changelog）。`v*` タグで `.github/workflows/release.yml` が NSIS インストーラー・portable zip・`THIRD_PARTY_LICENSES` を draft release に載せる（署名鍵の secret があれば updater 用の `.sig` と `latest.json` も）。ライセンス一覧は cargo-about と `scripts/licenses.mjs` で生成（`mise run licenses`）。手順は `docs/release.md`。 |
| G42 | 静的解析 | 済 | `mise run lint`: rustfmt（`rustfmt.toml` は既存の長い行に合わせた）、clippy（`--all-targets -D warnings`）、oxlint（type-aware。hooks・promise・`no-unsafe-*` など、外した規則は `oxlint.config.ts` に理由を書いた）。`mise run test` は lint の後に走る。型チェックは従来どおり `npm run build`（design-review §18）。 |
| G43 | 対話の入力欄で Vim キーバインド | 済 | 設定 › 要約・対話 で有効にする（既定はオフ、端末ごとに localStorage）。挿入モードで始まり、Esc でノーマルモード。h j k l w b e 0 $ gg G、i a I A o O、x dd dw cw yy p、u。送信はどちらのモードでも Ctrl+Enter。`src/vim.ts` の純粋な状態機械で、依存は足していない。 |
| G44 | アプリ全体を Vim 風に操作 | 後 | Chrome の Vimium のように、リンクのヒント表示などで操作する。G9 のキー設定の上に作る。 |
| G45 | モデルごとの effort 設定 | 済 | chain の各段に任意の effort（`low`〜`max`、Gemini は `low`〜`high`）。Claude CLI `--effort`、Codex CLI `model_reasoning_effort`（既定は従来どおり low）、OpenAI `reasoning.effort`、Anthropic `output_config.effort`、Gemini `thinkingConfig.thinkingLevel`。未指定は provider の既定で、保存済みの chain はそのまま読める。 |
| G46 | タスクバーに未読数バッジ | 済 | 未読数を描いた画像を Windows の overlay icon にする（99+ まで、0 で消す）。UI の未読数の変化を 500 ms まとめて backend に渡す。設定「タスクバー」でオフにできる（design-review §16）。 |
| G47 | スマホから使える簡易版 | 将来 | 同期の仕組みが前提（R2 バックアップの延長か、別の仕組みか）。 |
| G48 | Markdown の取り込みと表示 | 済 | インポート画面の「Markdown」タブで、ファイルか貼り付けたテキストを 1 つの記事にする（pulldown-cmark で IR に変換、HTML タグは捨てる）。URL の代わりに `local:md/<sha256>` を持ち、同じ本文は重複しない。Page・再試行・描画はなし。URL の画像は保存し、相対パスの画像は選んだファイルのフォルダからだけ読む（design-review §5）。 |
| G49 | 対話・要約のカスタム指示 | 済 | 設定 › 要約・対話 に全体共通の「自分について」（2000 文字まで）と、要約・対話それぞれの追加の指示。system prompt の組み込みの規則の後、untrusted input の注意の前に入れる。指示を変えると作成済みの要約を stale として表示する。 |
| G50 | Page 表示でページにフォーカスがあるとショートカットが効かない | 済 | アプリが転送するキーの一覧（`pageKeys`）を backend 経由で overlay に渡し（起動時・ページ読み込み時・変更時）、overlay がページの keydown（capture）で拾って `overlay_key` で送る。`Ctrl+K`・`Ctrl+B` とその次のキーはページの入力欄からも送り、ページには渡さない。j / k・s・m・v・[ ] などはページの入力欄の外でだけ、ページが `preventDefault` しなかったときに送る。Enter・Esc・矢印・Space はページのもの。パレット・検索・Reader への切り替え・ペイン移動はフォーカスをアプリに戻す。 |
| G51 | UI の多言語対応（日本語・英語） | 済 | `src/i18n` の型つきカタログ（`ja.ts` がキーの元、`en.ts` は `satisfies Messages` でキーの過不足が型エラー、`{name}` の引数は呼び出し側で型検査）と `useT()`。設定 › 操作 › 表示言語（既定は WebView の言語、再起動なしで切り替え、localStorage と DB の `ui_language` に保存。backend はネイティブダイアログの題名に使う）。英語の複数形は関数、日付・相対時刻・数値は `Intl`。ショートカット名・overlay の tooltip も対象。Rust からの文言は `msg!` のコード + 引数（JSON 文字列）で返し、UI が `be.*` で訳す。抽出は `scripts/i18n-extract.mjs`、UI コードに日本語が残ると `literals.test.ts` が落ちる。e2e は日本語の全 spec に加えて英語のプロジェクト（design-review §21）。 |
| G52 | Page ペイン・対話ペインを別ウィンドウに切り出す | 済 | タブ列の「別ウィンドウで開く」（`Ctrl+Shift+N`）でそのタブ（Reader でも Page でも）を文書ウィンドウ `doc-<n>` に、対話ペインの「別ウィンドウで開く」で対話を `chat` ウィンドウに出す。どのウィンドウも同じフロントエンドで、ラベルから何を映すかを決め、レイアウト・overlay・キーボード・パレットはウィンドウごと。Page タブは webview の鍵（`PageTab.key`）を持ち、タブが別のウィンドウに移ると webview を閉じて移った先で開き直す（`Webview::reparent` は実機で WebView2 の位置がずれたため使わない。移ったページは読み込み直しになり、履歴は引き継がない。イベントは webview のいるウィンドウへ）。「メインウィンドウに戻す」（同じキー）・×・Alt+F4 でタブはメインのフォーカスされたペインに戻り、最後のタブを閉じた文書ウィンドウは閉じる。対話ウィンドウの「この記事」はメインの記事、引用と Reader の「質問」はウィンドウをまたいで届く。位置と大きさは Rust が設定表に覚え、起動時に開いていた pop-out を復元する（モニタがなければ中央）。メインを閉じるとアプリ終了。タブはウィンドウをまたいでドラッグできる: 別の Lattice ウィンドウのタブ列に落とすとそこへ移り（落とした位置の slot）、どのタブ列でもない所に落とすと新しい文書ウィンドウにポインタの下へ切り出す（Chrome の挙動。↗ ボタンと `Ctrl+Shift+N` は残す）。ドラッグ中は元ウィンドウでタブのゴーストが追従し、落とし先のタブ列に挿入位置が出る（design-review §26）。 |
| G53 | 情報リソースのグループ（プロジェクト） | 済 | 手で作るグループ（`groups` / `group_articles`、名前は大文字小文字を区別せず一意、記事の削除で所属は消え、グループの削除で記事は残る）。1 つの記事が複数のグループに入る。`ArticleFilter::Group` で一覧・検索・対話・エクスポートの範囲になり、サイドバーの「グループ」（＋ 新規、⋯ で名前の変更・削除）、ファセットの「グループ」、検索と対話の範囲（今の一覧がグループなら対話に「このグループ」）に出る。入れ方は Reader のグループ chip とピッカー（検索して作成も）、一覧の「選択」（クリックで選択、Shift+クリックで範囲）→「グループに追加」、パレットの「グループ: X」「この記事をグループに追加…」、グループを開いた状態で URL を Index に追加、インポート画面（URL・Markdown・PDF）の「グループ」欄（今のグループが最初から入る。取り込み済みの URL も入る）。JSON エクスポートは各記事の所属と `group` 行を持ち、1 つのグループだけを書き出せる（design-review §24）。 |
| G54 | 自分の志向に基づく重要度判定 | 済 | job `relevance`（`relevance.rs`）が「自分について」を基準に 1〜5 と理由 1 行を付ける。分類と同じく最大 20 件を 1 回の LLM 呼び出しで判定（タイトル・ドメイン・要約か本文の冒頭 1500 字、untrusted input）。最新の判定だけを `relevance` 表に、判定に使ったプロフィールの hash と一緒に保存し、プロフィールを書き換えると「以前のプロフィールで判定」になる。プロフィールがあれば新しい記事を自動で判定（設定でオフ可）。一覧の目印（4・5 だけ）と理由の tooltip、Reader の理由の行、「重要度・高い順」、facet「重要度」、サイドバーの「重要」（既定 4 以上、設定で 2〜5）。「重要度を付け直す」は設定（未判定と古いものすべて）と一覧（表示中の記事）から（design-review §25）。 |
| G55 | RSS フィードの取り込みフィルタ | 済 | `feed_filter.rs`。新着 entry を queue する前に、全体（設定 › 取り込みフィルタ）とフィードごと（フィードを管理 › 編集）のフィルタを両方通す。ルールはタイトル・URL・著者・カテゴリ・ドメイン・言語へのキーワードか正規表現（大文字小文字を区別しない）で、「除く」のどれかに合えば除外、「含む」があればどれかに合う必要がある。本文を載せているフィードには最短文字数。ルールを通ったものだけ、LLM がオンなら job `feed_filter` がフィードごとに最大 20 件まとめて判定する（タイトル・抜粋・「自分について」・指示。重要度の下限を選ぶと G54 と同じ 1〜5 の点数で決める）。LLM が失敗したら取り込み、フィードに理由を出す（fail open）。判定は `feed_items` に状態・理由・判定に使った値と一緒に残し、poll で判定し直さない。「除外された記事」に理由を出し、「取り込む」「このルールを外す」「除外分を再評価」ができる（design-review §25）。 |
| G56 | 英単語の登録と学習 | 済 | Reader で英語の語・熟語を選ぶと「単語を登録」（ショートカット `w`）、文脈の文（ブロックの文から切り出す）・記事・block を保存する。Page では overlay が同じボタンを出し、`overlay_vocab`（browser webview から、画面に出ているときだけ、1 秒に 1 回まで、長さと「語が文に含まれる」を検証）で送る。出典はページの主張ではなく webview の URL で、保存済みの記事なら記事に結び付ける。LLM job `vocab`（20 語ずつ、文は untrusted、出力は検証）が見出し語・品詞・文脈での意味（日本語）・英語の定義・IPA・例文を付け、同じ見出し語の項目は 1 つにまとめて文脈を足す。意味が付くとカードが 2 枚（穴埋め＝意味をヒントに使われた形を答える、単語→意味＝答えの後に文脈）でき、「今日の復習」に quiz のカードと同じ 1 日の上限で並ぶ（同じ語のカードは 1 日 1 枚）。出典の箇所に飛べる。ツール › 単語帳で検索・並び替え（追加順・期限順）・意味の編集・停止・再取得・削除・Anki 用 CSV の書き出し、記事中の登録語に下線と意味のツールチップ（単語帳で切り替え、既定はオン）。`vocab.rs`・`review.rs`・`src/vocab.ts`、design-review §22。英語レベルからの候補提案は未着手。 |
| G57 | CLI・外部エージェントから機能を呼ぶ | 済 | `crates/lattice-cli` の `lattice-cli`（アプリの `lattice.exe` と衝突しない名前）。アプリと同じ保存場所の解決（`lattice_core::location` に移した）で同じ DB を WAL で開き、`search`（モデルがなければ全文検索と明示）・`get`・`list`・`summary`・`tags`・`genres`・`feeds`・`jobs`・`ask`（アプリの LLM chain）を JSON か `--format text` で返す。`save`・`tag`・`read`・`favorite` は `--allow-write` か `LATTICE_ALLOW_WRITE=1` のときだけ。`save` は ingest job を積んでアプリの runner（30 秒ごとに queue を見る）に任せ、`--run` で CLI が同じコードで取得する。`lattice-cli mcp` は同じ操作を MCP の tool として stdio で出す（最小の JSON-RPC、結果に untrusted の明示と 25,000 文字の上限）。portable zip に同梱し、README に Claude Code の設定と prompt injection の注意を書いた。設計は `docs/design-review.md` §23。 |

### 2026-10-21 のフィードバック（H）

| # | 項目 | 状態 | 方針 |
|---|---|---|---|
| H1 | 翻訳が壊れて見える | 済 | (1) Page の 訳文 / 混在 が効かない: overlay の設定は backend で全 webview 共通なのに、どのウィンドウも起動時に自分の既定（原文）を `browser_set_translation` していた。後から開いた pop-out・対話ウィンドウが全ページの翻訳を切っていた。送るのはメインだけにし、文書ウィンドウは起動時にメインへ今の選択を尋ねる（`main-request` の `pageLang`）。(2) Reader で 混在 / 訳文 を選んだとき、未翻訳で翻訳 job がなければ翻訳を始めて進み具合を出す（設定 › 翻訳「表示を切り替えたら自動で翻訳」、既定オン）。「保存した記事を自動で翻訳」（既定オフ、日本語の記事は対象外）。(3)「訳し直す」は訳が 1 つでもあれば ⋯ に説明付きで出す。 |
| H2 | ページ表示のちらつき・重なり・印刷 | 済 | 原因は、ページの view が mount し直すたびに（React の StrictMode の 2 回目の mount、ペインの移動）webview の hide が 2 つの show の間に送られていたこと（e2e で show, show, hide, show, show を確認）。設定・処理状況から戻ったときの一瞬の表示崩れと、hide が最後に届いた場合の白いままのペイン（推定）。unmount の hide は microtask まで待ち、同じタブがすぐ mount し直したら送らない。⋯ メニューを閉じたときは、webview を表示し直してから描き終わるまで（150 ms）静止画を残す。位置と大きさは 1 つの `set_bounds` で送る（`set_position` と `set_size` はそれぞれ今の矩形を読んで書き戻すので、後の方が古い位置を書き戻しうる）。placeholder が現れた・大きさが変わった後 600 ms は毎フレーム位置も見て追従する（ResizeObserver は位置の変化を知らせない）。印刷（Ctrl+P・ページの `window.print()`）は overlay が `overlay_print` を呼び、Windows では WebView2 の `ShowPrintUI(SYSTEM)` でシステムの印刷ダイアログを出す（それ以外はページの印刷のまま）。 |
| H3 | 記事の右クリックメニュー | 済 | 一覧の行と Reader / Page のタブを右クリック（またはメニューキー・Shift+F10。カーソルの行かフォーカスのあるタブ）で、お気に入り / 解除・既読 / 未読・グループに追加…・新しいタブで開く・別ウィンドウで開く・Page で開く・URL をコピー・Index から削除…（確認あり）。「選択」中に選んだ行の上で開くと、まとめて効くもの（お気に入り・既読 / 未読・グループに追加）だけを全部に。保存していないページのタブは 新しいタブで開く・別ウィンドウで開く・URL をコピー。 |
| H4 | アプリ内の戻る・進む | 済 | 画面（ライブラリ・処理状況・フィード・設定の各セクションなど）、scope と facet、フォーカスされたタブの文書の移り変わりを、上限 50 の履歴（`src/history.ts`、純粋な reducer）に積む。マウスのサイドボタン（XButton1 / XButton2）、`Alt+←` / `Alt+→`（ショートカットの一覧に追加）、タイトルバーの ‹ › で戻る・進む。ページにフォーカスがあるときのサイドボタンと Alt+矢印はページ自身の履歴（WebView2 の既定。overlay は転送しない）。 |
| H5 | 処理状況の job の説明 | 済 | 種類ごとに ⓘ（`InfoTip`）。hover とキーボードのフォーカスで何をする job かの tooltip を出し、Esc で閉じる。文は ⓘ の `aria-describedby`。ja / en。 |
| H6 | CSS の細部 | 済 | 押せるもの（button・select・summary・タブ・チェックボックス・ファイル選択を開く label）は `cursor: pointer`、disabled は `not-allowed`（title はそのまま）。ボタンの文字の上寄りは計測して直した（下の design-review）。サイドバーと記事一覧は `user-select: none`（入力欄は選べる）。 |

## 3. 要件定義の未実装項目

### MVP 後すぐ

| 項目 | 要件 | 状態 | 備考 |
|---|---|---|---|
| 検索の metadata filter | §6 UC6, §10 | 一部済 | 未読・お気に入り・タグ・ジャンル・feed は済。domain・期間は未着手。 |
| 再抽出コマンドと block ID の再利用 | §4.2, §6 | 済 | snapshot から再抽出し、`text_hash` が一致する block の id を再利用する。 |
| bulk import の同一ホスト宛て並列数の制限 | §15 | 済 | 同じホストへの同時取得を 1 本にする。 |
| job の一覧と再実行 UI | §4.6, §25 Observability | 済 | 失敗した job（job・記事・エラー・試行回数・時刻）を一覧し、再実行できる。 |
| エクスポート | §17 | 済 | 記事・訳・要約・対話を JSONL（gzip）で書き出す（design-review §10）。 |
| 画像の保存 | §26-10 | 済 | SQLite に保存し、Reader には `data:` URL で渡す（design-review §14）。 |

### LLM 処理

| 項目 | 要件 | 状態 | 備考 |
|---|---|---|---|
| タグ付け | §3 UC7 | 済 | F5 の分類と同じ job でタグ候補も出す。 |
| difficulty estimation | §3 UC7, §4.6 | 済 | Phase 3 の表示制御の入力になる。 |
| relevance estimation | §3 UC7, §12 | 済 | G54。サイドバーの「重要」が「High relevance」inbox。 |
| 要約の種類（short / detailed / key_points） | §4.4 | 後 | 今は normal だけ。 |
| technical term を英語のまま残すモード | §8 | 済 | 翻訳 prompt の option にする。 |
| Anthropic API provider | §9 | 済 | `anthropic.rs`（design-review §6）。 |
| Local Model provider | §9 | 後 | F4 の adapter と同じ形で追加できる。 |
| F9 のスコープに genre / feed | F9 | 済 | |

### 対話の広い範囲（検討中）

F9 の対話は範囲に数千記事を指定できるが、LLM に渡すのは hybrid search の上位 30 block（約 40,000 字）だけだった。範囲外の資料を使えないので、「このテーマについて何が分かっているか」（§24）のような網羅型の質問に弱い。上位が 2〜3 記事に偏りやすいのも原因の一つ。NotebookLM のように数百ソースを横断して答えられるようにしたい。

| 案 | 状態 | 内容 | 代償 |
|---|---|---|---|
| 上限を上げる | 済 | 設定 › 要約・対話 の「対話で使う範囲」（`chat::Budget`）。少なめ = 従来どおり（全文 30,000 字・検索 24 block・context 40,000 字）、標準（既定）= 60,000 字・48 block・80,000 字、多め = 120,000 字・96 block・150,000 字。多めでも日本語で 200k token に収まる大きさで止めた。 | 1 回の質問のコストと待ち時間が比例して増え、CLI の usage limit に当たりやすくなる。設定の説明に書いた。 |
| 1 記事あたりの block 数を制限する | 済 | `retrieve()` は枠の 2 倍の候補を検索し、順位順に 1 記事 4 block まで取ってから、枠が余れば残りを順位順に足す（`diversify`）。記事が 1〜2 件の範囲でも枠を使い切る。 | 1 記事を深く読む質問では、範囲を「この記事」にしない限り根拠が減る。 |
| 2 段階（map-reduce） | 後 | 範囲内の各記事の要約で関係する記事を選ばせ、選んだ記事の本文 block で回答させる。 | 全記事に要約が必要。今の要約は Reader から手動で作るだけなので、要約の自動生成と既存記事への backfill が先に要る。 |
| LLM に検索を繰り返させる（agentic） | 将来 | アプリ内の検索を読み取り専用の tool として渡し、LLM が何度も検索してから答える。 | 「untrusted な記事を扱う LLM に tool を渡さない」方針の見直しが要る。CLI provider で自前の tool を渡すのは難しく、作業量が最も大きい。 |

最初の 2 案を同時に入れ、網羅型の質問で足りなければ 2 段階に進むのが第一候補。

### 検索

| 項目 | 要件 | 状態 | 備考 |
|---|---|---|---|
| reranker | §10.3 | 将来 | |
| vector index（sqlite-vec / ANN） | §16 | 将来 | 10^6 block を超えたら。`Store::scan_embeddings` を差し替える。 |

### 収集

| 項目 | 要件 | 状態 | 備考 |
|---|---|---|---|
| Browser extension | §13 | 将来 | |
| Pocket / Raindrop import | §13 | 後 | 今の bulk import は URL を抜き出すので、export ファイルはそのまま読める。専用 import は tag・既読も取り込む場合に作る。 |
| GitHub trending / Hacker News / RSSHub | §13 | 後 | F6 の feed として登録できるもの（RSSHub など）はそれで足りる。 |
| Discord 通知 | §12 | 将来 | |

### Phase 2〜5

| Phase | 内容 | 状態 |
|---|---|---|
| 2 | Semantic Knowledge Base（全 block の embedding と自然言語検索） | 実装済み（hybrid search）。F9 の対話ペインで「資料群への問い合わせ」に近づける。 |
| 3 | Reading Personalization（理解度に応じた表示） | 将来 |
| 4 | Knowledge Graph（Concept と relation） | 将来 |
| 5 | Personal Knowledge Integration（既知・新規・矛盾の抽出） | 将来 |
