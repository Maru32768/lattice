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
  const [unused, setUnused] = useState<number | null>(null);
  const [confirmUnused, setConfirmUnused] = useState(false);
  const [deleted, setDeleted] = useState<number | null>(null);

  useEffect(() => {
    api
      .settings()
      .then(setSettings)
      .catch((e: unknown) => setError(String(e)));
    api
      .unusedTranslations()
      .then(setUnused)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  /** Counts again: the Page view may have translated more since the section opened. */
  async function askUnused() {
    setError(null);
    try {
      const n = await api.unusedTranslations();
      setUnused(n);
      setConfirmUnused(n > 0);
    } catch (e) {
      setError(String(e));
    }
  }

  async function deleteUnused() {
    setConfirmUnused(false);
    setError(null);
    try {
      setDeleted(await api.deleteUnusedTranslations());
      setUnused(await api.unusedTranslations());
    } catch (e) {
      setError(String(e));
    }
  }

  async function pick() {
    setError(null);
    try {
      setPicked(await api.pickDataDir());
    } catch (e) {
      setError(String(e));
    }
  }

  async function open(folder: () => Promise<void>) {
    setError(null);
    try {
      await folder();
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
          <button className="btn" onClick={() => open(api.openDataDir)} disabled={!settings || moving}>
            {t("storageSection.openFolder")}
          </button>
          {!portable && (
            <button className="btn" onClick={pick} disabled={!settings || moving || !!moved}>
              {moving ? t("storageSection.copying") : t("storageSection.change")}
            </button>
          )}
        </SetRow>
        <SetRow title={t("storageSection.database")} desc={<code>{settings?.db_path}</code>} />
        <SetRow title={t("storageSection.unused")} desc={t("storageSection.unusedDesc")}>
          {unused !== null && (
            <button className="btn" onClick={askUnused} disabled={unused === 0}>
              {t("storageSection.deleteUnused", { count: unused })}
            </button>
          )}
        </SetRow>
        <SetRow title={t("storageSection.logs")} desc={t.rich("storageSection.logsDesc", { path: <code>{settings?.log_dir}</code> })}>
          <button className="btn" onClick={() => open(api.openLogDir)} disabled={!settings} aria-label={t("storageSection.openLogFolder")}>
            {t("storageSection.openFolder")}
          </button>
        </SetRow>
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
      {deleted !== null && (
        <p role="status" className="msg">
          {t("storageSection.unusedDeleted", { count: deleted })}
        </p>
      )}
      {error && (
        <p role="alert" className="msg error-text">
          {t.msg(error)}
        </p>
      )}
      {confirmUnused && (
        <ConfirmDialog title={t("storageSection.confirmUnused")} confirm={t("common.delete")} onConfirm={deleteUnused} onCancel={() => setConfirmUnused(false)}>
          <p>{t("storageSection.unusedWarning", { count: unused ?? 0 })}</p>
        </ConfirmDialog>
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
