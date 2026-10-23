# 改善候補台帳

<!-- remediation -->
**修正後: 14項目・20テストの対応完了。[対応内容・現在のテスト位置・検証結果](remediation.md)。以下の件数・指摘本文は監査時点の記録。**

[全件台帳](ledger.md) / [監査概要](README.md) / [本番境界](boundaries.md) / [反例の再現](evidence.md)

監査対象の改善候補は14項目・一意な20テスト。現在は全件対応済み（上記対応台帳を参照）。優先度はテスト改善順であり本番障害の認定ではない。**削除のみの提案はない。** 名前の修正で十分な部分と、検証内容の補強が必要な部分を分けている。

| ID | 優先 | 対象 | 判断 | 問題 |
| --- | --- | --- | --- | --- |
| [F01](#F01) | P1 | T279 | 補強 | 実フォントと異なる名前を検証する |
| [F02](#F02) | P1 | T455 | 補強 | 切り詰めない抜粋実装でも通る |
| [F03](#F03) | P2 | T289 | 補強 | コピー操作を実行しない |
| [F04](#F04) | P2 | T383 | 補強 | codeの使用判定が文字列存在のみ |
| [F05](#F05) | P3 | T133 | 補強 | 署名の期待値を同じ署名実装から生成 |
| [F06](#F06) | P2 | T436 | 補強 | 実時間依存とcap分岐の片側assertion |
| [F07](#F07) | P3 | T190・T203・T231 | 範囲・名称修正 | 設定の永続化を過大に読める |
| [F08](#F08) | P3 | T277 | 補強 | 全設定カテゴリの列挙が古い |
| [F09](#F09) | P2 | T217 | 補強 | 空欄によるfeed名解除を試していない |
| [F10](#F10) | P3 | T255・T256 | 範囲・名称修正 | chat別窓の名前と実操作の不一致 |
| [F11](#F11) | P3 | T247・T310 | 範囲・名称修正 | URLを開く操作・題名更新が名前にしかない |
| [F12](#F12) | P3 | T240 | 範囲・名称修正 | DOM外側クリックをnative Pageクリックへ拡大解釈できる |
| [F13](#F13) | P3 | T451・T452 | 範囲・名称修正 | helper試験をRust/一覧との一致試験に見せる |
| [F14](#F14) | P3 | T237・T305 | 統合候補 | 静的assertion一つのための独立画面初期化 |

<a id="F01"></a>
## F01 — フォント検証の対象が本番と違う

対象: [T279 / shell.spec.ts:19](../../e2e/shell.spec.ts#L19)。確度: **検証式の反例を再現済み**。

33行目は`document.fonts.check('12px "IBM Plex Sans JP"', text)`を評価する。本番は[theme.css:21](../../src/theme.css#L21)の`Noto Sans JP Variable`系列で、[main.tsx:25](../../src/main.tsx#L25)の事前ロードもNotoを対象にする。フォント取得を止めたprobeで、Notoのloaded faceが0にもかかわらず、この式は6ボタン全てtrueになった。架空フォント名でもtrueになるため、実フォントの事前ロード失敗を検出できない。

**残す保証:** 初回frameでメニュー文字を表示できるという要求自体は有用。`fonts.ready`の後の固定500ms待機も、目的の文字subsetが初回表示に間に合う保証へ置き換える。

**対応・完了条件:** 実際のcomputed font-familyに対応したfaceと必要文字のロードを観測する。冷たいcacheで遅延/失敗を与えた負例が、その観測で区別できることを確認する。フォールバックを許容する仕様なら、その可読性を別の観測で表す。今回の反例は**この判定式**を実行したもので、ネットワークエラーを記録するharness込みで元テスト全体が成功したという主張ではない。

<a id="F02"></a>
## F02 — 抜粋の長さ・切出し位置が検証されない

対象: [T455 / search.test.ts:16](../../src/search/search.test.ts#L16)。確度: **変異実装で再現済み**。

1003文字の入力にmax=90を渡すが、assertするのは両端の`…`と`WAL`の存在だけ。無hit長文も先頭`zzz`しか確認しない。[本番excerpt](../../src/search/search.ts#L5)を監査用コピー内で「長文の全体に省略記号を付けるだけ」へ置き換えると、同ファイル3件が全て成功した。先頭hitを中心付近に置くという名前も確かめていない。

**残す保証:** 短文保持・検索語の可視化。**対応:** `…`を除いた長さ、期待する切出し内容、先頭/末尾近傍・複数hit・無hitを固定期待値で検証する。期待値を本番と同じ計算式で作らない。

**完了条件:** 全文を返す今回の変異が失敗し、先頭hitでなく後続hitを選ぶ変異も失敗する。全件mutation testingを要求するものではない。

<a id="F03"></a>
## F03 — コピーを名乗るが項目一覧だけを見る

対象: [T289 / shell.spec.ts:166](../../e2e/shell.spec.ts#L166)。確度: assertionと実装を照合。

テストは未保存Pageを開いてメニューを出し、項目が`URL をコピー`のみであることを確認して終了する。クリックもclipboard観測もない。本番の[BrowserView.tsx:347](../../src/browser/BrowserView.tsx#L347)では`navigator.clipboard.writeText(url)`を呼ぶため、このcallbackをnoopにしてもこのテストのassertionは変わらない（この変異自体は未実行）。

**対応・完了条件:** menuitemをクリックし、clipboard境界に正しい未保存URLが渡ることを検証する。成功/失敗を検証する場合はbrowser APIのcontrolled stubで十分で、OSclipboard統合まで同じテストに混ぜる必要はない。現状を残す場合の正しい名前は「未保存PageにはURLコピー項目だけを表示する」。[T197](ledger.md#T197)のtab menuも項目選択なのでコピーの代替保証ではない。

<a id="F04"></a>
## F04 — 使用中メッセージcodeの判定が緩い

対象: [T383 / backend.test.ts:80](../../src/i18n/backend.test.ts#L80)。確度: 判定式を直接確認。

`all.includes('"code"')`でRustソースに引用符付きcodeがあるかを見る。コメントや`#[cfg(test)]`内だけに残った文字列も「本番で使用」と数える。走査対象はcoreとTauri直下の`.rs`で、CLI・再帰サブディレクトリ全体を表すものでもない。現在実際に不要なカタログkeyを見つけたという指摘ではなく、不要key検出器の弱さ。

**対応:** 本番のメッセージ生成箇所から使用code集合を収集する。動的選択のcodeは明示的な一覧で扱う。単純にT382の文字列`msg!`scannerを流用するだけではコメント/テスト除外を解決しないため、Rust構文または生成manifestを使う。

**完了条件:** コメントだけ・テストだけに存在する架空codeをfixtureで「使用中」に数えず、本番の直接/動的codeを数える。[T382](ledger.md#T382)のparam/key対応、[T384](ledger.md#T384)のtranslator試験は別契約なので維持する。

<a id="F05"></a>
## F05 — R2署名の独立oracleが部分的にない

対象: [T133 / r2.rs:664](../../crates/lattice-core/src/r2.rs#L664)。確度: 呼出し経路を照合。

`build`内部で使う`authorization`を期待署名の計算にも使う。同じ署名計算の欠陥には共倒れできる。一方、GET/DELETE、固定canonical path/query、method差分を与えているため、引数接続・URL encodingの検証として価値は残る。

**対応・完了条件:** URLとmethod差分のassertionを維持し、R2のregion=`auto`、継続tokenのescape、DELETEを含む独立した固定vectorを追加する。外部R2へ削除を実行する必要はない。[T128 AWS既知vector](../../crates/lattice-core/src/r2.rs#L568)が署名algorithmを独立に守っているため、これはP3の追加強化であり全面欠如ではない。

<a id="F06"></a>
## F06 — timer試験がschedulerに左右される

対象: [T436 / overlay.test.ts:20](../../src/overlay/overlay.test.ts#L20)。確度: timer/assertionを直接確認。今回の実行では成功し、flakeは観測していない。

10ms intervalでDOMを書き換え、120msで停止し、実時計で140〜600msを要求する。混雑した実行環境では要求を満たす実装でも上限を越え得る。cap=150ms側は「400ms未満」だけで、更新中なのに早く解放するcap分岐の欠陥を区別できない。両方を即時returnにする変異なら前半で落ちるため、「即時returnが全体で通る」とは言わない。

**対応・完了条件:** MutationObserverとtimerの順序を制御できる時計で、更新中/静穏期間未満では未完了、静穏期間後またはcap到達で完了することを確認する。必要なら最小限の時計注入を行う。timerの後始末はfinallyに置く。実時間の上限を単に広げるだけではoracleの欠落を解決しない。

<a id="F07"></a>
## F07 — UI設定送信と永続化を区別する

対象: [T190](../../e2e/chat.spec.ts#L11)、[T203](../../e2e/english.spec.ts#L6)、[T231](../../e2e/i18n.spec.ts#L3)。確度: mockと操作を照合。

T190は設定を変更して別カテゴリへ移動し、戻った値を確認する。T203/T231は言語表示と`set_ui_language`等の送信を確認する。保存先は[e2e/mock.ts](../../e2e/mock.ts)のメモリ状態で、実DB・プロセス再起動を通らない。「persists」「stores the choice」「stored in the backend」を永続ストレージの耐久性と読むと過大な保証になる。

**対応・完了条件:** 「設定コマンドを送る」「同じセッションで再表示する」へ名前を限定する。DBへの保存/再openが要求なら一時Storeを閉じて再openする別結合試験で守る。モックをlocalStorageへ変えるだけでは本番のSQLite保持を試したことにならない。UI経由で設定が送られる保証は残す。T249/T292/T309のfrontend localStorage reloadは実ストレージを使っており、この指摘に含めない。

<a id="F08"></a>
## F08 — 「全設定」が固定17件のまま

対象: [T277 / settings.spec.ts:23](../../e2e/settings.spec.ts#L23)。確度: 本番カテゴリと日英列挙を照合。

[本番SettingsView](../../src/settings/SettingsView.tsx#L56)には19カテゴリがある。日本語テストの`SECTIONS`は17件で、表示言語と更新がない。[T205](../../e2e/english.spec.ts#L36)は19件を列挙している。日本語表示言語は別テストで触るが、「全カテゴリ」というチェックの更新漏れを検出する仕組みはない。

**対応・完了条件:** 期待カテゴリの集合と実navigation集合をまず比較して、全対象を開く。日英の操作ループを共通化する場合も各言語の独立した期待labelを残す。本番のタイトル配列をそのまま期待値にすると翻訳/欠落の共通誤りを見逃す。見出しsmokeは描画例外の検出であり、各設定の保存効果を検証したとは扱わない。

<a id="F09"></a>
## F09 — 空欄でのfeed名解除を検証していない

対象: [T217 / feedname.spec.ts:27](../../e2e/feedname.spec.ts#L27)。確度: 操作列を直接確認。

名前は「元名または空欄ならcustom nameを解除」だが、入力するのは`custom.title`だけ。空欄時に保存ボタンが押せるか、`null`を送るかは見ていない。Rustの[T063](ledger.md#T063)は保存意味論を守るが、UIの空欄変換を代替しない。

**対応・完了条件:** custom nameありの初期状態から、元名に戻す入力と空文字入力をそれぞれ実行し、`rename_feed({ id, name: null })`を確認する。同じ一つのfixtureを共有してもよいが、前ケースで上書き解除済みの状態を次ケースの前提にしない。

<a id="F10"></a>
## F10 — chat別窓のテスト名が実操作とずれる

対象: [T255](../../e2e/popout.spec.ts#L97)、[T256](../../e2e/popout.spec.ts#L105)。確度: 全操作と送信assertionを確認。

T255はdockからpop-outするところまでで、名前にある「docks back」は試さない。復帰はT256が`chatDocked`要求・close・storage削除で検証しているので、両方で復帰を重複追加する必要はない。一方T256の名前にある「citations」はクリックしていない。試すのはscope同期と復帰。[T311](ledger.md#T311)はmain内の対話引用で、chat窓からmainへの配送の代替ではない。

**対応・完了条件:** T255を別窓化、T256をscope同期/復帰と命名する。引用の保証が必要ならchat窓の引用をクリックし、main宛先と記事/ブロックを含む要求をassertする。真の別窓配送はmock範囲外なので[R02](boundaries.md#R02)と分ける。

<a id="F11"></a>
## F11 — URLの別操作・Page題名eventが名前にしかない

対象: [T247](../../e2e/palette.spec.ts#L36)、[T310](../../e2e/tabs.spec.ts#L91)。確度: 操作列と関連unitを照合。

T247はCtrl+Enter保存だけを操作し、名前の「opens as a page」は操作しない。EnterでPageを開く配線はT310にあるため、T247へ重ねるより名前を保存だけに限定する。

T310はhostの仮題と`browser_open/hide/close`を確認するが、名前の「until the page names itself」に相当する題名eventを送らない。[T402](ledger.md#T402)はlayout状態操作のunitで、browser eventから画面表示への接続を直接試すものではない。

**対応・完了条件:** T247を保存の名称にし、T310は対象tabの題名eventを注入して表示を確認するか、保証範囲を仮題とwebview要求までに限定する。後者なら題名event経路が未検証であることを残す。

<a id="F12"></a>
## F12 — DOMの外側クリックとPageのfocus eventを分ける

対象: [T240 / menus.spec.ts:67](../../e2e/menus.spec.ts#L67)。確度: 隣接試験を含め操作を確認。

T240はDOM内で外側をクリックして閉じる。名前の後半「a click in a page webview」はこのテストの操作ではない。次の[T241](../../e2e/menus.spec.ts#L90)がbrowser-focus eventを注入し、メニューのために隠したPage由来のfocusとユーザーfocusを区別している。

**対応・完了条件:** T240をDOM外側クリックへ命名限定する。T241のevent分岐を残す。どちらもnative webviewに実際のクリックを配送した試験ではないことをfixtureの説明に残す。T241のassertionをT240へ重複追加する必要はない。

<a id="F13"></a>
## F13 — 関数の集計とレイヤー間一致を分ける

対象: [T451](../../src/reader/mixed.test.ts#L48)、[T452](../../src/reader/mixed.test.ts#L56)。確度: 呼出し先を確認。

T451は`needsTranslation`を入力4例へ適用する。T452は`translationProgress`一つにfixtureを与える。テスト内でRust job、一覧component、Reader componentを比較していない。名前の「job would translate」「list and Reader count the same」を層間一致の検証と読むと過大になる。

**対応・完了条件:** helperの翻訳対象判定・done/total集計と命名する。異なる故障を持つので両テストは残す。層間一致を守るなら日本語・英語・中国語・混在識別子・code・既訳を含む共通fixtureをTSとRust双方へ適用し、期待対象集合を比較する。[T268](ledger.md#T268)はUI進捗の配線を補うが、backend数値はmockなのでその代替ではない。

<a id="F14"></a>
## F14 — 静的assertionを既存シナリオへ統合できる

対象: [T237](../../e2e/library.spec.ts#L78)、[T305](../../e2e/tabdrag.spec.ts#L287)。確度: 全操作を確認。時間削減量は未測定。

T237はアプリ初期化後に固定文字列`2 失敗`を確認するだけ。T305は同じ初期化後に`window_ready`の呼出しが空であることを確認するだけ。後者は名前の「main window is shown by its configuration」を検証する設定読込もnative表示もない。どちらも小さな接続保証はあるが、そのためだけに独立したpage/contextでアプリを初期化している。

**対応・完了条件:** T237のbadge assertionを[T232/T233のジョブ画面試験](../../e2e/jobs.spec.ts)の適切な初期状態へ、T305のno-ready assertionを[T291のmain shell試験](../../e2e/shell.spec.ts#L211)の開始直後へ移す。元の状態と観測時点を保ち、保証を捨てない。badgeを強めるなら失敗件数の増減とゼロ件非表示を検証する。nativeのvisibilityは必要に応じて別試験にする。

独立したテスト宣言が残ること自体を不具合とはしない。Playwrightはworker内でbrowserを再利用するため、統合で必ずbrowserプロセス起動2回が減るという意味でもない。
