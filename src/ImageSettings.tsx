import { useEffect, useState } from "react";
import { SetRow, Switch } from "./SetRow";
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
    <div className="grp">
      <SetRow title="画像を保存する" htmlFor="save-images"
        desc="記事の画像（PNG・JPEG・GIF・WebP・AVIF）を取り込み後にダウンロードし、データベースに保存します。元の URL が消えても読めて、バックアップにも入ります。SVG は保存せずリンクのままにします。オフにしても保存済みの画像は消えません。">
        <Switch id="save-images" checked={value.save} onChange={(on) => save({ ...value, save: on })} />
      </SetRow>
      <SetRow title="1 枚あたりの上限" htmlFor="image-max" desc="記事 1 件あたりは 30 MB まで。">
        <input id="image-max" className="input sm num" type="number" min={1} max={20} value={value.max_mb}
          onChange={(e) => save({ ...value, max_mb: Number(e.target.value) })} />
        <span className="muted">MB</span>
      </SetRow>
      {error && <p className="msg error-text" role="alert">{error}</p>}
    </div>
  );
}
