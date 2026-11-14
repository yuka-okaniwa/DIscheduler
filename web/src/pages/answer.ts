// S3: 回答入力（各候補の集計つき。docs/design.md §6.4）
import { loadPoll, request, type PollData } from "../lib/api";
import { choiceMark, dateTimeText, memberMatrix, mountViewerTzSwitch, timeZoneLabel, rememberDonation, showError, slotText, statusBanner, viewerTimeZone, errorText } from "../ui/common";
import { h, notice, render, setTitle } from "../lib/dom";
import { canAnswer, tally } from "../../../src/shared/model";
import { formatDate, formatSlotTime, zoneAbbr } from "../lib/time";
import { tr } from "../lib/i18n";

export async function answerPage(pollId: string): Promise<void> {
  const app = document.getElementById("app")!;
  let data: PollData;
  try {
    data = await loadPoll(pollId);
  } catch (e) {
    return showError(e, "answer");
  }
  rememberDonation(data.donationUrl);
  if (!data.me.isParticipant) {
    location.replace(`/p/${pollId}`);
    return;
  }

  // 入力中の内容（保存するまで集計には入れない）
  const draft = new Map<string, string>();
  for (const a of data.answers) if (a.userId === data.me.userId) draft.set(a.slotId, a.choiceId);
  let comment = data.me.comment ?? "";
  let message: HTMLElement | null = null;
  // 描き直しても、押したボタンのフォーカスと、開いた［みんなの回答］を保つ（画面全体を作り直すため）
  let focusKey: string | null = null;
  let whoOpen = false;

  const reload = async (msg?: HTMLElement) => {
    try {
      data = await loadPoll(pollId);
      message = msg ?? null;
      draw();
    } catch (e) {
      showError(e, "answer");
    }
  };

  mountViewerTzSwitch(() => draw());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void reload(message ?? undefined);
  });

  function draw(): void {
    const d = data;
    const tz = viewerTimeZone();
    setTitle(d.poll.title ?? tr("回答", "Answer"));
    const saved = d.answers.map((a) => ({ slotId: a.slotId, userId: a.userId, choiceId: a.choiceId }));
    const slots = d.slots.map((s) => ({ id: s.id, startAt: s.startAt }));
    const t = tally(slots, d.choices, saved);
    const answeredUsers = new Set(d.answers.map((a) => a.userId));
    const editable = canAnswer(d.poll.status);
    const first = d.choices[0];
    const last = d.choices[d.choices.length - 1];

    // 同じ日に候補が 2 つ以上ある調整だけ、同じ日付の候補を 1 つの枠で囲み、日付は枠の最初の行の時間帯の上にだけ書く（枠の中は区切り線を引かない）。
    // どの日も候補が 1 つなら、1 つの枠に区切り線で並べ、行に日付と時間帯を書く（日付は調整のタイムゾーンで決める。候補は日時の順に並んでいる）
    const dates = d.slots.map((s) => formatDate(s.startAt, d.poll.timezone));
    const slotStarts = d.slots.map((s) => s.startAt);
    const byDate = new Set(dates).size < dates.length;
    const list = h("div", { class: `answer-list${byDate ? " is-grouped" : ""}` });
    let day: HTMLElement | null = byDate ? null : list.appendChild(h("ol", { class: "answer-day" }));
    let dayLabel = "";
    d.slots.forEach((s, i) => {
      const st = slotText(s, d.poll.timezone, tz);
      const label = dates[i]!;
      const firstOfDay = byDate && (!day || label !== dayLabel);
      if (firstOfDay) {
        dayLabel = label;
        day = list.appendChild(h("ol", { class: "answer-day", aria: { label } }));
      }
      // 閲覧者のタイムゾーンが違うときだけ、略号（JST など）を付ける（slotText と同じ決まり）
      const time = byDate ? formatSlotTime(s, d.poll.timezone) + (st.sub ? ` ${zoneAbbr(s.startAt, d.poll.timezone)}` : "") : st.main;
      const tt = t.get(s.id)!;
      const isFixed = s.fixedAt !== null;
      const group = h("div", { class: "choice-group", role: "radiogroup", aria: { label: tr(`${st.main} の回答`, `Answer for ${st.main}`) } });
      for (const c of d.choices) {
        const selected = draft.get(s.id) === c.id;
        group.appendChild(
          h(
            "button",
            {
              type: "button",
              // 1 行に収めるため、ボタンには記号だけを出す。名前は読み上げとマウスを乗せたときの表示、表の上の凡例で伝える
              class: `choice-btn choice-btn-compact choice-${c.color}${selected ? " is-selected" : ""}`,
              role: "radio",
              title: c.label,
              aria: { checked: String(selected), label: `${c.symbol} ${c.label}` },
              data: { choiceKey: `${s.id}:${c.id}` },
              disabled: !editable,
              onClick: () => {
                draft.set(s.id, c.id);
                focusKey = `${s.id}:${c.id}`;
                draw();
              },
            },
            h("span", { class: "choice-symbol", aria: { hidden: "true" } }, c.symbol),
          ),
        );
      }
      // 1 件を 1 行にまとめる: 左に日時と集計（人数だけ）、右に選択ボタン。狭い画面でボタンが入らなければ、ボタンだけ次の行に回る
      day!.appendChild(
        h(
          "li",
          { class: `answer-row${isFixed ? " is-fixed" : ""}` },
          h(
            "div",
            { class: "answer-when" },
            h(
              "div",
              { class: "slot-head" },
              // 日付は、その日の枠の最初の行にだけ、時間帯の上に書く（読み上げは一覧の名前で伝える）
              firstOfDay ? h("span", { class: "answer-date", aria: { hidden: "true" } }, label) : null,
              // 最有力候補（★）は回答画面には出さない（集計画面だけで出す）
              isFixed ? h("span", { class: "badge badge-fixed" }, tr("確定", "Confirmed")) : null,
              h("span", { class: "slot-main" }, time),
            ),
            st.sub ? h("span", { class: "slot-sub" }, st.sub) : null,
            h(
              "div",
              { class: "tally-line" },
              h("span", { class: "visually-hidden" }, tr("いまの回答: ", "Current answers: ")),
              ...d.choices.map((c) => h("span", { class: "tally-item" }, choiceMark(c, "mark-tiny"), String(tt.byChoice[c.id] ?? 0))),
              h("span", { class: "tally-item muted" }, tr(`未回答 ${d.participants.length - tt.answered}`, `No answer ${d.participants.length - tt.answered}`)),
            ),
          ),
          group,
        ),
      );
    });

    const commentInput = h("input", {
      id: "comment",
      type: "text",
      maxLength: 100,
      value: comment,
      disabled: !editable,
      autocomplete: "off",
      onInput: () => (comment = commentInput.value),
    });
    const saveBtn = h("button", { type: "submit", class: "btn btn-primary", disabled: !editable }, tr("保存する", "Save"));
    const form = h(
      "form",
      {
        class: "answer-form",
        onSubmit: async (e) => {
          e.preventDefault();
          saveBtn.disabled = true;
          try {
            await request("PUT", `/api/polls/${pollId}/answers/me`, {
              choicesVersion: d.poll.choicesVersion,
              answers: [...draft].map(([slotId, choiceId]) => ({ slotId, choiceId })),
              comment: comment.trim() ? comment.trim() : null,
            });
            // 回答の完了画面へ移る（広告の枠はこの画面にだけ出す。§6.4, §6.10.1）。
            // 調整の ID は # の後ろに置き、サーバーのログにも広告の枠にも送らない
            // 完了画面も画面の言語のページへ（英語版は /en/answered。§6.12）
            location.assign(`${tr("/answered", "/en/answered")}#p=${pollId}`);
          } catch (err) {
            message = notice("error", errorText(err, "answer", tr("保存できませんでした。", "Couldn't save.")));
            saveBtn.disabled = false;
            draw();
          }
        },
      },
      h(
        "p",
        { class: "choice-legend muted small" },
        ...d.choices.flatMap((c, i) => [i ? "　" : "", choiceMark(c, "mark-tiny"), ` ${c.label}`]),
      ),
      // 候補の行にはタイムゾーンを書かないので（閲覧者と同じとき）、ここで一度だけ書く
      h(
        "p",
        { class: "tz-note small" },
        // UTC からの差は、候補の日時の時点のもの（夏時間で変わるため）
        // 「あなたの時刻」は時刻のある候補にだけ出るので、終日の候補だけなら調整のタイムゾーンだけを書く
        ...(tz === d.poll.timezone || d.slots.every((s) => s.allDay)
          ? [tr("日時はすべて", "All times are shown in "), h("strong", {}, timeZoneLabel(d.poll.timezone, slotStarts)), tr("で表示しています。", ".")]
          : [tr("候補の日時は調整のタイムゾーンの", "Date options are shown in the poll's time zone, "), h("strong", {}, timeZoneLabel(d.poll.timezone, slotStarts)), tr("、「あなたの時刻」は", ", and \"Your time\" in "), h("strong", {}, timeZoneLabel(tz, slotStarts)), tr("で表示しています。", ".")]),
      ),
      list,
      editable && first && last
        ? h(
            "div",
            { class: "row" },
            h("button", { type: "button", class: "btn btn-secondary btn-small", onClick: () => { for (const s of d.slots) draft.set(s.id, first.id); draw(); } }, tr(`すべて${first.symbol}`, `All ${first.symbol}`)),
            h("button", { type: "button", class: "btn btn-secondary btn-small", onClick: () => { for (const s of d.slots) draft.set(s.id, last.id); draw(); } }, tr(`すべて${last.symbol}`, `All ${last.symbol}`)),
          )
        : null,
      h("div", { class: "field" }, h("label", { for: "comment" }, tr("ひとこと（任意・100 文字まで）", "Comment (optional, up to 100 characters)")), commentInput),
      h("p", { class: "muted small" }, tr("あなたの回答とひとことは、この調整の参加者全員に表示されます。参加者以外には表示されません。", "Your answers and comment are shown to all participants in this poll. They are not shown to anyone else.")),
      h("div", { class: "row row-end" }, h("a", { class: "btn btn-secondary", href: `/p/${pollId}` }, tr("集計表を見る", "View results")), saveBtn),
    );

    render(
      document.getElementById("app")!,
      h(
        "section",
        { class: "page" },
        // まだ誰も回答を保存していないときは、最初の回答者だと分かるようにする（§6.4）
        editable && d.answers.length === 0 ? notice("info", tr("あなたが最初の入力者です。", "You are the first to answer.")) : null,
        h("h1", {}, d.poll.title ?? tr("日程調整", "Scheduling poll")),
        h(
          "p",
          { class: "meta" },
          d.poll.deadlineAt ? tr(`締切 ${dateTimeText(d.poll.deadlineAt, tz)}`, `Deadline ${dateTimeText(d.poll.deadlineAt, tz)}`) : "",
          h("span", { class: "sep" }, "／"),
          tr(`あなた: ${d.me.displayName ?? ""}`, `You: ${d.me.displayName ?? ""}`),
          h("span", { class: "sep" }, "／"),
          tr(`回答 ${answeredUsers.size}/${d.participants.length} 名`, `Answered ${answeredUsers.size}/${d.participants.length}`),
          " ",
          h("button", { type: "button", class: "btn btn-secondary btn-small", onClick: () => void reload() }, tr("↻ 更新", "↻ Refresh")),
        ),
        d.poll.description ? h("p", { class: "description" }, d.poll.description) : null,
        statusBanner(d),
        // 回答したあとに主催者が選択肢を変えていたら知らせる（§6.9.4）
        // ［確認しました］を押すまで表示する（ひとことだけの保存などでは消さない）
        d.me.needsChoicesAck && d.poll.choicesChangedAt
          ? notice(
              "warn",
              tr(`回答のあとで、主催者が選択肢を変更しました（${dateTimeText(d.poll.choicesChangedAt, tz)}）。あなたの回答の意味が変わっていないか確認してください。 `, `The organizer changed the answer choices after you answered (${dateTimeText(d.poll.choicesChangedAt, tz)}). Please check that your answers still mean what you intended. `),
              h(
                "button",
                {
                  type: "button",
                  class: "btn btn-secondary btn-small",
                  onClick: async () => {
                    try {
                      await request("POST", `/api/polls/${pollId}/choices-ack`, {});
                      await reload();
                    } catch (e) {
                      message = notice("error", errorText(e, "answer", tr("保存できませんでした。", "Couldn't save.")));
                      draw();
                    }
                  },
                },
                tr("確認しました", "Checked"),
              ),
            )
          : null,
        message,
        form,
        // 誰がどう答えたかは、行ごとではなく、いちばん下にまとめた表で見る（畳んでおく）
        d.answers.length ? memberMatrix(d, tz, tr("みんなの回答", "Everyone's answers"), whoOpen, (o) => (whoOpen = o)) : null,
      ),
    );
    if (focusKey) {
      const btn = Array.from(document.querySelectorAll<HTMLElement>("[data-choice-key]")).find((el) => el.dataset.choiceKey === focusKey);
      btn?.focus();
      focusKey = null;
    }
  }

  draw();
  void app;
}
