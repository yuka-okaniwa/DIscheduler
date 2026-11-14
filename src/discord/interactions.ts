// Discord Interaction の処理（docs/design.md §4, §8.3）
// ユーザー ID は必ず署名済みの Interaction 本体の値を使い、custom_id の値は信用しない。
import type { Env } from "../core/env";
import { issueLink, issueListLink } from "../auth";
import { getParticipant, getPoll, hitRateLimit } from "../db";
import { AppError, isQuotaError, nowSec, QUOTA_MSG } from "../core/lib";
import { langFromTag, pick, translator, type Lang } from "../shared/i18n";
import { createOrReuseDraft } from "../polls/create";
import { buildLocationModal, buildSettingsMessage, canManageGuild, EVENT_LOCATION_MAX, getGuildSettings, saveDefaultEventChannel, saveDefaultEventLocation, saveGuildSettings, type DefaultMode } from "../guilds/settings";
import { canAnswer, effectiveStatus } from "../shared/model";
import { charLength, hasControlChars, sanitizeDisplayName, sanitizeLine } from "../shared/text";
import { syncCommands } from "./commands";
import { hasPermission, PERM } from "./permissions";
import { escapeMarkdown, messageLink, NO_MENTIONS, pollTitle } from "./messages";
import { discord, memberDisplayName, type DiscordMember } from "./rest";

const EPHEMERAL = 64;

interface Interaction {
  type: number;
  id: string;
  application_id: string;
  token: string;
  guild_id?: string;
  channel_id?: string;
  channel?: { id: string };
  member?: DiscordMember & { permissions?: string };
  /** 押した人の Discord の言語（例: ja、en-US）。本人にだけ見える応答の言語に使う（§6.12） */
  locale?: string;
  data?: {
    name?: string;
    custom_id?: string;
    values?: string[];
    /** 選択メニューで選ばれたチャンネルの情報（Discord が付けて送る） */
    resolved?: { channels?: Record<string, { type?: number }> };
    options?: { name: string; type: number; value: string | number }[];
    /** モーダルの送信（type 5）で届く入力欄の値 */
    components?: { type: number; components?: { type: number; custom_id?: string; value?: string }[] }[];
  };
}

type Ctx = { waitUntil(p: Promise<unknown>): void };

/** 本人にだけ見える応答の言語。押した人の Discord の言語が日本語なら日本語、それ以外は英語（§6.12） */
const langOf = (i: Interaction): Lang => langFromTag(i.locale);
const trOf = (i: Interaction) => translator(langOf(i));

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
const ephemeral = (content: string, components: unknown[] = []) =>
  json({ type: 4, data: { content, components, flags: EPHEMERAL, allowed_mentions: NO_MENTIONS } });
const deferred = () => json({ type: 5, data: { flags: EPHEMERAL } });

function linkButton(label: string, url: string) {
  return { type: 2, style: 5, label, url };
}

/** mentionUser を渡したときは、その人へのメンションだけを有効にする（本人にだけ見える応答で、本人を強調するため） */
async function editOriginal(env: Env, i: Interaction, content: string, components: unknown[] = [], mentionUser?: string): Promise<void> {
  const allowed_mentions = mentionUser ? { parse: [] as string[], users: [mentionUser] } : NO_MENTIONS;
  await discord(env, "PATCH", `/webhooks/${i.application_id}/${i.token}/messages/@original`, { content, components, allowed_mentions }, { auth: "none" });
}

/** 応答後の処理。失敗しても利用者に理由を伝える */
function background(env: Env, ctx: Ctx, i: Interaction, work: () => Promise<void>): void {
  ctx.waitUntil(
    work().catch(async (e) => {
      const lang = langOf(i);
      const msg = isQuotaError(e)
        ? pick(QUOTA_MSG, lang)
        : e instanceof AppError
          ? pick(e.text, lang)
          : translator(lang)("エラーが発生しました。時間をおいてもう一度お試しください。", "Something went wrong. Please try again later.");
      if (!(e instanceof AppError)) console.error(JSON.stringify({ event: "interaction_error", error: e instanceof Error ? e.message : "unknown" }));
      await editOriginal(env, i, msg).catch(() => undefined);
    }),
  );
}

export async function handleInteraction(env: Env, ctx: Ctx, i: Interaction, origin: string): Promise<Response> {
  if (i.type === 1) {
    // PING（Interactions Endpoint URL の登録時にも届く）。このときにコマンドを登録・更新する
    ctx.waitUntil(syncCommands(env, { force: true }).catch((e) => console.error(JSON.stringify({ event: "commands_sync_failed", error: String(e) }))));
    return json({ type: 1 });
  }
  const t = trOf(i);
  if (env.MAINTENANCE === "1") return ephemeral(t("DIscheduler は現在メンテナンス中です。しばらくしてからお試しください。", "DIscheduler is under maintenance. Please try again later."));

  const userId = i.member?.user?.id;
  const guildId = i.guild_id;
  const channelId = i.channel_id ?? i.channel?.id;
  if (!userId || !guildId || !channelId) return ephemeral(t("DIscheduler はサーバーのチャンネルの中で使ってください。", "Please use DIscheduler in a server channel."));

  ctx.waitUntil(syncCommands(env).catch(() => undefined));

  if (i.type === 2 && (i.data?.name === "schedule" || i.data?.name === "di")) {
    background(env, ctx, i, () => handleCreate(env, i, origin, guildId, channelId, userId));
    return deferred();
  }

  // モーダルの送信（サーバー既定値の、イベントの場所）
  if (i.type === 5 && i.data?.custom_id === "settings_location_modal") {
    return handleSettings(env, i, "settings_location_modal", guildId, userId);
  }

  if (i.type === 3) {
    const id = i.data?.custom_id ?? "";
    // 募集メッセージの［使い方］は調整の言語（help:ja / help:en）。それ以外の［使い方］と、以前の募集メッセージ（help）は押した人の言語
    if (id === "help" || id === "help:ja" || id === "help:en") return ephemeral(helpText(origin, id === "help" ? langOf(i) : id === "help:en" ? "en" : "ja"));
    if (id === "settings" || id === "settings_mode" || id === "settings_role" || id === "settings_location" || id === "settings_channel") {
      return handleSettings(env, i, id, guildId, userId);
    }
    // 以前の［このチャンネルの調整］ボタン（すでに送ったメッセージに残っている分）にも応える
    if (id === "list") {
      background(env, ctx, i, () => handleList(env, i, guildId, channelId));
      return deferred();
    }
    if (id === "manage") {
      background(env, ctx, i, () => handleManage(env, i, origin, guildId, userId));
      return deferred();
    }
    // 以前の［作成した調整を管理］の選択メニュー（すでに送ったメッセージに残っている分）にも応える
    if (id === "manage_select") {
      const pollId = i.data?.values?.[0] ?? "";
      const poll = await getPoll(env.DB, pollId);
      if (!poll || poll.organizer_id !== userId || poll.guild_id !== guildId) {
        return json({ type: 7, data: { content: t("この調整は見つかりませんでした。", "This poll was not found."), components: [] } });
      }
      const url = await issueLink(env.DB, origin, poll.id, userId, "organizer", "edit");
      const tp = translator(poll.lang);
      return json({
        type: 7,
        data: {
          content: tp(
            `「${escapeMarkdown(poll.title ?? "（タイトル未入力）")}」の管理リンクです（10 分有効・1 回限り）。他の人に渡さないでください。`,
            `Here is the link to manage "${escapeMarkdown(poll.title ?? "(untitled)")}" (valid for 10 minutes, single use). Don't share it with anyone.`,
          ),
          components: [{ type: 1, components: [linkButton(tp("調整を開く", "Open the poll"), url)] }],
        },
      });
    }
    const m = /^(answer|view):([A-Za-z0-9_-]{22})$/.exec(id);
    if (m) {
      background(env, ctx, i, () => handlePollButton(env, i, origin, m[1] as "answer" | "view", m[2]!, guildId, channelId, userId));
      return deferred();
    }
  }
  return ephemeral(t("この操作には対応していません。", "This action isn't supported."));
}

function intOption(i: Interaction, name: string): number | null {
  const v = i.data?.options?.find((o) => o.name === name)?.value;
  return typeof v === "number" ? v : null;
}
function strOption(i: Interaction, name: string): string | null {
  const v = i.data?.options?.find((o) => o.name === name)?.value;
  return typeof v === "string" ? v : null;
}

async function handleCreate(env: Env, i: Interaction, origin: string, guildId: string, channelId: string, userId: string): Promise<void> {
  const rawTitle = strOption(i, "title");
  // 空白だけなどで空になったら、タイトルなし（Web 画面で入力する）として扱う
  const title = rawTitle ? sanitizeLine(rawTitle, 100) || null : null;
  const members = strOption(i, "members");
  const roleId = strOption(i, "role");
  const deadline = intOption(i, "deadline");
  const result = await createOrReuseDraft(env, {
    guildId,
    channelId,
    organizerId: userId,
    title,
    members: members === "auto" || members === "manual" ? members : null,
    roleId: roleId && /^\d{17,20}$/.test(roleId) ? roleId : null,
    deadlineDays: deadline && deadline >= 1 && deadline <= 90 ? Math.floor(deadline) : null,
    // 調整の言語（チャンネルに投稿するメッセージと最初の選択肢）は、作った主催者の Discord の言語にする（§6.12）
    lang: langOf(i),
  });
  const t = trOf(i);
  if (!result.ok) {
    await editOriginal(env, i, pick(result.message, langOf(i)), menuRow(i));
    return;
  }
  const url = await issueLink(env.DB, origin, result.pollId, userId, "organizer", "edit");
  const lines = [
    result.reused ? t("作成途中の日程調整の下書きがあります。", "You have a draft poll in progress.") : t("新しい日程調整の下書きを作りました。", "Created a new draft poll."),
    t(
      "［調整を作成する］から、タイトルや候補日時を入力して公開してください（リンクは 10 分有効・1 回限り。他の人に渡さないでください）。",
      "Press [Create the poll] to enter a title and date options, then publish it (the link is valid for 10 minutes and can be used once. Don't share it with anyone).",
    ),
  ];
  // 参加者をロールで決めていなければ、ロールの指定をすすめる（公開時と予定のリマインドの通知が、ロールにだけ届くため。§5.5、§5.7）
  if (result.targetType !== "role") {
    lines.push(
      "",
      t(
        "💡 参加者はロールで決めるのがおすすめです。公開したときと予定のリマインドで、そのロールのメンバーにだけ通知が届きます（ロールがないと @everyone で通知します）。作成画面の「参加者」か、`/schedule` の `role` で選べます。",
        "💡 We recommend choosing participants by role. Then only that role's members are notified when the poll is published and in event reminders (without a role, @everyone is notified). Choose it under \"Participants\" on the edit page, or with the `role` option of `/schedule`.",
      ),
    );
  }
  if (result.notice) lines.push("", `⚠️ ${pick(result.notice, langOf(i))}`);
  await editOriginal(env, i, lines.join("\n"), [
    { type: 1, components: [linkButton(t("調整を作成する", "Create the poll"), url)] },
    ...menuRow(i),
  ]);
}

function isAdmin(i: Interaction): boolean {
  return canManageGuild(i.member?.permissions);
}

function menuRow(i: Interaction) {
  const t = trOf(i);
  const buttons: unknown[] = [
    { type: 2, style: 2, label: t("作成した調整を管理", "Manage my polls"), custom_id: "manage" },
    { type: 2, style: 2, label: t("使い方", "Help"), custom_id: "help" },
  ];
  // サーバー管理の権限がある人にだけ、既定値の設定を出す（§5.3.1）
  if (isAdmin(i)) buttons.push({ type: 2, style: 2, label: t("サーバー既定値の設定", "Server defaults"), custom_id: "settings" });
  return [{ type: 1, components: buttons }];
}

/** サーバーの既定値の表示・変更。権限は署名済みの Interaction の permissions で毎回確かめる */
async function handleSettings(env: Env, i: Interaction, id: string, guildId: string, userId: string): Promise<Response> {
  const t = trOf(i);
  const lang = langOf(i);
  if (!isAdmin(i)) return ephemeral(t("サーバーの既定値を変更できるのは、「サーバー管理」の権限を持つメンバーだけです。", "Only members with the \"Manage Server\" permission can change the server defaults."));
  const current = await getGuildSettings(env.DB, guildId);
  if (id === "settings") return json({ type: 4, data: { ...buildSettingsMessage(current, null, lang), flags: EPHEMERAL } });
  // イベントの場所は、入力欄のあるフォーム（モーダル）で受け取る
  if (id === "settings_location") return json({ type: 9, data: buildLocationModal(current.eventLocation, lang) });
  if (id === "settings_channel") {
    const channelId = i.data?.values?.[0] ?? "";
    const type = i.data?.resolved?.channels?.[channelId]?.type;
    // ボイス・ステージのチャンネルだけを受け付ける（選択メニューの絞り込みに頼らず、ここでも確かめる）
    if (!/^\d{17,20}$/.test(channelId) || (type !== 2 && type !== 13)) return ephemeral(t("ボイスチャンネルを選んでください。", "Please choose a voice channel."));
    await saveDefaultEventChannel(env.DB, guildId, channelId, userId);
    const saved = await getGuildSettings(env.DB, guildId);
    return json({ type: 7, data: buildSettingsMessage(saved, t("イベントの場所をボイスチャンネルにしました。", "The event location is now the voice channel."), lang) });
  }
  if (id === "settings_location_modal") {
    const raw = i.data?.components?.flatMap((r) => r.components ?? []).find((c) => c.custom_id === "location")?.value ?? "";
    const value = raw.normalize("NFC").trim();
    if (charLength(value) > EVENT_LOCATION_MAX || hasControlChars(value)) {
      return ephemeral(
        t(
          `場所は ${EVENT_LOCATION_MAX} 文字以内で、改行や見えない文字を含めずに入力してください。`,
          `Enter a location of up to ${EVENT_LOCATION_MAX} characters, without line breaks or invisible characters.`,
        ),
      );
    }
    await saveDefaultEventLocation(env.DB, guildId, value || null, userId);
    const saved = await getGuildSettings(env.DB, guildId);
    const note = value ? t("イベントの場所を保存しました。", "Saved the event location.") : t("イベントの場所を「Discord」に戻しました。", "The event location is back to \"Discord\".");
    return json({ type: 7, data: buildSettingsMessage(saved, note, lang) });
  }

  let next: { mode: DefaultMode; roleId: string | null } = { mode: current.mode, roleId: current.roleId };
  let note: string | null = null;
  if (id === "settings_mode") {
    const v = i.data?.values?.[0];
    if (v !== "channel" && v !== "role" && v !== "manual") return ephemeral(t("この操作には対応していません。", "This action isn't supported."));
    next = { mode: v, roleId: v === "role" ? current.roleId : null };
    if (v === "role" && !current.roleId) note = t("下の欄でロールを選んでください。ロールを選ぶまでは、チャンネルのメンバーが参加者になります。", "Choose a role below. Until you do, the channel's members become participants.");
  } else {
    const roleId = i.data?.values?.[0] ?? null;
    if (roleId !== null && !/^\d{17,20}$/.test(roleId)) return ephemeral(t("この操作には対応していません。", "This action isn't supported."));
    next = roleId ? { mode: "role", roleId } : { mode: current.mode === "role" ? "channel" : current.mode, roleId: null };
  }
  await saveGuildSettings(env.DB, guildId, next, userId);
  const saved = await getGuildSettings(env.DB, guildId);
  return json({ type: 7, data: buildSettingsMessage(saved, note ?? t("保存しました。", "Saved."), lang) });
}

async function handlePollButton(
  env: Env,
  i: Interaction,
  origin: string,
  kind: "answer" | "view",
  pollId: string,
  guildId: string,
  channelId: string,
  userId: string,
): Promise<void> {
  const t = trOf(i);
  const poll = await getPoll(env.DB, pollId);
  // custom_id は改ざんできるため、調整のサーバーとチャンネルが押された場所と一致するかを確かめる
  if (!poll || poll.guild_id !== guildId || poll.channel_id !== channelId || poll.status === "draft" || poll.status === "cancelled") {
    await editOriginal(env, i, t("この調整は見つかりませんでした。削除された可能性があります。", "This poll was not found. It may have been deleted."));
    return;
  }
  // 調整に結び付いた返事は、押した人ではなく調整の言語で書く（チャンネルのメッセージと言語をそろえる。§6.12）
  const tp = translator(poll.lang);
  if (!(await hitRateLimit(env.DB, `link:${userId}`, 20, 3600, nowSec()))) {
    await editOriginal(env, i, tp("リンクの発行回数の上限（1 時間に 20 回）に達しました。しばらくしてからお試しください。", "You've reached the limit of 20 links per hour. Please try again later."));
    return;
  }
  const isOrganizer = poll.organizer_id === userId;
  let participant = await getParticipant(env.DB, poll.id, userId);
  if (!participant && !isOrganizer) {
    const canView = hasPermission(i.member?.permissions, PERM.VIEW_CHANNEL);
    if (kind === "answer" && poll.join_policy === "open" && canView) {
      const name = sanitizeDisplayName(memberDisplayName(i.member!), 64);
      await env.DB.prepare("INSERT OR IGNORE INTO participants (poll_id, user_id, display_name) VALUES (?, ?, ?)").bind(poll.id, userId, name).run();
      participant = await getParticipant(env.DB, poll.id, userId);
    } else {
      await editOriginal(
        env,
        i,
        tp(
          "この調整の参加者ではないため、回答・閲覧できません。参加したい場合は主催者に追加を依頼してください。",
          "You're not a participant in this poll, so you can't answer or view it. If you'd like to join, ask the organizer to add you.",
        ),
      );
      return;
    }
  }
  const status = effectiveStatus(poll.status, poll.deadline_at, nowSec());
  if (kind === "answer" && !participant) {
    // 主催者が参加者に入っていない場合は、集計の閲覧に切り替える
    kind = "view";
  }
  if (kind === "answer" && !canAnswer(status)) {
    await editOriginal(env, i, tp("この調整にはいま回答できません。", "This poll isn't accepting answers right now."));
    return;
  }
  const role = isOrganizer ? "organizer" : "participant";
  const url = await issueLink(env.DB, origin, poll.id, userId, role, kind);
  const label = kind === "answer" ? tp("回答する", "Answer") : tp("集計を見る", "View results");
  const note =
    status === "fixed"
      ? tp("日時は確定していますが、予定が変わった場合は回答を変更できます。", "A date is confirmed, but you can still change your answer if your plans change.")
      : status === "closed"
        ? tp("締切を過ぎていますが、回答の入力・変更はできます。", "The deadline has passed, but you can still enter or change your answer.")
        : "";
  await editOriginal(
    env,
    i,
    // 応答に気づきやすくするため、押した本人をメンションする（本人にだけ見える応答なので、ほかの人には見えない）
    tp(
      `<@${userId}> 「${pollTitle(poll)}」のあなた専用のリンクです（10 分有効・1 回限り）。他の人に渡さないでください。${note ? `\n${note}` : ""}`,
      `<@${userId}> Here is your own link for "${pollTitle(poll)}" (valid for 10 minutes, single use). Don't share it with anyone.${note ? `\n${note}` : ""}`,
    ),
    [{ type: 1, components: [linkButton(label, url)] }],
    userId,
  );
}

async function handleList(env: Env, i: Interaction, guildId: string, channelId: string): Promise<void> {
  const t = trOf(i);
  const rows = await env.DB.prepare(
    "SELECT id, title, status, deadline_at, message_id FROM polls WHERE guild_id = ? AND channel_id = ? AND status IN ('open','closed','fixed') ORDER BY created_at DESC LIMIT 15",
  )
    .bind(guildId, channelId)
    .all<{ id: string; title: string | null; status: "open" | "closed" | "fixed"; deadline_at: number | null; message_id: string | null }>();
  if (rows.results.length === 0) {
    await editOriginal(env, i, t("このチャンネルには進行中の調整はありません。", "There are no active polls in this channel."));
    return;
  }
  const now = nowSec();
  const label = { open: t("募集中", "Open"), closed: t("締切後", "Closed"), fixed: t("確定", "Confirmed") } as const;
  const lines = rows.results.map((r) => {
    const st = effectiveStatus(r.status, r.deadline_at, now) as "open" | "closed" | "fixed";
    const link = r.message_id ? ` ${messageLink(guildId, channelId, r.message_id)}` : "";
    return t(`・${escapeMarkdown(r.title ?? "（タイトルなし）")}（${label[st]}）${link}`, `・${escapeMarkdown(r.title ?? "(untitled)")} (${label[st]})${link}`);
  });
  await editOriginal(env, i, [t("このチャンネルの調整です。回答は各募集メッセージの［回答する］から入力できます。", "Polls in this channel. Answer from [Answer] on each poll message."), ...lines].join("\n"));
}

/** ［作成した調整を管理］: このサーバーで自分が主催した調整の一覧ページ（S9。§6.11）のリンクを本人にだけ返す */
async function handleManage(env: Env, i: Interaction, origin: string, guildId: string, userId: string): Promise<void> {
  const t = trOf(i);
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM polls WHERE guild_id = ? AND organizer_id = ? AND status != 'cancelled'")
    .bind(guildId, userId)
    .first<{ n: number }>();
  if (!row || row.n === 0) {
    await editOriginal(env, i, t("このサーバーであなたが主催している調整はありません。`/schedule` で作成できます。", "You don't organize any polls in this server. Create one with `/schedule`."));
    return;
  }
  if (!(await hitRateLimit(env.DB, `link:${userId}`, 20, 3600, nowSec()))) {
    await editOriginal(env, i, t("リンクの発行回数の上限（1 時間に 20 回）に達しました。しばらくしてからお試しください。", "You've reached the limit of 20 links per hour. Please try again later."));
    return;
  }
  const url = await issueListLink(env.DB, origin, guildId, userId);
  await editOriginal(
    env,
    i,
    t(
      `このサーバーであなたが主催している調整（${row.n} 件）の一覧です。編集・集計・削除ができます。\nリンクは 10 分有効・1 回限りです。他の人に渡さないでください。`,
      `Here are the polls you organize in this server (${row.n}). You can edit them, view results and delete them.\nThe link is valid for 10 minutes and can be used once. Don't share it with anyone.`,
    ),
    [{ type: 1, components: [linkButton(t("作成した調整の一覧を開く", "Open my polls"), url)] }],
  );
}

export function helpText(origin: string, lang: Lang = "ja"): string {
  if (lang === "en") {
    return [
      "**How to use DIscheduler**",
      "1. Run `/schedule` (or `/di`) in a channel.",
      "2. Open the link you receive, enter a title and date options, and publish.",
      "3. Participants press [Answer] on the poll message, choose an option for each date and save.",
      "4. The organizer confirms the date on the results page. It can also be added as a Discord event.",
      "",
      "・Answer links are personal, valid for 10 minutes and can be used once. Don't share them with anyone.",
      "・Answers are shared only among the participants of that poll and are not visible to anyone else.",
      "・Server admins can choose the channels where the commands work in Server Settings → Integrations → DIscheduler.",
      "・Server admins can set defaults for choosing participants (channel, role or manual) and for the Discord event location with [Server defaults] in `/schedule`.",
      "",
      `About: ${origin}/`,
      `Manual: ${origin}/manual/`,
      `Security policy: ${origin}/security`,
    ].join("\n");
  }
  return [
    "**DIscheduler の使い方**",
    "1. チャンネルで `/schedule`（または `/di`）と入力して実行します。",
    "2. 届いたリンクから、タイトルと候補日時を入力して公開します。",
    "3. 参加者は募集メッセージの［回答する］から、候補ごとに選択肢を選んで保存します。",
    "4. 主催者は集計画面で日時を確定します。Discord のイベントとしても登録できます。",
    "",
    "・入力リンクは本人専用で、10 分有効・1 回限りです。他の人に渡さないでください。",
    "・回答はその調整の参加者同士で共有され、参加者以外には見えません。",
    "・サーバー管理者は「サーバー設定 → 連携サービス → DIscheduler」で、コマンドを使えるチャンネルを指定できます。",
    "・サーバー管理者は `/schedule` の［サーバー既定値の設定］で、参加者の決め方（チャンネル・ロール・手動）と、Discord イベントの場所の既定値を決められます。",
    "",
    `案内: ${origin}/`,
    `マニュアル: ${origin}/manual/`,
    `セキュリティ方針: ${origin}/security`,
  ].join("\n");
}
