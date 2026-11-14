// Web API の呼び出し
import type { ChoiceColor, ChoiceKind, PollStatus, Role } from "../../../src/shared/model";
import { LANG, tr } from "./i18n";

export interface PollData {
  now: number;
  csrfToken: string;
  donationUrl: string | null;
  poll: {
    id: string;
    title: string | null;
    description: string | null;
    status: PollStatus;
    deadlineAt: number | null;
    timezone: string;
    timezoneSet: boolean;
    targetType: "channel" | "role" | "manual";
    targetId: string | null;
    joinPolicy: "closed" | "open";
    choicesVersion: number;
    updatedAt: number;
    messageUrl: string | null;
    lastSyncedAt: number | null;
    pendingChanges: number | null;
    nextAutoSyncAt: number | null;
    choicesChangedAt: number | null;
    /** 予定のリマインドを当日（0）か前日（1）の何時（remindHour。調整のタイムゾーン）に送るか（§5.7） */
    remindDayOffset: number;
    remindHour: number;
  };
  me: { userId: string; role: Role; isParticipant: boolean; displayName: string | null; comment: string | null; answeredAt: number | null; needsChoicesAck: boolean };
  /** fixedAt: 確定した時刻（未確定なら null。複数の候補を確定できる）。hasEvent: この候補で Discord イベントを登録済みか。announced: 前回の［確定をお知らせする］で確定日として知らせたか */
  slots: { id: string; startAt: number; endAt: number | null; allDay: boolean; fixedAt: number | null; hasEvent: boolean; announced: boolean }[];
  choices: { id: string; symbol: string; label: string; kind: ChoiceKind; score: number; color: ChoiceColor }[];
  participants: { userId: string; displayName: string; comment: string | null; answeredAt: number | null }[];
  answers: { slotId: string; userId: string; choiceId: string; prevChoiceId: string | null; updatedAt: number }[];
  /** サーバーで最近使った時間帯（新しい順・最大 3 件）。主催者にだけ返る */
  recentTimes: { start: string; end: string }[];
  /** サーバーの既定値の、Discord イベントの場所（主催者にだけ返る。null なら「Discord」） */
  defaultEventLocation: string | null;
  /** サーバーの既定値の、Discord イベントのボイスチャンネル（主催者にだけ返る）。入っていれば確定の画面で最初から選ぶ */
  defaultEventChannelId: string | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** 日本語と英語の両方の文言（あれば、画面の言語を切り替えたときにこちらを使う。§6.12） */
    readonly texts: { ja: string; en: string } | null = null,
  ) {
    super(message);
  }

  /** いまの画面の言語での文言 */
  text(): string {
    return this.texts ? this.texts[LANG] : this.message;
  }
}

/** 日本語と英語の両方を持つエラーを作る（画面の中で作るエラー） */
export function apiError(status: number, code: string, ja: string, en: string): ApiError {
  return new ApiError(status, code, tr(ja, en), { ja, en });
}

let csrfToken = "";
export function setCsrf(token: string): void {
  csrfToken = token;
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  // エラーの文言を画面の言語で受け取る（§6.12）
  const headers: Record<string, string> = { Accept: "application/json", "X-DI-Lang": LANG };
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw apiError(0, "network", "通信できませんでした。接続を確認してもう一度お試しください。", "Couldn't connect. Check your connection and try again.");
  }
  const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string; messages?: { ja: string; en: string } } } | null;
  if (!res.ok) {
    const err = data?.error;
    if (!err?.message) throw apiError(res.status, err?.code ?? "error", "エラーが発生しました。", "Something went wrong.");
    const texts = err.messages && typeof err.messages.ja === "string" && typeof err.messages.en === "string" ? err.messages : null;
    throw new ApiError(res.status, err.code ?? "error", err.message, texts);
  }
  return data as T;
}

export async function loadPoll(pollId: string): Promise<PollData> {
  const d = await request<PollData>("GET", `/api/polls/${pollId}`);
  setCsrf(d.csrfToken);
  return d;
}
