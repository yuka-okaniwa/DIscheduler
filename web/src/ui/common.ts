// 画面共通の部品
import { ApiError, apiError, request, type PollData } from "../lib/api";
import { h, lineIcon, notice, render } from "../lib/dom";
import { donationNote } from "../../../src/shared/text";
import { DEFAULT_TIMEZONE, formatDateTime, formatSlot, isValidTimeZone, zoneAbbr, type SlotTime } from "../lib/time";
import { tr, LANG } from "../lib/i18n";
import type { Lang } from "../../../src/shared/i18n";

const TZ_KEY = "dis.viewerTz";

export function browserTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && isValidTimeZone(tz) ? tz : DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/** 閲覧者の表示タイムゾーン（ブラウザの localStorage にだけ保存する。§6.7） */
export function viewerTimeZone(): string {
  try {
    const saved = localStorage.getItem(TZ_KEY);
    if (saved && isValidTimeZone(saved)) return saved;
  } catch {
    /* 保存できない環境では既定値 */
  }
  return browserTimeZone();
}

export function setViewerTimeZone(tz: string): void {
  try {
    localStorage.setItem(TZ_KEY, tz);
  } catch {
    /* 無視 */
  }
}

export function allTimeZones(): string[] {
  const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  const list = f ? f("timeZone") : [DEFAULT_TIMEZONE, "UTC"];
  return list.includes("UTC") ? list : [...list, "UTC"];
}

type TzEntry = { id: string; name: string; offset: string; haystack: string };
let tzEntries: TzEntry[] | null = null;

/** タイムゾーン・名前の書き方ごとの Intl.DateTimeFormat（作るのに時間がかかるので使い回す。作れなければ null） */
const zoneFormatters = new Map<string, Intl.DateTimeFormat | null>();

/** タイムゾーンの名前（style に合わせて「日本標準時」「GMT+9」など）。言語を渡さなければ画面の言語。取れなければ空文字 */
function zonePart(tz: string, style: Intl.DateTimeFormatOptions["timeZoneName"], at: Date, lang: Lang = LANG): string {
  const key = `${tz}|${style}|${lang}`;
  let f = zoneFormatters.get(key);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat(lang === "en" ? "en-US" : "ja-JP", { timeZone: tz, timeZoneName: style });
    } catch {
      f = null;
    }
    zoneFormatters.set(key, f);
  }
  return f?.formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "";
}

/**
 * 画面に出すタイムゾーンの説明。例: 日本標準時（UTC+9）。名前が取れなければ IANA 名（例: Asia/Tokyo（UTC+9））。
 * UTC からの差は、表示する日時（at）の時点のもの。夏時間をまたいで差が変わるときは、差を書かず名前だけにする
 */
export function timeZoneLabel(tz: string, at: readonly number[]): string {
  const dates = (at.length ? at : [Math.floor(Date.now() / 1000)]).map((sec) => new Date(sec * 1000));
  const name = zonePart(tz, "longGeneric", dates[0]!) || zonePart(tz, "long", dates[0]!) || tz;
  const offsets = new Set(dates.map((d) => zonePart(tz, "shortOffset", d).replace(/^GMT/, "UTC") || "UTC"));
  return offsets.size === 1 ? tr(`${name}（${[...offsets][0]}）`, `${name} (${[...offsets][0]})`) : name;
}

/**
 * タイムゾーンの一覧に、名前と UTC からの差を添える（検索に使う。最初に開いたときに 1 回だけ作る）。
 * 名前は画面の言語で表示する。日本語の画面では英語の名前でも探せる（例: Japan）。
 * 英語の画面で日本語の名前で探せるのは、日本（Asia/Tokyo。例: 日本）だけ
 */
function timeZoneEntries(): TzEntry[] {
  if (tzEntries) return tzEntries;
  const now = new Date();
  const part = (tz: string, style: Intl.DateTimeFormatOptions["timeZoneName"]): string => zonePart(tz, style, now);
  tzEntries = allTimeZones().map((id) => {
    const name = part(id, "longGeneric") || part(id, "long");
    const other: Lang = LANG === "en" ? "ja" : "en";
    const otherName = LANG === "ja" || id === DEFAULT_TIMEZONE ? zonePart(id, "longGeneric", now, other) || zonePart(id, "long", now, other) : "";
    const gmt = part(id, "shortOffset"); // 例: GMT+9、GMT-3:30、GMT
    const offset = gmt.replace(/^GMT/, "UTC") || "UTC";
    const haystack = normalizeTzQuery([id, id.replace(/_/g, " "), name, otherName, offset, gmt, offset.replace(/^UTC/, "")].join(" "));
    return { id, name, offset, haystack };
  });
  return tzEntries;
}

function normalizeTzQuery(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[_\s]+/g, " ");
}

/** 入力した文字列（空白区切りのすべての語を含むもの）に合うタイムゾーン */
export function filterTimeZones(query: string): TzEntry[] {
  const words = normalizeTzQuery(query).split(" ").filter(Boolean);
  const all = timeZoneEntries();
  if (!words.length) return all;
  return all.filter((e) => words.every((w) => e.haystack.includes(w)));
}

/**
 * タイムゾーンの選択欄。文字を入れると一覧を絞り込める（例: Tokyo、日本、+9）。
 * 一覧はボタンではなく listbox（WAI-ARIA の combobox）で、矢印キーと Enter でも選べる。
 * 一覧にあるタイムゾーンしか選べない（決めずに離れると、元の値に戻す）
 */
export function timeZoneSelect(current: string, onChange: (tz: string) => void, id = "tz", align: "left" | "right" = "left"): HTMLElement {
  let value = current;
  let matches: TzEntry[] = [];
  let active = -1;
  const listId = `${id}-list`;
  const input = h("input", {
    type: "text",
    id,
    value,
    autocomplete: "off",
    role: "combobox",
    placeholder: tr("検索（例: Tokyo、日本、+9）", "Search (e.g. Tokyo, Japan, +9)"),
    aria: { autocomplete: "list", expanded: "false", controls: listId },
  });
  input.spellcheck = false;
  const list = h("ul", { id: listId, class: `tz-list tz-list-${align}`, role: "listbox", hidden: true, aria: { label: tr("タイムゾーンの候補", "Time zone suggestions") } });

  const open = (query: string) => {
    matches = filterTimeZones(query);
    active = matches.findIndex((e) => e.id === value);
    if (active < 0 && matches.length) active = 0;
    list.replaceChildren(
      ...matches.map((e, i) => {
        const li = h(
          "li",
          { id: `${listId}-${i}`, role: "option", class: "tz-option", aria: { selected: String(e.id === value) } },
          h("span", { class: "tz-id" }, e.id),
          h("span", { class: "tz-meta" }, [e.name, e.offset].filter(Boolean).join(tr("・", " · "))),
        );
        // 入力欄からフォーカスが外れる前に選べるよう、mousedown で決める
        li.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          pick(e.id);
        });
        return li;
      }),
    );
    if (!matches.length) list.appendChild(h("li", { class: "tz-empty" }, tr("見つかりませんでした", "No matches")));
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    highlight();
  };
  const close = () => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };
  const highlight = () => {
    list.querySelectorAll(".tz-option.is-active").forEach((el) => el.classList.remove("is-active"));
    const el = active >= 0 ? document.getElementById(`${listId}-${active}`) : null;
    if (el) {
      el.classList.add("is-active");
      el.scrollIntoView({ block: "nearest" });
      input.setAttribute("aria-activedescendant", el.id);
    } else input.removeAttribute("aria-activedescendant");
  };
  const pick = (tz: string) => {
    close();
    input.value = tz;
    if (tz === value) return;
    value = tz;
    onChange(tz);
  };

  input.addEventListener("focus", () => {
    input.select();
    open("");
  });
  input.addEventListener("click", () => {
    if (list.hidden) open("");
  });
  input.addEventListener("input", () => open(input.value));
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (list.hidden) return open(input.value);
      if (!matches.length) return;
      active = ev.key === "ArrowDown" ? Math.min(active + 1, matches.length - 1) : Math.max(active - 1, 0);
      highlight();
    } else if (ev.key === "Enter") {
      if (list.hidden) return;
      ev.preventDefault();
      const e = matches[active];
      if (e) pick(e.id);
    } else if (ev.key === "Escape") {
      if (list.hidden) return;
      ev.preventDefault();
      close();
      input.value = value;
    }
  });
  input.addEventListener("blur", () => {
    close();
    input.value = value;
  });

  return h("div", { class: "tz-picker" }, input, list);
}

/** ヘッダー右上の表示タイムゾーン切り替え（S3・S4） */
export function mountViewerTzSwitch(onChange: () => void): void {
  const tools = document.getElementById("header-tools");
  if (!tools) return;
  const picker = timeZoneSelect(viewerTimeZone(), (tz) => {
    setViewerTimeZone(tz);
    onChange();
  }, "viewer-tz", "right");
  picker.classList.add("tz-switch");
  render(tools, h("label", { class: "visually-hidden", for: "viewer-tz" }, tr("表示するタイムゾーン", "Time zone to display")), picker);
}

/** 候補日時の表示。閲覧者のタイムゾーンが調整と違えば両方を出す（§6.7） */
export function slotText(slot: SlotTime, pollTz: string, viewerTz: string): { main: string; sub: string | null } {
  // 閲覧者のタイムゾーンが調整と同じなら、タイムゾーンの略号（JST など）は付けない（候補の行を短くするため）
  if (viewerTz === pollTz || slot.allDay) return { main: formatSlot(slot, pollTz), sub: null };
  return {
    main: `${formatSlot(slot, pollTz)} ${zoneAbbr(slot.startAt, pollTz)}`,
    sub: tr(`あなたの時刻: ${formatSlot(slot, viewerTz)} ${zoneAbbr(slot.startAt, viewerTz)}`, `Your time: ${formatSlot(slot, viewerTz)} ${zoneAbbr(slot.startAt, viewerTz)}`),
  };
}

/**
 * メンバー別の回答の表（行がメンバー、列が候補。保存済みの回答を出す）。畳んだ状態で置き、開くと表を見られる。
 * 集計画面（［メンバー別に表示］）と回答画面（［みんなの回答］）で使う。
 * open・onToggle で、画面を描き直しても開いた状態を保てる
 */
export function memberMatrix(d: PollData, tz: string, label: string, open = false, onToggle?: (open: boolean) => void): HTMLElement {
  const choiceById = new Map(d.choices.map((c) => [c.id, c]));
  // 「候補:メンバー」→ 回答。表の各マスで毎回探さないよう、先に索引を作る
  const answerAt = new Map(d.answers.map((a) => [`${a.slotId}:${a.userId}`, a]));
  const head = h("tr", {}, h("th", { scope: "col" }, tr("メンバー", "Member")), ...d.slots.map((s) => h("th", { scope: "col" }, slotText(s, d.poll.timezone, tz).main)));
  const body = h("tbody");
  for (const p of d.participants) {
    body.appendChild(
      h(
        "tr",
        { class: p.userId === d.me.userId ? "is-me" : "" },
        h("th", { scope: "row" }, p.displayName, p.comment ? h("span", { class: "slot-sub" }, p.comment) : null),
        ...d.slots.map((s) => {
          const a = answerAt.get(`${s.id}:${p.userId}`);
          const c = a ? choiceById.get(a.choiceId) : undefined;
          return h("td", { class: "num" }, c ? choiceMark(c) : h("span", { class: "muted" }, "—"));
        }),
      ),
    );
  }
  const details = h(
    "details",
    { class: "card", open },
    h("summary", {}, label),
    h("div", { class: "table-wrap matrix" }, h("table", { class: "data" }, h("thead", {}, head), body)),
  );
  if (onToggle) details.addEventListener("toggle", () => onToggle(details.open));
  return details;
}

export function dateTimeText(epoch: number, tz: string): string {
  return `${formatDateTime(epoch, tz)} ${zoneAbbr(epoch, tz)}`;
}

export function choiceMark(c: { symbol: string; label: string; color: string }, extra = ""): HTMLElement {
  return h("span", { class: `mark mark-${c.color} ${extra}`.trim(), title: c.label, aria: { label: c.label } }, c.symbol);
}

export const STATUS_LABEL: Record<string, string> = {
  draft: tr("下書き", "Draft"),
  open: tr("募集中", "Open"),
  closed: tr("締切後", "Closed"),
  fixed: tr("確定", "Confirmed"),
  cancelled: tr("削除済み", "Deleted"),
};

/** エラーが出た画面の種類。リンクの期限が切れたときに、どのボタンを押し直せばよいかの案内を変える */
export type PageKind = "answer" | "summary" | "edit" | "done" | "link";

/** サーバーのメッセージだけで、新しいリンクの受け取り方まで伝えているエラー */
const SELF_EXPLAINING = new Set(["list_session_expired", "link_expired"]);

/** リンク（セッション）の期限が切れたときに、新しいリンクを受け取る方法 */
export function reopenHint(kind: PageKind): string {
  switch (kind) {
    case "answer":
      return tr("チャンネルの募集メッセージの［回答する］を、もう一度押してください。", "Press [Answer] on the poll message in the channel again.");
    case "summary":
      return tr("チャンネルの募集メッセージの［集計を見る］を、もう一度押してください。", "Press [View results] on the poll message in the channel again.");
    case "edit":
    case "done":
      return tr("Discord でもう一度 /schedule を実行し、［作成した調整を管理］を押して、新しいリンクを受け取ってください。", "Run /schedule in Discord again and press [Manage my polls] to get a new link.");
    default:
      return tr("参加者はチャンネルの募集メッセージの［回答する］または［集計を見る］を、主催者は Discord で /schedule を実行して［作成した調整を管理］を、もう一度押してください。", "Participants: press [Answer] or [View results] on the poll message again. Organizers: run /schedule in Discord and press [Manage my polls] again.");
  }
}

/** 画面の中に出すエラーの文。リンクの期限切れなら、新しいリンクを受け取る方法を添える */
export function errorText(e: unknown, kind: PageKind, fallback: string): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : fallback;
  if (e.status === 401 && !SELF_EXPLAINING.has(e.code)) return `${e.message}${reopenHint(kind)}`;
  return e.message;
}

/** エラー画面（S5） */
/** いま表示しているエラー（リンク中継の画面で言語を切り替えたときに、描き直すため） */
let shownError: { err: unknown; kind: PageKind } | null = null;
export function redrawError(): void {
  if (shownError) showError(shownError.err, shownError.kind);
}

export function showError(err: unknown, kind: PageKind = "link"): void {
  shownError = { err, kind };
  const app = document.getElementById("app")!;
  const e = err instanceof ApiError ? err : apiError(0, "unknown", "エラーが発生しました。", "Something went wrong.");
  const freeTier = e.code === "free_tier_exceeded";
  render(
    app,
    h(
      "section",
      { class: "card error-card" },
      h("h1", {}, freeTier ? tr("本日の無料枠を超えました", "Today's free tier has been used up") : e.status === 401 || e.status === 404 ? tr("ページを開けません", "Can't open this page") : tr("エラーが発生しました", "Something went wrong")),
      h("p", {}, e.text()),
      // リンクの期限切れは、画面に合わせて押し直すボタンを案内する。
      // 一覧ページの期限切れと、中継ページで使えなかったリンクは、サーバーのメッセージで受け取り方まで伝えるので、ここでは出さない
      e.status === 401 && !SELF_EXPLAINING.has(e.code) ? h("p", {}, reopenHint(kind)) : null,
      freeTier && donationFromError ? h("p", {}, tr("運営を支援していただけると、有料プランへの切り替えを検討できます: ", "With your support, we can consider moving to a paid plan: "), h("a", { href: donationFromError, rel: "noopener noreferrer" }, tr("運営を支援する", "Support DIscheduler"))) : null,
      h("p", {}, h("a", { href: "/manual/" }, tr("DIscheduler のマニュアルへ", "Go to the DIscheduler manual"))),
    ),
  );
}

/** コーヒーカップ（Lucide の coffee。public/assets/lucide-LICENSE.txt） */
const COFFEE_PATHS = ["M10 2v2", "M14 2v2", "M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1", "M6 2v2"] as const;

/**
 * 完了の画面に置く寄付リンク（§6.10）。枠で囲み、コーヒーカップの絵を添える。
 * 回答の完了画面（public/answered.html）と同じ形にする。寄付リンクがなければ null
 */
export function donationLine(url: string | null): HTMLElement | null {
  if (!url) return null;
  const note = donationNote(url, LANG);
  const cup = h("span", { class: "support-cup" });
  cup.appendChild(lineIcon("support-cup-ic", COFFEE_PATHS));
  return h(
    "aside",
    { class: "support-card", aria: { label: tr("運営の支援", "Support") } },
    cup,
    h(
      "div",
      { class: "support-body" },
      h("p", { class: "support-lead" }, tr("DIscheduler は無料で運営しています。役に立ったら、コーヒー 1 杯分の支援をいただけるとうれしいです。", "DIscheduler is free to use. If it helped you, a coffee's worth of support would be much appreciated.")),
      h("p", {}, h("a", { class: "btn btn-secondary btn-small", href: url, rel: "noopener noreferrer" }, tr("コーヒーを 1 杯おごる", "Buy me a coffee"))),
      h("p", { class: "term" }, tr("任意です。支援の有無で機能は変わりません。", "Optional. Supporting doesn't change any features.")),
      note ? h("p", { class: "term" }, note) : null,
    ),
  );
}

let donationFromError: string | null = null;
export function rememberDonation(url: string | null): void {
  donationFromError = url;
}

/** 募集メッセージの更新状況（主催者だけ。§6.5） */
export function syncPanel(d: PollData, reload: () => void): HTMLElement | null {
  if (d.me.role !== "organizer" || d.poll.status === "draft") return null;
  const repostStatus = h("p", { class: "muted", role: "status" });
  const repostBtn = h(
    "button",
    {
      class: d.poll.messageUrl ? "btn btn-secondary btn-small" : "btn btn-primary btn-small",
      type: "button",
      onClick: async () => {
        const msg = d.poll.messageUrl
          ? tr("募集メッセージをチャンネルに投稿し直します（いまのメッセージは削除します）。よろしいですか？", "Repost the poll message to the channel? (The current message will be deleted.)")
          : tr("募集メッセージをチャンネルにもう一度投稿します。よろしいですか？", "Post the poll message to the channel again?");
        if (!confirm(msg)) return;
        repostBtn.disabled = true;
        repostStatus.textContent = tr("投稿しています…", "Posting…");
        try {
          await request("POST", `/api/polls/${d.poll.id}/repost`, {});
          reload();
        } catch (e) {
          repostStatus.textContent = errorText(e, "summary", tr("投稿できませんでした。", "Couldn't post."));
          repostBtn.disabled = false;
        }
      },
    },
    d.poll.messageUrl ? tr("チャンネルに投稿し直す", "Repost to the channel") : tr("もう一度投稿する", "Post again"),
  );
  if (!d.poll.messageUrl) {
    // Discord で募集メッセージが削除されると、［回答する］ボタンもなくなるため、投稿し直せるようにする
    return h(
      "section",
      { class: "card sync-panel", aria: { label: tr("募集メッセージ", "Poll message") } },
      h("h2", { class: "card-title" }, tr("チャンネルの募集メッセージ", "Poll message in the channel"), h("span", { class: "tag tag-optional" }, tr("主催者だけに表示", "Only you (the organizer) can see this"))),
      notice("warn", tr("募集メッセージが見つかりません。Discord で削除された可能性があります。参加者が［回答する］を押せるよう、もう一度投稿してください。", "The poll message can't be found. It may have been deleted in Discord. Post it again so participants can press [Answer].")),
      h("div", { class: "row" }, repostBtn),
      repostStatus,
    );
  }
  const tz = viewerTimeZone();
  const pending = d.poll.pendingChanges ?? 0;
  const status = h("p", { class: "muted", role: "status" });
  const btn = h(
    "button",
    {
      class: "btn btn-secondary btn-small",
      type: "button",
      onClick: async () => {
        btn.disabled = true;
        status.textContent = tr("更新しています…", "Updating…");
        try {
          await request("POST", `/api/polls/${d.poll.id}/sync-message`, {});
          reload();
        } catch (e) {
          status.textContent = errorText(e, "summary", tr("更新できませんでした。", "Couldn't update."));
          btn.disabled = false;
        }
      },
    },
    tr("今すぐ更新", "Update now"),
  );
  return h(
    "section",
    { class: "card sync-panel", aria: { label: tr("募集メッセージの更新状況", "Poll message update status") } },
    h("h2", { class: "card-title" }, tr("チャンネルの募集メッセージ", "Poll message in the channel"), h("span", { class: "tag tag-optional" }, tr("主催者だけに表示", "Only you (the organizer) can see this"))),
    h(
      "dl",
      { class: "kv" },
      h("dt", {}, tr("最終更新", "Last updated")),
      h("dd", {}, d.poll.lastSyncedAt ? dateTimeText(d.poll.lastSyncedAt, tz) : tr("まだ更新していません", "Not updated yet")),
      h("dt", {}, tr("未反映の回答の変更", "Answer changes not yet shown")),
      h("dd", {}, pending > 0 ? tr(`あり（${pending} 件）`, `Yes (${pending})`) : tr("なし（回答は反映済みです。締切などの表示を最新にしたいときも［今すぐ更新］を押せます）", "None (all answers are shown. You can also press [Update now] to refresh the deadline and other details)")),
      h("dt", {}, tr("次の自動更新", "Next automatic update")),
      h("dd", {}, d.poll.nextAutoSyncAt ? dateTimeText(d.poll.nextAutoSyncAt, tz) : "—", d.poll.status === "fixed" ? "" : tr("（回答の保存時にも自動で更新されます）", " (also updated automatically when answers are saved)")),
    ),
    h("div", { class: "row" }, btn, h("a", { href: d.poll.messageUrl, rel: "noopener noreferrer" }, tr("募集メッセージを開く", "Open the poll message")), repostBtn),
    status,
    repostStatus,
  );
}

export function statusBanner(d: PollData): HTMLElement | null {
  const tz = viewerTimeZone();
  const fixed = d.slots.filter((x) => x.fixedAt !== null);
  if (d.poll.status === "fixed" && fixed.length) {
    const when = fixed.map((s) => slotText(s, d.poll.timezone, tz).main).join(tr("、", ", "));
    return notice("ok", h("strong", {}, tr(`${when} に確定しています。`, `Confirmed for ${when}.`)), tr(" 予定が変わった場合は回答を変更してください。", " If your plans change, please update your answer."));
  }
  if (d.poll.status === "closed") return notice("info", tr("締切を過ぎています。回答の入力・変更はできます。", "The deadline has passed. You can still enter or change your answer."));
  if (d.poll.status === "draft") return notice("info", tr("この調整はまだ公開されていません。", "This poll has not been published yet."));
  return null;
}
