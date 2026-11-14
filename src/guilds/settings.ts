// サーバーごとの既定値（docs/design.md §5.3.1）
// 変更できるのは「サーバー管理」権限を持つメンバーだけ。権限は署名済みの Interaction の値で判定する。
import { nowSec } from "../core/lib";
import { escapeMarkdown } from "../discord/messages";
import { translator, type Lang } from "../shared/i18n";
import { hasPermission, PERM } from "../discord/permissions";

/** イベントの場所の最大文字数（確定の画面の入力欄と同じ） */
export const EVENT_LOCATION_MAX = 100;

export type DefaultMode = "channel" | "role" | "manual";

export interface GuildSettings {
  mode: DefaultMode;
  roleId: string | null;
  /** Discord イベントの場所の既定値。null なら「Discord」 */
  eventLocation: string | null;
  /** Discord イベントのボイスチャンネルの既定値。入っていれば「場所を入力」より優先して選ぶ */
  eventChannelId: string | null;
  updatedBy: string | null;
  updatedAt: number | null;
}

export const DEFAULT_SETTINGS: GuildSettings = { mode: "channel", roleId: null, eventLocation: null, eventChannelId: null, updatedBy: null, updatedAt: null };

/** 「サーバー管理」権限（MANAGE_GUILD）または管理者権限 */
export function canManageGuild(permissions: string | undefined): boolean {
  return hasPermission(permissions, PERM.MANAGE_GUILD);
}

export async function getGuildSettings(db: D1Database, guildId: string): Promise<GuildSettings> {
  const row = await db
    .prepare("SELECT mode, role_id, event_location, event_channel_id, updated_by, updated_at FROM guild_settings WHERE guild_id = ?")
    .bind(guildId)
    .first<{ mode: DefaultMode; role_id: string | null; event_location: string | null; event_channel_id: string | null; updated_by: string; updated_at: number }>();
  if (!row) return DEFAULT_SETTINGS;
  return { mode: row.mode, roleId: row.role_id, eventLocation: row.event_location, eventChannelId: row.event_channel_id, updatedBy: row.updated_by, updatedAt: row.updated_at };
}

/** Discord イベントの場所の既定値だけを読む（集計画面を開いた主催者に返す） */
export async function getEventDefaults(db: D1Database, guildId: string): Promise<{ location: string | null; channelId: string | null }> {
  const row = await db
    .prepare("SELECT event_location, event_channel_id FROM guild_settings WHERE guild_id = ?")
    .bind(guildId)
    .first<{ event_location: string | null; event_channel_id: string | null }>();
  return { location: row?.event_location ?? null, channelId: row?.event_channel_id ?? null };
}

/**
 * 文字で入力する場所の既定値を保存する（null で「Discord」に戻す）。参加者の決め方はそのまま。
 * 文字で決めたら「場所を入力」を既定にするので、ボイスチャンネルの既定は外す
 */
export async function saveDefaultEventLocation(db: D1Database, guildId: string, location: string | null, userId: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO guild_settings (guild_id, event_location, updated_by, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(guild_id) DO UPDATE SET event_location = excluded.event_location, event_channel_id = NULL, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
    )
    .bind(guildId, location, userId, nowSec())
    .run();
}

/** ボイスチャンネルの既定値を保存する。文字の場所の既定値は、「場所を入力」に切り替えたときのために残す */
export async function saveDefaultEventChannel(db: D1Database, guildId: string, channelId: string, userId: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO guild_settings (guild_id, event_channel_id, updated_by, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(guild_id) DO UPDATE SET event_channel_id = excluded.event_channel_id, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
    )
    .bind(guildId, channelId, userId, nowSec())
    .run();
}

export async function saveGuildSettings(db: D1Database, guildId: string, s: { mode: DefaultMode; roleId: string | null }, userId: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO guild_settings (guild_id, mode, role_id, updated_by, updated_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(guild_id) DO UPDATE SET mode = excluded.mode, role_id = excluded.role_id, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
    )
    .bind(guildId, s.mode, s.mode === "role" ? s.roleId : null, userId, nowSec())
    .run();
}

const MODE_LABEL: Record<Lang, Record<DefaultMode, string>> = {
  ja: {
    channel: "自動: コマンドを実行したチャンネルのメンバー",
    role: "自動: 指定したロールのメンバー",
    manual: "手動: 主催者が選ぶ",
  },
  en: {
    channel: "Automatic: members of the channel where the command was run",
    role: "Automatic: members of the selected role",
    manual: "Manual: the organizer chooses",
  },
};

/** 既定値の設定メッセージ（本人にだけ表示。押した人の Discord の言語で書く。§6.12） */
export function buildSettingsMessage(s: GuildSettings, note: string | null, lang: Lang = "ja") {
  const t = translator(lang);
  // 「自動: 」「手動: 」のあとの、いま選ばれている値を太字と下線で目立たせる（Discord の __**…**__）
  const [kind, value] = MODE_LABEL[lang][s.mode].split(": ") as [string, string];
  const mode = s.mode === "role" && s.roleId ? t(`${value}（<@&${s.roleId}>）`, `${value} (<@&${s.roleId}>)`) : value;
  const location = s.eventLocation ? escapeMarkdown(s.eventLocation) : t("Discord（初期値）", "Discord (default)");
  // ボイスチャンネルを既定にしているときは、そのチャンネルを出す（チャンネル名の表示は Discord がする）
  const place = s.eventChannelId
    ? [
        t(`○イベントの場所: ボイスチャンネル __**<#${s.eventChannelId}>**__`, `○Event location: voice channel __**<#${s.eventChannelId}>**__`),
        t("日時を確定して Discord イベントに登録するとき、このボイスチャンネルが最初から選ばれます", "This voice channel is preselected when a date is confirmed and added as a Discord event"),
        t(`（「場所を入力」に切り替えたときは、「${location}」が入ります）`, `(If "Enter a location" is chosen instead, "${location}" is filled in)`),
      ]
    : [
        t(`○イベントの場所: __**${location}**__`, `○Event location: __**${location}**__`),
        t("日時を確定して Discord イベントに登録するとき、「場所を入力」の欄に最初から入ります", "Filled in as the location when a date is confirmed and added as a Discord event"),
      ];
  const lines = [
    t("**このサーバーの既定値**", "**Defaults for this server**"),
    t("主催者は調整ごとに変更できます。", "Organizers can change these for each poll."),
    "",
    t(`○参加者の決め方: ${kind}: __**${mode}**__`, `○How participants are chosen: ${kind}: __**${mode}**__`),
    t("`/schedule`（`/di`）でオプションを指定しなかったときに使われます", "Used when no options are given to `/schedule` (`/di`)"),
    "",
    ...place,
  ];
  if (s.updatedBy && s.updatedAt) lines.push("", t(`（最終変更: <@${s.updatedBy}>：<t:${s.updatedAt}:f>）`, `(Last changed by <@${s.updatedBy}>: <t:${s.updatedAt}:f>)`));
  if (note) lines.push("", note);
  return {
    content: lines.join("\n"),
    allowed_mentions: { parse: [] as string[] },
    components: [
      {
        type: 1,
        components: [
          {
            type: 3,
            custom_id: "settings_mode",
            placeholder: t("参加者の決め方を選ぶ", "Choose how participants are chosen"),
            options: (["channel", "role", "manual"] as const).map((m) => ({ label: MODE_LABEL[lang][m].slice(0, 100), value: m, default: m === s.mode })),
          },
        ],
      },
      {
        type: 1,
        components: [
          {
            type: 6, // ロールの選択
            custom_id: "settings_role",
            placeholder: t("既定のロールを選ぶ（「指定したロールのメンバー」のとき）", "Choose the default role (for \"members of the selected role\")"),
            min_values: 0,
            max_values: 1,
            // 保存済みのロールは本文に表示し、選択メニューでは選んだ状態にしない
            // （そのロールが削除されていると、Discord が default_values を受け付けず画面が開けないおそれがあるため）
          },
        ],
      },
      {
        type: 1,
        components: [
          {
            type: 8, // チャンネルの選択
            custom_id: "settings_channel",
            placeholder: t("イベントの場所をボイスチャンネルにする", "Use a voice channel as the event location"),
            channel_types: [2, 13], // ボイス・ステージ（確定の画面の一覧と同じ）
            min_values: 1,
            max_values: 1,
            // 保存済みのチャンネルは本文に表示し、選んだ状態にしない（ロールと同じ理由）
          },
        ],
      },
      { type: 1, components: [{ type: 2, style: 2, label: t("イベントの場所を文字で入力", "Enter the event location as text"), custom_id: "settings_location" }] },
    ],
  };
}

/** イベントの場所を入力するフォーム（Discord のモーダル）。空にすると「Discord」に戻す */
export function buildLocationModal(current: string | null, lang: Lang = "ja") {
  const t = translator(lang);
  return {
    custom_id: "settings_location_modal",
    title: t("イベントの場所（文字で入力）", "Event location (text)"),
    components: [
      {
        type: 1,
        components: [
          {
            type: 4, // 1 行の入力欄
            custom_id: "location",
            style: 1,
            label: t("場所（空にすると「Discord」）", "Location (leave empty for \"Discord\")"),
            placeholder: "Discord",
            min_length: 0,
            max_length: EVENT_LOCATION_MAX,
            required: false,
            ...(current ? { value: current } : {}),
          },
        ],
      },
    ],
  };
}
