import { useEffect, useState } from "react";
import { api, type ImageSettings as Value } from "./api";

export function ImageSettings() {
  const [value, setValue] = useState<Value>({ save: true, max_mb: 5 });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.imageSettings().then(setValue).catch((e) => setError(String(e))); }, []);

  async function save(next: Value) {
    setValue(next);
    setError(null);
    try {
      await api.setImageSettings(next);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div>
      <h3>画像</h3>
      <label className="row">
        <input type="checkbox" checked={value.save} onChange={(e) => save({ ...value, save: e.target.checked })} />
        画像を保存する
      </label>
      <label className="row">
        1 枚あたりの上限
        <input type="number" min={1} max={20} value={value.max_mb} style={{ width: "5em" }}
          onChange={(e) => save({ ...value, max_mb: Number(e.target.value) })} />
        MB
      </label>
      <p className="muted">記事の画像（PNG・JPEG・GIF・WebP・AVIF）を取り込み後にダウンロードし、データベースに保存します。元の URL が消えても読めて、バックアップにも入ります。SVG は保存せずリンクのままにします。記事 1 件あたり 30 MB まで。オフにしても保存済みの画像は消えません。</p>
      {error && <p className="error-text" role="alert">{error}</p>}
    </div>
  );
}
