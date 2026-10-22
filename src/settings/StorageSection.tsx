import { useEffect, useState } from "react";
import { api, type Settings } from "../api";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { SetRow } from "../ui/SetRow";
import { useT } from "../i18n";

const LOCATION = { default: "storageSection.default", custom: "storageSection.custom", portable: "storageSection.portable" } as const;

export function StorageSection() {
  const t = useT();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ path: string; has_data: boolean } | null>(null);
  const [moving, setMoving] = useState(false);
  const [moved, setMoved] = useState<string | null>(null);

  useEffect(() => {
    api
      .settings()
      .then(setSettings)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  async function pick() {
    setError(null);
    try {
      setPicked(await api.pickDataDir());
    } catch (e) {
      setError(String(e));
    }
  }

  async function apply() {
    if (!picked) {
      return;
    }
    setPicked(null);
    setMoving(true);
    try {
      setMoved(await api.setDataDir(!picked.has_data));
    } catch (e) {
      setError(String(e));
    }
    setMoving(false);
  }

  const portable = settings?.location === "portable";
  return (
    <>
      <div className="grp">
        <SetRow
          title={t("storageSection.location")}
          desc={
            <>
              {t.rich("storageSection.locationDesc", { kind: settings ? t(LOCATION[settings.location]) : "", path: <code>{settings?.data_dir}</code> })}
              {portable && t.rich("storageSection.portableDesc", { file: <code>portable</code> })}
            </>
          }
        >
          {!portable && (
            <button className="btn" onClick={pick} disabled={moving || !!moved}>
              {moving ? t("storageSection.copying") : t("storageSection.change")}
            </button>
          )}
        </SetRow>
        <SetRow title={t("storageSection.database")} desc={<code>{settings?.db_path}</code>} />
        <SetRow title={t("storageSection.logs")} desc={t.rich("storageSection.logsDesc", { path: <code>{settings?.log_dir}</code> })} />
      </div>
      {settings?.location_warning && (
        <p role="alert" className="msg error-text">
          {t.msg(settings.location_warning)}
        </p>
      )}
      {moved && (
        <div role="status" className="msg moved">
          <p>{t.rich("storageSection.moved", { code: <code>{moved}</code>, code2: <code>{settings?.data_dir}</code> })}</p>
          <button className="btn pri" onClick={() => api.restart().catch((e: unknown) => setError(String(e)))}>
            {t("storageSection.restartNow")}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="msg error-text">
          {t.msg(error)}
        </p>
      )}
      {picked &&
        (picked.has_data ? (
          <ConfirmDialog title={t("storageSection.useData")} confirm={t("storageSection.switch")} onConfirm={apply} onCancel={() => setPicked(null)}>
            <p>{t.rich("storageSection.hasData", { path: <code>{picked.path}</code> })}</p>
            <p>{t.rich("storageSection.dataStays", { code: <code>{settings?.data_dir}</code> })}</p>
          </ConfirmDialog>
        ) : (
          <ConfirmDialog
            title={t("storageSection.changeLocation")}
            confirm={t("storageSection.copyAndChange")}
            onConfirm={apply}
            onCancel={() => setPicked(null)}
          >
            <p>{t.rich("storageSection.copyDesc", { code: <code>{picked.path}</code> })}</p>
            <p>{t("storageSection.copyWarning")}</p>
          </ConfirmDialog>
        ))}
    </>
  );
}
