// Human-reviewed assertion summaries for the dated audit; one line per inventory ID.
export const summaries = `
T001 CLIエラーをcode/paramsの構造のままJSONへ出す
T002 MCPのツール定義が各操作の引数スキーマを公開する
T003 MCP結果に注意書きを付け、出力サイズ上限を守る
T004 CLIのscope指定をアプリ共通の検索・一覧フィルタへ変換する
T005 実Storeのコレクション一覧とID付き記事ブロックを返す
T006 MCPの名前・引数をCLIと同じ操作型へ変換する
T007 実CLIプロセスが一時DBの記事・ブロック・検索結果を読む
T008 実CLIでフォルダの所属フィードへ絞り、フォルダ名を出す
T009 資料がない質問ではLLMを使わず回答する
T010 実CLIの書き込みは明示オプトインなしでは拒否する
T011 存在しないDBをエラーにし、誤って新規作成しない
T012 実CLIのstdioでMCP初期化・一覧・呼び出しを処理する
T013 MCP経由の書き込みにも明示オプトインを要求する
T014 Anthropicのリクエスト形状と応答解析を固定例で検証する
T015 Anthropicキー未設定を利用不能として扱う
T016 保持世代の選択で最新と現在のバックアップを残す
T017 ローカルバックアップの名前・対象判定を守る
T018 実ファイルの世代整理が古いバックアップだけを消す
T019 プロバイダ失敗時に次段へ進み、失敗段をクールダウンする
T020 旧モデル・APIキー設定を新しいプロバイダチェーンへ移す
T021 対話の検索対象を指定記事だけに限定する
T022 記事全文の対話入力、引用番号の検証、履歴保存を連携させる
T023 大きな対話scopeでも範囲外の記事を検索資料へ混ぜない
T024 対話予算設定に応じて投入コンテキスト量を変える
T025 資料選択を記事ごとに分散し、余り枠を埋める
T026 対話入力が設定されたコンテキスト上限を超えない
T027 分類をバッチ化し、既存ジャンルと手動選択を保持する
T028 ジャンルの改名・統合・削除をDBへ反映する
T029 分類ジョブ履歴のない記事だけを起動時補完へ回す
T030 分類バッチ失敗時に対象ジョブを取り残さない
T031 Claude CLIの構造化応答を解析する
T032 Claude CLI引数に指定時だけmodel/effortを渡す
T033 Codex execのイベントから応答・失敗を解析する
T034 Codexのeffort省略時の値をlowにする
T035 実Codex execから文字列を得る疎通確認（通常はignore）
T036 オフライン埋め込み器は取得せず、既存モデルキャッシュを認識する
T037 記事・翻訳・対話を出力し、秘密値とHTMLを混入させない
T038 グループ限定exportと記事の全所属グループを保つ
T039 exportしたフィードに所属フォルダを含める
T040 記事内asideを抽出本文から落とさない
T041 HTML記事を種別付きブロックへ分割する
T042 HTMLからfavicon候補リンクを解決する
T043 favicon取得対象を裸のホスト名へ制限する
T044 faviconを重複キュー投入せず、保存・配信・週次再取得する
T045 privateホストのfaviconを拒否し失敗を保存する
T046 feed除外規則優先と各scope内includeのOR条件を守る
T047 著者・カテゴリ・言語・長さのfeed条件を判定する
T048 feed規則の空白等を整え、不正正規表現を拒否する
T049 RSS/Atomからフィルタが読む属性を取り出す
T050 拒否記事と理由を残し、同じエントリを再判定しない
T051 規則通過分だけLLM判定し、LLM失敗時は取り込みを許す
T052 フォルダ名・順序を保存し、削除時もフィードを残す
T053 フォルダ内のユーザー指定フィード順を保存する
T054 フォルダ内フィードの記事だけを一覧・検索する
T055 OPMLの階層をフォルダとしてimport/exportする
T056 RSSとAtomの標準エントリを解析する
T057 ページ内のフィードリンクを発見・解決する
T058 feedエントリ日付で未設定の公開日時だけを補う
T059 feedタイトルを保持し、全文と短い概要を区別する
T060 ページ取得拒否時にfeed本文または描画へフォールバックする
T061 feed本文保存前に失敗した既存記事を一度だけ回復する
T062 feed本文保存と記事失敗が重なった場合も再試行する
T063 フィード名・アイコンの上書きと解除を保存する
T064 同一poll内の重複エントリを一度だけキューへ入れる
T065 未知エントリだけ取り込み、初回取得数を制限する
T066 IPアドレスのpublic/private分類を境界例で守る
T067 private宛てHTTP取得を拒否する
T068 代表的なネットワーク失敗をユーザー向け原因へ分類する
T069 Content-Type等からPDFとページを判別する
T070 宣言・内容から文字コードを選ぶ
T071 Geminiリクエスト形状と応答解析を固定例で検証する
T072 グループ多対多所属を一覧・検索の絞り込みへ反映する
T073 グループ名のtrimと大文字小文字無視の一意性を守る
T074 グループ削除で記事を、記事削除でグループを巻き込まない
T075 画像の形式・サイズ制約を守る
T076 画像取得で危険なscheme/privateホストを拒否する
T077 画像を重複保存せず、参照・配信・不要データ回収する
T078 画像補完は試行済みURLを避け、設定オフを尊重する
T079 貼り付け形式の異なる入力からURLを抽出する
T080 記事投入の件数と再投入の冪等性を守る
T081 抽出ブロックを保存し、同じ内容を重複登録しない
T082 同一ホストへの取得を同時実行しない
T083 描画結果で薄い抽出を更新し、再抽出で同一ブロックIDを保つ
T084 保存済み記事の再保存で記事自体が別記事へ吸収されない
T085 PDFのURLを元URLの記事として取り込む
T086 抽出失敗を保存し、再試行可能にする
T087 追加指示をtrimして保存し、文字数上限を守る
T088 非信頼入力の扱いを末尾に残し、指示変更で版を変える
T089 ジョブ失敗一覧と分類バッチの再試行を扱う
T090 実行中ジョブのキャンセル・再試行を拒否する
T091 翻訳対象本文だけを訳し、再実行で重複処理しない
T092 保存だけでは翻訳せず、明示要求でも対象言語済み本文を除く
T093 再翻訳要求で既存キャッシュを捨てて訳し直す
T094 日本語記事を英語へ翻訳するジョブ経路を守る
T095 ジョブ失敗時のbackoffと手動再試行からの再開を守る
T096 要約保存と本文変更によるstale化を守る
T097 要約に追加指示を適用し、指示変更でstale化する
T098 記事に紐づかないfaviconジョブを実行する
T099 指定記事実行で他記事のジョブを動かさない
T100 前回実行中のまま残ったジョブを回復する
T101 strict JSON schemaのobjectを閉じる
T102 portableマーカーを他の保存先設定より優先する
T103 マーカーもbootstrapもなければ既定保存先を選ぶ
T104 有効なbootstrap指定を保存先として使う
T105 不正bootstrapでは警告付きで既定保存先へ戻す
T106 bootstrapを往復保存し、既定保存先に戻すと削除する
T107 選択フォルダにDBがなければ既定保存先へ戻す
T108 bootstrapを書き込めない場合はエラーにする
T109 アプリ識別子から既定保存フォルダ名を決める
T110 Markdownを種別付き記事ブロックへ変換する
T111 日本語改行を結合し、inline script本文を落とす
T112 Markdownタイトルをファイル名・先頭行へフォールバックする
T113 同じMarkdown本文は一度だけ登録し、その場で再抽出する
T114 相対画像読み込みを選択したフォルダ内へ制限する
T115 メッセージcode/paramsをJSON形式で表す
T116 OpenAIリクエスト形状と応答解析を固定例で検証する
T117 人工PDFの二段組本文を読む順へ組み立てる
T118 PDFタイトルをmetadata・ファイル名へフォールバックする
T119 PDF形式・節番号・参考文献番号・caption・日付の補助判定を守る
T120 同じPDFを重複登録せず、再抽出を既存記事へ反映する
T121 quiz応答の有効な設問だけを残し、引用元へ対応付ける
T122 quiz生成ジョブの保存と本文・プロフィール変更によるstale化を守る
T123 有効な設問がない生成応答をジョブ失敗にする
T124 quiz回答済み状態を復習へ引き継ぎ、未回答を新規カードにする
T125 復習の一日上限とdue日時を守る
T126 復習設定の入力範囲を検証する
T127 記事削除に伴いquiz・カード・履歴を消す
T128 AWS既知の署名値とSigV4計算結果を比較する
T129 R2のpath-style PUTリクエストを組み立てる
T130 UTC日付・バックアップキーを生成する
T131 R2設定の秘密値を隠し、スケジュールへ反映する
T132 R2保持世代設定と秘密値クリアを保存する
T133 R2 list/deleteのURLと署名への引数の接続を守る
T134 R2一覧XMLのページ・継続トークンを解析する
T135 当該端末の古い世代だけを削除候補にする
T136 重要度応答の理由とscore範囲を検証する
T137 重要度を一括評価し、プロフィール変更時にstale化する
T138 自動重要度評価と閾値設定を適用する
T139 薄い抽出で描画を一度だけ投入し、描画が再描画を連鎖させない
T140 十分な本文・描画無効設定では描画ジョブを投入しない
T141 描画失敗や短い結果で既存記事を失わない
T142 RRFで複数検索が一致した結果を優先する
T143 実Storeの全文検索・埋め込み検索と失敗時fallbackを組み合わせる
T144 翻訳用plain textと記事ブロック本文を一致させる
T145 用語モードが指示だけを変え、対象言語を変えない
T146 日本語原文の英訳指示・判定を守る
T147 ユーザー指示を翻訳promptとキャッシュキーへ反映する
T148 長い翻訳単位の分割上限を守る
T149 翻訳結果の重複・不正IDを受け入れない
T150 翻訳バッチの再試行と再分割を守る
T151 出典を翻訳snippet単位で保持する
T152 Good継続時のSM2間隔増加と最大値を守る
T153 忘却時にeaseを下げ、最小間隔から再学習する
T154 Hard/Easyによるease変化を上下限内へ抑える
T155 短い最小間隔を学習ステップとして使う
T156 短い間隔でもHard・Good・Easyのpreview順を守る
T157 snapshot追加migrationで既存行を保持する
T158 前リリースschemaのDBを現行へ上げる
T159 quiz追加migrationで既存ライブラリを維持する
T160 vocab追加migrationで既存ライブラリを維持する
T161 clozeを廃止してもmeaningカード履歴を保持する
T162 group追加migrationで既存ライブラリを維持する
T163 relevance追加migrationで既存ライブラリを維持する
T164 feed-folder追加migrationで既存ライブラリを維持する
T165 feed-order追加migrationで従来の名前順を引き継ぐ
T166 feed-filter追加migrationで既存ライブラリを維持する
T167 Mediumの旧feed URLを再正規化する
T168 翻訳migration後も既存行を検索可能にする
T169 再抽出で内容不変のブロックIDを再利用する
T170 記事削除時に関連レコードを孤児として残さない
T171 失敗ジョブ再投入で試行回数をリセットする
T172 連続失敗の待機を倍増し、上限到達で失敗を確定する
T173 同一ホスト待機をfetchジョブだけに適用する
T174 inbox条件とタグで記事を絞る
T175 genre/feed条件を一覧・検索へ適用する
T176 保存日時・公開日時で記事をソートする
T177 設定を保存し、DBバックアップへ反映する
T178 要約応答を整形し、入力コンテキストの長さを制限する
T179 URLから追跡queryとfragmentを除く
T180 単語captureを短い英語・文内の選択範囲へ制限する
T181 語義生成応答から番号に対応する有効な語義を残す
T182 語義には定義と新しい例文を必須とする
T183 同じlemmaの語形を一つの単語項目へ統合する
T184 語義ジョブ実行中の追加captureを完了後に再投入する
T185 単語の編集・停止・削除をDBへ反映する
T186 単語を共通上限内の一枚の復習カードとして扱う
T187 語義再生成でカードを維持して語義だけを更新する
T188 出典記事への紐づけと記事削除後の文脈保持を守る
T189 Anki向けCSVのescapeとカード裏面相当の内容を守る
T190 対話予算の設定送信と同じセッション内での再表示を守る
T191 対話入力のVim有効化・モード・編集・undo・送信操作を守る
T192 開いている記事とタブ変更を対話scope候補へ反映する
T193 api.tsの文字列invoke名とモックhandler名の集合を一致させる
T194 行メニューのお気に入り・既読・新規タブ・削除確認を操作する
T195 メニューキー/Shift+F10でカーソル行を開き、Escで戻す
T196 複数選択のメニュー操作を全対象へ送る
T197 記事タブと未保存ページタブで適用可能なメニュー項目を分ける
T198 クリック可能要素のcursorと場所別text-selection CSSを守る
T199 無効ボタンのcursorとtooltipを保持する
T200 j/kで開かずに行移動し、EnterでReaderへ開く
T201 Shift+Enterでカーソル記事をPageへ開く
T202 記事削除の確認・Esc取消・確定をUIから行う
T203 英語localeで起動し、英語UIと設定コマンド送信を確認する
T204 Reader・ジョブ・feed・復習画面の主要英語表示を守る
T205 設定19カテゴリの英語見出しとcoded errorの英語表示を守る
T206 パレットの英語コマンド検索を守る
T207 単語帳の主要英語表示を守る
T208 feed拒否理由を表示し、手動取込・規則削除から許可する
T209 feed別規則を編集し、不正正規表現エラーを表示する
T210 設定画面からglobal feedフィルタを編集する
T211 feedをフォルダへ移し、scopeと未読合計をUIへ反映する
T212 複数行URLを選択フォルダへ購読する
T213 navのフォルダを改名・削除し、フィードを残すUIを守る
T214 OPML取込後のフォルダ表示とパレット検索を守る
T215 feed検索失敗をfield下へ出し、入力変更で消す
T216 feed元名を編集欄へ入れ、未変更を保存不可にする
T217 カスタム名からfeed元名へ戻すとname:nullを送る
T218 feedドラッグで順序・所属を変え、記事を誤って開かない
T219 Alt上下とフォルダドラッグでfeed・フォルダ順を変える
T220 sidebarグループの作成・scope・改名・削除を操作する
T221 Readerのグループ所属を選択・新規作成・解除する
T222 空scopeで不要なfilter/sort/select操作を出さない
T223 行選択とShift範囲選択を一括グループ追加へつなぐ
T224 グループをfacet・検索scope・対話scopeとして使う
T225 取り込み先グループを選択し、表示中グループを初期選択する
T226 パレットでグループを開き、記事・URLを所属へ追加する
T227 グループ限定JSON exportのコマンド引数を送る
T228 サイドボタン・Alt矢印・titlebarで画面/scope履歴を辿る
T229 設定カテゴリごとの移動履歴を守る
T230 記事遷移・タブ切替を戻る/進む履歴へ反映する
T231 表示言語を即時切替し、backend設定コマンドを送る
T232 ジョブ種別の表示名とhover時IDを守る
T233 ジョブ説明をhover/keyboard focusで出し、iconを説明付けする
T234 sidebar件数とscope選択後の一覧を合わせる
T235 facet次元間AND・候補件数・解除をUIで守る
T236 該当なしから条件一つを解除して結果を回復する
T237 fixtureの失敗ジョブ件数2をnavに表示する
T238 webview非表示完了までメニューを不可視にし、その後表示する
T239 webviewがなければメニューを初回frameから表示する
T240 DOM内の外側クリックでgroup pickerとメニューを閉じる
T241 browser-focusイベントの由来に応じてpopoverを閉じる/保つ
T242 Escでpopoverだけを閉じ、filterは残す
T243 navグループメニューをtriggerの横へ配置する
T244 library離脱でPageを隠し、復帰後に古いhideを送らない
T245 Ctrl+K開閉とコマンド専用パレットを守る
T246 Tabでタグfacetを積み、パレットを開いたままにする
T247 貼り付けURLをCtrl+EnterでIndexへ保存する
T248 保存済みURLのパレット候補ではReaderを優先する
T249 ペイン幅のドラッグ結果をlocalStorage経由でreload後も保つ
T250 keyboardリサイズの上下限とダブルクリック初期化を守る
T251 PDF取込コマンドの結果をReaderへ開き、Page/描画を出さない
T252 タブ別窓化でlayoutを保存し、新しいdocument windowを要求する
T253 document windowの限定layoutとmainへの返却・空窓closeを守る
T254 main起動で保存済み別窓を復元し、返却記事を開く
T255 対話ヘッダから別窓要求を送り、dockを閉じて状態保存する
T256 chat専用画面のscope同期とdock復帰要求・closeを守る
T257 chat窓closeだけではdockを開かず、後の対話操作で開く
T258 mainだけがPage言語を送信し、別窓はmainの値を受け取る
T259 別窓で選んだPage言語もmain経由で配信する
T260 quiz回答・解説/出典・復習への追加をUIでつなぐ
T261 画面・タブ変更をまたいでquiz進捗を保持する
T262 quiz未生成状態から生成コマンドと即時モック結果を表示する
T263 dueカードの採点・次間隔表示・完了集計をUIで進める
T264 復習カード出典をReaderの対象箇所へ開く
T265 復習の最小間隔を単位付きで設定する
T266 Reader全体とブロック単位の原文/訳文切替を守る
T267 要約の展開とMarkdown記事のPage非表示を守る
T268 未翻訳記事の訳文選択から翻訳要求と進捗表示へつなぐ
T269 自動翻訳設定オフでは表示切替だけで翻訳要求を送らない
T270 翻訳済み記事の再翻訳メニューと説明を表示する
T271 重要scopeの記事と重要度理由のmarkを表示する
T272 重要度sort/filterとReaderの理由表示を守る
T273 プロフィール未設定の案内と設定後の再評価要求を守る
T274 検索結果を記事別に束ね、方式filterとEsc退出を守る
T275 検索hitを矢印で選び、Enterで対象ブロックへ開く
T276 検索scopeに一覧scopeとグループを出し、タグを出さない
T277 固定17設定カテゴリの見出し・保存先・段数とEsc復帰を守る
T278 狭幅でもプロバイダselectの最小幅を保つ
T279 初回メニューframeで旧フォント名のcheckがtrueかを見る
T280 Page静止画の先行取得をメニュー表示時に再利用する
T281 検索/コマンドboxをtitlebarに一つだけ配置する
T282 chat専用窓にはコマンドセンターを出さない
T283 nav上部のcloseボタンとパレットへの操作集約を守る
T284 閉じた一覧の再展開ボタンとj/k移動を守る
T285 タブ＋で検索エンジンの開始ページを新規タブへ開く
T286 保存記事のPage上に要約stripを出し、生成操作を送る
T287 未保存Pageには要約stripを出さない
T288 Reader/Pageの共通action順と差分、quiz隣接配置を守る
T289 未保存Pageメニューの項目がURLコピーだけであることを見る
T290 document窓上段stripのdrag領域と右上window controlsを守る
T291 mainは独立titlebarを持ち、stripを窓drag領域にしない
T292 記録shortcutの実行・reload後保持・削除を守る
T293 shortcut衝突の警告とEsc記録取消を守る
T294 tab drag開始のbackend引数と終了eventによるUI終了を守る
T295 自窓/他窓由来のtab dragでmarkerと仮タブを描き分ける
T296 drag中に各窓のstripを報告し、タブ変更時にも更新する
T297 tear-off指示で元タブを除き、backendへ別窓作成を委ねる
T298 drop通知を受けて自窓内移動または他窓への送信を行う
T299 分割pane間のstrip dropと空stripのmarkerを守る
T300 各pane本文領域を報告し、drag中のdrop zoneを表示する
T301 中央dropで既存paneへ、端dropで新paneへtabを移す
T302 document別窓でも分割pane間のtab移動を行う
T303 他窓からのopen要求で指定slotへtabを入れる
T304 単一tab窓のdrag・tear-off後返却・空窓closeを連携する
T305 main起動時にwindow_readyを呼ばない
T306 Ctrl-click新規tab・Ctrl+Tab循環・Ctrl+W closeを守る
T307 tabドラッグ並べ替えとmiddle-click closeを守る
T308 右分割した空paneへ次の記事を開き、closeで統合する
T309 tab付きlayoutをlocalStorage経由でreload後も復元する
T310 Pageのhost仮題とbrowser_open/hide/closeの要求を守る
T311 対話引用・パレット記事のCtrl/middle-clickで新規tabを開く
T312 タグ検索・AND/any切替・Backspace解除を守る
T313 タグpopoverの矢印・Space・Ctrl+Enter操作を守る
T314 facet選択でchipが置換されてもclose時にfocusを戻す
T315 Reader選択語と文脈を登録し、保存語markを表示する
T316 単語帳検索・語義編集・停止・export・削除をUIで操作する
T317 単語復習の表裏・採点とモック音声への読み上げ要求を守る
T318 offline英語音声なしでは自動読み上げと音声ボタンを出さない
T319 自動再生offでも明示ボタンによる読み上げを許す
T320 単語カードの出典を元の記事箇所へ開く
T321 同梱npm依存にlicense本文を揃え、開発用依存を除く
T322 同じlicense本文を一つにまとめる
T323 repoのversion定義が一致することを守る
T324 Tauri設定がCargoのversionを参照することを守る
T325 version更新を対象定義へ反映し、依存指定を維持する
T326 versionの不一致と不正入力を報告する
T327 badge件数表記を99+で打ち止めにする
T328 badge画像のaccent円と白い数字のpixelを検証する
T329 browserラベルをtab識別子として厳密に検証する
T330 snapshot nonceをラベル別・一回限りにする
T331 Page用key設定のシリアライズ形状をoverlayに合わせる
T332 browser event payloadへtab識別子を付ける
T333 画面上での単語captureと連続要求制限を守る
T334 非表示webviewのうち長く隠れたものから上限超過分を退避する
T335 CLIとTauriのアプリ識別子由来保存先を合わせる
T336 現保存フォルダ自身/内部への移動先指定を拒否する
T337 DB・関連フォルダをコピーし、元データを残す
T338 document/chatだけをpop-outラベルとして扱う
T339 保存window位置のmonitorが消えたら位置を破棄する
T340 pointer左側のtab中心数から挿入slotを決める
T341 windowのscaleとsource優先順で対象stripを探す
T342 detach閾値を超えるまで元strip内dragとして扱う
T343 tear-off窓追従・strip上で非表示・離脱時再表示の状態遷移を守る
T344 本文drop位置を中央と端四分の一へ分ける
T345 分割窓内ではpane間移動し、窓外で初めてtear-offする
T346 同窓の別pane strip上で離すとそのpaneへ移す
T347 strip上dropをtab保持windowに処理させる
T348 Escapeでdrag開始前の位置へ戻す
T349 tear-off窓load前のreleaseは窓準備を待つ
T350 単一tab窓そのものを追従させ、Escapeで元位置へ戻す
T351 drag座標等を通常の数値としてUI payloadへ出す
T352 未設定・空白・placeholderの更新鍵ではupdaterを有効化しない
T353 同じ場所への連続visitを履歴へ重複追加しない
T354 戻る/進むの端停止と途中からの新visitで先の履歴を捨てる
T355 履歴数上限で古いentryを落とす
T356 遷移到着先で現entryを更新し、進む履歴を切らない
T357 Page内部遷移と明示document navigationを区別する
T358 window labelから用途を解釈し、未知labelはmain扱いにする
T359 storageのpop-outキー一覧と最小空きdocument番号を求める
T360 mainだけのoverlay設定送信と別窓Page言語継承を判定する
T361 入力をURL・host補完・検索文字列へ分ける
T362 navigation先をhttp(s)に限定する
T363 組み込み/独自engineの検索URLとhomeを生成する
T364 検証済み引用番号だけを対話chipに変換する
T365 保存済みの開いた記事だけをtab順・重複なしで抽出する
T366 Vimの行内・縦・単語移動の境界を守る
T367 Vimの行頭末尾・文書先頭末尾移動を守る
T368 Vim挿入開始位置・改行挿入・Esc時位置を守る
T369 Vim削除・変更・yank/pasteを守る
T370 Vimのundo単位と空挿入を履歴へ積まないことを守る
T371 normal時の文字key抑止とページへ委ねるkeyを分ける
T372 feed拒否理由の各種を日英の文章へ整形する
T373 同一規則が複数ある場合は最初の一つだけ除去する
T374 フォルダ別feedと未読合計、未所属feedを組み立てる
T375 フォルダ順を隣と交換し、端を越えない
T376 複数行feed URLから空行・重複を除く
T377 フォルダ順内feedを先に、未所属を後ろに並べる
T378 Alt移動で隣folder境界を越えてfeedを一つ動かす
T379 feed上dropはそのslot、folder上dropは末尾へ配置する
T380 folder dropでfolderと所属feedをまとめて並べ替える
T381 backend応答前のfeed移動を楽観的な一覧へ反映する
T382 Rustの文字列msg!呼び出しに日訳keyと同じparamがあるか調べる
T383 be.* keyのcode文字列がRustソース内に存在するか調べる
T384 coded errorと入れ子codeを訳し、未知/旧/plain errorを保持する
T385 日英カタログのkeyとparam集合を一致させる
T386 markup隣接文字列の先頭末尾spaceを翻訳で失わない
T387 英語カタログに日本語文字が残っていないか調べる
T388 param埋込・locale数値整形・英語複数形を守る
T389 UIの日本語literalをカタログ外へ増やさない
T390 単一paneのstripをtitlebar全幅として扱う
T391 横分割paneの上段strip群と右端controls位置を求める
T392 縦/入れ子分割で最上段に接するstripだけを選ぶ
T393 空paneを埋め、通常openは置換、新tabはactiveの右へ置く
T394 Page同一tab更新でwebview IDを維持し、同一URLは無変更にする
T395 tab close後の隣active化と最後のpaneの扱いを守る
T396 split/mergeのfocusと同方向splitのtree平坦化を守る
T397 分割pane最後のtab closeでpaneを統合しfocusを移す
T398 同pane並べ替え・別pane移動・空pane削除を守る
T399 中央dropで末尾追加、端dropで指定側splitを行う
T400 tab循環と未知pane focusの無視を守る
T401 resize時に隣と比率を分け合い、両者の最小幅を守る
T402 同一URLの題名保持・別URLの題名resetとReaderへのevent無視を守る
T403 記事削除でその記事の全tabを閉じる
T404 layout保存/復元で実行時状態を捨て、不正shapeを拒否する
T405 置換・pane/窓間移動でもPageのwebview keyを維持する
T406 幾何学的隣pane選択・端停止・循環を守る
T407 角だけ接するpaneと進行方向外のpaneを除外する
T408 nav移動でdisabledを飛ばし両端で止まる
T409 keyを正規化し、印字文字に含まれるShiftを重ねない
T410 shortcutの表示ラベルを整形する
T411 既定/複数key/上書きからactionを解決する
T412 key衝突を検出し、registry順の先頭を採用する
T413 入力欄内でも送るCtrl keyとPageに残すnamed keyを分ける
T414 shortcutを既定へ戻すとoverrideを消し、個別/全体resetする
T415 連続runの開始offsetを累積長から求める
T416 相対日時を最大の整数単位で表示し、不正値をダッシュにする
T417 http(s)でない貼り付け行を理由別に数える
T418 単一記事と複数選択で適用可能なaction集合を選ぶ
T419 全件が既に設定済みの場合だけfavorite/readを一括解除する
T420 importファイル/別窓では不適切なPage/copy/new-window actionを除く
T421 genre別一覧を名前順にし、未分類を最後・群内順を維持する
T422 feed別一覧を手動追加→feed→genreの順でグループ化する
T423 feed群をユーザー順にし、未知feedを最後へ置く
T424 recentの7日境界と未分類/手動追加scopeを判定する
T425 グループscopeとfacetのOR/AND・名前表示を守る
T426 重要閾値・未判定facetとbackend filter変換を守る
T427 facet次元間AND・次元内OR・タグmodeを適用する
T428 facet件数計算から自分の次元を外し、タグallだけ例外にする
T429 現条件から一つずつ緩和する候補を組み立てる
T430 scope/facetの表示labelとbackend filterを組み立てる
T431 表示中に既読にした記事はそのview内だけ保持する
T432 フォルダscopeを所属feedの記事とフォルダ名へ解決する
T433 空genre除外・特殊候補常設・filter key往復を守る
T434 フィードと並べてフォルダscopeを候補に出す
T435 clickの選択toggleと両方向Shift範囲追加を守る
T436 DOM更新の静穏待機とcapを実時間の幅で確認する
T437 Page言語属性/本文判定から翻訳先と翻訳要否を選ぶ
T438 空行と文末の改行だけで翻訳単位を分ける
T439 翻訳表示割合を個数どおり決定的に割り当てる
T440 script・event属性・危険URLをsanitizeする
T441 scheme難読化でも危険URLを落とし、許可URLを残す
T442 snippet属性を削ぎ、linkとatom番号を保持する
T443 実DOMの文をwrap/原文復元/訳文表示して既存要素を失わない
T444 Page内のkeyを入力状況に応じてアプリへ転送するか選ぶ
T445 復習間隔を分・時・日・月・年へ丸めて表示する
T446 選択問題の正誤から採点候補を選び、想起問題では強制しない
T447 原文/訳文モードで翻訳を表示するblockを選ぶ
T448 混在割合の正確な個数・分散配置と未翻訳除外を守る
T449 backtickをコード部分と通常文字列へ分割する
T450 表示mode・翻訳済み状態・job状態から自動翻訳要否を決める
T451 needsTranslationの言語・翻訳済み・code除外条件を守る
T452 translationProgressのdone/total集計とcodeのみのゼロ件を守る
T453 翻訳不要理由を本文なし/対象言語済み等から選ぶ
T454 正規表現記号を含む検索語を大小文字無視で安全に強調する
T455 検索語を含む抜粋の省略記号・短文保持・非hit先頭を確認する
T456 検索方式・記事scopeでhitを絞り、順位順に記事別へ束ねる
T457 offline en-USを優先し、他の英語は許すがcloud音声は使わない
T458 単語選択を短い単一行の英語へ制限する
T459 quoteや改行をまたぐ選択語の所属文を取り出す
T460 同語が複数回ある文から選択位置に対応する出現を取る
T461 語形を大小文字無視・単語境界付きで検索する
T462 保存語形を最長優先でmarkし、意味を付ける
T463 全語形検索と登録順/due順の単語一覧を作る
`
  .trim()
  .split("\n")
  .map((line) => [line.slice(0, 4), line.slice(5)]);

export const findings = [
  {
    id: "F01",
    priority: "P1",
    tests: ["T279"],
    decision: "補強",
    title: "旧フォント名の検証が、実フォント未読込でも成功する",
    action: "現在のfont-familyとロード状態を対象にし、フォント取得失敗・遅延の負例を追加する",
    evidence: "再現済み",
  },
  {
    id: "F02",
    priority: "P1",
    tests: ["T455"],
    decision: "補強",
    title: "抜粋を一切切り詰めなくてもテストが通る",
    action: "長さ・先頭hitの位置・切出し境界を独立した期待値でassertする",
    evidence: "変異実装で再現済み",
  },
  {
    id: "F03",
    priority: "P2",
    tests: ["T289"],
    decision: "補強",
    title: "URLコピーと名付けたテストがコピー操作を実行しない",
    action: "項目をクリックし、clipboardへ渡ったURLを確認する",
    evidence: "assertionと実装の照合",
  },
  {
    id: "F04",
    priority: "P2",
    tests: ["T383"],
    decision: "補強",
    title: "backendで使用中の判定がソース内の文字列存在だけ",
    action: "メッセージ生成箇所を収集し、コメント・テストだけに残るcodeを使用中に数えない",
    evidence: "判定式の直接確認",
  },
  {
    id: "F05",
    priority: "P3",
    tests: ["T133"],
    decision: "補強",
    title: "R2署名の期待値が同じ署名関数から作られる",
    action: "URL/引数接続の検証を残し、R2固有canonical requestの独立ベクトルを加える",
    evidence: "呼び出し経路の照合",
  },
  {
    id: "F06",
    priority: "P2",
    tests: ["T436"],
    decision: "補強",
    title: "DOM待機テストが実時間に依存し、cap分岐の早期終了を検出しない",
    action: "制御可能なtimerで静穏期間前/後とcap直前/直後を検証し、後始末をfinallyに置く",
    evidence: "timer/assertionの直接確認",
  },
  {
    id: "F07",
    priority: "P3",
    tests: ["T190", "T203", "T231"],
    decision: "範囲・名称修正",
    title: "設定の永続化という名称がセッション内モックの保証を越える",
    action: "UI設定送信・同一セッション再表示と命名し、DB再openの永続化は別の結合試験にする",
    evidence: "モックとassertionの照合",
  },
  {
    id: "F08",
    priority: "P3",
    tests: ["T277"],
    decision: "補強",
    title: "全設定カテゴリという列挙から2カテゴリが漏れる",
    action: "表示言語・更新を含むカテゴリ集合そのものと一致させる。日英固有assertionは残す",
    evidence: "17件と19件の列挙・本番カテゴリを照合",
  },
  {
    id: "F09",
    priority: "P2",
    tests: ["T217"],
    decision: "補強",
    title: "feed名の空欄による上書き解除を試していない",
    action: "元名に戻すケースと空欄ケースを別入力で実行し、いずれもname:nullをassertする",
    evidence: "操作列の直接確認",
  },
  {
    id: "F10",
    priority: "P3",
    tests: ["T255", "T256"],
    decision: "範囲・名称修正",
    title: "chat別窓テスト名の復帰・引用が各テストの実操作と合わない",
    action: "T255を別窓化、T256をscope同期/復帰へ改名し、chat窓の引用送信は実クリックで補う",
    evidence: "操作列と送信assertionの直接確認",
  },
  {
    id: "F11",
    priority: "P3",
    tests: ["T247", "T310"],
    decision: "範囲・名称修正",
    title: "URL開き方・Page題名更新の一部が名前だけに現れる",
    action: "T247は保存操作に命名を限定し、T310は題名eventを注入して表示更新まで検証する",
    evidence: "操作列とlayout単体試験の照合",
  },
  {
    id: "F12",
    priority: "P3",
    tests: ["T240"],
    decision: "範囲・名称修正",
    title: "DOM外クリック試験がnative Pageクリックまで保証した名前になる",
    action: "DOM内の外側クリックへ命名を限定し、Page eventはT241に委ねる",
    evidence: "隣接テストとevent境界の照合",
  },
  {
    id: "F13",
    priority: "P3",
    tests: ["T451", "T452"],
    decision: "範囲・名称修正",
    title: "翻訳集計関数の試験をRust job・一覧との一致検証と読めてしまう",
    action: "helperの判定/集計と命名し、TS/Rust共通の言語fixtureによる照合を別途設ける",
    evidence: "import・呼び出し先の照合",
  },
  {
    id: "F14",
    priority: "P3",
    tests: ["T237", "T305"],
    decision: "統合候補",
    title: "単一の静的assertionのために独立した画面初期化を使う",
    action: "T237をジョブ画面試験へ、T305をmain shell試験へ統合する。元のassertionは残す",
    evidence: "各試験の全操作と近接試験を照合",
  },
];
