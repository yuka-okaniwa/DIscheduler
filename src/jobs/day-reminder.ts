// 予定のリマインド（docs/design.md §5.7）
// 確定した日時ごとに、主催者が決めた日時（予定の当日か前日の何時。調整のタイムゾーン。既定は当日の 17 時）に、調整のチャンネルへ知らせる。
// Cron は毎時 0〜4 分に 1 分おきに 5 回動き、送る時刻を過ぎていて、まだ送っていない日時に送る。1 回で DAY_REMINDER_MAX_PER_RUN 件まで（残りは次の分の回）。
// 送る時刻を過ぎてから確定した日時は、次の回で送る。［確定をお知らせする］のお知らせが先なら、お知らせにリマインドの一文を添えて、それで送ったことにする（§4.3）。
import type { Env } from "../core/env";
import type { PollRow } from "../db";
import { buildDayReminderMessage } from "../discord/messages";
import { discord, DiscordError } from "../discord/rest";
import { reminderAt } from "../shared/model";

/** 予定のリマインドだけを行う Cron（wrangler.jsonc の crons と同じ文字列） */
export const REMINDER_CRON = "0-4 * * * *";

/**
 * 1 回の実行で送る数の上限。無料プランでは、Discord への送信（サブリクエスト）と D1 の問い合わせが、
 * それぞれ 1 回の実行あたり 50 回まで。対象の読み込み 1 文と、1 件ごとに権利の取得 1 文・送信 1 回を使う
 */
export const DAY_REMINDER_MAX_PER_RUN = 20;

const HOUR = 3600;
const DAY = 24 * HOUR;
/**
 * 読み込む予定の範囲。送る時刻は、早くて予定の前日の 0 時（予定の開始の最大 48 時間前。夏時間の境目で前後する分を足す）。
 * 終日の予定は、その日が終わるまで送れる
 */
const LOOKAHEAD = 2 * DAY + 2 * HOUR;
/** 1 回に読み込む予定の数の上限（送る時刻を過ぎていないものも含まれるため、送る数より多めに読む） */
const MAX_CANDIDATES = 200;

type Target = Pick<PollRow, "id" | "guild_id" | "channel_id" | "message_id" | "title" | "target_type" | "target_id" | "timezone" | "remind_day_offset" | "remind_hour" | "lang"> & {
  slot_id: string;
  start_at: number;
  all_day: number;
};

/** 送る時刻を過ぎていて、予定がまだ終わっていないか */
export function isReminderDue(t: Pick<Target, "start_at" | "all_day" | "timezone" | "remind_day_offset" | "remind_hour">, now: number): boolean {
  const at = reminderAt({ startAt: t.start_at, allDay: t.all_day === 1 }, t.timezone, t.remind_day_offset, t.remind_hour);
  const limit = t.all_day === 1 ? t.start_at + DAY : t.start_at;
  return at !== null && at <= now && now < limit;
}

export async function runDayReminder(env: Env, scheduledTime: number): Promise<void> {
  const now = Math.floor(scheduledTime / 1000);
  const db = env.DB;
  // 確定した日時のうち、これから始まる（終日はその日が終わっていない）もので、その日時についてまだ送っていないもの。
  // 送る時刻は調整ごとの設定とタイムゾーンで決まるので、読み込んだあとで絞り込む
  const rows = await db
    .prepare(
      "SELECT s.id AS slot_id, p.id, p.guild_id, p.channel_id, p.message_id, p.title, p.target_type, p.target_id, p.timezone, p.lang, " +
        "p.remind_day_offset, p.remind_hour, s.start_at, s.all_day " +
        "FROM slots s JOIN polls p ON p.id = s.poll_id " +
        "WHERE s.fixed_at IS NOT NULL AND s.start_at > ? AND s.start_at <= ? AND p.status = 'fixed' " +
        "AND (s.day_reminded_at IS NULL OR s.day_reminded_at != s.start_at) " +
        "ORDER BY s.start_at, s.id LIMIT ?",
    )
    .bind(now - DAY, now + LOOKAHEAD, MAX_CANDIDATES)
    .all<Target>();
  const due = rows.results.filter((t) => isReminderDue(t, now));
  // 上限を超えた分は、次の分の回で送る（ログ用に残りがあるかを残す）
  const deferred = due.length > DAY_REMINDER_MAX_PER_RUN;
  const targets = due.slice(0, DAY_REMINDER_MAX_PER_RUN);

  let sent = 0;
  let failed = 0;
  for (const t of targets) {
    // 送る前に権利を取る。Cron が重なっても、同じ確定日時には 1 回だけ送る。送信に失敗しても戻さない
    const claimed = await db
      .prepare("UPDATE slots SET day_reminded_at = ? WHERE id = ? AND (day_reminded_at IS NULL OR day_reminded_at != ?)")
      .bind(t.start_at, t.slot_id, t.start_at)
      .run();
    if (claimed.meta.changes !== 1) continue;
    try {
      await discord(env, "POST", `/channels/${t.channel_id}/messages`, buildDayReminderMessage(t, { startAt: t.start_at, allDay: t.all_day === 1, timezone: t.timezone }));
      sent++;
    } catch (e) {
      // チャンネルが消えている・Bot が投稿できない（403・404）ときも、ほかの調整の処理は続ける
      failed++;
      if (!(e instanceof DiscordError && (e.status === 403 || e.status === 404))) {
        console.error(JSON.stringify({ event: "day_reminder_failed", error: e instanceof Error ? e.message : "unknown" }));
      }
    }
  }
  console.log(JSON.stringify({ event: "day_reminder", sent, deferred, failed }));
}
