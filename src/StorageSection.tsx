import { useEffect, useState } from "react";
import { api, type Settings } from "./api";
import { SetRow } from "./SetRow";

export function StorageSection() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.settings().then(setSettings).catch((e) => setError(String(e))); }, []);

  return (
    <>
      <div className="grp">
        <SetRow title="ログ" desc={<>取得や翻訳ジョブの失敗はログに記録されます: <code>{settings?.log_dir}</code></>} />
        <SetRow title="データベース" desc={<>記事・訳・要約・画像・検索 index など、すべてのデータは 1 つの SQLite ファイルにあります: <code>{settings?.db_path}</code></>} />
      </div>
      {error && <p role="alert" className="msg error-text">{error}</p>}
    </>
  );
}
