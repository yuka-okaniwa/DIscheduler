// 調整の作成・参加者の設定など、Discord と Web の両方から使う処理
import type { Env } from "../core/env";
import { defaultChoiceStatements, hitRateLimit, rateLimitResetIn, type PollRow, insertParticipantsStatement } from "../db";
import { extractParticipants, fetchMember, type Candidate } from "../discord/members";
import { getGuildSettings } from "../guilds/settings";
import { DAY, floorToMinute, nowSec, randomId } from "../core/lib";
import { msg, type Lang, type Msg } from "../shared/i18n";

export const DRAFT_TTL = 3 * DAY;
export const RETENTION = 180 * DAY;
export const DEFAULT_DEADLINE_DAYS = 7;

export interface CreateOptions {
  guildId: string;
  channelId: string;
  organizerId: string;
  title: string | null;
  members: "auto" | "manual" | null;
  roleId: string | null;
  deadlineDays: number | null;
  /** 主催者の Discord の言語から決めた、調整の言語（§6.12） */
  lang: Lang;
}

export type CreateResult =
  | { ok: true; pollId: string; reused: boolean; notice: Msg | null; targetType: PollRow["target_type"] }
  | { ok: false; message: Msg };

/**
 * 未入力の下書きを使い回すとき、主催者の言語が変わっていたら、調整の言語と最初の選択肢をその言語にする。
 * 未入力の下書き（候補がない）なので、回答はなく、選択肢を入れ替えても失うものはない
 */
function switchLangStatements(db: D1Database, pollId: string, lang: Lang): D1PreparedStatement[] {
  return [
    // 選択肢を入れ替えるので版を上げる（開いたままの作成画面から古い選択肢で保存されたら、「ほかの画面で変更されています」と知らせる）
    db.prepare("UPDATE polls SET lang = ?, choices_version = choices_version + 1 WHERE id = ?").bind(lang, pollId),
    db.prepare("DELETE FROM choices WHERE poll_id = ?").bind(pollId),
    ...defaultChoiceStatements(db, pollId, lang),
  ];
}

/** 未入力（タイトルも候補もない）の下書き。あれば使い回す（§4.4） */
async function findEmptyDraft(db: D1Database, organizerId: string, channelId: string): Promise<PollRow | null> {
  return db
    .prepare(
      "SELECT * FROM polls WHERE organizer_id = ? AND channel_id = ? AND status = 'draft' AND title IS NULL " +
        "AND NOT EXISTS (SELECT 1 FROM slots WHERE slots.poll_id = polls.id) ORDER BY created_at DESC LIMIT 1",
    )
    .bind(organizerId, channelId)
    .first<PollRow>();
}

export async function createOrReuseDraft(env: Env, opts: CreateOptions): Promise<CreateResult> {
  let o = opts;
  const db = env.DB;
  const now = nowSec();
  const hasOptions = o.title !== null || o.members !== null || o.roleId !== null || o.deadlineDays !== null;

  const existing = await findEmptyDraft(db, o.organizerId, o.channelId);
  if (existing && !hasOptions) {
    if (existing.lang !== o.lang) await db.batch(switchLangStatements(db, existing.id, o.lang));
    return { ok: true, pollId: existing.id, reused: true, notice: null, targetType: existing.target_type };
  }

  // 作成数の上限（§5.4.2）
  if (!(await hitRateLimit(db, `create:user:${o.organizerId}`, 10, 3600, now))) {
    const min = Math.ceil(rateLimitResetIn(3600, now) / 60);
    return {
      ok: false,
      message: msg(`作成数の上限（1 時間に 10 件）に達しました。${min} 分後に再度お試しください。`, `You've reached the limit of 10 polls per hour. Please try again in ${min} minutes.`),
    };
  }
  if (!(await hitRateLimit(db, `create:guild:${o.guildId}`, 100, DAY, now))) {
    return {
      ok: false,
      message: msg("このサーバー全体の作成数の上限（1 日 100 件）に達しました。明日もう一度お試しください。", "This server has reached the limit of 100 polls per day. Please try again tomorrow."),
    };
  }
  const active = await db
    .prepare("SELECT COUNT(*) AS n FROM polls WHERE channel_id = ? AND status IN ('draft','open')")
    .bind(o.channelId)
    .first<{ n: number }>();
  if ((active?.n ?? 0) >= 20 && !existing) {
    return {
      ok: false,
      message: msg("このチャンネルの進行中の調整が多すぎます（20 件まで）。不要な調整を削除してください。", "This channel has too many active polls (up to 20). Please delete polls you no longer need."),
    };
  }

  // コマンドで指定がなければ、サーバーの既定値を使う（§5.3.1）
  let usedDefaultRole = false;
  if (o.members === null && o.roleId === null) {
    const def = await getGuildSettings(db, o.guildId);
    if (def.mode === "manual") o = { ...o, members: "manual" };
    else if (def.mode === "role" && def.roleId) {
      o = { ...o, roleId: def.roleId };
      usedDefaultRole = true;
    }
  }
  const decided = await decideParticipants(env, o.guildId, o.channelId, o.organizerId, o.members === "manual" ? "manual" : "auto", o.roleId, {
    roleIsDefault: usedDefaultRole,
  });
  const finalTarget = decided.targetType;
  const participants = decided.participants;
  const notice = decided.notice;
  o = { ...o, roleId: decided.roleId };

  const deadlineAt = o.deadlineDays ? floorToMinute(now + o.deadlineDays * DAY) : null;
  const pollId = existing?.id ?? randomId();
  const stmts: D1PreparedStatement[] = [];
  if (existing) {
    stmts.push(db.prepare("DELETE FROM participants WHERE poll_id = ?").bind(pollId));
    stmts.push(
      db
        .prepare("UPDATE polls SET title = ?, target_type = ?, target_id = ?, deadline_at = ?, updated_at = ?, purge_after = ? WHERE id = ?")
        .bind(o.title, finalTarget, o.roleId, deadlineAt, now, now + DRAFT_TTL, pollId),
    );
    if (existing.lang !== o.lang) stmts.push(...switchLangStatements(db, pollId, o.lang));
  } else {
    stmts.push(
      db
        .prepare(
          "INSERT INTO polls (id, guild_id, channel_id, organizer_id, title, target_type, target_id, deadline_at, lang, created_at, updated_at, purge_after) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(pollId, o.guildId, o.channelId, o.organizerId, o.title, finalTarget, o.roleId, deadlineAt, o.lang, now, now, now + DRAFT_TTL),
    );
    stmts.push(...defaultChoiceStatements(db, pollId, o.lang));
  }
  if (participants.length) stmts.push(insertParticipantsStatement(db, pollId, participants));
  await db.batch(stmts);
  return { ok: true, pollId, reused: !!existing, notice, targetType: finalTarget };
}

export type TargetType = "channel" | "role" | "manual";

export interface Decided {
  targetType: TargetType;
  roleId: string | null;
  participants: Candidate[];
  notice: Msg | null;
}

/**
 * 参加者の決め方から、実際の参加者を決める（作成時と、作成画面で決め方を変えたときの共通処理。§5.3）
 * - 自動: チャンネルの閲覧者、またはロールのメンバー。取得できなければ手動に切り替えて理由を返す
 * - サーバーの既定のロールを使ったのに誰もいなければ、チャンネルのメンバーにする（§5.3.1）
 * - 手動: 主催者だけを最初の参加者にする
 */
export async function decideParticipants(
  env: Env,
  guildId: string,
  channelId: string,
  organizerId: string,
  members: "auto" | "manual",
  roleId: string | null,
  opts: { roleIsDefault?: boolean } = {},
): Promise<Decided> {
  let targetType: TargetType = members === "manual" ? "manual" : roleId ? "role" : "channel";
  let role = targetType === "role" ? roleId : null;
  let notice: Msg | null = null;
  let participants: Candidate[] = [];
  if (targetType !== "manual") {
    let r = await extractParticipants(env, guildId, channelId, role);
    if (r.ok && r.members.length === 0 && role && opts.roleIsDefault) {
      r = await extractParticipants(env, guildId, channelId, null);
      targetType = "channel";
      role = null;
      notice = msg(
        "サーバーの既定のロールを持つメンバーがいないため、このチャンネルのメンバーを参加者にしました。",
        "No one has the server's default role, so the members of this channel were made participants.",
      );
    }
    if (r.ok) participants = r.members;
    else {
      targetType = "manual";
      role = null;
      notice = r.message;
    }
  }
  if (targetType === "manual") {
    const me = await fetchMember(env, guildId, organizerId).catch(() => null);
    participants = me ? [me] : [];
  }
  return { targetType, roleId: role, participants, notice };
}

/** 参加者の決め方を変えたときに、参加者を設定し直す（下書きのときだけ） */
export async function resetParticipants(
  env: Env,
  poll: PollRow,
  members: "auto" | "manual",
  roleId: string | null,
): Promise<{ notice: Msg | null; targetType: TargetType }> {
  const d = await decideParticipants(env, poll.guild_id, poll.channel_id, poll.organizer_id, members, roleId);
  const db = env.DB;
  await db.batch([
    db.prepare("DELETE FROM answers WHERE poll_id = ?").bind(poll.id),
    db.prepare("DELETE FROM participants WHERE poll_id = ?").bind(poll.id),
    db.prepare("UPDATE polls SET target_type = ?, target_id = ?, updated_at = ? WHERE id = ?").bind(d.targetType, d.roleId, nowSec(), poll.id),
    ...(d.participants.length ? [insertParticipantsStatement(db, poll.id, d.participants)] : []),
  ]);
  return { notice: d.notice, targetType: d.targetType };
}
