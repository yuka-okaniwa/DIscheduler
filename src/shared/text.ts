// 文字列の検証・整形（docs/security-design.md §4.4）

// 制御文字（改行・タブを含む）と、双方向制御文字・ゼロ幅文字などの見えない書式文字
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const INVISIBLE_FORMAT = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/u;

export function hasControlChars(s: string): boolean {
  return CONTROL.test(s) || INVISIBLE_FORMAT.test(s);
}

/** 改行だけは許す（説明欄など） */
export function hasControlCharsExceptNewline(s: string): boolean {
  return CONTROL.test(s.replace(/\r?\n/g, "")) || INVISIBLE_FORMAT.test(s);
}

/** 制御文字・見えない書式文字を取り除き、前後の空白を落として長さを切り詰める（空になることがある） */
export function sanitizeLine(s: string, max: number): string {
  const cleaned = Array.from(s.normalize("NFC"))
    .filter((ch) => !CONTROL.test(ch) && !INVISIBLE_FORMAT.test(ch))
    .join("")
    .trim();
  const chars = Array.from(cleaned);
  return chars.length > max ? chars.slice(0, max).join("").trim() : cleaned;
}

/** Discord から取得した表示名などを、表示用に安全な形にする */
export function sanitizeDisplayName(name: string, max = 64): string {
  const s = sanitizeLine(name, max);
  return s.length > 0 ? s : "（名前なし）";
}

/** 書記素（見た目の 1 文字）の数 */
export function graphemeLength(s: string): number {
  const Seg = (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Seg) {
    let n = 0;
    for (const _ of new Seg("ja", { granularity: "grapheme" }).segment(s)) n++;
    return n;
  }
  return Array.from(s).length;
}

/** コード ポイント単位の長さ（DB の length() とそろえるため UTF-16 ではなく文字数で数える） */
export function charLength(s: string): number {
  return Array.from(s).length;
}

/**
 * 寄付リンクとして使える URL か（https で、決まった文字だけでできている）。
 * scripts/prepare-public.sh の DONATION_URL の検証と同じ規則（変えるときは両方そろえる）
 */
export const DONATION_URL_PATTERN = /^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._~/-]*)?$/;
export function isValidDonationUrl(u: string | null | undefined): u is string {
  return typeof u === "string" && DONATION_URL_PATTERN.test(u);
}

/**
 * 寄付リンクの近くに添える、リンク先の支援サービスの説明（§6.10）。Ko-fi のときだけ、画面が英語であることと支払い方を書く。
 * scripts/prepare-public.sh の __DONATION_NOTE__ の文と同じにする（変えるときは両方そろえる）
 */
export const KOFI_DONATION_NOTE = "支援は Ko-fi（海外の支援サービス）で受け付けています。画面は英語ですが、金額を選んで、PayPal で支払えます。";
/** 英語の画面での説明（Ko-fi の画面が英語であることは書かない。§6.12） */
export const KOFI_DONATION_NOTE_EN = "Support is accepted through Ko-fi. Choose an amount and pay with PayPal.";
export function donationNote(url: string, lang: "ja" | "en" = "ja"): string {
  if (!/^https:\/\/(www\.)?ko-fi\.com(\/|$)/.test(url)) return "";
  return lang === "en" ? KOFI_DONATION_NOTE_EN : KOFI_DONATION_NOTE;
}

/** 選択肢の記号・名前に使えない文字（メンション・カスタム絵文字の記法など） */
export function isSafeChoiceText(s: string): boolean {
  return !hasControlChars(s) && !/[<>@`\\]/.test(s);
}
