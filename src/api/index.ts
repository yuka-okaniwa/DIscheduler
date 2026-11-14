// Web API（docs/design.md §8）
import { Hono, type Context } from "hono";
import * as v from "valibot";
import type { Env } from "../core/env";
import {
  clearSessionCookie,
  consumeLink,
  consumeListLink,
  createListSession,
  createSession,
  getListSession,
  getSession,
  listCookieName,
  lookupLinkKind,
  listSessionCookie,
  readCookie,
  sessionCookie,
  sessionCookieName,
  type ListSessionRow,
} from "../auth";
import {
  deletePollData,
  getChoices,
  getParticipant,
  getParticipants,
  getPoll,
  getSlots,
  hitRateLimit,
  hitRateLimitStatement,
  rateLimitAllows,
  insertChoiceStatements,
  insertParticipantsStatement,
  readPollWithData,
  type PollWithData,
  type PollRow,
  type SlotRow,
  type SessionRow,
} from "../db";
import { fetchMember, searchMembers } from "../discord/members";
import { buildAnnounceMessage, buildDeletedMessage, buildFixedMessage, buildMentionMessage, buildPollMessage, escapeMarkdown, messageLink, pollTitle, rawPollTitle, slotWhen } from "../discord/messages";
import { discord, DiscordError, type DiscordChannel, type DiscordRole } from "../discord/rest";
import { AppError, DAY, floorToMinute, nowSec, randomId, timingSafeEqual } from "../core/lib";
import { DEFAULT_DEADLINE_DAYS, resetParticipants, RETENTION } from "../polls/create";
import { canAnswer, effectiveStatus, LIMITS, reminderAt, UNANSWERED } from "../shared/model";
import { isValidTimeZone, nextCronAt } from "../shared/time";
import { isValidDonationUrl } from "../shared/text";
import { decodeMsg, msg, pick, requestLang, translator, type Lang, type Msg } from "../shared/i18n";
import { getRecentTimes, mergeRanges, rangesFromSlots, saveRecentTimesStatement } from "../guilds/recent-times";
import { getEventDefaults } from "../guilds/settings";
import { syncAfterAnswer, syncNow } from "../polls/sync";
import { AnnounceBody, AnswersBody, ChoicesBody, FixBody, OpenPollBody, ParticipantsBody, PatchPollBody, SessionBody, SlotsBody } from "./schemas";

type Vars = { session: SessionRow; poll: PollRow };
type C = Context<{ Bindings: Env; Variables: Vars }>;

export const api = new Hono<{ Bindings: Env; Variables: Vars }>();

// --- 共通の前処理 ---

/** 画面の言語（エラーと警告の文言に使う。§6.12） */
const reqLang = (c: { req: { header(name: string): string | undefined } }): Lang => requestLang((n) => c.req.header(n));

/** 警告の一覧を、画面の言語の文言にする */
const localize = (c: { req: { header(name: string): string | undefined } }, list: Msg[]): string[] => {
  const lang = reqLang(c);
  return list.map((w) => pick(w, lang));
};

api.use("*", async (c, next) => {
  if (c.env.MAINTENANCE === "1") throw new AppError(503, "maintenance", msg("DIscheduler は現在メンテナンス中です。", "DIscheduler is under maintenance."));
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    // CSRF 対策: Origin の完全一致と JSON の Content-Type を必須にする（security-design T-3）
    const origin = c.req.header("Origin");
    if (!origin || origin !== new URL(c.req.url).origin) throw new AppError(403, "bad_origin", msg("不正なリクエストです。", "Invalid request."));
    const ct = c.req.header("Content-Type") ?? "";
    if (!ct.toLowerCase().startsWith("application/json")) throw new AppError(415, "bad_content_type", msg("不正なリクエストです。", "Invalid request."));
    const len = Number(c.req.header("Content-Length") ?? "0");
    if (len > LIMITS.bodyBytesMax) throw new AppError(413, "too_large", msg("送信する内容が大きすぎます。", "The request is too large."));
  }
  await next();
});

async function readJson<T extends v.GenericSchema>(c: C | Context<{ Bindings: Env }>, schema: T): Promise<v.InferOutput<T>> {
  const text = await c.req.text();
  if (text.length > LIMITS.bodyBytesMax) throw new AppError(413, "too_large", msg("送信する内容が大きすぎます。", "The request is too large."));
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new AppError(400, "bad_json", msg("不正なリクエストです。", "Invalid request."));
  }
  const r = v.safeParse(schema, data);
  if (!r.success) {
    // スキーマの文言は日本語と英語の組（vmsg）。valibot が付ける英語の既定の文言（Invalid ...）は使わない
    const found = r.issues.find((i) => !i.message.startsWith("Invalid"))?.message;
    throw new AppError(400, "invalid", found ? decodeMsg(found) : msg("入力内容が正しくありません。", "The input is not valid."));
  }
  return r.output;
}

// --- セッション ---

api.post("/session", async (c) => {
  const body = await readJson(c, SessionBody);
  const link = await consumeLink(c.env.DB, body.token);
  if (!link) {
    // 主催者の調整一覧（S9）のリンクなら、サーバー単位のセッションを発行する（§6.11）
    const list = await consumeListLink(c.env.DB, body.token);
    if (list) {
      const { sid } = await createListSession(c.env.DB, list.guild_id, list.user_id);
      c.header("Set-Cookie", listSessionCookie(list.guild_id, sid));
      return c.json({ redirect: `/g/${list.guild_id}/polls` });
    }
  }
  if (!link) {
    // リンクの種類に合わせて、新しいリンクの受け取り方を案内する（Discord に残っている前のリンクを開き直さないように）
    const kind = await lookupLinkKind(c.env.DB, body.token);
    const how =
      kind === "answer"
        ? msg("チャンネルの募集メッセージの［回答する］を、もう一度押してください。", "Press [Answer] on the poll message in the channel again.")
        : kind === "view"
          ? msg("チャンネルの募集メッセージの［集計を見る］を、もう一度押してください。", "Press [View results] on the poll message in the channel again.")
          : kind === "edit" || kind === "list"
            ? msg("Discord でもう一度 /schedule を実行し、［作成した調整を管理］を押して、新しいリンクを受け取ってください。", "Run /schedule in Discord again and press [Manage my polls] to get a new link.")
            : msg(
                "参加者はチャンネルの募集メッセージの［回答する］または［集計を見る］を、主催者は Discord で /schedule を実行して［作成した調整を管理］を、もう一度押してください。",
                "Participants: press [Answer] or [View results] on the poll message again. Organizers: run /schedule in Discord and press [Manage my polls] again.",
              );
    throw new AppError(
      401,
      "link_expired",
      msg(
        `リンクの有効期限が切れているか、すでに使われています。Discord で前に受け取ったリンクは、無効になっています。${how.ja}`,
        `This link has expired or has already been used. Links you received earlier in Discord no longer work. ${how.en}`,
      ),
    );
  }
  const poll = await getPoll(c.env.DB, link.poll_id);
  if (!poll || poll.status === "cancelled") throw new AppError(404, "not_found", msg("この調整は削除されました。", "This poll has been deleted."));
  if (link.role === "participant" && !(await getParticipant(c.env.DB, poll.id, link.user_id))) {
    throw new AppError(403, "not_participant", msg("この調整の参加者ではありません。", "You are not a participant in this poll."));
  }
  const { sid } = await createSession(c.env.DB, poll.id, link.user_id, link.role);
  const path = link.purpose === "edit" ? `/p/${poll.id}/edit` : link.purpose === "answer" ? `/p/${poll.id}/answer` : `/p/${poll.id}`;
  c.header("Set-Cookie", sessionCookie(poll.id, sid));
  return c.json({ redirect: path });
});

// --- 調整ごとの API（セッション必須） ---

const polls = new Hono<{ Bindings: Env; Variables: Vars }>();

// Hono の "/:id/*" は "/:id" にも一致するので、1 つだけ登録する（2 回実行しない）
polls.use("/:id/*", loadSession);

async function loadSession(c: C, next: () => Promise<void>) {
  const id = c.req.param("id") ?? "";
  if (!/^[A-Za-z0-9_-]{22}$/.test(id)) throw new AppError(404, "not_found", msg("調整が見つかりません。", "Poll not found."));
  const sid = readCookie(c.req.header("Cookie") ?? null, sessionCookieName(id));
  const session = sid ? await getSession(c.env.DB, id, sid) : null;
  if (!session) throw new AppError(401, "no_session", msg("リンクの有効期限が切れています。Discord で前に受け取ったリンクは、無効になっています。", "This link has expired. Links you received earlier in Discord no longer work."));
  // GET /:id は、調整と関連データをハンドラで 1 文で読むので、ここでは読まない（同じ行を 2 回読まないため）
  const isDetail = c.req.method === "GET" && /^\/api\/polls\/[A-Za-z0-9_-]{22}\/?$/.test(c.req.path);
  const poll = isDetail ? null : await getPoll(c.env.DB, id);
  if (!isDetail && (!poll || poll.status === "cancelled")) throw new AppError(404, "not_found", msg("この調整は削除されました。", "This poll has been deleted."));
  if (c.req.method !== "GET") {
    const token = c.req.header("X-CSRF-Token") ?? "";
    if (!timingSafeEqual(token, session.csrf_token)) throw new AppError(403, "bad_csrf", msg("不正なリクエストです。画面を再読み込みしてください。", "Invalid request. Please reload the page."));
  }
  c.set("session", session);
  if (poll) c.set("poll", poll);
  await next();
}

function requireOrganizer(c: C): void {
  if (c.var.session.role !== "organizer" || c.var.poll.organizer_id !== c.var.session.user_id) {
    throw new AppError(403, "forbidden", msg("この操作は主催者だけができます。", "Only the organizer can do this."));
  }
}

function donationUrl(env: Env): string | null {
  return isValidDonationUrl(env.DONATION_URL) ? env.DONATION_URL : null;
}

polls.get("/:id", async (c) => {
  const { session } = c.var;
  const db = c.env.DB;
  const now = nowSec();
  const isOrganizer = session.role === "organizer";
  // 調整と関連データは 1 文で読む（画面を開くたびに呼ばれるため、問い合わせの回数を抑える）
  const data = await readPollWithData(db, session.poll_id);
  if (!data || data.poll.status === "cancelled") throw new AppError(404, "not_found", msg("この調整は削除されました。", "This poll has been deleted."));
  const { poll, slots, choices, participants, answers } = data;
  if (poll.status === "draft" && !isOrganizer) throw new AppError(404, "not_found", msg("この調整はまだ公開されていません。", "This poll has not been published yet."));
  const me = participants.find((p) => p.user_id === session.user_id);
  if (!me && !isOrganizer) throw new AppError(403, "not_participant", msg("この調整の参加者ではありません。", "You are not a participant in this poll."));
  // 未反映の回答の変更は、読み込み済みの回答から数える（問い合わせを増やさない）
  const pending = isOrganizer ? answers.filter((a) => a.updated_at > (poll.last_synced_at ?? 0)).length : null;
  // サーバーの最近使った時間帯は、候補日時を編集できる主催者にだけ返す（§6.3.1）
  // イベントの場所の既定値（§5.3.1）も、確定できる主催者にだけ返す
  const [recentTimes, eventDefaults] = isOrganizer
    ? await Promise.all([getRecentTimes(db, poll.guild_id), getEventDefaults(db, poll.guild_id)])
    : [[], { location: null, channelId: null }];
  return c.json({
    now,
    csrfToken: session.csrf_token,
    donationUrl: donationUrl(c.env),
    poll: {
      id: poll.id,
      title: poll.title,
      description: poll.description,
      status: effectiveStatus(poll.status, poll.deadline_at, now),
      deadlineAt: poll.deadline_at,
      timezone: poll.timezone,
      timezoneSet: poll.timezone_set === 1,
      targetType: poll.target_type,
      targetId: poll.target_id,
      joinPolicy: poll.join_policy,
      choicesVersion: poll.choices_version,
      updatedAt: poll.updated_at,
      messageUrl: poll.message_id ? messageLink(poll.guild_id, poll.channel_id, poll.message_id) : null,
      lastSyncedAt: isOrganizer ? poll.last_synced_at : null,
      pendingChanges: pending,
      nextAutoSyncAt: isOrganizer ? nextCronAt(now) : null,
      choicesChangedAt: poll.choices_changed_at,
      remindDayOffset: poll.remind_day_offset,
      remindHour: poll.remind_hour,
    },
    me: {
      userId: session.user_id,
      role: session.role,
      isParticipant: !!me,
      displayName: me?.display_name ?? null,
      comment: me?.comment ?? null,
      answeredAt: me?.answered_at ?? null,
      // 回答のあとで選択肢が変わり、まだ確認していなければ true（§6.9.4）
      needsChoicesAck:
        !!me &&
        poll.choices_changed_at !== null &&
        (me.answered_at ?? 0) > 0 &&
        (me.choices_ack_version ?? 0) < poll.choices_version &&
        answers.some((a) => a.user_id === me.user_id && a.updated_at <= poll.choices_changed_at!),
    },
    slots: slots.map((s) => ({ id: s.id, startAt: s.start_at, endAt: s.end_at, allDay: s.all_day === 1, fixedAt: s.fixed_at, hasEvent: s.discord_event_id !== null, announced: s.announced_fixed === 1 })),
    choices: choices.map((ch) => ({ id: ch.id, symbol: ch.symbol, label: ch.label, kind: ch.kind, score: ch.score, color: ch.color })),
    participants: participants.map((p) => ({ userId: p.user_id, displayName: p.display_name, comment: p.comment, answeredAt: p.answered_at })),
    answers: answers.map((a) => ({ slotId: a.slot_id, userId: a.user_id, choiceId: a.choice_id, prevChoiceId: a.prev_choice_id, updatedAt: a.updated_at })),
    recentTimes,
    defaultEventLocation: eventDefaults.location,
    defaultEventChannelId: eventDefaults.channelId,
  });
});

polls.patch("/:id", async (c) => {
  requireOrganizer(c);
  const body = await readJson(c, PatchPollBody);
  const { poll } = c.var;
  const db = c.env.DB;
  const now = nowSec();
  if (body.updatedAt !== undefined && body.updatedAt !== poll.updated_at) {
    throw new AppError(409, "conflict", msg("ほかの画面で変更されています。画面を再読み込みしてください。", "This poll was changed in another window. Please reload the page."));
  }
  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  if (body.title !== undefined) {
    sets.push("title = ?");
    binds.push(body.title);
  }
  if (body.description !== undefined) {
    sets.push("description = ?");
    binds.push(body.description && body.description.trim() ? body.description.trim() : null);
  }
  // 締切は画面で分まで入力するので、分単位で同じなら「変えていない」とみなす
  const deadlineChanged = body.deadlineAt !== undefined && (poll.deadline_at === null || floorToMinute(body.deadlineAt) !== floorToMinute(poll.deadline_at));
  if (body.deadlineAt !== undefined && deadlineChanged) {
    if (body.deadlineAt < now - DAY || body.deadlineAt > now + 365 * DAY) throw new AppError(400, "invalid", msg("締切は今日から 1 年以内にしてください。", "Set the deadline within one year from today."));
    sets.push("deadline_at = ?");
    binds.push(floorToMinute(body.deadlineAt));
    if (poll.status === "closed" && body.deadlineAt > now) {
      sets.push("status = 'open'");
    }
    if (poll.status !== "draft" && poll.status !== "fixed") {
      sets.push("purge_after = ?");
      binds.push(body.deadlineAt + RETENTION);
    }
  }
  if (body.timezone !== undefined) {
    if (!isValidTimeZone(body.timezone)) throw new AppError(400, "invalid", msg("タイムゾーンが正しくありません。", "Invalid time zone."));
    // 主催者が選んだとき（timezoneAuto でないとき）は、以後ブラウザのタイムゾーンで上書きしない
    if (!body.timezoneAuto || poll.timezone_set === 0) {
      sets.push("timezone = ?", "timezone_set = ?");
      binds.push(body.timezone, body.timezoneAuto ? 0 : 1);
    }
  }
  if (body.remindDayOffset !== undefined) {
    sets.push("remind_day_offset = ?");
    binds.push(body.remindDayOffset);
  }
  if (body.remindHour !== undefined) {
    sets.push("remind_hour = ?");
    binds.push(body.remindHour);
  }
  if (body.joinPolicy !== undefined) {
    sets.push("join_policy = ?");
    binds.push(body.joinPolicy);
  }
  let notice: Msg | null = null;
  if (body.members !== undefined || body.roleId !== undefined) {
    if (poll.status !== "draft") throw new AppError(409, "published", msg("公開後は参加者の決め方を変えられません。参加者の追加・削除をお使いください。", "You can't change how participants are chosen after publishing. Add or remove participants instead."));
    const members = body.members ?? (poll.target_type === "manual" ? "manual" : "auto");
    const roleId = body.roleId !== undefined ? body.roleId : poll.target_id;
    notice = (await resetParticipants(c.env, poll, members, members === "manual" ? null : roleId)).notice;
  }
  if (sets.length > 0) {
    sets.push("updated_at = ?");
    binds.push(now);
    await db.prepare(`UPDATE polls SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, poll.id).run();
  }
  if (poll.status !== "draft" && sets.length > 0) {
    c.executionCtx.waitUntil(syncNow(c.env, poll.id));
  }
  return c.json({ ok: true, notice: notice ? pick(notice, reqLang(c)) : null });
});

polls.put("/:id/slots", async (c) => {
  requireOrganizer(c);
  const body = await readJson(c, SlotsBody);
  const { poll } = c.var;
  const db = c.env.DB;
  const now = nowSec();
  if (body.updatedAt !== undefined && body.updatedAt !== poll.updated_at) {
    throw new AppError(409, "conflict", msg("ほかの画面で変更されています。画面を再読み込みしてください。", "This poll was changed in another window. Please reload the page."));
  }
  const existing = await getSlots(db, poll.id);
  const existingIds = new Set(existing.map((s) => s.id));
  const seen = new Set<string>();
  const seenIds = new Set<string>();
  for (const s of body.slots) {
    if (s.id && !existingIds.has(s.id)) throw new AppError(400, "invalid", msg("候補が見つかりません。画面を再読み込みしてください。", "Date option not found. Please reload the page."));
    if (s.id && seenIds.has(s.id)) throw new AppError(400, "invalid", msg("同じ候補が重複しています。画面を再読み込みしてください。", "The same date option appears twice. Please reload the page."));
    if (s.id) seenIds.add(s.id);
    if (s.endAt !== null && s.endAt <= s.startAt) throw new AppError(400, "invalid", msg("終了は開始より後にしてください。", "The end must be after the start."));
    if (s.startAt < now - 366 * DAY || s.startAt > now + 2 * 365 * DAY) throw new AppError(400, "invalid", msg("候補の日時が範囲外です。", "A date option is out of range."));
    const key = `${s.startAt}-${s.endAt}`;
    if (seen.has(key)) throw new AppError(400, "invalid", msg("同じ候補が重複しています。", "The same date option appears twice."));
    seen.add(key);
  }
  const keepIds = new Set(body.slots.filter((s) => s.id).map((s) => s.id!));
  if (existing.some((s) => s.fixed_at !== null && !keepIds.has(s.id))) throw new AppError(409, "fixed_slot", msg("確定した候補は削除できません。確定を取り消してから削除してください。", "You can't delete a confirmed date. Cancel the confirmation first."));
  const sorted = [...body.slots].sort((a, b) => a.startAt - b.startAt);
  const stmts: D1PreparedStatement[] = [];
  for (const old of existing) {
    if (!keepIds.has(old.id)) {
      stmts.push(db.prepare("DELETE FROM answers WHERE slot_id = ?").bind(old.id));
      stmts.push(db.prepare("DELETE FROM slots WHERE id = ?").bind(old.id));
    }
  }
  // UNIQUE 制約にぶつからないよう、残す候補はいったん仮の位置・時刻にずらしてから書き換える
  sorted.forEach((s, i) => {
    if (s.id) stmts.push(db.prepare("UPDATE slots SET start_at = ?, end_at = ?, position = ? WHERE id = ?").bind(-1 - i, null, i, s.id));
  });
  sorted.forEach((s, i) => {
    if (s.id) {
      stmts.push(db.prepare("UPDATE slots SET start_at = ?, end_at = ?, all_day = ?, position = ? WHERE id = ?").bind(s.startAt, s.endAt, s.allDay ? 1 : 0, i, s.id));
    } else {
      stmts.push(
        db.prepare("INSERT INTO slots (id, poll_id, start_at, end_at, all_day, position) VALUES (?, ?, ?, ?, ?, ?)").bind(randomId(), poll.id, s.startAt, s.endAt, s.allDay ? 1 : 0, i),
      );
    }
  });
  // 新しく追加した候補の時間帯を、サーバーの最近使った時間帯として覚える（§6.3.1）
  const newRanges = rangesFromSlots(body.slots.filter((s) => !s.id), poll.timezone);
  if (newRanges.length) stmts.push(saveRecentTimesStatement(db, poll.guild_id, mergeRanges(newRanges, await getRecentTimes(db, poll.guild_id)), now));
  // 確定した候補の日時が変わったら、データの削除時刻も決め直す（いちばん遅い確定日時から 6 か月後）
  stmts.push(poll.status === "fixed" ? refreshFixedStatement(db, poll, now) : db.prepare("UPDATE polls SET updated_at = ? WHERE id = ?").bind(now, poll.id));
  await db.batch(stmts);
  if (poll.status !== "draft") c.executionCtx.waitUntil(syncNow(c.env, poll.id));
  // 確定した候補の日時を変えたときは、登録済みの Discord イベントの日時も合わせる
  const warnings: Msg[] = [];
  for (const oldFixed of existing) {
    if (!oldFixed.discord_event_id) continue;
    const newFixed = body.slots.find((s) => s.id === oldFixed.id);
    if (newFixed && (oldFixed.start_at !== newFixed.startAt || oldFixed.end_at !== newFixed.endAt || (oldFixed.all_day === 1) !== newFixed.allDay)) {
      const err = await updateEventTime(c.env, poll, oldFixed, { start_at: newFixed.startAt, end_at: newFixed.endAt, all_day: newFixed.allDay ? 1 : 0 });
      if (err && !warnings.some((w) => w.ja === err.ja)) warnings.push(err);
    }
  }
  return c.json({ ok: true, updatedAt: now, warnings: localize(c, warnings) });
});

polls.put("/:id/choices", async (c) => {
  requireOrganizer(c);
  const body = await readJson(c, ChoicesBody);
  const { poll } = c.var;
  const db = c.env.DB;
  const now = nowSec();
  const status = effectiveStatus(poll.status, poll.deadline_at, now);
  if (status === "closed" || status === "fixed") throw new AppError(409, "locked", msg("締切後・確定後は選択肢を変更できません。", "You can't change the answer choices after the deadline or after a date is confirmed."));
  if (body.choicesVersion !== poll.choices_version) throw new AppError(409, "conflict", msg("選択肢がほかの画面で変更されています。画面を再読み込みしてください。", "The answer choices were changed in another window. Please reload the page."));
  const kinds = new Set(body.choices.map((ch) => ch.kind));
  if (!kinds.has("ok") || !kinds.has("ng")) throw new AppError(400, "invalid", msg("「参加できる」と「参加できない」の選択肢をそれぞれ 1 つ以上入れてください。", "Include at least one \"available\" choice and one \"not available\" choice."));
  const labels = new Set(body.choices.map((ch) => ch.label));
  if (labels.size !== body.choices.length) throw new AppError(400, "invalid", msg("選択肢の名前が重複しています。", "Two answer choices have the same name."));

  const existing = await getChoices(db, poll.id);
  const existingIds = new Set(existing.map((ch) => ch.id));
  for (const ch of body.choices) if (ch.id && !existingIds.has(ch.id)) throw new AppError(400, "invalid", msg("選択肢が見つかりません。画面を再読み込みしてください。", "Answer choice not found. Please reload the page."));
  const bodyIds = body.choices.filter((ch) => ch.id).map((ch) => ch.id!);
  if (new Set(bodyIds).size !== bodyIds.length) throw new AppError(400, "invalid", msg("同じ選択肢が重複しています。画面を再読み込みしてください。", "The same answer choice appears twice. Please reload the page."));
  const keepIds = new Set(body.choices.filter((ch) => ch.id).map((ch) => ch.id!));
  const removed = existing.filter((ch) => !keepIds.has(ch.id));
  const used = await db.prepare("SELECT choice_id, COUNT(*) AS n FROM answers WHERE poll_id = ? GROUP BY choice_id").bind(poll.id).all<{ choice_id: string; n: number }>();
  const usedIds = new Set(used.results.filter((u) => u.n > 0).map((u) => u.choice_id));
  const reassign = new Map(body.reassign.map((r) => [r.from, r.to]));
  for (const r of removed) {
    if (usedIds.has(r.id)) {
      const to = reassign.get(r.id);
      if (!to || !keepIds.has(to)) throw new AppError(400, "reassign_required", msg("回答がある選択肢を削除するときは、回答の移し先を選んでください。", "To delete a choice that has answers, choose where to move those answers."));
    }
  }
  const stmts: D1PreparedStatement[] = [];
  // 仮の名前にしてから書き換え（名前の UNIQUE 制約のため）
  existing.forEach((ch, i) => stmts.push(db.prepare("UPDATE choices SET label = ? WHERE id = ?").bind(`~${i}`, ch.id)));
  for (const r of removed) {
    const to = reassign.get(r.id);
    if (to) stmts.push(db.prepare("UPDATE answers SET choice_id = ?, updated_at = ? WHERE choice_id = ?").bind(to, now, r.id));
    stmts.push(db.prepare("UPDATE answers SET prev_choice_id = NULL WHERE prev_choice_id = ?").bind(r.id));
    stmts.push(db.prepare("DELETE FROM choices WHERE id = ?").bind(r.id));
  }
  body.choices.forEach((ch, i) => {
    if (ch.id) {
      stmts.push(
        db.prepare("UPDATE choices SET symbol = ?, label = ?, kind = ?, score = ?, color = ?, position = ? WHERE id = ?").bind(ch.symbol, ch.label, ch.kind, ch.score, ch.color, i, ch.id),
      );
    } else {
      stmts.push(...insertChoiceStatements(db, poll.id, [ch]));
    }
  });
  // 公開後に変えたときは、回答画面で「選択肢が変更されました」を出すために時刻を残す（§6.9.4）
  stmts.push(
    db
      .prepare("UPDATE polls SET choices_version = choices_version + 1, updated_at = ?, choices_changed_at = CASE WHEN status = 'draft' THEN choices_changed_at ELSE ? END WHERE id = ?")
      .bind(now, now, poll.id),
  );
  await db.batch(stmts);
  // 新しく追加した選択肢の position を、送られてきた順にそろえる
  const after = await getChoices(db, poll.id);
  const order = body.choices.map((ch) => ch.label);
  await db.batch(after.map((ch) => db.prepare("UPDATE choices SET position = ? WHERE id = ?").bind(order.indexOf(ch.label), ch.id)));
  if (poll.status !== "draft") c.executionCtx.waitUntil(syncNow(c.env, poll.id));
  return c.json({ ok: true, choicesVersion: poll.choices_version + 1 });
});

polls.get("/:id/member-search", async (c) => {
  requireOrganizer(c);
  const q = (c.req.query("q") ?? "").trim();
  if (q.length < 1 || q.length > 32) return c.json({ members: [] });
  if (!(await hitRateLimit(c.env.DB, `search:${c.var.session.user_id}`, 60, 600, nowSec()))) {
    throw new AppError(429, "rate_limited", msg("検索の回数が多すぎます。少し待ってからお試しください。", "Too many searches. Please wait a moment and try again."));
  }
  try {
    const members = await searchMembers(c.env, c.var.poll.guild_id, q);
    return c.json({ members });
  } catch (e) {
    if (e instanceof DiscordError && e.status === 403) throw new AppError(502, "discord_forbidden", msg("Bot にメンバーを検索する権限がありません。", "The bot doesn't have permission to search members."));
    throw e;
  }
});

/** Discord API を呼ぶ一覧の取得の回数制限（Bot 全体の Discord の回数制限を守るため） */
async function limitDiscordLookups(c: C): Promise<void> {
  if (!(await hitRateLimit(c.env.DB, `lookup:${c.var.session.user_id}`, 30, 600, nowSec()))) {
    throw new AppError(429, "rate_limited", msg("読み込みの回数が多すぎます。少し待ってからお試しください。", "Too many requests. Please wait a moment and try again."));
  }
}

polls.get("/:id/roles", async (c) => {
  requireOrganizer(c);
  await limitDiscordLookups(c);
  const roles = await discord<DiscordRole[]>(c.env, "GET", `/guilds/${c.var.poll.guild_id}/roles`);
  return c.json({
    roles: roles
      .filter((r) => r.id !== c.var.poll.guild_id && !r.managed)
      .sort((a, b) => b.position - a.position)
      .map((r) => ({ id: r.id, name: r.name.slice(0, 100) })),
  });
});

polls.get("/:id/voice-channels", async (c) => {
  requireOrganizer(c);
  await limitDiscordLookups(c);
  const channels = await discord<DiscordChannel[]>(c.env, "GET", `/guilds/${c.var.poll.guild_id}/channels`);
  return c.json({
    channels: channels.filter((ch) => ch.type === 2 || ch.type === 13).map((ch) => ({ id: ch.id, name: (ch.name ?? "").slice(0, 100) })),
  });
});

polls.put("/:id/participants", async (c) => {
  requireOrganizer(c);
  const body = await readJson(c, ParticipantsBody);
  const { poll } = c.var;
  const db = c.env.DB;
  const current = await getParticipants(db, poll.id);
  const currentIds = new Set(current.map((p) => p.user_id));
  const toAdd = body.add.filter((id) => !currentIds.has(id));
  if (current.length - body.remove.length + toAdd.length > LIMITS.participantsMax) {
    throw new AppError(400, "too_many", msg(`参加者は ${LIMITS.participantsMax} 人までです。`, `You can have up to ${LIMITS.participantsMax} participants.`));
  }
  // メンバー情報は並列で取得する（最大 25 人）
  const added = (await Promise.all(toAdd.map((id) => fetchMember(c.env, poll.guild_id, id)))).filter((m) => m !== null);
  const stmts: D1PreparedStatement[] = [];
  for (const id of body.remove) {
    stmts.push(db.prepare("DELETE FROM answers WHERE poll_id = ? AND user_id = ?").bind(poll.id, id));
    stmts.push(db.prepare("DELETE FROM participants WHERE poll_id = ? AND user_id = ?").bind(poll.id, id));
    // 外された人は、その時点で画面を開けなくする（主催者自身のセッションは残す）
    if (id !== poll.organizer_id) {
      stmts.push(db.prepare("DELETE FROM sessions WHERE poll_id = ? AND user_id = ?").bind(poll.id, id));
      stmts.push(db.prepare("DELETE FROM link_tokens WHERE poll_id = ? AND user_id = ?").bind(poll.id, id));
    }
  }
  if (added.length) stmts.push(insertParticipantsStatement(db, poll.id, added));
  stmts.push(db.prepare("UPDATE polls SET updated_at = ? WHERE id = ?").bind(nowSec(), poll.id));
  await db.batch(stmts);
  if (poll.status !== "draft") c.executionCtx.waitUntil(syncNow(c.env, poll.id));
  return c.json({ ok: true, added: added.length, notFound: toAdd.length - added.length });
});

/**
 * 募集メッセージを投稿する（公開・投稿し直しの共通処理。§5.5）。
 * 同時に押されても 1 件だけ投稿するよう、投稿の前に publishing_at で権利を取る（60 秒より古い取りかけは取り直せる）。
 * 投稿に成功したら afterPost（DB の更新）を呼び、投稿したメッセージの ID と投稿に使ったデータを返す。失敗しても権利は必ず手放す
 */
async function postPollMessage(
  env: Env,
  pollId: string,
  now: number,
  opts: { draftOnly: boolean; prepare: (data: PollWithData) => PollWithData; afterPost: (messageId: string, data: PollWithData) => Promise<void> },
): Promise<{ messageId: string; data: PollWithData }> {
  const db = env.DB;
  const claimed = await db
    .prepare(
      `UPDATE polls SET publishing_at = ? WHERE id = ? AND ${opts.draftOnly ? "status = 'draft'" : "status IN ('open','closed','fixed')"} ` +
        "AND (publishing_at IS NULL OR publishing_at < ?)",
    )
    .bind(now, pollId, now - 60)
    .run();
  if (claimed.meta.changes !== 1) throw new AppError(409, "publishing", msg("投稿の処理中です。少し待ってから画面を再読み込みしてください。", "Posting is in progress. Please wait a moment and reload the page."));
  try {
    const loaded = await readPollWithData(db, pollId);
    if (!loaded) throw new AppError(404, "not_found", msg("この調整は削除されました。", "This poll has been deleted."));
    const data = opts.prepare(loaded);
    let messageId: string;
    try {
      const res = await discord<{ id: string }>(env, "POST", `/channels/${data.poll.channel_id}/messages`, buildPollMessage({ ...data, now }));
      messageId = res.id;
    } catch (e) {
      if (e instanceof DiscordError && (e.status === 403 || e.status === 404)) {
        throw new AppError(502, "discord_forbidden", msg("チャンネルに投稿できませんでした。Bot にこのチャンネルの「チャンネルを見る」「メッセージを送信」の権限があるか確認してください。", "Couldn't post to the channel. Check that the bot has the \"View Channel\" and \"Send Messages\" permissions in this channel."));
      }
      throw e;
    }
    await opts.afterPost(messageId, data);
    return { messageId, data };
  } finally {
    await db.prepare("UPDATE polls SET publishing_at = NULL WHERE id = ? AND publishing_at = ?").bind(pollId, now).run();
  }
}

polls.post("/:id/publish", async (c) => {
  requireOrganizer(c);
  const { poll } = c.var;
  const db = c.env.DB;
  const now = nowSec();
  if (poll.status !== "draft") throw new AppError(409, "published", msg("この調整はすでに公開されています。", "This poll has already been published."));
  if (!poll.title) throw new AppError(400, "no_title", msg("タイトルを入力してください。", "Enter a title."));
  const deadlineAt = poll.deadline_at && poll.deadline_at > now ? poll.deadline_at : floorToMinute(now + DEFAULT_DEADLINE_DAYS * DAY);
  const { messageId, data: posted } = await postPollMessage(c.env, poll.id, now, {
    draftOnly: true,
    prepare: (data) => {
      if (data.slots.length === 0) throw new AppError(400, "no_slots", msg("候補日時を 1 件以上入れてください。", "Add at least one date option."));
      if (data.participants.length === 0) throw new AppError(400, "no_participants", msg("参加者を 1 人以上入れてください。", "Add at least one participant."));
      return { ...data, poll: { ...data.poll, status: "open", deadline_at: deadlineAt }, answers: [] };
    },
    afterPost: async (messageId) => {
      await db
        .prepare(
          // publishing_at は postPollMessage の finally で外す
          "UPDATE polls SET status = 'open', deadline_at = ?, message_id = ?, last_synced_at = ?, updated_at = ?, purge_after = ? " +
            "WHERE id = ? AND status = 'draft' AND publishing_at = ?",
        )
        .bind(deadlineAt, messageId, now, now, deadlineAt + RETENTION, poll.id, now)
        .run();
    },
  });
  // 募集を始めたことを、ロール（ロールがなければ @everyone）へのメンションで知らせる（§5.5）。
  // 投稿し直しのときは知らせない。失敗しても公開そのものは済んでいるので、エラーにはしない
  await discord(c.env, "POST", `/channels/${posted.poll.channel_id}/messages`, buildAnnounceMessage(posted.poll, messageId)).catch(() => undefined);
  return c.json({ ok: true, redirect: `/p/${poll.id}/done?kind=published` });
});

polls.put("/:id/answers/me", async (c) => {
  const body = await readJson(c, AnswersBody);
  const { poll, session } = c.var;
  const db = c.env.DB;
  const now = nowSec();
  const status = effectiveStatus(poll.status, poll.deadline_at, now);
  if (poll.status === "draft") throw new AppError(403, "draft", msg("この調整はまだ公開されていません。", "This poll has not been published yet."));
  if (!canAnswer(status)) throw new AppError(409, "closed", msg("この調整にはいま回答できません。", "This poll isn't accepting answers right now."));
  if (body.choicesVersion !== poll.choices_version) throw new AppError(409, "choices_changed", msg("選択肢が変更されました。画面を再読み込みしてから入力し直してください。", "The answer choices have changed. Please reload the page and answer again."));
  if (!(await hitRateLimit(db, `answer:${session.user_id}`, 30, 600, now))) {
    throw new AppError(429, "rate_limited", msg("保存の回数が多すぎます。少し待ってからお試しください。", "Too many saves. Please wait a moment and try again."));
  }
  // 参加者・候補・選択肢・これまでの回答は 1 文で読む（回答の保存はいちばん多い書き込みなので、問い合わせを減らす）
  const data = await readPollWithData(db, poll.id);
  if (!data) throw new AppError(404, "not_found", msg("この調整は削除されました。", "This poll has been deleted."));
  const { slots, choices } = data;
  if (!data.participants.some((p) => p.user_id === session.user_id)) {
    throw new AppError(403, "not_participant", msg("この調整の参加者ではないため、回答できません。", "You can't answer because you are not a participant in this poll."));
  }
  const slotIds = new Set(slots.map((s) => s.id));
  const choiceIds = new Set(choices.map((ch) => ch.id));
  const seen = new Set<string>();
  for (const a of body.answers) {
    if (!slotIds.has(a.slotId) || !choiceIds.has(a.choiceId)) throw new AppError(400, "invalid", msg("候補または選択肢が見つかりません。画面を再読み込みしてください。", "Date option or answer choice not found. Please reload the page."));
    if (seen.has(a.slotId)) throw new AppError(400, "invalid", msg("同じ候補への回答が重複しています。", "There are two answers for the same date option."));
    seen.add(a.slotId);
  }
  const old = new Map(data.answers.filter((a) => a.user_id === session.user_id).map((r) => [r.slot_id, r]));
  const isFixed = poll.status === "fixed";
  // 確定した候補だけ、確定時点の回答からの変更を記録する（§6.5）
  const fixedSlotIds = new Set(slots.filter((s) => s.fixed_at !== null).map((s) => s.id));
  const stmts: D1PreparedStatement[] = [];
  for (const a of body.answers) {
    const prev = old.get(a.slotId);
    if (prev && prev.choice_id === a.choiceId) continue;
    // 確定後に変えた場合は、確定時点の選択肢を残す（元に戻したら消す）。
    // 確定時点で未回答だった場合は、空文字（UNANSWERED）を残す
    let prevChoice: string | null = null;
    if (fixedSlotIds.has(a.slotId)) {
      const atFix = prev ? (prev.prev_choice_id ?? prev.choice_id) : UNANSWERED;
      prevChoice = atFix === a.choiceId ? null : atFix;
    }
    stmts.push(
      db
        .prepare(
          "INSERT INTO answers (poll_id, slot_id, user_id, choice_id, prev_choice_id, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(slot_id, user_id) DO UPDATE SET choice_id = excluded.choice_id, prev_choice_id = excluded.prev_choice_id, updated_at = excluded.updated_at",
        )
        .bind(poll.id, a.slotId, session.user_id, a.choiceId, prevChoice, now),
    );
  }
  // 確定後は、送られなかった候補の回答を消さない（確定時点の回答の記録が消えてしまうため）
  if (!isFixed) {
    for (const [slotId] of old) {
      if (!seen.has(slotId)) stmts.push(db.prepare("DELETE FROM answers WHERE slot_id = ? AND user_id = ?").bind(slotId, session.user_id));
    }
  }
  stmts.push(
    // 回答が 1 件でも残っていれば回答済み（確定後は送らなかった候補の回答も残るため、件数ではなく実際の行で判定する）
    db
      .prepare(
        "UPDATE participants SET comment = ?, answered_at = CASE WHEN EXISTS (SELECT 1 FROM answers WHERE poll_id = ? AND user_id = ?) THEN ? ELSE NULL END " +
          "WHERE poll_id = ? AND user_id = ?",
      )
      .bind(body.comment || null, poll.id, session.user_id, now, poll.id, session.user_id),
  );
  await db.batch(stmts);
  // 確定後は 1 日 2 回の Cron と手動更新に任せる（§5.5）
  if (!isFixed) c.executionCtx.waitUntil(syncAfterAnswer(c.env, poll.id));
  return c.json({ ok: true });
});

/** 登録済みの Discord イベントを消す。すでに消えていれば何もしない。消せなかったら警告の文を返す */
async function deleteEvent(env: Env, poll: PollRow, slot: SlotRow): Promise<Msg | null> {
  if (!slot.discord_event_id) return null;
  try {
    await discord(env, "DELETE", `/guilds/${poll.guild_id}/scheduled-events/${slot.discord_event_id}`);
  } catch (e) {
    // 消せなくても記録は外す（古いイベントが取り消した候補に結び付いたまま残らないように。主催者には Discord で消すよう知らせる）
    if (!(e instanceof DiscordError && e.status === 404)) {
      await env.DB.prepare("UPDATE slots SET discord_event_id = NULL WHERE id = ?").bind(slot.id).run();
      return msg("登録済みの Discord イベントを削除できませんでした。Discord で削除してください。", "Couldn't delete the Discord event. Please delete it in Discord.");
    }
  }
  await env.DB.prepare("UPDATE slots SET discord_event_id = NULL WHERE id = ?").bind(slot.id).run();
  return null;
}

/** 調整のステータスと削除時刻を、確定した候補の有無から決め直す文（確定・取り消しが重なっても、slots の状態と食い違わないよう SQL の中で数える） */
function refreshFixedStatement(db: D1Database, poll: PollRow, now: number): D1PreparedStatement {
  return db
    .prepare(
      "UPDATE polls SET " +
        "status = CASE WHEN EXISTS (SELECT 1 FROM slots WHERE poll_id = ?1 AND fixed_at IS NOT NULL) THEN 'fixed' ELSE 'open' END, " +
        "purge_after = COALESCE((SELECT MAX(MAX(start_at), ?2) FROM slots WHERE poll_id = ?1 AND fixed_at IS NOT NULL), MAX(COALESCE(deadline_at, ?2), ?2)) + ?3, " +
        "updated_at = ?2 WHERE id = ?1",
    )
    .bind(poll.id, now, RETENTION);
}

// 候補を確定する。確定済みの候補はそのまま残し、複数の候補を確定できる（§4.3）。
// チャンネルへのお知らせはここではせず、主催者が［確定をお知らせする］（POST /announce）でまとめて投稿する
polls.post("/:id/fix", async (c) => {
  requireOrganizer(c);
  const body = await readJson(c, FixBody);
  const { poll } = c.var;
  const db = c.env.DB;
  const now = nowSec();
  if (!canAnswer(poll.status)) throw new AppError(409, "not_published", msg("公開中の調整だけ確定できます。", "You can only confirm dates in a published poll."));
  const slots = await getSlots(db, poll.id);
  const slot = slots.find((s) => s.id === body.slotId);
  if (!slot) throw new AppError(400, "invalid", msg("候補が見つかりません。", "Date option not found."));
  const alreadyFixed = () => new AppError(409, "already_fixed", msg("この候補はすでに確定しています。画面を再読み込みしてください。", "This date is already confirmed. Please reload the page."));
  if (slot.fixed_at !== null) throw alreadyFixed();
  // 先に確定の権利を取る（同時に 2 回押されても、イベントの登録などは 1 回だけにする）
  const claimed = await db.prepare("UPDATE slots SET fixed_at = ? WHERE id = ? AND fixed_at IS NULL").bind(now, slot.id).run();
  if (claimed.meta.changes !== 1) throw alreadyFixed();
  await db.batch([
    // この候補の「確定後の変更」の記録は、確定した時点から数える
    db.prepare("UPDATE answers SET prev_choice_id = NULL WHERE slot_id = ?").bind(slot.id),
    refreshFixedStatement(db, poll, now),
  ]);
  const warnings: Msg[] = [];
  await syncNow(c.env, poll.id).catch(() => warnings.push(msg("募集メッセージを更新できませんでした。", "Couldn't update the poll message.")));
  if (body.event) {
    const err = await upsertEvent(c.env, poll, slot, body.event);
    if (err) warnings.push(err);
  }
  return c.json({ ok: true, warnings: localize(c, warnings) });
});

// 確定を取り消す（主催者）。Discord イベントを消す。チャンネルへのお知らせは［確定をお知らせする］でまとめて投稿する。
// 確定した候補がなくなったら、募集中（締切を過ぎていれば締切後）に戻る
polls.delete("/:id/fix/:slotId", async (c) => {
  requireOrganizer(c);
  const { poll } = c.var;
  const db = c.env.DB;
  const now = nowSec();
  const slots = await getSlots(db, poll.id);
  const slot = slots.find((s) => s.id === c.req.param("slotId"));
  if (!slot) throw new AppError(404, "not_found", msg("候補が見つかりません。画面を再読み込みしてください。", "Date option not found. Please reload the page."));
  if (slot.fixed_at === null) throw new AppError(409, "not_fixed", msg("この候補は確定していません。画面を再読み込みしてください。", "This date isn't confirmed. Please reload the page."));

  const warnings: Msg[] = [];
  const err = await deleteEvent(c.env, poll, slot);
  if (err) warnings.push(err);
  await db.batch([
    db.prepare("UPDATE answers SET prev_choice_id = NULL WHERE slot_id = ?").bind(slot.id),
    // 取り消した日時にリマインドを送らないよう、送った記録も消す（もう一度確定したら改めて送る）
    db.prepare("UPDATE slots SET fixed_at = NULL, day_reminded_at = NULL WHERE id = ?").bind(slot.id),
    refreshFixedStatement(db, poll, now),
  ]);
  await syncNow(c.env, poll.id).catch(() => warnings.push(msg("募集メッセージを更新できませんでした。", "Couldn't update the poll message.")));
  return c.json({ ok: true, warnings: localize(c, warnings) });
});

// 確定をお知らせする（主催者）。いま確定している日時と、前回のお知らせのあとに取り消した日時を、1 つのメッセージにまとめて投稿する（§4.3）
polls.post("/:id/announce", async (c) => {
  requireOrganizer(c);
  const body = await readJson(c, AnnounceBody);
  const { poll } = c.var;
  const db = c.env.DB;
  const now = nowSec();
  if (!canAnswer(poll.status)) throw new AppError(409, "not_published", msg("公開中の調整だけお知らせできます。", "You can only announce dates for a published poll."));
  const slots = await getSlots(db, poll.id);
  const fixed = slots.filter((s) => s.fixed_at !== null);
  const cancelled = slots.filter((s) => s.fixed_at === null && s.announced_fixed === 1);
  if (!fixed.length && !cancelled.length) throw new AppError(409, "nothing", msg("お知らせする確定日・取り消しがありません。", "There are no confirmed or cancelled dates to announce."));
  // チャンネルへの投稿が続かないよう、1 つの調整につき 1 時間に 10 回まで
  if (!(await hitRateLimit(db, `announce:${poll.id}`, 10, 3600, now))) throw new AppError(429, "rate_limited", msg("確定のお知らせは 1 時間に 10 回までです。", "You can announce dates up to 10 times per hour."));

  const warnings: Msg[] = [];
  // メンションは公開時のお知らせと同じ（ロールの調整はそのロール、それ以外は @everyone。§5.5）。
  // ロールや @everyone への通知が続かないよう、メンションは 1 つの調整につき 1 時間に 3 回まで（投稿できたときだけ数える）
  const MENTION_KEY = `fix-mention:${poll.id}`;
  let mention = body.mention;
  if (mention && !(await rateLimitAllows(db, MENTION_KEY, 3, 3600, now))) {
    mention = false;
    warnings.push(msg("確定のお知らせのメンションは 1 時間に 3 回までのため、今回はメンションせずに投稿しました。", "Mentions in announcements are limited to 3 per hour, so this was posted without a mention."));
  }
  // 予定のリマインド（§5.7）を送る回がもう過ぎていて、予定がまだ先なら、このお知らせがリマインドを兼ねる。
  // 開始までの時間を添え、あとの回で同じ日時に重ねて送らないよう記録する
  const late = fixed.filter((s) => {
    if (s.start_at <= now || s.day_reminded_at === s.start_at) return false;
    const at = reminderAt({ startAt: s.start_at, allDay: s.all_day === 1 }, poll.timezone, poll.remind_day_offset, poll.remind_hour);
    return at !== null && at <= now;
  });
  const lateIds = new Set(late.map((s) => s.id));
  const message = buildFixedMessage(
    poll,
    fixed.map((s) => ({
      when: slotWhen(s, poll.lang),
      note: lateIds.has(s.id) ? translator(poll.lang)(`<t:${s.start_at}:R>に始まります`, `starts <t:${s.start_at}:R>`) : null,
    })),
    cancelled.map((s) => slotWhen(s, poll.lang)),
    mention,
  );
  try {
    await discord(c.env, "POST", `/channels/${poll.channel_id}/messages`, message);
  } catch {
    throw new AppError(502, "discord_failed", msg("確定のお知らせを投稿できませんでした。Bot がこのチャンネルに投稿できるか確認してください。", "Couldn't post the announcement. Check that the bot can post in this channel."));
  }
  const stmts: D1PreparedStatement[] = [
    // お知らせした内容を覚える（次のお知らせで、取り消した日時を知らせるため）
    db.prepare("UPDATE slots SET announced_fixed = CASE WHEN fixed_at IS NULL THEN 0 ELSE 1 END WHERE poll_id = ?").bind(poll.id),
    ...late.map((s) => db.prepare("UPDATE slots SET day_reminded_at = ? WHERE id = ?").bind(s.start_at, s.id)),
  ];
  if (mention) stmts.push(hitRateLimitStatement(db, MENTION_KEY, 3600, now));
  await db.batch(stmts);
  return c.json({ ok: true, warnings: localize(c, warnings) });
});

/** 登録済みの Discord イベントの日時だけを変える（場所などはそのまま） */
async function updateEventTime(env: Env, poll: PollRow, slot: SlotRow, time: { start_at: number; end_at: number | null; all_day: number }): Promise<Msg | null> {
  if (!slot.discord_event_id) return null;
  if (time.start_at <= nowSec() + 60) return msg("確定した候補の開始日時が過ぎているため、Discord イベントの日時は変更しませんでした。", "The confirmed date has already started, so the Discord event's time was not changed.");
  const end = time.end_at ?? time.start_at + (time.all_day ? DAY : 3600);
  try {
    await discord(env, "PATCH", `/guilds/${poll.guild_id}/scheduled-events/${slot.discord_event_id}`, {
      scheduled_start_time: new Date(time.start_at * 1000).toISOString(),
      scheduled_end_time: new Date(end * 1000).toISOString(),
    });
    return null;
  } catch (e) {
    if (e instanceof DiscordError && e.status === 404) {
      await env.DB.prepare("UPDATE slots SET discord_event_id = NULL WHERE id = ?").bind(slot.id).run();
      return null;
    }
    return msg("Discord イベントの日時を変更できませんでした。Discord で変更してください。", "Couldn't change the Discord event's time. Please change it in Discord.");
  }
}

async function upsertEvent(
  env: Env,
  poll: PollRow,
  slot: SlotRow,
  ev: { type: "voice" | "external"; channelId: string | null; location: string | null },
): Promise<Msg | null> {
  const now = nowSec();
  if (slot.start_at <= now + 60) return msg("開始日時が過ぎているため、Discord イベントは登録しませんでした。", "The start time has passed, so no Discord event was created.");
  const end = slot.end_at ?? slot.start_at + (slot.all_day ? DAY : 3600);
  const payload: Record<string, unknown> = {
    name: rawPollTitle(poll).slice(0, 100),
    description: (poll.description ?? "").slice(0, 1000) || undefined,
    privacy_level: 2,
    scheduled_start_time: new Date(slot.start_at * 1000).toISOString(),
    scheduled_end_time: new Date(end * 1000).toISOString(),
  };
  if (ev.type === "voice") {
    if (!ev.channelId) return msg("ボイスチャンネルが選ばれていないため、Discord イベントは登録しませんでした。", "No voice channel was selected, so no Discord event was created.");
    payload.entity_type = 2;
    payload.channel_id = ev.channelId;
  } else {
    payload.entity_type = 3;
    payload.channel_id = null;
    payload.entity_metadata = { location: ev.location ?? "Discord" };
  }
  try {
    if (slot.discord_event_id) {
      await discord(env, "PATCH", `/guilds/${poll.guild_id}/scheduled-events/${slot.discord_event_id}`, payload);
    } else {
      const res = await discord<{ id: string }>(env, "POST", `/guilds/${poll.guild_id}/scheduled-events`, payload);
      await env.DB.prepare("UPDATE slots SET discord_event_id = ? WHERE id = ?").bind(res.id, slot.id).run();
    }
    return null;
  } catch (e) {
    if (e instanceof DiscordError && e.status === 404 && slot.discord_event_id) {
      await env.DB.prepare("UPDATE slots SET discord_event_id = NULL WHERE id = ?").bind(slot.id).run();
      return upsertEvent(env, poll, { ...slot, discord_event_id: null }, ev);
    }
    if (e instanceof DiscordError && e.status === 403) return msg("Bot に「イベントの作成」権限がないため、Discord イベントは登録しませんでした。", "The bot doesn't have the \"Create Events\" permission, so no Discord event was created.");
    return msg("Discord イベントを登録できませんでした。", "Couldn't create the Discord event.");
  }
}

polls.post("/:id/remind", async (c) => {
  requireOrganizer(c);
  const { poll } = c.var;
  const db = c.env.DB;
  const now = nowSec();
  if (poll.status === "draft") throw new AppError(409, "draft", msg("公開してからリマインドしてください。", "Publish the poll before sending a reminder."));
  if (poll.status === "fixed") throw new AppError(409, "fixed", msg("日時が確定しているため、リマインドはできません。", "A date is already confirmed, so reminders can't be sent."));
  if (poll.last_reminded_at && now - poll.last_reminded_at < 12 * 3600) {
    throw new AppError(429, "rate_limited", msg("リマインドは 12 時間に 1 回までです。", "You can send a reminder once every 12 hours."));
  }
  const rows = await db
    .prepare("SELECT user_id FROM participants p WHERE poll_id = ? AND NOT EXISTS (SELECT 1 FROM answers a WHERE a.poll_id = p.poll_id AND a.user_id = p.user_id)")
    .bind(poll.id)
    .all<{ user_id: string }>();
  if (rows.results.length === 0) return c.json({ ok: true, count: 0 });
  const r = await db.prepare("UPDATE polls SET last_reminded_at = ? WHERE id = ? AND (last_reminded_at IS NULL OR last_reminded_at <= ?)").bind(now, poll.id, now - 12 * 3600).run();
  if (r.meta.changes !== 1) throw new AppError(429, "rate_limited", msg("リマインドは 12 時間に 1 回までです。", "You can send a reminder once every 12 hours."));
  const link = poll.message_id ? `\n${messageLink(poll.guild_id, poll.channel_id, poll.message_id)}` : "";
  // チャンネルに投稿するので、調整の言語で書く（§6.12）
  const t = translator(poll.lang);
  const deadline = poll.deadline_at ? t(`（締切 <t:${poll.deadline_at}:f>）`, ` (deadline <t:${poll.deadline_at}:f>)`) : "";
  await discord(
    c.env,
    "POST",
    `/channels/${poll.channel_id}/messages`,
    {
      ...buildMentionMessage(
        t(
          `**${pollTitle(poll)}** の回答をお願いします${deadline}。募集メッセージの［回答する］から入力できます。${link}`,
          `Please answer **${pollTitle(poll)}**${deadline}. Press [Answer] on the poll message to enter your availability.${link}`,
        ),
        rows.results.map((x) => x.user_id),
      ),
      // 募集メッセージと同じ［回答する］。押したときの確認（参加者か・チャンネルが同じか）も同じ処理で行う
      components: [{ type: 1, components: [{ type: 2, style: 1, label: t("回答する", "Answer"), custom_id: `answer:${poll.id}` }] }],
    },
  );
  return c.json({ ok: true, count: rows.results.length });
});

/** 「選択肢が変更されました」を確認した（§6.9.4） */
polls.post("/:id/choices-ack", async (c) => {
  const { poll, session } = c.var;
  await c.env.DB.prepare("UPDATE participants SET choices_ack_version = ? WHERE poll_id = ? AND user_id = ?").bind(poll.choices_version, poll.id, session.user_id).run();
  return c.json({ ok: true });
});

polls.post("/:id/sync-message", async (c) => {
  requireOrganizer(c);
  const { poll } = c.var;
  if (!poll.message_id) throw new AppError(409, "no_message", msg("募集メッセージがありません（未公開か、メッセージが削除されています）。", "There is no poll message (the poll isn't published, or the message was deleted)."));
  if (!(await hitRateLimit(c.env.DB, `sync:${poll.id}`, 1, 60, nowSec()))) {
    throw new AppError(429, "rate_limited", msg("手動更新は 1 分に 1 回までです。", "You can refresh manually once per minute."));
  }
  const ok = await syncNow(c.env, poll.id);
  if (!ok) throw new AppError(502, "sync_failed", msg("募集メッセージを更新できませんでした。時間をおいてお試しください。", "Couldn't update the poll message. Please try again later."));
  return c.json({ ok: true, lastSyncedAt: nowSec() });
});

/**
 * 募集メッセージをチャンネルに投稿し直す（§5.5）。
 * Discord で削除されてしまったときや、会話に埋もれたときに使う。古いメッセージが残っていれば「削除されました」に書き換えず消す
 */
polls.post("/:id/repost", async (c) => {
  requireOrganizer(c);
  const { poll } = c.var;
  const db = c.env.DB;
  const now = nowSec();
  if (!canAnswer(poll.status)) throw new AppError(409, "not_published", msg("公開してから投稿してください。", "Publish the poll before posting."));
  if (!(await hitRateLimit(db, `sync:${poll.id}`, 1, 60, now))) throw new AppError(429, "rate_limited", msg("投稿・更新は 1 分に 1 回までです。", "You can post or refresh once per minute."));
  await postPollMessage(c.env, poll.id, now, {
    draftOnly: false,
    prepare: (data) => data,
    afterPost: async (messageId, data) => {
      // 先に新しい ID を記録してから古いメッセージを消す（同時に走る更新が新しいメッセージを見失わないように）
      await db.prepare("UPDATE polls SET message_id = ?, last_synced_at = ? WHERE id = ?").bind(messageId, now, poll.id).run();
      const old = data.poll.message_id;
      if (old && old !== messageId) {
        await discord(c.env, "DELETE", `/channels/${data.poll.channel_id}/messages/${old}`).catch(() => undefined);
      }
    },
  });
  return c.json({ ok: true });
});

/** 調整を削除する。募集メッセージを「削除されました」に変え、Discord イベントも消してから、データを消す */
async function deletePollEverywhere(env: Env, poll: PollRow): Promise<Msg[]> {
  if (poll.message_id) {
    await discord(env, "PATCH", `/channels/${poll.channel_id}/messages/${poll.message_id}`, buildDeletedMessage(poll)).catch(() => undefined);
  }
  // 確定時に登録した Discord イベントも、調整と一緒に消す
  const warnings: Msg[] = [];
  const eventIds = (await env.DB.prepare("SELECT discord_event_id FROM slots WHERE poll_id = ? AND discord_event_id IS NOT NULL").bind(poll.id).all<{ discord_event_id: string }>()).results;
  const results = await Promise.allSettled(eventIds.map(({ discord_event_id }) => discord(env, "DELETE", `/guilds/${poll.guild_id}/scheduled-events/${discord_event_id}`)));
  if (results.some((r) => r.status === "rejected" && !(r.reason instanceof DiscordError && r.reason.status === 404))) {
    warnings.push(msg("Discord イベントを削除できませんでした。Discord で削除してください。", "Couldn't delete the Discord event. Please delete it in Discord."));
  }
  await deletePollData(env.DB, poll.id);
  return warnings;
}

polls.delete("/:id", async (c) => {
  requireOrganizer(c);
  const warnings = await deletePollEverywhere(c.env, c.var.poll);
  c.header("Set-Cookie", clearSessionCookie(c.var.poll.id));
  return c.json({ ok: true, warnings: localize(c, warnings) });
});

polls.delete("/:id/session", async (c) => {
  await c.env.DB.prepare("DELETE FROM sessions WHERE sid_hash = ?").bind(c.var.session.sid_hash).run();
  c.header("Set-Cookie", clearSessionCookie(c.var.poll.id));
  return c.json({ ok: true });
});

api.route("/polls", polls);

// --- 主催者の調整一覧（S9。docs/design.md §6.11。サーバー単位のセッション必須） ---

type ListVars = { list: ListSessionRow };
type LC = Context<{ Bindings: Env; Variables: ListVars }>;
const guilds = new Hono<{ Bindings: Env; Variables: ListVars }>();

guilds.use("/:guildId/*", async (c: LC, next) => {
  const guildId = c.req.param("guildId") ?? "";
  if (!/^\d{17,20}$/.test(guildId)) throw new AppError(404, "not_found", msg("見つかりません。", "Not found."));
  const sid = readCookie(c.req.header("Cookie") ?? null, listCookieName(guildId));
  const list = sid ? await getListSession(c.env.DB, guildId, sid) : null;
  // 前に受け取ったリンクは使えないので、Discord に残っているリンクを開き直さないよう、作り直す手順を伝える
  if (!list) {
    throw new AppError(
      401,
      "list_session_expired",
      msg("一覧ページの有効期限が切れています。Discord で前に受け取ったリンクは、無効になっています。Discord でもう一度 /schedule を実行し、［作成した調整を管理］を押して、新しいリンクを受け取ってください。", "This list page has expired. Links you received earlier in Discord no longer work. Run /schedule in Discord again and press [Manage my polls] to get a new link."),
    );
  }
  if (c.req.method !== "GET") {
    const token = c.req.header("X-CSRF-Token") ?? "";
    if (!timingSafeEqual(token, list.csrf_token)) throw new AppError(403, "bad_csrf", msg("不正なリクエストです。画面を再読み込みしてください。", "Invalid request. Please reload the page."));
  }
  c.set("list", list);
  await next();
});

/** 一覧のセッションの持ち主が、このサーバーで主催している調整だけを返す。それ以外は見つからない扱い */
async function ownPoll(c: LC): Promise<PollRow> {
  const poll = await getPoll(c.env.DB, c.req.param("pollId") ?? "");
  const { list } = c.var;
  if (!poll || poll.status === "cancelled" || poll.guild_id !== list.guild_id || poll.organizer_id !== list.user_id) {
    throw new AppError(404, "not_found", msg("この調整は見つかりませんでした。削除された可能性があります。", "This poll was not found. It may have been deleted."));
  }
  return poll;
}

guilds.get("/:guildId/polls", async (c: LC) => {
  const { list } = c.var;
  const now = nowSec();
  const rows = await c.env.DB.prepare(
    "SELECT p.id, p.title, p.status, p.deadline_at, p.channel_id, p.message_id, p.created_at, p.updated_at, p.timezone, " +
      "(SELECT json_group_array(json_object('s', s.start_at, 'e', s.end_at, 'a', s.all_day)) FROM slots s WHERE s.poll_id = p.id AND s.fixed_at IS NOT NULL) AS fixed_json, " +
      "(SELECT COUNT(*) FROM participants pa WHERE pa.poll_id = p.id) AS participants, " +
      "(SELECT COUNT(*) FROM participants pa WHERE pa.poll_id = p.id AND pa.answered_at IS NOT NULL) AS answered " +
      "FROM polls p " +
      "WHERE p.guild_id = ? AND p.organizer_id = ? AND p.status != 'cancelled' ORDER BY p.updated_at DESC LIMIT 200",
  )
    .bind(list.guild_id, list.user_id)
    .all<{
      id: string;
      title: string | null;
      status: PollRow["status"];
      deadline_at: number | null;
      channel_id: string;
      message_id: string | null;
      created_at: number;
      updated_at: number;
      timezone: string;
      fixed_json: string;
      participants: number;
      answered: number;
    }>();
  return c.json({
    now,
    csrfToken: list.csrf_token,
    polls: rows.results.map((r) => ({
      id: r.id,
      title: r.title,
      status: effectiveStatus(r.status, r.deadline_at, now),
      deadlineAt: r.deadline_at,
      timezone: r.timezone,
      fixed: (JSON.parse(r.fixed_json) as { s: number; e: number | null; a: number }[])
        .map((f) => ({ startAt: f.s, endAt: f.e, allDay: f.a === 1 }))
        .sort((x, y) => x.startAt - y.startAt),
      participants: r.participants,
      answered: r.answered,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      messageUrl: r.message_id ? messageLink(list.guild_id, r.channel_id, r.message_id) : null,
    })),
  });
});

// 一覧から調整を開く。主催者本人であることを確かめてから、その調整だけに有効なセッションを発行する
guilds.post("/:guildId/polls/:pollId/open", async (c: LC) => {
  const body = await readJson(c as unknown as Context<{ Bindings: Env }>, OpenPollBody);
  const poll = await ownPoll(c);
  if (body.to === "summary" && poll.status === "draft") throw new AppError(409, "draft", msg("下書きの調整には集計画面がありません。", "Draft polls don't have a results page."));
  const { sid } = await createSession(c.env.DB, poll.id, c.var.list.user_id, "organizer");
  c.header("Set-Cookie", sessionCookie(poll.id, sid));
  return c.json({ redirect: body.to === "edit" ? `/p/${poll.id}/edit` : `/p/${poll.id}` });
});

guilds.delete("/:guildId/polls/:pollId", async (c: LC) => {
  const poll = await ownPoll(c);
  const warnings = await deletePollEverywhere(c.env, poll);
  return c.json({ ok: true, warnings: localize(c, warnings) });
});

api.route("/guilds", guilds);

