// 日本語と英語の切り替え（docs/design.md §6.12）
// 文言は「日本語と英語の組」で書き、表示するときに言語を選ぶ。キーの一覧は作らず、文言を使う場所に両方を並べて書く。

export type Lang = "ja" | "en";

/** 日本語と英語の組 */
export interface Msg {
  ja: string;
  en: string;
}

export const msg = (ja: string, en: string): Msg => ({ ja, en });

/** 言語を決めた「日本語と英語のうち一方を返す」関数を作る（Discord のメッセージなど、サーバー側で文を組み立てるとき） */
export const translator =
  (lang: Lang) =>
  (ja: string, en: string): string =>
    lang === "en" ? en : ja;

export function pick(m: Msg | string, lang: Lang): string {
  return typeof m === "string" ? m : m[lang];
}

/** 言語タグ（ja, ja-JP, en-US, Discord の locale など）から言語を決める。日本語以外はすべて英語 */
export function langFromTag(tag: string | null | undefined): Lang {
  return typeof tag === "string" && /^ja(\b|-|_|$)/i.test(tag.trim()) ? "ja" : "en";
}

export function isLang(v: unknown): v is Lang {
  return v === "ja" || v === "en";
}

/**
 * HTTP の Accept-Language から言語を決める。いちばん優先度の高い言語が日本語なら日本語、そうでなければ英語。
 * 見出しがないときは日本語（これまでの動きを変えない）
 */
export function langFromAcceptLanguage(header: string | null | undefined): Lang {
  if (!header) return "ja";
  const tags = header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => /^\s*q=([0-9.]+)\s*$/.exec(p)?.[1]).find((v) => v !== undefined);
      return { tag: (tag ?? "").trim(), q: q === undefined ? 1 : Number(q) };
    })
    .filter((t) => t.tag && t.tag !== "*" && t.q > 0)
    .sort((a, b) => b.q - a.q);
  return tags.length ? langFromTag(tags[0]!.tag) : "ja";
}

// 入力スキーマ（valibot）の文言は文字列しか持てないので、日本語と英語を区切り文字でつないで持たせ、使うときに分ける
const SEP = "␞";
export const vmsg = (ja: string, en: string): string => `${ja}${SEP}${en}`;
export function decodeMsg(s: string): Msg {
  const i = s.indexOf(SEP);
  return i < 0 ? { ja: s, en: s } : { ja: s.slice(0, i), en: s.slice(i + SEP.length) };
}

/** Web 画面からのリクエストの言語。画面が X-DI-Lang で知らせ、なければ Accept-Language で決める */
export function requestLang(header: (name: string) => string | undefined): Lang {
  const v = header("X-DI-Lang");
  return isLang(v) ? v : langFromAcceptLanguage(header("Accept-Language"));
}
