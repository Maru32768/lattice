const MAX_URL = 2048;

/** An address the PC can fetch. Refused here, while the text is still in the box to correct. */
export const savableUrl = (url: string) => url.length <= MAX_URL && /^https?:\/\/\S+$/i.test(url);
