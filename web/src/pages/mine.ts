// S9: 主催者の調整一覧（docs/design.md §6.11）
// Discord の［作成した調整を管理］から開く。このサーバーで自分が主催した調整だけを表示し、編集・集計・削除ができる。
import { ApiError, request, setCsrf } from "../lib/api";
import { h, notice, render, setTitle } from "../lib/dom";
import { dateTimeText, showError, STATUS_LABEL, viewerTimeZone } from "../ui/common";
import { formatSlot } from "../lib/time";
import type { PollStatus } from "../../../src/shared/model";
import { tr } from "../lib/i18n";

interface MinePoll {
  id: string;
  title: string | null;
  status: PollStatus;
  deadlineAt: number | null;
  timezone: string;
  fixed: { startAt: number; endAt: number | null; allDay: boolean }[];
  participants: number;
  answered: number;
  createdAt: number;
  updatedAt: number;
  messageUrl: string | null;
}

type Filter = "all" | "draft" | "open" | "closed" | "fixed";
// 状態の名前は、集計画面と同じもの（ui/common の STATUS_LABEL）を使う
const FILTERS: [Filter, string][] = [
  ["all", tr("すべて", "All")],
  ...(["draft", "open", "closed", "fixed"] as const).map((f): [Filter, string] => [f, STATUS_LABEL[f]!]),
];

export async function minePage(guildId: string): Promise<void> {
  const base = `/api/guilds/${guildId}`;
  let polls: MinePoll[];
  try {
    const d = await request<{ now: number; csrfToken: string; polls: MinePoll[] }>("GET", `${base}/polls`);
    setCsrf(d.csrfToken);
    polls = d.polls;
  } catch (e) {
    return showError(e);
  }
  const tz = viewerTimeZone();
  let filter: Filter = "all";
  let message: HTMLElement | null = null;
  let busy = false;

  async function open(p: MinePoll, to: "edit" | "summary"): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const r = await request<{ redirect: string }>("POST", `${base}/polls/${p.id}/open`, { to });
      if (/^\/p\/[A-Za-z0-9_-]{22}(\/edit)?$/.test(r.redirect)) location.assign(r.redirect);
    } catch (e) {
      message = notice("error", e instanceof ApiError ? e.text() : tr("開けませんでした。", "Couldn't open."));
      draw();
    } finally {
      busy = false;
    }
  }

  async function remove(p: MinePoll): Promise<void> {
    if (busy) return;
    if (!confirm(tr(`「${p.title ?? "（タイトル未入力）"}」を削除します。候補・回答などのデータはすぐに消え、元に戻せません。よろしいですか？`, `Delete "${p.title ?? "(untitled)"}"? Its date options, answers and other data will be deleted right away and can't be restored.`))) return;
    busy = true;
    try {
      const r = await request<{ warnings?: string[] }>("DELETE", `${base}/polls/${p.id}`, {});
      polls = polls.filter((x) => x.id !== p.id);
      message = notice(r.warnings?.length ? "warn" : "ok", tr(`「${p.title ?? "（タイトル未入力）"}」を削除しました。`, `Deleted "${p.title ?? "(untitled)"}".`), ...(r.warnings ?? []).map((w) => h("p", {}, w)));
    } catch (e) {
      message = notice("error", e instanceof ApiError ? e.text() : tr("削除できませんでした。", "Couldn't delete."));
    } finally {
      busy = false;
      draw();
    }
  }

  function item(p: MinePoll): HTMLElement {
    const info: (string | HTMLElement)[] = [];
    if (p.fixed.length) info.push(tr(`確定: ${p.fixed.map((f) => formatSlot(f, tz)).join("、")}`, `Confirmed: ${p.fixed.map((f) => formatSlot(f, tz)).join(", ")}`));
    else if (p.deadlineAt && p.status !== "draft") info.push(tr(`締切: ${dateTimeText(p.deadlineAt, tz)}`, `Deadline: ${dateTimeText(p.deadlineAt, tz)}`));
    if (p.status !== "draft") info.push(tr(`回答 ${p.answered} / ${p.participants} 名`, `Answered ${p.answered} / ${p.participants}`));
    info.push(tr(`更新: ${dateTimeText(p.updatedAt, tz)}`, `Updated: ${dateTimeText(p.updatedAt, tz)}`));
    return h(
      "li",
      { class: "card mine-item" },
      h(
        "div",
        { class: "mine-head" },
        h("span", { class: `badge badge-status badge-${p.status}` }, STATUS_LABEL[p.status] ?? p.status),
        h("h2", { class: "mine-title" }, p.title ?? tr("（タイトル未入力）", "(untitled)")),
      ),
      h("p", { class: "muted small mine-info" }, ...info.map((t) => h("span", {}, t))),
      h(
        "div",
        { class: "row" },
        h("button", { type: "button", class: "btn btn-primary btn-small", onClick: () => void open(p, "edit") }, tr("編集", "Edit")),
        p.status !== "draft" ? h("button", { type: "button", class: "btn btn-secondary btn-small", onClick: () => void open(p, "summary") }, tr("集計", "Results")) : null,
        p.messageUrl ? h("a", { class: "btn btn-secondary btn-small", href: p.messageUrl, rel: "noopener noreferrer" }, tr("募集メッセージ", "Poll message")) : null,
        h("button", { type: "button", class: "btn btn-danger btn-small mine-delete", onClick: () => void remove(p) }, tr("削除", "Delete")),
      ),
    );
  }

  function draw(): void {
    setTitle(tr("作成した調整", "My polls"));
    const shown = polls.filter((p) => filter === "all" || p.status === filter);
    const count = (f: Filter) => (f === "all" ? polls.length : polls.filter((p) => p.status === f).length);
    render(
      document.getElementById("app")!,
      h(
        "section",
        { class: "page" },
        h("h1", {}, tr("作成した調整", "My polls")),
        h("p", { class: "muted" }, tr("このサーバーであなたが主催している調整の一覧です。他の人には見えません。", "Polls you organize in this server. Other people can't see this list.")),
        message,
        h(
          "div",
          { class: "row mine-filter", role: "group", aria: { label: tr("状態で絞り込む", "Filter by status") } },
          ...FILTERS.map(([f, label]) =>
            h(
              "button",
              {
                type: "button",
                class: `btn btn-small ${filter === f ? "btn-primary" : "btn-secondary"}`,
                aria: { pressed: String(filter === f) },
                onClick: () => {
                  filter = f;
                  message = null;
                  draw();
                },
              },
              tr(`${label}（${count(f)}）`, `${label} (${count(f)})`),
            ),
          ),
        ),
        shown.length
          ? h("ul", { class: "mine-list" }, ...shown.map(item))
          : h("p", { class: "muted" }, polls.length ? tr("この状態の調整はありません。", "No polls with this status.") : tr("このサーバーであなたが主催している調整はありません。Discord で /schedule を実行すると作成できます。", "You don't organize any polls in this server. Run /schedule in Discord to create one.")),
        h("p", { class: "muted small" }, tr("削除した調整は元に戻せません。何も入力していない下書きは 3 日、公開した調整は締切（確定した場合は確定した日時）から 6 ヶ月で自動的に削除されます。", "Deleted polls can't be restored. Empty drafts are deleted automatically after 3 days, and published polls 6 months after the deadline (or the confirmed date).")),
      ),
    );
  }

  draw();
}
