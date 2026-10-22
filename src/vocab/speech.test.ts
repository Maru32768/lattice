import { test } from "node:test";
import assert from "node:assert/strict";
import { englishVoice } from "./speech.ts";

const v = (name: string, lang: string, localService = true) => ({ name, lang, localService });

test("englishVoice takes an offline en-US voice first, then other English, never a cloud one", () => {
  const zira = v("Zira", "en-US");
  const hazel = v("Hazel", "en-GB");
  const haruka = v("Haruka", "ja-JP");
  const online = v("Aria Online", "en-US", false);
  assert.equal(englishVoice([haruka, hazel, online, zira]), zira);
  assert.equal(englishVoice([haruka, hazel, online]), hazel);
  assert.equal(englishVoice([v("x", "en_US")])?.name, "x");
  assert.equal(englishVoice([haruka, online]), null);
  assert.equal(englishVoice([v("Eng", "eng-XX")]), null, "en only as the language subtag");
  assert.equal(englishVoice([]), null);
});
