import jsQR from "jsqr";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useT } from "../i18n";

/** Frames are read at this width at most: a phone camera's full frame takes too long to search. */
const READ_WIDTH = 640;

/** The camera exists only in a secure context: the local network's plain HTTP page has the pasted link alone. */
export const canScan = () => typeof navigator.mediaDevices?.getUserMedia === "function";

/**
 * Reads the PC's QR code with the camera, for a page the code cannot open: on iOS the home screen's page keeps
 * storage of its own. `onCode` says whether the code was one to connect with; reading goes on until it is.
 */
export function QrScan({ onCode, onStop }: { onCode: (text: string) => boolean; onStop: () => void }) {
  const t = useT();
  const video = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  const found = useEffectEvent(onCode);
  useEffect(() => {
    let stream: MediaStream | null = null;
    let frame = 0;
    let stopped = false;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const look = () => {
      const v = video.current;
      if (stopped || !v || !ctx) {
        return;
      }
      if (v.readyState >= v.HAVE_ENOUGH_DATA && v.videoWidth > 0) {
        const scale = Math.min(1, READ_WIDTH / v.videoWidth);
        canvas.width = Math.round(v.videoWidth * scale);
        canvas.height = Math.round(v.videoHeight * scale);
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        const code = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: "dontInvert" });
        if (code?.data && found(code.data)) {
          return;
        }
      }
      frame = requestAnimationFrame(look);
    };
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false }).then(
      (s) => {
        stream = s;
        const v = video.current;
        if (stopped || !v) {
          s.getTracks().forEach((track) => track.stop());
          return;
        }
        v.srcObject = s;
        void v.play().catch(() => {});
        look();
      },
      () => setFailed(true),
    );
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);
  return (
    <div className="m-scan">
      {failed ? <p role="alert">{t("mobile.cameraFailed")}</p> : <video ref={video} playsInline muted aria-label={t("mobile.scanQr")} />}
      <button type="button" className="btn" onClick={onStop}>
        {t("mobile.stopScan")}
      </button>
    </div>
  );
}
