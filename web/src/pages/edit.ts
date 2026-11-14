// S2: 調整の作成・編集（主催者。docs/design.md §6.3, §6.9）
import { ApiError, loadPoll, request, type PollData } from "../lib/api";
import { browserTimeZone, choiceMark, dateTimeText, donationLine, rememberDonation, showError, slotText, statusBanner, syncPanel, timeZoneSelect, errorText } from "../ui/common";
import { h, notice, render, setTitle } from "../lib/dom";
import {
  CHOICE_COLORS,
  CHOICE_KINDS,
  choiceTemplates,
  DEFAULT_COLOR,
  DEFAULT_SCORE,
  KIND_LABEL,
  KIND_LABEL_EN,
  LIMITS,
  type ChoiceColor,
  type ChoiceKind,
} from "../../../src/shared/model";
import { epochToZoned, formatSlot, zonedToEpoch } from "../lib/time";
import { tr, LANG } from "../lib/i18n";

/** 英語の画面で使う月の名前 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface SlotDraft {
  id: string | null;
  startAt: number;
  endAt: number | null;
  allDay: boolean;
}
interface ChoiceDraft {
  id: string | null;
  symbol: string;
  label: string;
  kind: ChoiceKind;
  score: number;
  color: ChoiceColor;
}

const COLOR_LABEL: Record<ChoiceColor, string> = { green: tr("緑", "Green"), teal: tr("青緑", "Teal"), yellow: tr("黄", "Yellow"), orange: tr("橙", "Orange"), red: tr("赤", "Red"), gray: tr("灰", "Gray") };

const pad = (n: number) => String(n).padStart(2, "0");
/** "HH:MM" の 1 時間後（24 時を過ぎたら 0 時から数える） */
function plusOneHour(hhmm: string): string {
  const [hh, mm] = hhmm.split(":").map(Number) as [number, number];
  return `${pad((hh + 1) % 24)}:${pad(mm)}`;
}

export async function editPage(pollId: string): Promise<void> {
  let d: PollData;
  try {
    d = await loadPoll(pollId);
  } catch (e) {
    return showError(e, "edit");
  }
  rememberDonation(d.donationUrl);
  if (d.me.role !== "organizer") return showError(new ApiError(403, "forbidden", tr("この画面は主催者だけが開けます。", "Only the organizer can open this page.")));

  // 調整のタイムゾーンが未設定なら、主催者のブラウザのタイムゾーンを使う（§6.7）
  if (!d.poll.timezoneSet) {
    const btz = browserTimeZone();
    if (btz !== d.poll.timezone) {
      await request("PATCH", `/api/polls/${pollId}`, { timezone: btz, timezoneAuto: true }).catch(() => undefined);
      d = await loadPoll(pollId);
    }
  }

  // --- 画面の状態 ---
  let title = d.poll.title ?? "";
  let description = d.poll.description ?? "";
  let tz = d.poll.timezone;
  let tzChanged = false;
  let joinPolicy = d.poll.joinPolicy;
  let remindDayOffset = d.poll.remindDayOffset;
  let remindHour = d.poll.remindHour;
  let deadlineLocal = d.poll.deadlineAt ? toLocalInput(d.poll.deadlineAt, tz) : "";
  let slots: SlotDraft[] = d.slots.map((s) => ({ ...s }));
  let slotsChanged = false;
  let choices: ChoiceDraft[] = d.choices.map((c) => ({ ...c }));
  let choicesChanged = false;
  const reassign = new Map<string, string>();
  let choiceEditorOpen = false;
  const today = epochToZoned(d.now, tz);
  let month = { y: today.year, m: today.month };
  const selectedDates = new Set<string>();
  // 日付の選び方。range のときは、始まりの日と終わりの日をタップして間の日をまとめて選ぶ
  let pickMode: "single" | "range" = "single";
  let rangeStart: string | null = null;
  let lastPicked: string | null = null; // Shift + クリックで範囲を選ぶときの起点
  // このサーバーで最近使った時間帯（§6.3.1）
  const recentPresets = d.recentTimes ?? [];
  let startTime = "20:00";
  let endTime = "22:00";
  let allDay = false;
  let message: HTMLElement | null = null;
  let searchResults: { userId: string; displayName: string }[] = [];
  let roles: { id: string; name: string }[] | null = null;
  let busy = false;

  const isDraft = d.poll.status === "draft";
  const choicesLocked = d.poll.status === "closed" || d.poll.status === "fixed";
  const answerCount = (choiceId: string) => d.answers.filter((a) => a.choiceId === choiceId).length;

  /** 予定のリマインドの日時（§5.7）。確定した日時ごとに、その日か前日の決めた時刻にチャンネルへ知らせる */
  function reminderSection(): HTMLElement {
    const daySel = h(
      "select",
      { id: "remind-day", onChange: () => (remindDayOffset = Number(daySel.value)) },
      h("option", { value: "0", selected: remindDayOffset === 0 }, tr("予定の当日", "On the day of the event")),
      h("option", { value: "1", selected: remindDayOffset === 1 }, tr("予定の前日", "The day before the event")),
    );
    const hourSel = h("select", { id: "remind-hour", aria: { label: tr("リマインドする時刻", "Reminder time") }, onChange: () => (remindHour = Number(hourSel.value)) });
    for (let i = 0; i < 24; i++) hourSel.appendChild(h("option", { value: String(i), selected: remindHour === i }, `${i}:00`));
    return h(
      "section",
      { class: "card" },
      h("div", { class: "field" }, h("label", { for: "remind-day" }, tr(`予定のリマインド（${tz}）`, `Event reminder (${tz})`)), h("div", { class: "field-inline" }, daySel, hourSel)),
      h(
        "p",
        { class: "muted small" },
        tr("日時を確定すると、確定した日時ごとに、ここで決めた日時にチャンネルへリマインドを投稿します。", "After you confirm dates, a reminder is posted to the channel at this time for each confirmed date."),
        h("br"),
        h("strong", {}, tr("※予定が始まったあとになる日時には投稿しません", "No reminder is posted if this time would be after the event starts")),
        tr("（例: 当日 17:00 にすると、17:00 より前に始まる予定には投稿しません）。", " (e.g. with 17:00 on the day, events that start before 17:00 get no reminder)."),
      ),
    );
  }

  async function reloadAll(msg?: HTMLElement) {
    d = await loadPoll(pollId);
    slots = d.slots.map((s) => ({ ...s }));
    choices = d.choices.map((c) => ({ ...c }));
    slotsChanged = false;
    choicesChanged = false;
    reassign.clear();
    message = msg ?? null;
    draw();
  }

  async function save(): Promise<string[]> {
    // 公開後はタイトルを空にできない（募集メッセージの見出しになるため）
    if (!isDraft && !title.trim()) throw new Error(tr("タイトルを入力してください。公開後はタイトルを空にできません。", "Enter a title. The title can't be empty after publishing."));
    const patch: Record<string, unknown> = { description: description.trim() ? description : null, joinPolicy, remindDayOffset, remindHour };
    if (title.trim()) patch.title = title.trim();
    if (tzChanged) patch.timezone = tz;
    // 締切は変えたときだけ送る（過ぎた締切をそのまま送ると、保存全体が止まってしまうため）
    if (deadlineLocal) {
      const ep = fromLocalInput(deadlineLocal, tz);
      // 入力欄は分までなので、分単位で比べる（秒の違いで「変えた」と判定しない）
      if (ep !== null && (d.poll.deadlineAt === null || Math.floor(ep / 60) !== Math.floor(d.poll.deadlineAt / 60))) patch.deadlineAt = ep;
    }
    await request("PATCH", `/api/polls/${pollId}`, patch);
    tzChanged = false;
    const warnings: string[] = [];
    if (slotsChanged) {
      const r = await request<{ warnings?: string[] }>("PUT", `/api/polls/${pollId}/slots`, { slots });
      warnings.push(...(r.warnings ?? []));
      slotsChanged = false;
    }
    if (choicesChanged) {
      await request("PUT", `/api/polls/${pollId}/choices`, {
        choicesVersion: d.poll.choicesVersion,
        choices,
        reassign: [...reassign].map(([from, to]) => ({ from, to })),
      });
      choicesChanged = false;
    }
    return warnings;
  }

  async function run(action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    try {
      await action();
    } catch (e) {
      message = notice("error", errorText(e, "edit", tr("エラーが発生しました。", "Something went wrong.")));
      draw();
    } finally {
      busy = false;
    }
  }

  // --- 部品 ---

  /** a〜b（順不同）の日付を、今日以降だけまとめて選ぶ */
  function selectRange(a: string, b: string): void {
    const [from, to] = a <= b ? [a, b] : [b, a];
    const todayKey = `${today.year}-${pad(today.month)}-${pad(today.day)}`;
    const [fy, fm, fd] = from.split("-").map(Number) as [number, number, number];
    for (let t = Date.UTC(fy, fm - 1, fd), i = 0; i < 366; t += 86400000, i++) {
      const d = new Date(t);
      const key = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
      if (key > to) break;
      if (key >= todayKey) selectedDates.add(key);
    }
  }

  function modeButton(mode: "single" | "range", label: string): HTMLElement {
    return h(
      "button",
      {
        type: "button",
        class: `btn btn-small ${pickMode === mode ? "btn-primary" : "btn-secondary"}`,
        aria: { pressed: String(pickMode === mode) },
        onClick: () => {
          pickMode = mode;
          rangeStart = null;
          draw();
        },
      },
      label,
    );
  }

  function pickHint(): string | HTMLElement[] {
    if (pickMode === "range" && rangeStart) {
      const [, m, d] = rangeStart.split("-").map(Number);
      return tr(`${m}月${d}日から、終わりの日をタップしてください（別の月にも移れます）。`, `From ${MONTHS[(m ?? 1) - 1]} ${d}, tap the last day (you can move to another month).`);
    }
    // 日付を選んだら、候補にするには［＋ 選択した日時を候補に追加］を押す必要があることを伝える
    if (selectedDates.size) return tr(`${selectedDates.size} 日を選択中です。② で時間帯を決めて、下の［＋ 選択した日時を候補に追加］を押すと候補になります。`, `${selectedDates.size} day(s) selected. Choose a time in step 2, then press [+ Add selected dates] below to add them as options.`);
    if (pickMode === "range") return tr("始まりの日をタップしてください。", "Tap the first day.");
    // Shift + クリックの案内は、幅の広い画面（パソコン）でだけ出す
    return [
      h("span", { class: "narrow-only" }, tr("日付をタップして選びます（複数可）。", "Tap dates to select them (you can select more than one).")),
      h("span", { class: "wide-only" }, tr("日付をタップして選びます（複数可。パソコンでは Shift キーを押しながらクリックすると範囲で選べます）。", "Tap dates to select them (you can select more than one. On a computer, Shift-click to select a range).")),
    ];
  }

  /** 選んだ日付を候補に追加しないまま保存しようとしたら確かめる。追加しに戻るなら false */
  function confirmPendingDates(): boolean {
    if (selectedDates.size === 0) return true;
    if (confirm(tr(`選択中の ${selectedDates.size} 日はまだ候補に追加されていません。\n追加しないで保存しますか？\n（追加するときは［キャンセル］を押して、［＋ 選択した日時を候補に追加］を押してください）`, `The ${selectedDates.size} selected day(s) haven't been added as options yet.\nSave without adding them?\n(To add them, press [Cancel], then press [+ Add selected dates].)`))) return true;
    const btn = document.getElementById("add-slots");
    btn?.scrollIntoView({ block: "center" });
    btn?.focus();
    return false;
  }

  function calendar(): HTMLElement {
    const first = new Date(Date.UTC(month.y, month.m - 1, 1));
    const daysInMonth = new Date(Date.UTC(month.y, month.m, 0)).getUTCDate();
    const grid = h("div", { class: "cal-grid", role: "group", aria: { label: tr(`${month.y}年${month.m}月`, `${MONTHS[month.m - 1]} ${month.y}`) } });
    for (const w of [tr("日", "Sun"), tr("月", "Mon"), tr("火", "Tue"), tr("水", "Wed"), tr("木", "Thu"), tr("金", "Fri"), tr("土", "Sat")]) grid.appendChild(h("span", { class: "cal-wd", aria: { hidden: "true" } }, w));
    for (let i = 0; i < first.getUTCDay(); i++) grid.appendChild(h("span", {}));
    const todayKey = `${today.year}-${pad(today.month)}-${pad(today.day)}`;
    for (let day = 1; day <= daysInMonth; day++) {
      const key = `${month.y}-${pad(month.m)}-${pad(day)}`;
      const sel = selectedDates.has(key);
      grid.appendChild(
        h(
          "button",
          {
            type: "button",
            class: `cal-day${sel ? " is-selected" : ""}${key === todayKey ? " is-today" : ""}${key === rangeStart ? " is-range-start" : ""}`,
            aria: { pressed: String(sel), label: tr(`${month.m}月${day}日`, `${MONTHS[month.m - 1]} ${day}`) },
            disabled: key < todayKey,
            onClick: (e: MouseEvent) => {
              if (pickMode === "range") {
                if (rangeStart === null) {
                  rangeStart = key;
                } else {
                  selectRange(rangeStart, key);
                  rangeStart = null;
                }
              } else if (e.shiftKey && lastPicked && lastPicked !== key) {
                selectRange(lastPicked, key);
              } else if (sel) {
                selectedDates.delete(key);
              } else {
                selectedDates.add(key);
              }
              lastPicked = key;
              draw();
            },
          },
          String(day),
        ),
      );
    }
    const move = (delta: number) => {
      const nm = month.m + delta;
      month = { y: month.y + Math.floor((nm - 1) / 12), m: ((nm - 1 + 120) % 12) + 1 };
      draw();
    };
    return h(
      "div",
      { class: "calendar" },
      h(
        "div",
        { class: "cal-head" },
        h("button", { type: "button", class: "btn btn-secondary btn-small", onClick: () => move(-1), aria: { label: tr("前の月", "Previous month") } }, "◀"),
        h("strong", {}, tr(`${month.y}年${month.m}月`, `${MONTHS[month.m - 1]} ${month.y}`)),
        h("button", { type: "button", class: "btn btn-secondary btn-small", onClick: () => move(1), aria: { label: tr("次の月", "Next month") } }, "▶"),
      ),
      h(
        "div",
        { class: "pick-mode", role: "group", aria: { label: tr("日付の選び方", "How to select dates") } },
        modeButton("single", tr("1 日ずつ", "One day at a time")),
        modeButton("range", tr("範囲で選ぶ", "A range")),
      ),
      grid,
      h("p", { class: "muted small", aria: { live: "polite" } }, ...[pickHint()].flat()),
      selectedDates.size || rangeStart
        ? h("button", { type: "button", class: "btn btn-secondary btn-small", onClick: () => { selectedDates.clear(); rangeStart = null; lastPicked = null; draw(); } }, tr("選択を解除", "Clear selection"))
        : null,
    );
  }

  function addSlots() {
    const [sh, sm] = startTime.split(":").map(Number);
    const [eh, em] = endTime.split(":").map(Number);
    let added = 0;
    for (const key of [...selectedDates].sort()) {
      const [y, m, dd] = key.split("-").map(Number) as [number, number, number];
      let s: SlotDraft;
      if (allDay) {
        s = { id: null, startAt: zonedToEpoch(y, m, dd, 0, 0, tz), endAt: null, allDay: true };
      } else {
        const startAt = zonedToEpoch(y, m, dd, sh ?? 0, sm ?? 0, tz);
        let endAt: number | null = zonedToEpoch(y, m, dd, eh ?? 0, em ?? 0, tz);
        if (endAt === startAt) endAt = null;
        else if (endAt < startAt) endAt += 86400; // 日付をまたぐ
        s = { id: null, startAt, endAt, allDay: false };
      }
      if (slots.some((x) => x.startAt === s.startAt && x.endAt === s.endAt)) continue;
      if (slots.length >= LIMITS.slotsMax) {
        message = notice("warn", tr(`候補は ${LIMITS.slotsMax} 件までです。`, `You can add up to ${LIMITS.slotsMax} date options.`));
        break;
      }
      slots.push(s);
      added++;
    }
    slots.sort((a, b) => a.startAt - b.startAt);
    if (added) {
      slotsChanged = true;
      selectedDates.clear();
    }
    draw();
  }

  function slotSection(): HTMLElement {
    const startIn: HTMLInputElement = h("input", {
      type: "time",
      id: "start-time",
      value: startTime,
      disabled: allDay,
      onChange: () => {
        if (!startIn.value) return;
        startTime = startIn.value;
        // 開始を決めたら、終了はその 1 時間後にする（日付をまたぐときは候補の追加時に翌日として扱う）
        endTime = plusOneHour(startTime);
        endIn.value = endTime;
      },
    });
    const endIn = h("input", { type: "time", id: "end-time", value: endTime, disabled: allDay, onChange: () => (endTime = endIn.value || endTime) });
    const allDayIn = h("input", { type: "checkbox", id: "all-day", checked: allDay, onChange: () => { allDay = allDayIn.checked; draw(); } });
    const preset = (label: string, s: string, e: string) =>
      h("button", { type: "button", class: "btn btn-small btn-raised", onClick: () => { startTime = s; endTime = e; allDay = false; draw(); } }, label);
    const list = h("ul", { class: "slot-list" });
    const fixedIds = new Set(d.slots.filter((x) => x.fixedAt !== null).map((x) => x.id));
    for (const s of slots) {
      const hasAnswers = s.id !== null && d.answers.some((a) => a.slotId === s.id);
      // 確定した候補（保存済みで id が一致するもの）は削除できないので、× を出さない
      const isFixed = s.id !== null && fixedIds.has(s.id);
      list.appendChild(
        h(
          "li",
          {},
          h("span", {}, slotText(s, tz, tz).main),
          isFixed
            ? null
            : h(
                "button",
                {
                  type: "button",
                  class: "btn btn-secondary btn-small",
                  aria: { label: tr(`${formatSlot(s, tz)} を削除`, `Delete ${formatSlot(s, tz)}`) },
                  onClick: () => {
                    if (hasAnswers && !confirm(tr("この候補には回答があります。削除すると回答も消えます。よろしいですか？", "This date option has answers. Deleting it also deletes those answers. Continue?"))) return;
                    slots = slots.filter((x) => x !== s);
                    slotsChanged = true;
                    draw();
                  },
                },
                "×",
              ),
        ),
      );
    }
    return h(
      "section",
      { class: "card" },
      h("h2", { class: "card-title" }, tr("① 日付を選ぶ", "1. Select dates")),
      calendar(),
      h("h2", { class: "card-title" }, tr("② 時間帯", "2. Time")),
      recentPresets.length
        ? h(
            "div",
            { class: "preset-row" },
            h("span", { class: "preset-label muted small" }, tr("最近使った:", "Recently used:")),
            h("div", { class: "preset-btns" }, ...recentPresets.map((r) => preset(`${r.start}–${r.end}`, r.start, r.end))),
          )
        : null,
      // 開始・終了は、ラベルと入力欄を組にして並べる。1 行に収まらない幅では、それぞれを 1 行ずつ縦に並べる
      h(
        "div",
        { class: "time-fields" },
        h("div", { class: "time-field" }, h("label", { for: "start-time" }, tr("開始", "Start")), startIn),
        h("div", { class: "time-field" }, h("label", { for: "end-time" }, tr("終了", "End")), endIn),
        h("div", { class: "time-field time-field-check" }, allDayIn, h("label", { for: "all-day" }, tr("終日", "All day"))),
      ),
      selectedDates.size
        ? h("p", { class: "add-prompt", role: "status" }, tr(`選んだ ${selectedDates.size} 日を候補にするには、このボタンを押してください。`, `Press this button to add the ${selectedDates.size} selected day(s) as options.`))
        : null,
      h(
        "button",
        { type: "button", id: "add-slots", class: `btn btn-primary${selectedDates.size ? " btn-attention" : ""}`, disabled: selectedDates.size === 0, onClick: addSlots },
        tr("＋ 選択した日時を候補に追加", "+ Add selected dates"),
      ),
      h("h2", { class: "card-title" }, tr(`③ 候補一覧（${slots.length} 件）`, `3. Date options (${slots.length})`)),
      slots.length ? list : h("p", { class: "muted" }, tr("まだ候補がありません。", "No date options yet.")),
    );
  }

  function choiceSection(): HTMLElement {
    const summary = h("p", { class: "choice-summary" }, ...choices.map((c) => h("span", { class: "choice-chip" }, choiceMark(c), c.label)));
    if (!choiceEditorOpen) {
      return h(
        "section",
        { class: "card" },
        h("h2", { class: "card-title" }, tr("④ 回答の選択肢", "4. Answer choices")),
        summary,
        choicesLocked
          ? h("p", { class: "muted small" }, tr("締切後・確定後は選択肢を変更できません。", "You can't change the answer choices after the deadline or after a date is confirmed."))
          : h("button", { type: "button", class: "btn btn-secondary btn-small", onClick: () => { choiceEditorOpen = true; draw(); } }, tr("変更", "Change")),
      );
    }
    const tplSel = h(
      "select",
      {
        id: "tpl",
        onChange: () => {
          const t = choiceTemplates(LANG).find((x) => x.id === tplSel.value);
          if (!t) return;
          // いまの選択肢の ID を並び順で引き継ぐ（回答をそのまま残し、余った古い選択肢には移し先を選べるようにする）
          const keep = choices.map((c) => c.id);
          choices = t.choices.map((c, i) => ({ ...c, id: keep[i] ?? null }));
          choicesChanged = true;
          draw();
        },
      },
      h("option", { value: "" }, tr("ひな形から選ぶ…", "Choose a template…")),
      ...choiceTemplates(LANG).map((t) => h("option", { value: t.id }, tr(`${t.name}（${t.choices.map((c) => c.symbol).join("")}）`, `${t.name} (${t.choices.map((c) => c.symbol).join("")})`))),
    );
    const rows = h("ol", { class: "choice-editor" });
    choices.forEach((c, i) => {
      const mark = () => { choicesChanged = true; };
      const sym = h("input", { type: "text", value: c.symbol, maxLength: 8, class: "in-symbol", aria: { label: tr(`${i + 1} 番目の記号`, `Symbol ${i + 1}`) }, onInput: () => { c.symbol = sym.value; mark(); } });
      const lab = h("input", { type: "text", value: c.label, maxLength: 10, class: "in-label", aria: { label: tr(`${i + 1} 番目の名前`, `Name ${i + 1}`) }, onInput: () => { c.label = lab.value; mark(); } });
      const kind = h(
        "select",
        { aria: { label: tr(`${i + 1} 番目の区分`, `Type ${i + 1}`) }, onChange: () => { c.kind = kind.value as ChoiceKind; c.score = DEFAULT_SCORE[c.kind]; c.color = DEFAULT_COLOR[c.kind]; mark(); draw(); } },
        ...CHOICE_KINDS.map((k) => h("option", { value: k, selected: k === c.kind }, (LANG === "en" ? KIND_LABEL_EN : KIND_LABEL)[k])),
      );
      const score = h("input", { type: "number", min: "0", max: "10", value: String(c.score), class: "in-score", aria: { label: tr(`${i + 1} 番目の点数`, `Score ${i + 1}`) }, onInput: () => { c.score = Math.max(0, Math.min(10, Math.floor(Number(score.value) || 0))); mark(); } });
      const color = h(
        "select",
        { aria: { label: tr(`${i + 1} 番目の色`, `Color ${i + 1}`) }, onChange: () => { c.color = color.value as ChoiceColor; mark(); draw(); } },
        ...CHOICE_COLORS.map((k) => h("option", { value: k, selected: k === c.color }, COLOR_LABEL[k])),
      );
      const moveBtn = (delta: number, label: string) =>
        h("button", {
          type: "button",
          class: "btn btn-secondary btn-small",
          disabled: i + delta < 0 || i + delta >= choices.length,
          aria: { label },
          onClick: () => { const t = choices[i + delta]!; choices[i + delta] = c; choices[i] = t; mark(); draw(); },
        }, delta < 0 ? "↑" : "↓");
      rows.appendChild(
        h(
          "li",
          {},
          choiceMark(c),
          sym,
          lab,
          kind,
          score,
          color,
          moveBtn(-1, tr("上へ", "Move up")),
          moveBtn(1, tr("下へ", "Move down")),
          h("button", {
            type: "button",
            class: "btn btn-secondary btn-small",
            disabled: choices.length <= LIMITS.choicesMin,
            aria: { label: tr(`${c.label} を削除`, `Delete ${c.label}`) },
            onClick: () => { choices = choices.filter((x) => x !== c); mark(); draw(); },
          }, tr("削除", "Delete")),
        ),
      );
    });
    // 回答がある選択肢を消すときの移し先（§6.9.4）
    const keptIds = new Set(choices.filter((c) => c.id).map((c) => c.id!));
    const removedWithAnswers = d.choices.filter((c) => !keptIds.has(c.id) && answerCount(c.id) > 0);
    const reassignFields = removedWithAnswers.map((rc) => {
      const sel = h(
        "select",
        { onChange: () => { if (sel.value) reassign.set(rc.id, sel.value); else reassign.delete(rc.id); choicesChanged = true; } },
        h("option", { value: "" }, tr("移し先を選ぶ", "Choose where to move")),
        ...choices.filter((c) => c.id).map((c) => h("option", { value: c.id!, selected: reassign.get(rc.id) === c.id }, `${c.symbol} ${c.label}`)),
      );
      return h("div", { class: "field-inline" }, h("span", {}, tr(`「${rc.symbol} ${rc.label}」を選んだ回答（${answerCount(rc.id)} 件）の移し先: `, `Move the answers that chose "${rc.symbol} ${rc.label}" (${answerCount(rc.id)}) to: `)), sel);
    });
    return h(
      "section",
      { class: "card" },
      h("h2", { class: "card-title" }, tr("④ 回答の選択肢", "4. Answer choices")),
      h("div", { class: "row" }, h("label", { for: "tpl" }, tr("ひな形", "Template")), tplSel),
      h("p", { class: "muted small" }, tr("記号（1〜2 文字）・名前（10 文字まで）・区分・点数（0〜10。最有力候補の判定に使う）・色を設定できます。2〜5 個。", "Set a symbol (1–2 characters), a name (up to 10 characters), a type, a score (0–10, used to pick the best option) and a color. 2 to 5 choices.")),
      rows,
      h("button", {
        type: "button",
        class: "btn btn-secondary btn-small",
        disabled: choices.length >= LIMITS.choicesMax,
        onClick: () => { choices.push({ id: null, symbol: tr("？", "?"), label: tr(`選択肢${choices.length + 1}`, `Choice ${choices.length + 1}`), kind: "maybe", score: DEFAULT_SCORE.maybe, color: "gray" }); choicesChanged = true; draw(); },
      }, tr(`＋ 選択肢を追加（最大 ${LIMITS.choicesMax} 個）`, `+ Add a choice (up to ${LIMITS.choicesMax})`)),
      ...reassignFields,
      h("p", {}, tr("プレビュー: ", "Preview: "), ...choices.map((c) => h("span", { class: `choice-btn choice-${c.color} is-preview` }, c.symbol, " ", c.label))),
    );
  }

  function participantSection(): HTMLElement {
    const list = h("ul", { class: "member-list" });
    for (const p of d.participants) {
      list.appendChild(
        h(
          "li",
          {},
          p.displayName,
          h("button", {
            type: "button",
            class: "btn btn-secondary btn-small",
            aria: { label: tr(`${p.displayName} を参加者から外す`, `Remove ${p.displayName} from participants`) },
            onClick: () => run(async () => {
              if (!confirm(tr(`${p.displayName} を参加者から外します。この人の回答も消えます。よろしいですか？`, `Remove ${p.displayName} from the participants? Their answers will also be deleted.`))) return;
              await request("PUT", `/api/polls/${pollId}/participants`, { add: [], remove: [p.userId] });
              await reloadAll(notice("ok", tr("参加者から外しました。", "Removed from participants.")));
            }),
          }, "×"),
        ),
      );
    }
    const q = h("input", { type: "search", id: "member-q", maxLength: 32, placeholder: tr("名前で検索", "Search by name"), autocomplete: "off" });
    const results = h("ul", { class: "member-list" });
    for (const r of searchResults) {
      const already = d.participants.some((p) => p.userId === r.userId);
      results.appendChild(
        h(
          "li",
          {},
          r.displayName,
          already
            ? h("span", { class: "muted small" }, tr("参加者です", "Already a participant"))
            : h("button", {
                type: "button",
                class: "btn btn-secondary btn-small",
                onClick: () => run(async () => {
                  await request("PUT", `/api/polls/${pollId}/participants`, { add: [r.userId], remove: [] });
                  await reloadAll(notice("ok", tr(`${r.displayName} を追加しました。`, `Added ${r.displayName}.`)));
                }),
              }, tr("追加", "Add")),
        ),
      );
    }
    const mode = d.poll.targetType === "manual" ? "manual" : "auto";
    const modeAuto = h("input", { type: "radio", name: "mode", id: "mode-auto", checked: mode === "auto", disabled: !isDraft });
    const modeManual = h("input", { type: "radio", name: "mode", id: "mode-manual", checked: mode === "manual", disabled: !isDraft });
    const roleSel = h("select", { id: "role", disabled: !isDraft || mode === "manual" }, h("option", { value: "" }, tr("なし（このチャンネルのメンバー）", "None (members of this channel)")));
    if (roles) for (const r of roles) roleSel.appendChild(h("option", { value: r.id, selected: r.id === d.poll.targetId }, r.name));
    else if (d.poll.targetId) roleSel.appendChild(h("option", { value: d.poll.targetId, selected: true }, tr("（指定したロール）", "(selected role)")));
    const applyMode = () => run(async () => {
      // 参加者は設定し直され、手で追加・削除した内容は消えるので、先に確かめる
      if (!confirm(tr("参加者の決め方を変えると、参加者が設定し直され、手で追加・削除した内容は元に戻ります。よろしいですか？", "Changing how participants are chosen resets the participants, and any you added or removed by hand will be undone. Continue?"))) {
        draw();
        return;
      }
      const members = modeManual.checked ? "manual" : "auto";
      const r = await request<{ notice: string | null }>("PATCH", `/api/polls/${pollId}`, { members, roleId: members === "manual" ? null : roleSel.value || null });
      await reloadAll(r.notice ? notice("warn", r.notice) : notice("ok", tr("参加者を設定し直しました。", "Participants were reset.")));
    });
    modeAuto.addEventListener("change", applyMode);
    modeManual.addEventListener("change", applyMode);
    roleSel.addEventListener("change", applyMode);
    roleSel.addEventListener("focus", () => {
      if (roles || !isDraft) return;
      void request<{ roles: { id: string; name: string }[] }>("GET", `/api/polls/${pollId}/roles`).then((r) => { roles = r.roles; draw(); document.getElementById("role")?.focus(); }).catch(() => undefined);
    }, { once: true });
    const jpClosed = h("input", { type: "radio", name: "jp", id: "jp-closed", checked: joinPolicy === "closed", onChange: () => (joinPolicy = "closed") });
    const jpOpen = h("input", { type: "radio", name: "jp", id: "jp-open", checked: joinPolicy === "open", onChange: () => (joinPolicy = "open") });

    return h(
      "section",
      { class: "card" },
      h("h2", { class: "card-title" }, tr(`参加者（${d.participants.length} 名）`, `Participants (${d.participants.length})`)),
      h(
        "fieldset",
        {},
        h("legend", {}, tr("決め方", "How to choose"), isDraft ? "" : tr("（公開後は変更できません）", " (can't be changed after publishing)")),
        h("div", { class: "field-inline field-check" }, modeAuto, h("label", { for: "mode-auto" }, tr("自動（チャンネルのメンバー・ロールのメンバー）", "Automatic (channel members or role members)"))),
        h("div", { class: "field-inline field-check" }, modeManual, h("label", { for: "mode-manual" }, tr("手動で選ぶ", "Choose manually"))),
        h("div", { class: "field-inline" }, h("label", { for: "role" }, tr("ロール", "Role")), roleSel),
        roleHint(),
      ),
      d.participants.length ? list : h("p", { class: "muted" }, tr("参加者がいません。", "No participants.")),
      h(
        "form",
        {
          class: "row",
          onSubmit: (e) => {
            e.preventDefault();
            void run(async () => {
              const r = await request<{ members: { userId: string; displayName: string }[] }>("GET", `/api/polls/${pollId}/member-search?q=${encodeURIComponent(q.value.trim())}`);
              searchResults = r.members;
              if (!r.members.length) message = notice("info", tr("見つかりませんでした。", "No matches."));
              draw();
            });
          },
        },
        h("label", { for: "member-q" }, tr("メンバーを追加", "Add members")),
        q,
        h("button", { type: "submit", class: "btn btn-secondary btn-small" }, tr("検索", "Search")),
      ),
      results,
      h(
        "fieldset",
        {},
        h("legend", {}, tr("参加者以外が［回答する］を押したとき", "When a non-participant presses [Answer]")),
        h("div", { class: "field-inline field-check" }, jpClosed, h("label", { for: "jp-closed" }, tr("回答できない", "They can't answer"))),
        h("div", { class: "field-inline field-check" }, jpOpen, h("label", { for: "jp-open" }, tr("チャンネルを見られる人なら、参加者に追加して回答できる", "Anyone who can see the channel is added as a participant and can answer"))),
      ),
    );
  }

  /**
   * ロールで参加者を決めるようすすめる（下書きのときだけ）。
   * 公開時のお知らせと予定のリマインドは、ロールがあればそのロールに、なければ @everyone にメンションするため（§5.5、§5.7）
   */
  function roleHint(): HTMLElement | null {
    if (!isDraft) return null;
    if (d.poll.targetType === "role") {
      return h("p", { class: "muted small" }, tr("公開したときと予定のリマインドで、このロールにメンションして知らせます。", "This role is mentioned when the poll is published and in event reminders."));
    }
    return notice(
      "info",
      h("strong", {}, tr("参加者は「自動」でロールを選んで決めるのがおすすめです。", "We recommend choosing participants with \"Automatic\" and a role.")),
      tr(" 公開したときと予定のリマインドで、そのロールのメンバーにだけ通知が届きます。ロールを選ばないと、@everyone でチャンネルの全員に通知します。", " Then only that role's members are notified when the poll is published and in event reminders. Without a role, everyone in the channel is notified with @everyone."),
    );
  }

  function draw(): void {
    setTitle(isDraft ? tr("新しい日程調整", "New scheduling poll") : tr(`${d.poll.title ?? ""} の編集`, `Edit ${d.poll.title ?? ""}`));
    const titleIn = h("input", {
      type: "text",
      id: "title",
      value: title,
      maxLength: LIMITS.titleMax,
      required: true,
      autocomplete: "off",
      onInput: () => {
        title = titleIn.value;
        // 入力のたびに画面全体を描き直さず、公開ボタンと案内だけを更新する
        if (publishBtn) publishBtn.disabled = !canPublish();
        updatePublishHint();
      },
    });
    const canPublish = () => title.trim().length > 0 && slots.length > 0;
    /** 公開に足りない項目（例: 「タイトルを入力してください。」） */
    const missingText = () => {
      const items = [!title.trim() ? tr("タイトル", "Title") : null, slots.length === 0 ? tr("候補日時", "Date options") : null].filter((x): x is string => x !== null);
      return items.length ? tr(`${items.join("と")}を入力してください。`, `Enter ${items.join(" and ").toLowerCase()}.`) : "";
    };
    const missingHint = h("p", { class: "missing-hint small right", aria: { live: "polite" } }, missingText());
    const publishHint = h(
      "div",
      { hidden: !isDraft || canPublish() },
      missingHint,
      h("p", { class: "muted small right" }, tr("公開するには、タイトルと候補日時（1 件以上）が必要です。", "To publish, you need a title and at least one date option.")),
    );
    const updatePublishHint = () => {
      publishHint.hidden = !isDraft || canPublish();
      missingHint.textContent = missingText();
    };
    const descIn = h("textarea", { id: "desc", rows: 3, maxLength: LIMITS.descriptionMax, onInput: () => (description = descIn.value) });
    descIn.value = description;
    const tzSel = timeZoneSelect(tz, (v) => {
      if (slots.length && !confirm(tr("タイムゾーンを変えても、入力済みの候補の日時（世界共通の時刻）は変わりません。表示だけが変わります。よろしいですか？", "Changing the time zone doesn't change the date options you entered (the same moments in time). Only how they are shown changes. Continue?"))) {
        draw();
        return;
      }
      tz = v;
      tzChanged = true;
      if (deadlineLocal && d.poll.deadlineAt) deadlineLocal = toLocalInput(d.poll.deadlineAt, tz);
      draw();
    }, "poll-tz");
    const deadlineIn = h("input", { type: "datetime-local", id: "deadline", value: deadlineLocal, onChange: () => (deadlineLocal = deadlineIn.value) });

    const saveBtn = h("button", {
      type: "button",
      class: "btn btn-secondary",
      onClick: () => run(async () => {
        if (!confirmPendingDates()) return;
        const warnings = await save();
        await reloadAll(warnings.length ? notice("warn", tr("保存しました。", "Saved."), ...warnings.map((w) => h("p", {}, w))) : notice("ok", tr("保存しました。", "Saved.")));
      }),
    }, isDraft ? tr("下書きを保存", "Save draft") : tr("変更を保存", "Save changes"));
    const publishBtn = isDraft
      ? h("button", {
          type: "button",
          class: "btn btn-primary",
          disabled: !canPublish(),
          onClick: () => run(async () => {
            if (!confirmPendingDates()) return;
            await save();
            const r = await request<{ redirect: string }>("POST", `/api/polls/${pollId}/publish`, {});
            location.assign(r.redirect);
          }),
        }, tr("公開してチャンネルに投稿", "Publish and post to the channel"))
      : null;

    render(
      document.getElementById("app")!,
      h(
        "section",
        { class: "page" },
        h("h1", {}, isDraft ? tr("新しい日程調整", "New scheduling poll") : tr("調整の編集", "Edit poll")),
        statusBanner(d),
        message,
        syncPanel(d, () => void reloadAll(notice("ok", tr("募集メッセージを更新しました。", "The poll message was updated.")))),
        h(
          "section",
          { class: "card" },
          h("div", { class: "field" }, h("label", { for: "title" }, tr("タイトル", "Title"), h("span", { class: "required" }, tr("（必須）", " (required)"))), titleIn),
          h("div", { class: "field" }, h("label", { for: "desc" }, tr("説明（任意・1000 文字まで）", "Description (optional, up to 1000 characters)")), descIn),
          h("div", { class: "field" }, h("label", { for: "poll-tz" }, tr("タイムゾーン（候補日時を入力する基準）", "Time zone (used to enter date options)")), tzSel),
        ),
        // 参加者は、タイトル・説明・タイムゾーンのすぐ下で決める（ロールの選び方で、公開時のお知らせのメンション先も変わるため）
        participantSection(),
        slotSection(),
        choiceSection(),
        h(
          "section",
          { class: "card" },
          h("div", { class: "field" }, h("label", { for: "deadline" }, tr(`締切（${tz}）`, `Deadline (${tz})`)), deadlineIn),
          h("p", { class: "muted small" }, isDraft ? tr("締切は目安です。未入力なら公開から 7 日後になります。締切を過ぎても回答の入力・変更はできます。", "The deadline is a guide. If left empty, it is 7 days after publishing. Answers can still be entered or changed after the deadline.") : tr("締切は目安です。締切を過ぎても回答の入力・変更はできます。", "The deadline is a guide. Answers can still be entered or changed after the deadline.")),
        ),
        reminderSection(),
        h(
          "div",
          { class: "row row-end sticky-actions" },
          isDraft ? null : h("a", { class: "btn btn-secondary", href: `/p/${pollId}` }, tr("集計画面へ", "Go to results")),
          saveBtn,
          publishBtn,
        ),
        publishHint,
        h(
          "section",
          { class: "card danger-zone" },
          h("h2", { class: "card-title" }, tr("調整の削除", "Delete poll")),
          h("p", { class: "muted small" }, tr("削除すると、候補・回答などのデータはすぐに消え、元に戻せません。募集メッセージは「削除されました」に変わります。", "Deleting removes the date options, answers and other data right away, and they can't be restored. The poll message changes to \"Deleted\".")),
          h("button", {
            type: "button",
            class: "btn btn-danger btn-small",
            onClick: () => run(async () => {
              if (!confirm(tr("この調整を削除します。元に戻せません。よろしいですか？", "Delete this poll? This can't be undone."))) return;
              const r = await request<{ warnings?: string[] }>("DELETE", `/api/polls/${pollId}`, {});
              render(
                document.getElementById("app")!,
                h(
                  "section",
                  { class: "page" },
                  h("h1", {}, tr("調整を削除しました", "Poll deleted")),
                  h("p", {}, tr("データはすべて削除されました。", "All data has been deleted.")),
                  ...(r.warnings ?? []).map((w) => notice("warn", w)),
                  h("p", {}, h("a", { href: tr("/manual/", "/en/manual/") }, tr("DIscheduler のマニュアルへ", "Go to the DIscheduler manual"))),
                  donationLine(d.donationUrl),
                ),
              );
            }),
          }, tr("この調整を削除", "Delete this poll")),
        ),
        d.poll.deadlineAt && !isDraft ? h("p", { class: "muted small" }, tr(`現在の締切: ${dateTimeText(d.poll.deadlineAt, tz)}`, `Current deadline: ${dateTimeText(d.poll.deadlineAt, tz)}`)) : null,
      ),
    );
  }

  draw();
}

function toLocalInput(epoch: number, tz: string): string {
  const p = epochToZoned(epoch, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

function fromLocalInput(v: string, tz: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v);
  if (!m) return null;
  return zonedToEpoch(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), tz);
}
