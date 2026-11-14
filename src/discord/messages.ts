// チャンネルに投稿するメッセージの組み立て（docs/design.md §5.5, §6.6）
// 個人ごとの回答は載せず、候補ごとの「参加できる」区分の人数と回答率だけを出す。
// チャンネルの全員が読むので、言語は見る人ごとではなく、調整の言語（polls.lang。§6.12）で書く。
import type { ChoiceRow, ParticipantRow, PollRow, SlotRow, AnswerRow } from "../db";
import { bestSlotId, effectiveStatus, tally } from "../shared/model";
import { formatDate } from "../shared/time";
import { translator, type Lang } from "../shared/i18n";

/** Discord の Markdown として解釈される記号をエスケープする */
export function escapeMarkdown(s: string): string {
  return s.replace(/([\\*_~`|>#[\]()\-:<@])/g, "\\$1");
}

function slotLabel(s: SlotRow, lang: Lang): string {
  if (s.all_day) return lang === "en" ? `<t:${s.start_at}:D> all day` : `<t:${s.start_at}:D> 終日`;
  const dash = lang === "en" ? "–" : "〜";
  return s.end_at ? `<t:${s.start_at}:f>${dash}<t:${s.end_at}:t>` : `<t:${s.start_at}:f>${dash}`;
}

/** 調整のタイトル（なければ「日程調整」）。Markdown の記号を無効にしないそのままの文字（Discord イベントの名前など） */
export function rawPollTitle(poll: Pick<PollRow, "title" | "lang">): string {
  return poll.title ?? translator(poll.lang)("日程調整", "Scheduling poll");
}

/** 調整のタイトル（なければ「日程調整」）。Markdown の記号は無効にする */
export function pollTitle(poll: Pick<PollRow, "title" | "lang">): string {
  return escapeMarkdown(rawPollTitle(poll));
}

/** 確定した日時の書き方（確定のお知らせ用。§4.3） */
export function slotWhen(slot: { start_at: number; all_day: number }, lang: Lang): string {
  if (!slot.all_day) return `<t:${slot.start_at}:F>`;
  return translator(lang)(`<t:${slot.start_at}:D>（終日）`, `<t:${slot.start_at}:D> (all day)`);
}

export interface MessageData {
  poll: PollRow;
  slots: SlotRow[];
  choices: ChoiceRow[];
  participants: ParticipantRow[];
  answers: AnswerRow[];
  now: number;
}

export const NO_MENTIONS = { parse: [] as string[] };

export function buildPollMessage(d: MessageData) {
  const { poll, slots, choices, participants, answers, now } = d;
  const status = effectiveStatus(poll.status, poll.deadline_at, now);
  const tl = tally(
    slots.map((s) => ({ id: s.id, startAt: s.start_at })),
    choices,
    answers.map((a) => ({ slotId: a.slot_id, userId: a.user_id, choiceId: a.choice_id })),
  );
  const best = bestSlotId(slots.map((s) => ({ id: s.id, startAt: s.start_at })), tl);
  const answered = new Set(answers.map((a) => a.user_id)).size;
  const okLabel = choices.filter((c) => c.kind === "ok").map((c) => c.symbol).join("");
  const L = poll.lang;
  const t = translator(L);

  const lines: string[] = [];
  if (poll.description) lines.push(escapeMarkdown(poll.description), "");
  // 確定した候補は複数のことがある（§4.3）
  const fixedSlots = slots.filter((s) => s.fixed_at !== null);
  if (status === "fixed" && fixedSlots.length) {
    for (const fixed of fixedSlots) {
      const ok = tl.get(fixed.id)?.ok ?? 0;
      lines.push(t(`**確定: ${slotLabel(fixed, L)}**（参加できる人: ${ok} 人）`, `**Confirmed: ${slotLabel(fixed, L)}** (available: ${ok})`));
    }
    lines.push(t(`（人数は <t:${now}:f> 時点）`, `(counts as of <t:${now}:f>)`));
  } else if (status === "closed") {
    lines.push(t("締切を過ぎました（回答の入力・変更はできます）", "The deadline has passed (you can still enter or change your answer)"));
  } else if (poll.deadline_at) {
    lines.push(t(`締切: <t:${poll.deadline_at}:f>（<t:${poll.deadline_at}:R>）`, `Deadline: <t:${poll.deadline_at}:f> (<t:${poll.deadline_at}:R>)`));
  }
  lines.push(
    t(`回答: ${answered}/${participants.length} 名`, `Answered: ${answered}/${participants.length}`),
    "",
    t(`**候補**（${okLabel} の人数）`, `**Date options** (number of ${okLabel})`),
  );
  for (const s of slots) {
    const mark = s.fixed_at !== null ? "✅" : s.id === best ? "★" : "・";
    lines.push(`${mark} ${slotLabel(s, L)}　${t(`${tl.get(s.id)?.ok ?? 0} 人`, String(tl.get(s.id)?.ok ?? 0))}`);
  }
  lines.push(
    "",
    t(
      "［回答する］から、あなた専用の入力画面を開けます。回答は参加者同士で共有されます。",
      "Press [Answer] to open your own answer page. Answers are shared among the participants.",
    ),
  );

  return {
    content: "",
    embeds: [
      {
        title: pollTitle(poll).slice(0, 256),
        description: lines.join("\n").slice(0, 4000),
        color: status === "fixed" ? 0x157f4c : 0x4f46e5,
        footer: { text: "DIscheduler" },
      },
    ],
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 1, label: t("回答する", "Answer"), custom_id: `answer:${poll.id}` },
          { type: 2, style: 2, label: t("集計を見る", "View results"), custom_id: `view:${poll.id}` },
          { type: 2, style: 2, label: t("使い方", "Help"), custom_id: "help" },
        ],
      },
    ],
    allowed_mentions: NO_MENTIONS,
  };
}

export function buildDeletedMessage(poll: Pick<PollRow, "title" | "lang">) {
  const t = translator(poll.lang);
  return {
    content: "",
    embeds: [{ title: pollTitle(poll), description: t("この調整は主催者によって削除されました。", "This poll was deleted by the organizer."), color: 0x888888 }],
    components: [],
    allowed_mentions: NO_MENTIONS,
  };
}

/** ユーザーへのメンション付きのお知らせ（メンションは指定したユーザーだけに限る。security-design E-3） */
export function buildMentionMessage(text: string, userIds: string[]) {
  const ids = userIds.slice(0, 100);
  return {
    content: `${text}\n${ids.map((id) => `<@${id}>`).join(" ")}`.slice(0, 2000),
    allowed_mentions: { parse: [] as string[], users: ids },
  };
}

/**
 * 募集を始めたお知らせ（§5.5）。募集メッセージへの返信として、募集メッセージとは別に投稿する。
 * 参加者をロールで決めた調整はそのロールを、それ以外は @everyone をメンションする（security-design E-3）。
 * Bot に「@everyone、@here、全てのロールにメンション」の権限がないサーバーでは、@everyone は文字だけが出て通知されない
 */
export function buildAnnounceMessage(poll: Pick<PollRow, "title" | "target_type" | "target_id" | "lang">, pollMessageId: string) {
  const t = translator(poll.lang);
  const text = t(
    `**${pollTitle(poll)}** の募集を始めました。募集メッセージの［回答する］から入力できます。`,
    `**${pollTitle(poll)}** is now open. Press [Answer] on the poll message to enter your availability.`,
  );
  return withPollMention(poll, text, pollMessageId);
}

/**
 * 予定のリマインド（§5.7）。日付で書く。時刻のある予定は Discord のタイムスタンプ記法（見る人のタイムゾーンで日付と時刻を表示）、
 * 終日の予定は調整のタイムゾーンでの日付（例: 11/7(土)）。メンションは公開時のお知らせと同じ。
 * 募集メッセージがあれば、その返信にしてリンクも添える
 */
export function buildDayReminderMessage(
  poll: Pick<PollRow, "title" | "target_type" | "target_id" | "guild_id" | "channel_id" | "message_id" | "lang">,
  when: { startAt: number; allDay: boolean; timezone: string },
) {
  const t = translator(poll.lang);
  const link = poll.message_id ? `\n${messageLink(poll.guild_id, poll.channel_id, poll.message_id)}` : "";
  const title = pollTitle(poll);
  const text = when.allDay
    ? t(`**${title}** は ${formatDate(when.startAt, when.timezone)} です（終日）。${link}`, `**${title}** is on ${formatDate(when.startAt, when.timezone, "en")} (all day).${link}`)
    : t(`**${title}** は <t:${when.startAt}:f> からです。${link}`, `**${title}** starts at <t:${when.startAt}:f>.${link}`);
  return withPollMention(poll, text, poll.message_id);
}

/**
 * 確定のお知らせ（§4.3）。いま確定している日時と、前回のお知らせのあとに取り消した日時をまとめて書く。
 * mention のときは、公開時のお知らせ（§5.5）と同じく、参加者をロールで決めた調整はそのロールを、それ以外は @everyone をメンションする
 */
export function buildFixedMessage(
  poll: Pick<PollRow, "title" | "target_type" | "target_id" | "lang">,
  fixed: readonly { when: string; note: string | null }[],
  cancelled: readonly string[],
  mention: boolean,
) {
  const t = translator(poll.lang);
  const lines = [t(`**${pollTitle(poll)}** の日程のお知らせ`, `**${pollTitle(poll)}**: schedule update`)];
  if (fixed.length) lines.push(t("確定した日時:", "Confirmed dates:"), ...fixed.map((f) => `・${f.when}${f.note ? t(`（${f.note}）`, ` (${f.note})`) : ""}`));
  else lines.push(t("確定している日時はありません。", "No dates are confirmed."));
  if (cancelled.length) lines.push(t("確定を取り消した日時:", "Cancelled dates:"), ...cancelled.map((w) => `・~~${w}~~`));
  const text = lines.join("\n");
  return mention ? withPollMention(poll, text, null) : { content: text, allowed_mentions: { parse: [] as string[] } };
}

/** 参加者をロールで決めた調整はそのロールを、それ以外は @everyone を、本文の最後の行でメンションする（security-design E-3） */
function withPollMention(poll: Pick<PollRow, "target_type" | "target_id">, text: string, replyTo: string | null) {
  const reply = replyTo ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {};
  const roleId = poll.target_type === "role" && poll.target_id && /^\d{17,20}$/.test(poll.target_id) ? poll.target_id : null;
  if (roleId) return { content: `${text}\n<@&${roleId}>`, allowed_mentions: { parse: [] as string[], roles: [roleId], replied_user: false }, ...reply };
  return { content: `${text}\n@everyone`, allowed_mentions: { parse: ["everyone"], replied_user: false }, ...reply };
}

export function messageLink(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}
