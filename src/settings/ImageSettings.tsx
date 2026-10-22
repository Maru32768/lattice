import { useEffect, useState } from "react";
import { SetRow, Switch } from "../ui/SetRow";
import { api, type ImageSettings as Value } from "../api";
import { useT } from "../i18n";

export function ImageSettings() {
  const t = useT();
  const [value, setValue] = useState<Value>({ save: true, max_mb: 5 });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .imageSettings()
      .then(setValue)
      .catch((e: unknown) => setError(String(e)));
  }, []);

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
      <SetRow title={t("imageSettings.save")} htmlFor="save-images" desc={t("imageSettings.saveDesc")}>
        <Switch id="save-images" checked={value.save} onChange={(on) => save({ ...value, save: on })} />
      </SetRow>
      <SetRow title={t("imageSettings.maxMb")} htmlFor="image-max" desc={t("imageSettings.maxMbDesc")}>
        <input
          id="image-max"
          className="input sm num"
          type="number"
          min={1}
          max={20}
          value={value.max_mb}
          onChange={(e) => save({ ...value, max_mb: Number(e.target.value) })}
        />
        <span className="muted">MB</span>
      </SetRow>
      {error && (
        <p className="msg error-text" role="alert">
          {t.msg(error)}
        </p>
      )}
    </div>
  );
}
