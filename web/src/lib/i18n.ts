// 画面の言語（docs/design.md §6.12）。日本語以外の言語のブラウザでは英語を出す。
// 画面右上の切り替えで選んだ言語は、このブラウザの localStorage にだけ保存する
import { isLang, langFromTag, type Lang } from "../../../src/shared/i18n";

const KEY = "dis.lang";

function detect(): Lang {
  // ?lang=en のように URL で指定されたら、それを使って保存する（言語の切り替えや、静的ページの英語版から来たとき）
  const fromUrl = new URLSearchParams(location.search).get("lang");
  if (isLang(fromUrl)) {
    try {
      localStorage.setItem(KEY, fromUrl);
    } catch {
      /* 保存できなくても、この読み込みでは使う */
    }
    return fromUrl;
  }
  try {
    const saved = localStorage.getItem(KEY);
    if (isLang(saved)) return saved;
  } catch {
    /* 保存できない環境では、ブラウザの言語で決める */
  }
  const first = (navigator.languages && navigator.languages[0]) || navigator.language;
  return langFromTag(first);
}

/** 画面の言語。リンク中継の画面（/l）では、読み込み直さずに切り替える（setLangInPlace） */
export let LANG: Lang = detect();
document.documentElement.lang = LANG;

/** 日本語と英語のうち、画面の言語のほうを返す */
export function tr(ja: string, en: string): string {
  return LANG === "en" ? en : ja;
}

/** 言語を切り替え、読み込み直さずに、その場で描き直す（リンク中継の画面用。読み込み直すとリンクの中身が URL から消えているため） */
export function setLangInPlace(lang: Lang, redraw: () => void): void {
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    /* 保存できなくても、この画面では切り替える */
  }
  LANG = lang;
  document.documentElement.lang = lang;
  redraw();
}

/** 言語を切り替えて、画面を読み込み直す（描いた画面の文言をすべて入れ替えるため） */
export function setLang(lang: Lang): void {
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    /* 保存できなくても、この読み込みの間だけは切り替える */
  }
  const url = new URL(location.href);
  url.searchParams.set("lang", lang);
  location.replace(url.toString());
}
