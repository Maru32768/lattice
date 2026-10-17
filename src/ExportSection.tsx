import { useState } from "react";
import { api } from "./api";
import { SetRow } from "./SetRow";

export function ExportSection() {
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function exportJson() {
    setError(null);
    setStatus("エクスポート中…");
    try {
      setStatus(`エクスポートしました: ${await api.exportJson()}`);
    } catch (e) {
      setStatus(null);
      setError(String(e));
    }
  }

  return (
    <>
      <div className="grp">
        <SetRow title="JSON でエクスポート"
          desc={<><code>exports</code> フォルダに、1 行 1 オブジェクトの gzip で書き出します。記事・ブロック・訳・要約・タグ・ジャンル・フィード・対話が入ります。API キーなどの設定と取得した HTML は含まないので、HTML まで残すにはバックアップを使ってください。</>}>
          <button className="btn" onClick={exportJson}>エクスポート</button>
        </SetRow>
      </div>
      {status && <p role="status" className="msg">{status}</p>}
      {error && <p role="alert" className="msg error-text">{error}</p>}
    </>
  );
}
