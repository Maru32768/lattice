// Pronunciation of vocabulary cards (H20) with the Web Speech API. WebView2 on Windows lists the
// system's voices (Microsoft David / Zira / Mark…), which speak offline. Only those (localService)
// are used: a cloud voice would send the words out. No English voice: no audio buttons.
import { useSyncExternalStore } from "react";

type Voice = Pick<SpeechSynthesisVoice, "lang" | "localService">;

/** The offline English voice to use: en-US first, then any other English. */
export function englishVoice<V extends Voice>(voices: readonly V[]): V | null {
  const en = voices.filter((v) => v.localService && /^en([-_]|$)/i.test(v.lang));
  return en.find((v) => /^en[-_]US$/i.test(v.lang)) ?? en[0] ?? null;
}

const synth = (): SpeechSynthesis | null => (typeof speechSynthesis === "undefined" ? null : speechSynthesis);

let voice: SpeechSynthesisVoice | null = null;
// The list fills in asynchronously: Chromium returns [] until `voiceschanged`, which may fire before
// anyone listens. So an empty answer is not kept: it is asked again until a voice turns up.
const current = () => (voice ??= englishVoice(synth()?.getVoices() ?? []));
function subscribe(changed: () => void) {
  const s = synth();
  const on = () => {
    voice = englishVoice(s?.getVoices() ?? []);
    changed();
  };
  s?.addEventListener("voiceschanged", on);
  // The list may have filled between the first read and now.
  if (!voice && current()) {
    changed();
  }
  return () => s?.removeEventListener("voiceschanged", on);
}

/** The English voice, or null while there is none. */
export const useEnglishVoice = () => useSyncExternalStore(subscribe, current);

export function speak(text: string, v: SpeechSynthesisVoice) {
  const s = synth();
  if (!s) {
    return;
  }
  s.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.voice = v;
  u.lang = v.lang;
  s.speak(u);
}

const AUTO_KEY = "lattice.vocabAutoplay";
/** Whether a card says its word when it appears (default on; per device, like the word marks). */
export function autoplay(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) !== "off";
  } catch {
    return true;
  }
}
export function setAutoplay(on: boolean) {
  try {
    localStorage.setItem(AUTO_KEY, on ? "on" : "off");
  } catch {
    // Blocked storage: the default stays.
  }
}

let replay: (() => void) | null = null;
/** The card on screen says its word again on the `speak` shortcut; returns the unregister. */
export function onReplay(f: () => void) {
  replay = f;
  return () => {
    if (replay === f) {
      replay = null;
    }
  };
}
export const replayWord = () => replay?.();
