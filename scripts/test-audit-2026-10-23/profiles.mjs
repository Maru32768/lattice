// Reviewed production seams and reasons for retaining related coverage; data for the dated audit.
export const profiles = {};
const profile = (file, targets, boundary, overlap) => {
  profiles[file] = { targets: targets.split(" "), boundary, overlap };
};
const core = (name, boundary, overlap) => profile(`crates/lattice-core/src/${name}.rs`, `crates/lattice-core/src/${name}.rs`, boundary, overlap);
core(
  "anthropic",
  "実providerのrequest構築/response解析。外部HTTPと実認証は呼ばない。",
  "Gemini/OpenAIは別wire protocolなので重複ではない。chainはfallbackの責務。各assertionを維持。",
);
core(
  "backup",
  "実世代選択と一時フォルダ内のファイル操作。常駐schedulerの起動は含まない。",
  "storeのDB snapshotとR2の遠隔世代管理は異なる境界。名前判定と実削除は相補。",
);
core("chain", "実chainに失敗/成功providerを差し込む。実サービス・CLIは呼ばない。", "各providerのwire試験とは異なるfallback/設定migrationを保護。");
core(
  "chat",
  "実Storeと対話/資料選択コード。LLM/embeddingを制御したfixtureに置換。",
  "src/chatは表示用引用・scope、e2e/chatは入力UI。ここは資料制約とDB履歴なので維持。",
);
core("classify", "実SQLiteと分類job。LLM応答はfixture。", "jobsの一般再試行とは別のbatch全件終了、手動genre保持がある。migrationとは実行時の責務が違う。");
core("claude", "実CLI adapterの応答解析・引数構築。Claudeプロセス起動は含まない。", "Codexのevent形式とは別。引数省略と応答解析は異なる故障条件。");
core(
  "codex",
  "通常2件はevent解析とeffort既定値。live_codex_execだけ実CLI疎通だがignore。",
  "Claudeとはprotocolが異なる。無効化された疎通試験を成功数へ入れない。",
);
core("embed", "実offline load/cache存在判定。モデル推論精度やdownload成功は対象外。", "searchの検索融合とは異なる、意図しないネットワーク取得防止。");
core(
  "export",
  "実Storeからexport値を生成。GUIファイル選択と外部viewerは対象外。",
  "e2e/groupsのexport要求と補完。秘密値除外・所属・folderの出力内容はここでしか直接守らない。",
);
core("extract", "HTML fixtureを実extractorへ通す。ライブサイト/取得は含まない。", "ingestは抽出後のDB連携、markdown/pdfは異形式。aside境界と記事分割は相補。");
core(
  "favicons",
  "実URL検証・queue/store/cache処理。公開サイトの実favicon取得は保証しない。",
  "fetch/imagesとprivate拒否が重なるが入口が別。重複投入・週次更新も固有。",
);
core("feed_filter", "実規則評価・parser・Store/poll。LLMは制御応答。", "src/feedFilterは理由表示と編集、e2eは操作。規則優先・失敗時許可はbackend固有で維持。");
core("feed_folders", "実SQLiteで所属・順序・scope・OPML変換を実行。", "TSは楽観表示、e2eは操作接続。mockがTS helperを共有するため、この独立Rust側を残す。");
core(
  "feeds",
  "RSS/Atom fixtureと実Storeによる取り込み。ネットワーク境界は制御される。",
  "feed_filterは採否、feed_foldersは所属。回復の各race条件は異なるため似た名前でも維持。",
);
core(
  "fetch",
  "IP/URL/エラー/charsetの実判定とprivate宛先拒否。公開HTTP成功・全redirect連鎖の実地試験ではない。",
  "画像/faviconでもSSRF境界がある。別の呼び出し口を保護するので機械的に統合しない。",
);
core("gemini", "実providerのrequest構築/response解析。実HTTP/認証は対象外。", "Anthropic/OpenAIとwire protocolが異なるため維持。");
core("groups", "実SQLiteで多対多所属・一覧/検索・削除連鎖を確認。", "store migrationは既存DB更新、UI testsは操作。名前正規化・連鎖削除も別契約。");
core("images", "実検証・保存/配信/GC・補完処理をfixtureと一時storeで実行。", "fetchの防御と入口が異なり、GC/参照数は画像固有。Markdown相対pathも別境界。");
core(
  "ingest",
  "実抽出・Store・job処理をfixture取得器で接続。OSファイルdialog/実ページ描画は含まない。",
  "extract/pdf/markdownの形式処理をDB保存へ接続する層。再保存・dedup・再抽出の故障は異なる。",
);
core(
  "instructions",
  "実設定保存・prompt結合・version算出。LLMによる指示遵守までは保証しない。",
  "jobs/segmentsは指示の利用先。上限・非信頼入力の配置はここで独立して維持。",
);
core("job_status", "実SQLiteの状態一覧とretry/cancel操作。UI表示は対象外。", "jobsは実行、storeはqueue遷移、e2e/jobsは表示・説明。各境界を残す。");
core(
  "jobs",
  "実Store/job runnerと制御LLM・取得器。Tauri常駐loopや実外部サービスは含まない。",
  "storeのqueue primitiveと重なるが、翻訳/要約/cacheの業務連携を追加で守る。各失敗状態は別。",
);
core("llm", "JSON schemaの実変換。各APIがそのschemaを受け入れるかは対象外。", "providerのwire試験と補完。小さい試験でもobject閉鎖の契約は独立。");
core(
  "location",
  "一時ディレクトリで保存先選択・bootstrap読書きを実行。OS全体の権限設定は再現しない。",
  "Tauri locationはcopyと移動先制約、CLIは実起動。優先順位の各branchを残す。",
);
core(
  "markdown",
  "実Markdown parserと一時ファイル/Store。OS選択dialogは通らない。",
  "HTML/PDFとは別形式、ingestとは別の相対画像境界。idempotencyを別形式でも保護。",
);
core("msg", "実msg macroのJSON形状。frontendの翻訳表示は別。", "i18n/backendの静的照合と相補。小ささだけで低価値としない。");
core("openai", "実providerのrequest構築/response解析。実HTTP/認証は対象外。", "Gemini/Anthropicとはwire protocolが異なるため維持。");
core(
  "pdf",
  "生成/固定PDF bytesを実parser・Storeへ通す。多様な実論文corpus、OSdialogは含まない。",
  "e2e/pdfはprepared articleだけなので代替不能。helpersは形式判定等の独立branch。",
);
core("quiz", "実quiz解析・SQLite・due管理。LLM応答と時刻を制御。", "srsは間隔計算、e2eは回答UI。カード登録・日次上限・cascadeはDB固有。");
core(
  "r2",
  "実SigV4/URL/XML/設定/世代選択。R2実サーバーへのPUT/GET/DELETEはしない。",
  "AWS既知vector T128は残す。T133の自己参照部分だけF05。local backupと対象が異なる。",
);
core("relevance", "実検証・SQLite/batch処理。LLMはfixture。", "e2e/relevanceの表示・設定操作とは別。score範囲、profile stale、auto設定を個別に残す。");
core(
  "render",
  "描画jobの投入・結果採否を実Storeで検証。native hidden webviewの実行は含まない。",
  "ingestの抽出更新とは異なる描画再投入防止。e2e/Page testsもnative描画は代替しない。",
);
core(
  "search",
  "実Store/FTSと制御embeddingを用いて検索融合を実行。実モデルの関連度評価ではない。",
  "TSは表示用filter/excerpt、e2eはfixture hitの操作。検索backendの試験を削らない。",
);
core(
  "segments",
  "実翻訳単位・prompt/cache/再試行処理。翻訳応答を制御。",
  "overlay/readerに似た言語判定があるが実行runtimeが異なる。共通corpus候補、削除対象ではない。",
);
core("srs", "実間隔計算へ明示的な状態・gradeを与える純粋試験。", "quiz/vocabはDB登録・due selection、e2eは採点UI。各grade/interval境界を残す。");
core(
  "store",
  "旧schema/現schemaの実SQLite、一時ファイルbackup、queueの状態遷移。Tauri橋渡しは含まない。",
  "21件は異なるmigration元/保存制約。新規DBで通る試験で旧DB移行を代替しない。",
);
core("summarize", "実要約入力の整形・切詰め。要約生成の品質は対象外。", "jobsの要約保存・staleとは別。入力上限を低コストで守る。");
core("url_norm", "実URL正規化を入力例で検証。ネットワークは不要。", "navigationの許可schemeと異なり、重複判定用のcanonical URLを守る。");
core(
  "vocab",
  "実capture検証・語義解析・SQLite/card/CSV。生成応答・時刻は制御。",
  "src/vocabは選択/mark、e2eは操作。lemma統合・job競合・カード履歴はbackend固有。",
);

profile(
  "crates/lattice-cli/src/main.rs",
  "crates/lattice-cli/src/main.rs",
  "実error出力値。プロセス起動はintegration側。",
  "core msgはコード化、CLI mainは公開JSON形状。別の出力境界。",
);
profile(
  "crates/lattice-cli/src/mcp.rs",
  "crates/lattice-cli/src/mcp.rs crates/lattice-cli/src/ops.rs",
  "実MCP schema/result構築。stdio framingはintegration側。",
  "opsの引数変換とCLI integrationの実protocolに補完する。",
);
profile(
  "crates/lattice-cli/src/ops.rs",
  "crates/lattice-cli/src/ops.rs",
  "実操作型変換・一時Storeを使った操作。CLI引数parser/stdioは一部別試験。",
  "integrationと同じ処理を含むがscope分岐とMCP変換の故障を局所化する。",
);
profile(
  "crates/lattice-cli/tests/cli.rs",
  "crates/lattice-cli/src/main.rs crates/lattice-cli/src/ops.rs crates/lattice-cli/src/mcp.rs",
  "実CLI binaryをspawnし、一時DB・stdin/stdout・exit statusを使う。外部LLMを使わない。",
  "unitより広いがCLI接続・write gate・DB非作成・stdioを独立に保護。7件維持。",
);

const native = (name, related, boundary) => profile(`src-tauri/src/${name}.rs`, `src-tauri/src/${name}.rs src-tauri/src/lib.rs`, boundary, related);
native("badge", "UI失敗件数badgeとは別物。Windows taskbar用の表記・pixelを守る。", "実label/pixel生成。Windows taskbarへの表示API自体は未実行。");
native(
  "browser",
  "Node overlayのkey/DOM、e2e Pageの呼出し列と補完。native hostのlabel/nonce/capture境界を残す。",
  "実検証・payload・退避候補選択。WebView2の作成・focus・snapshot取得自体は未実行。",
);
native("location", "coreは保存先決定、ここはTauri識別子とcopy。別の失敗条件。", "識別子/移動先検証と一時フォルダcopy。OS移動UI・再起動は対象外。");
native(
  "popout",
  "src/app/windowsはUI側label/storage、e2eは窓要求。monitor消失はここ固有。",
  "ラベルとmonitor位置判定。native窓作成/placementの実機確認はない。",
);
native(
  "tabdrag",
  "src/layoutはtree mutation、e2e/tabdragはUI/event接続。ここは座標と状態機械なので12件を維持。",
  "実geometry/state machine/payloadの純粋試験。OS cursor polling・実窓z-order・mixed DPIを実機で動かさない。",
);
native("update", "version scriptの定義整合性とは別の有効化条件。", "実public keyの有効化判定。更新配信・署名検証・インストールの実行は含まない。");

const browser = (name, targets, boundary, overlap) => profile(`e2e/${name}.spec.ts`, `${targets} src/api.ts`, `実React UI → mockIPC。${boundary}`, overlap);
browser(
  "chat",
  "src/chat/ChatPane.tsx src/settings/ChatSettings.tsx src/app/useChatBridge.ts",
  "対話応答・設定はメモリfixture。DB再open/実LLMなし。",
  "vim unitは編集状態、core chatは資料/履歴、ここはDOM操作。T190のみF07。",
);
browser(
  "contextmenu",
  "src/library/ListPane.tsx src/library/articleMenu.ts src/layout/TabStrip.tsx",
  "操作要求・モック一覧変化。native clipboard/DB削除連鎖は対象外。",
  "articleMenu unitはaction集合。delete specはEsc取消もあり重複削除しない。T197はtab固有入口。",
);
browser(
  "css",
  "src/theme.css src/ui/Popover.tsx",
  "Chromium computed styleを観測。native OS cursor描画や全themeの目視ではない。",
  "機能試験と違いcursor/selection/disabled affordanceを直接検証するため維持。",
);
browser(
  "cursor",
  "src/app/useKeyboard.ts src/library/ListPane.tsx src/app/useDocuments.ts",
  "実keyboardイベントとUI遷移。native Pageは呼出し記録。",
  "keys unitはbinding決定だけ。tabs/menusと異なるcursor操作入口。",
);
browser(
  "delete",
  "src/library/ListPane.tsx src/ui/ConfirmDialog.tsx src/app/useLibrary.ts",
  "削除先はin-memory記事配列。DB cascadeはcore store。",
  "contextmenuの確定削除に対しEsc取消を追加で守るため維持。",
);
browser(
  "english",
  "src/i18n/index.ts src/settings/SettingsView.tsx src/app/App.tsx",
  "英語localeの実画面。backend error/設定はmock。",
  "カタログ単体はDOM配線を守らない。日本語specと異なるlocaleなので保持。T203はF07。",
);
browser(
  "feedfilter",
  "src/feeds/FeedFilterEditor.tsx src/feeds/FeedsView.tsx src/settings/SettingsView.tsx",
  "採否結果・regex拒否はmock生成。実poll/LLMを通らない。",
  "core/feed_filterが規則意味論、ここは編集とエラー表示。相補。",
);
browser(
  "feedfolders",
  "src/feeds/FeedFoldersCard.tsx src/feeds/FeedsView.tsx src/library/NavFolders.tsx src/app/Palette.tsx",
  "OPML/購読はfixture応答。mockが本番folderTreeを再利用する。",
  "core/feed_foldersを独立oracleとして残す。UI scope・入力・メニューの配線は固有。",
);
browser("feedname", "src/feeds/FeedsView.tsx", "rename_feedの引数まで検証。DB保存はcore。", "通常名/カスタム名は異なる初期状態。空欄branchだけF09。");
browser(
  "feedorder",
  "src/library/NavFolders.tsx src/feeds/feedFolders.ts",
  "ドラッグ/keyboard入力は実DOM。mockもplaceFeedsを使いbackendの順序計算を代替。",
  "TS unitと共有実装部分があるがevent配線は独立。Rust順序試験を削らない。",
);
browser(
  "groups",
  "src/library/NavGroups.tsx src/library/GroupPicker.tsx src/import/ImportView.tsx src/app/Palette.tsx src/settings/ExportSection.tsx",
  "グループCRUD/export/importはmockの状態・引数。",
  "core groups/exportは実DB、Node libraryは集合計算。各UI入口が違うので9件維持。",
);
browser(
  "history",
  "src/app/useHistory.ts src/app/history.ts src/app/TitleBar.tsx",
  "ブラウザDOMでmouse/keyboardを送る。native webview内履歴ではない。",
  "history unitはstack不変条件、UIは訪問記録と操作配線。画面/設定/tabは異なる遷移。",
);
browser(
  "i18n",
  "src/settings/LanguageSettings.tsx src/i18n/index.ts",
  "言語はmock設定。実DB再起動の保持は見ない。",
  "English起動と異なりlive switchを守る。F07は名前の範囲修正であり削除ではない。",
);
browser(
  "jobs",
  "src/jobs/JobsView.tsx src/ui/InfoTip.tsx",
  "固定job一覧とtooltip。実runner/retryの結果は含まない。",
  "backend job_statusとは別の説明・focus。T237の静的badgeを統合できる先。",
);
browser(
  "library",
  "src/library/ListPane.tsx src/library/FacetPopover.tsx src/library/Nav.tsx src/app/useLibraryView.ts",
  "fixture一覧に対する実frontend filter/表示。SQL検索は未実行。",
  "library unitは集合境界、UIは選択・件数の配線。T237のみ単独起動を統合候補F14。",
);
browser(
  "menus",
  "src/ui/Popover.tsx src/browser/BrowserView.tsx src/library/GroupPicker.tsx src/library/NavGroups.tsx",
  "browser_hide遅延やfocusはmock/event注入。native webview重なり自体は見ない。",
  "shell H8はsnapshot/font、こちらは表示順・外クリック・Esc/座標。T240の範囲だけF12。",
);
browser(
  "pageview",
  "src/browser/BrowserView.tsx src/app/App.tsx",
  "browser_show/hideのmock呼出し順を観測。native画面はない。",
  "tabsはtab切替、ここはlibrary離脱復帰のhide raceで独立。",
);
browser(
  "palette",
  "src/app/Palette.tsx src/app/useDocuments.ts",
  "URL保存/検索結果はmock。Ctrl+EnterのUI配線を観測。",
  "tabsのEnterでPageを開く経路と相補。T247は名前だけF11。",
);
browser(
  "panes",
  "src/layout/Splitter.tsx src/app/App.tsx",
  "実geometry・localStorage reload。OSwindow位置とは別。",
  "layout unitの比率計算と別のpointer/keyboard/永続UI配線。2件とも維持。",
);
browser(
  "pdf",
  "src/import/ImportView.tsx src/reader/Reader.tsx",
  "mock import_pdf_fileはprepared articleを返す。PDF bytes/dialog/parserを通らない。",
  "core/pdfとingest/pdfの実bytes試験を残す。UIのPage非表示はここ固有。",
);
browser(
  "popout",
  "src/app/useWindows.ts src/app/useChatBridge.ts src/app/usePageLang.ts src/app/host.ts",
  "queryで窓labelを模倣。emit_toは記録されるだけで実他窓へ届かない。",
  "native popoutとwindow unitは別境界。main/chat/documentの配線差を維持。T255/256はF10。",
);
browser(
  "quiz",
  "src/quiz/QuizPanel.tsx src/quiz/QuizReview.tsx src/settings/QuizSettings.tsx",
  "生成は即時mock、gradeはdueをfalseにするだけ。SRS時計/queue/失敗はcore側。",
  "core quiz/srsが採点意味論、ここは回答UI・出典・state継続。モック統合として保持。",
);
browser(
  "reader",
  "src/reader/Reader.tsx src/reader/mixed.ts src/app/useDocuments.ts",
  "翻訳要求とmock進捗。実翻訳job/LLMは通らない。",
  "mixed unitは表示判定、Rust jobsは生成/cache。自動翻訳offやPage適用可否はUI固有。",
);
browser(
  "relevance",
  "src/library/ListPane.tsx src/reader/Reader.tsx src/settings/RelevanceSettings.tsx",
  "score/profileはfixture。再評価の実LLM/DB更新は通らない。",
  "core relevanceとNode libraryを表示・操作へつなぐため維持。",
);
browser(
  "search",
  "src/search/SearchPane.tsx src/app/useSearch.ts",
  "検索はfixture hit。SQL FTS・embedding推論・ランキング品質は対象外。",
  "core searchは融合、TS searchはexcerpt/filter。UI keyboard/scope配線は別。",
);
browser(
  "settings",
  "src/settings/SettingsView.tsx src/settings/ModelSettings.tsx",
  "各sectionは本物だが値と保存はmock。native設定効果は見ない。",
  "英語smokeとlocaleが違う。カテゴリ列挙の漏れF08、狭幅layoutは独立。",
);
browser(
  "shell",
  "src/app/TitleBar.tsx src/layout/TabStrip.tsx src/browser/BrowserView.tsx src/reader/Reader.tsx src/theme.css",
  "ChromiumのDOM/座標とIPC要求。実native titlebar/clipboard/webview描画は通らない。",
  "Reader/Page、main/document/chatは別hostのため両方必要。font F01/copy F03のみ検証不足。",
);
browser(
  "shortcuts",
  "src/settings/ShortcutSettings.tsx src/app/useKeyboard.ts",
  "実記録入力・localStorage reload・action。native Page key転送は別。",
  "keys unitのmap/競合にUI永続化を加える。2件のpositive/cancelは別。",
);
browser(
  "tabdrag",
  "src/layout/tabDrag.ts src/layout/TabStrip.tsx src/layout/DocArea.tsx src/app/useWindows.ts",
  "backend drag結果をevent注入。native cursor polling/実他窓配送は通らない。",
  "Rust状態機械・Node tree変更と三層で補完。main/documentを両方残す。T305のみF14。",
);
browser(
  "tabs",
  "src/layout/DocArea.tsx src/layout/TabStrip.tsx src/app/useDocuments.ts",
  "実tab/layout/localStorage。PageはmockIPC。",
  "layout unitは状態操作、e2eは入力配線。T310の題名event不足F11。それ以外維持。",
);
browser(
  "tags",
  "src/library/FacetPopover.tsx src/app/useLibraryView.ts",
  "fixtureタグへの実DOM選択・focus。backend tag保存は対象外。",
  "library facetsと異なるpopover keyboard/復帰focus。3件を保持。",
);
browser(
  "vocab",
  "src/vocab/VocabView.tsx src/vocab/VocabCard.tsx src/reader/Reader.tsx src/app/useVocab.ts src/vocab/speech.ts",
  "vocab_addは即ready、speechSynthesisはstub。job待機/実音声/OSvoiceは含まない。",
  "core vocabはDB/card、Node vocabは文字選択。UI各操作/音声設定branchは固有。",
);
profile(
  "e2e/commands.test.ts",
  "src/api.ts e2e/mock.ts",
  "Nodeでソースのinvoke文字列とmock keyを比較。実Tauri handler登録・引数型・権限は照合しない。",
  "モックの更新漏れを安価に検出するため維持。完全なIPC契約とは呼ばない（R01）。",
);

const unit = (name, targets, boundary, overlap) => profile(`src/${name}.test.ts`, targets || `src/${name}.ts`, boundary, overlap);
unit("app/history", null, "実履歴helperへの状態入力。React hookの接続はe2e。", "e2e/historyと補完。stack端・上限・到着更新・Page区別は異なるbranch。");
unit("app/windows", null, "実label/storage key/言語判定helper。native窓は作らない。", "Rust popoutとUI起動試験はruntime/呼出し側が違う。維持。");
unit(
  "browser/engines",
  null,
  "実URL/検索engine変換。navigator・ネットワークは使わない。",
  "Rust url_normは重複用正規化なので別。危険schemeとcustom engine境界を維持。",
);
unit("chat/chat", null, "実引用chip解析とopen article集合。LLM/Storeは使わない。", "core/chatの資料・引用検証と表示変換が異なる。e2eはDOM配線。");
unit("chat/vim", null, "実Vim状態機械へkey入力。DOM入力そのものはe2e。", "e2e一連操作では覆えないmotion/edit/undo境界を保持。");
unit("feeds/feedFilter", null, "実理由整形/規則削除helper。規則評価はRust。", "両言語で全理由を表示する契約、first-only削除は独立。");
unit(
  "feeds/feedFolders",
  null,
  "実frontend tree/順序計算。mockも一部を共有。",
  "e2eとの実装共有は独立oracleではない。ただし固定期待順があり、Rust store試験とも補完する。",
);
unit(
  "i18n/backend",
  "src/i18n/index.ts src/i18n/ja.ts crates/lattice-core/src/msg.rs",
  "Rustソース走査+実translator。Rustを起動した翻訳結合ではない。",
  "カタログ相互照合とは別のbackend message境界。使用中判定だけF04。",
);
unit(
  "i18n/i18n",
  "src/i18n/index.ts src/i18n/ja.ts src/i18n/en.ts",
  "実カタログとtranslator。画面に適用されるかはe2e。",
  "key/params・空白・残存日本語・整形は別故障。英語e2eでは全keyを覆わない。",
);
unit(
  "i18n/literals",
  "src/i18n/ja.ts src/i18n/en.ts",
  "UIソースの文字列走査による方針チェック。自然言語の翻訳品質は判定しない。",
  "key整合や英語DOM試験と異なる、カタログ外の増加を阻止する静的gate。",
);
unit("layout/chrome", null, "実layout treeの最上段strip選択。OStitlebarは対象外。", "shellはDOMのdrag属性/controls、ここはtree形状の組合せ。維持。");
unit(
  "layout/layout",
  null,
  "実layout状態操作/serialization。React/event/native windowは使わない。",
  "e2e tabdrag/tabsとRust geometryは異なる層。重なるopen/closeも空pane・key・tree不変条件が固有。",
);
unit("layout/panes", null, "実幾何近傍選択とnav index計算。DOM計測は入力fixture。", "layout状態更新やe2e keyboard配線と異なる幾何境界。");
unit("lib/keys", null, "実key正規化/action map/override変換。OSkey配送は含まない。", "e2e shortcutは記録とUI、overlayは転送条件。各boundaryを残す。");
unit("lib/runs", null, "実累積offset helper。DOMは使わない。", "単文の試験だが文字列分割の開始位置という独立不変条件。削除根拠なし。");
unit("lib/time", null, "実相対時間整形に固定時刻を与える。timezone全網羅ではない。", "e2e固定clockとは別の単位/不正入力境界。低コストで維持。");
unit("lib/urlLines", null, "実貼り付けURLの分類。通信はしない。", "feedFoldersの空行/重複除去と異なる理由分類。");
unit(
  "library/articleMenu",
  null,
  "実menu modelの項目・一部callback引数。多くのactionはnoopでDOM/clipboardなし。",
  "contextmenu/shellが操作接続を補完。項目集合・bulk flip・import/popout除外は異なる入力。",
);
unit("library/groups", null, "実一覧グループ化。SQL所属変更とは無関係。", "core groupsはユーザーcollection、ここは見た目のgenre/feed群で責務が違う。");
unit(
  "library/library",
  null,
  "実scope/facet集合計算とbackend filter生成。SQLは動かさない。",
  "e2eがDOM、Rust store/searchがDB側を担当。9件は時間・集合・count・緩和等の別契約。",
);
unit("library/scopes", null, "実filter候補/キー変換。DOMoptionは作らない。", "e2e search/chat scopeが接続を補完。フォルダの候補構造は独立。");
unit("library/selection", null, "実行選択状態の更新。pointer/focusはe2e。", "groups/contextmenuはbulk操作への接続。双方向spanの境界を残す。");
unit(
  "overlay/overlay",
  "src/overlay/dom.ts src/overlay/logic.ts src/overlay/index.ts",
  "JSDOMに実DOM/logic関数を読込。実サイト/隔離world/native bridgeはない。settleのみ実timer。",
  "sanitizeの二件は基本攻撃とscheme難読化で別。言語判定はRust/Readerと別runtime。T436だけF06。",
);
unit("quiz/quiz", null, "実interval表示/採点候補helper。SRS更新はRust。", "core srsの日時とUI上の丸め表示は別。e2eでは全単位境界を網羅しない。");
unit(
  "reader/mixed",
  null,
  "実表示block選択・言語判定・集計。Rust job/一覧componentは呼ばない。",
  "overlayはPageのDOM、coreは翻訳処理。T451/452は名称の射程だけF13、値のassertionは残す。",
);
unit(
  "search/search",
  null,
  "実強調・抜粋・結果filter/group helper。検索engineはfixture。",
  "core検索とe2e操作は別。T455の弱いoracleのみF02。他2件は固定期待値が独立。",
);
unit(
  "vocab/speech",
  null,
  "voiceリストを入力して選択する実helper。音声deviceは使わない。",
  "e2eはUIからspeech stubへの接続。offline/locale優先順はここで維持。",
);
unit(
  "vocab/vocab",
  null,
  "実選択文字/文/語形mark/filter helper。ブラウザSelection APIの接続はe2e。",
  "Rust captureは非信頼入力の検証。文字境界・複数出現・最長matchはfrontend固有。",
);
profile(
  "scripts/licenses.test.mjs",
  "scripts/licenses.mjs",
  "実node_modulesのlicense収集結果とfixture重複化。配布binary自体は起動しない。",
  "license存在と同文統合は異なる契約。短いassertionでも実依存を走査するため維持。",
);
profile(
  "scripts/version.test.mjs",
  "scripts/version.mjs src-tauri/tauri.conf.json Cargo.toml",
  "実repo版数の照合と一時コピー更新。不正入力も確認。",
  "Tauri updateの有効化とは別。version一致/参照元/更新/失敗の4契約を保持。",
);
