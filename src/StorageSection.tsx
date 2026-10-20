import { useEffect, useState } from "react";
import { api, type Settings } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { SetRow } from "./SetRow";

const LOCATION = { default: "既定の場所", custom: "選んだフォルダ", portable: "ポータブル（exe の隣）" };

export function StorageSection() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ path: string; has_data: boolean } | null>(null);
  const [moving, setMoving] = useState(false);
  const [moved, setMoved] = useState<string | null>(null);

  useEffect(() => { api.settings().then(setSettings).catch((e) => setError(String(e))); }, []);

  async function pick() {
    setError(null);
    try {
      setPicked(await api.pickDataDir());
    } catch (e) {
      setError(String(e));
    }
  }

  async function apply() {
    if (!picked) return;
    setPicked(null);
    setMoving(true);
    try {
      setMoved(await api.setDataDir(!picked.has_data));
    } catch (e) {
      setError(String(e));
    } finally {
      setMoving(false);
    }
  }

  const portable = settings?.location === "portable";
  return (
    <>
      <div className="grp">
        <SetRow title="データの保存場所"
          desc={<>記事・訳・要約・画像・検索 index など、すべてのデータは 1 つの SQLite ファイルにあり、バックアップ・エクスポート・検索モデルも同じフォルダに置きます（{settings ? LOCATION[settings.location] : ""}）: <code>{settings?.data_dir}</code>
            {portable && <>。exe の隣に <code>portable</code> ファイルがあるので、ページ表示のログイン情報やログも含めてここに保存します。</>}</>}>
          {!portable && <button className="btn" onClick={pick} disabled={moving || !!moved}>{moving ? "コピー中…" : "変更…"}</button>}
        </SetRow>
        <SetRow title="データベース" desc={<code>{settings?.db_path}</code>} />
        <SetRow title="ログ" desc={<>取得や翻訳ジョブの失敗はログに記録されます: <code>{settings?.log_dir}</code></>} />
      </div>
      {settings?.location_warning && <p role="alert" className="msg error-text">{settings.location_warning}</p>}
      {moved && (
        <div role="status" className="msg moved">
          <p>次回の起動から <code>{moved}</code> を使います。今の場所 <code>{settings?.data_dir}</code> のデータは削除していません。不要になったら手動で削除してください。</p>
          <button className="btn pri" onClick={() => api.restart().catch((e) => setError(String(e)))}>今すぐ再起動</button>
        </div>
      )}
      {error && <p role="alert" className="msg error-text">{error}</p>}
      {picked && (picked.has_data
        ? <ConfirmDialog title="このフォルダのデータを使いますか？" confirm="切り替える" onConfirm={apply} onCancel={() => setPicked(null)}>
            <p><code>{picked.path}</code> には既に Lattice のデータがあります。コピーはせず、再起動後はそのデータを使います。</p>
            <p>今のデータは <code>{settings?.data_dir}</code> にそのまま残ります。</p>
          </ConfirmDialog>
        : <ConfirmDialog title="保存場所を変更しますか？" confirm="コピーして変更" onConfirm={apply} onCancel={() => setPicked(null)}>
            <p>データベース・バックアップ・エクスポート・検索モデルを <code>{picked.path}</code> にコピーし、再起動後はそこを使います。</p>
            <p>コピーの後に追加・変更したものは新しい場所に入らないので、終わったらすぐ再起動してください。今のデータは削除しません。</p>
          </ConfirmDialog>)}
    </>
  );
}
