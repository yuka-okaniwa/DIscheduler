import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/core/env";
import { issueLink } from "../src/auth";
import { ALICE, BOB, call, CHANNEL, getReq, GUILD, jsonReq, login, mockDiscord, ORGANIZER, ORIGIN, OUTSIDER, seedPoll, tokenFromUrl } from "./helpers";

const db = () => (env as unknown as Env).DB;

beforeEach(() => {
  mockDiscord();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("セッション（入力リンクの交換）", () => {
  it("正しいトークンで Cookie を発行し、用途に応じた画面を返す", async () => {
    const { pollId } = await seedPoll();
    const url = await issueLink(db(), ORIGIN, pollId, ALICE, "participant", "answer");
    expect(url).toMatch(/\/l#t=[A-Za-z0-9_-]{43}$/);
    const res = await call(jsonReq("POST", "/api/session", { token: tokenFromUrl(url) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redirect: `/p/${pollId}/answer` });
    const cookie = res.headers.get("Set-Cookie")!;
    expect(cookie).toContain(`__Host-s_${pollId}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
  });

  it("同じトークンは 2 回使えない", async () => {
    const { pollId } = await seedPoll();
    const token = tokenFromUrl(await issueLink(db(), ORIGIN, pollId, ALICE, "participant", "answer"));
    expect((await call(jsonReq("POST", "/api/session", { token }))).status).toBe(200);
    expect((await call(jsonReq("POST", "/api/session", { token }))).status).toBe(401);
  });

  it("期限切れのトークンは使えない", async () => {
    const { pollId } = await seedPoll();
    const token = tokenFromUrl(await issueLink(db(), ORIGIN, pollId, ALICE, "participant", "answer"));
    await db().prepare("UPDATE link_tokens SET expires_at = 1").run();
    expect((await call(jsonReq("POST", "/api/session", { token }))).status).toBe(401);
  });

  it("DB にはトークンのハッシュだけを保存する", async () => {
    const { pollId } = await seedPoll();
    const token = tokenFromUrl(await issueLink(db(), ORIGIN, pollId, ALICE, "participant", "answer"));
    const rows = await db().prepare("SELECT token_hash FROM link_tokens").all<{ token_hash: string }>();
    expect(rows.results.some((r) => r.token_hash === token)).toBe(false);
    expect(rows.results.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash))).toBe(true);
  });

  it("Origin が違う POST は拒否する（CSRF 対策）", async () => {
    const { pollId } = await seedPoll();
    const token = tokenFromUrl(await issueLink(db(), ORIGIN, pollId, ALICE, "participant", "answer"));
    expect((await call(jsonReq("POST", "/api/session", { token }, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await call(jsonReq("POST", "/api/session", { token }, { origin: null }))).status).toBe(403);
    expect((await call(jsonReq("POST", "/api/session", { token }, { contentType: "text/plain" }))).status).toBe(415);
  });
});

describe("外部の人から見えないこと（§6.6）", () => {
  it("セッションがなければ何も返さない", async () => {
    const { pollId } = await seedPoll();
    const res = await call(getReq(`/api/polls/${pollId}`));
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain("定例会");
  });

  it("別の調整のセッションでは見られない", async () => {
    const a = await seedPoll();
    const b = await seedPoll();
    const { cookie } = await login(a.pollId, ALICE, "participant");
    const forged = cookie.replace(a.pollId, b.pollId);
    expect((await call(getReq(`/api/polls/${b.pollId}`, forged))).status).toBe(401);
  });

  it("参加者から外された人はセッションが消える", async () => {
    const { pollId } = await seedPoll();
    const alice = await login(pollId, ALICE, "participant");
    const org = await login(pollId, ORGANIZER, "organizer", "edit");
    const res = await call(jsonReq("PUT", `/api/polls/${pollId}/participants`, { add: [], remove: [ALICE] }, org));
    expect(res.status).toBe(200);
    expect((await call(getReq(`/api/polls/${pollId}`, alice.cookie))).status).toBe(401);
  });

  it("参加者でない人のトークンはセッションに交換できない", async () => {
    const { pollId } = await seedPoll();
    const token = tokenFromUrl(await issueLink(db(), ORIGIN, pollId, OUTSIDER, "participant", "answer"));
    expect((await call(jsonReq("POST", "/api/session", { token }))).status).toBe(403);
  });

  it("下書きは参加者には見せない", async () => {
    const { pollId } = await seedPoll({ status: "draft" });
    await db().prepare("INSERT INTO sessions (sid_hash, poll_id, user_id, role, csrf_token, expires_at, created_at) VALUES ('x', ?, ?, 'participant', 'c', 9999999999, 0)").bind(pollId, ALICE).run();
    const { cookie } = await login(pollId, ORGANIZER, "organizer", "edit");
    expect((await call(getReq(`/api/polls/${pollId}`, cookie))).status).toBe(200);
  });

  it("API の応答にセキュリティヘッダーが付く", async () => {
    const { pollId } = await seedPoll();
    const res = await call(getReq(`/api/polls/${pollId}`));
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });
});

describe("回答（§4.2）", () => {
  it("CSRF トークンがなければ保存できない", async () => {
    const s = await seedPoll();
    const { cookie } = await login(s.pollId, ALICE, "participant");
    const body = { choicesVersion: 1, answers: [{ slotId: s.slotIds[0], choiceId: s.choiceIds[0] }], comment: null };
    expect((await call(jsonReq("PUT", `/api/polls/${s.pollId}/answers/me`, body, { cookie }))).status).toBe(403);
    expect((await call(jsonReq("PUT", `/api/polls/${s.pollId}/answers/me`, body, { cookie, csrf: "wrong" }))).status).toBe(403);
  });

  it("自分の回答を保存でき、参加者全員がその回答を見られる", async () => {
    const s = await seedPoll();
    const alice = await login(s.pollId, ALICE, "participant");
    const res = await call(
      jsonReq("PUT", `/api/polls/${s.pollId}/answers/me`, { choicesVersion: 1, answers: [{ slotId: s.slotIds[0], choiceId: s.choiceIds[0] }], comment: "21時からなら" }, alice),
    );
    expect(res.status).toBe(200);
    const bob = await login(s.pollId, BOB, "participant");
    const data = (await (await call(getReq(`/api/polls/${s.pollId}`, bob.cookie))).json()) as { answers: { userId: string }[]; participants: { userId: string; comment: string }[] };
    expect(data.answers.some((a) => a.userId === ALICE)).toBe(true);
    expect(data.participants.find((p) => p.userId === ALICE)!.comment).toBe("21時からなら");
  });

  it("他の調整の候補や選択肢は指定できない", async () => {
    const a = await seedPoll();
    const b = await seedPoll();
    const alice = await login(a.pollId, ALICE, "participant");
    const res = await call(jsonReq("PUT", `/api/polls/${a.pollId}/answers/me`, { choicesVersion: 1, answers: [{ slotId: b.slotIds[0], choiceId: a.choiceIds[0] }], comment: null }, alice));
    expect(res.status).toBe(400);
  });

  it("未知のキーは拒否する", async () => {
    const s = await seedPoll();
    const alice = await login(s.pollId, ALICE, "participant");
    const res = await call(jsonReq("PUT", `/api/polls/${s.pollId}/answers/me`, { choicesVersion: 1, answers: [], comment: null, userId: BOB }, alice));
    expect(res.status).toBe(400);
  });

  it("締切後も確定後も回答を変更でき、確定後の変更は記録される", async () => {
    const s = await seedPoll({ deadlineAt: 1000 });
    const alice = await login(s.pollId, ALICE, "participant");
    const put = (choiceIdx: number) =>
      call(jsonReq("PUT", `/api/polls/${s.pollId}/answers/me`, { choicesVersion: 1, answers: [{ slotId: s.slotIds[0], choiceId: s.choiceIds[choiceIdx] }], comment: null }, alice));
    expect((await put(0)).status).toBe(200); // 締切後
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    const fix = await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[0], event: null }, org));
    expect(fix.status).toBe(200);
    expect((await put(2)).status).toBe(200); // 確定後に ○ → ×
    const row = await db().prepare("SELECT choice_id, prev_choice_id FROM answers WHERE poll_id = ? AND user_id = ?").bind(s.pollId, ALICE).first<{ choice_id: string; prev_choice_id: string }>();
    expect(row).toEqual({ choice_id: s.choiceIds[2], prev_choice_id: s.choiceIds[0] });
    expect((await put(0)).status).toBe(200); // 元に戻したら記録は消える
    const row2 = await db().prepare("SELECT prev_choice_id FROM answers WHERE poll_id = ? AND user_id = ?").bind(s.pollId, ALICE).first<{ prev_choice_id: string | null }>();
    expect(row2!.prev_choice_id).toBeNull();
  });

  it("選択肢の版が古いと 409", async () => {
    const s = await seedPoll();
    const alice = await login(s.pollId, ALICE, "participant");
    const res = await call(jsonReq("PUT", `/api/polls/${s.pollId}/answers/me`, { choicesVersion: 99, answers: [], comment: null }, alice));
    expect(res.status).toBe(409);
  });
});

describe("主催者だけの操作", () => {
  it("参加者は編集・確定・削除・リマインド・手動更新ができない", async () => {
    const s = await seedPoll();
    const alice = await login(s.pollId, ALICE, "participant");
    expect((await call(jsonReq("PATCH", `/api/polls/${s.pollId}`, { title: "乗っ取り" }, alice))).status).toBe(403);
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[0], event: null }, alice))).status).toBe(403);
    expect((await call(jsonReq("DELETE", `/api/polls/${s.pollId}`, {}, alice))).status).toBe(403);
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/remind`, {}, alice))).status).toBe(403);
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/sync-message`, {}, alice))).status).toBe(403);
    expect((await call(jsonReq("PUT", `/api/polls/${s.pollId}/participants`, { add: [], remove: [BOB] }, alice))).status).toBe(403);
  });

  it("選択肢を変更でき、回答がある選択肢は移し先なしでは消せない", async () => {
    const s = await seedPoll();
    const alice = await login(s.pollId, ALICE, "participant");
    await call(jsonReq("PUT", `/api/polls/${s.pollId}/answers/me`, { choicesVersion: 1, answers: [{ slotId: s.slotIds[0], choiceId: s.choiceIds[1] }], comment: null }, alice));
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    const twoChoices = [
      { id: s.choiceIds[0], symbol: "○", label: "参加", kind: "ok", score: 2, color: "green" },
      { id: s.choiceIds[2], symbol: "×", label: "不可", kind: "ng", score: 0, color: "red" },
    ];
    const noReassign = await call(jsonReq("PUT", `/api/polls/${s.pollId}/choices`, { choicesVersion: 1, choices: twoChoices, reassign: [] }, org));
    expect(noReassign.status).toBe(400);
    const ok = await call(jsonReq("PUT", `/api/polls/${s.pollId}/choices`, { choicesVersion: 1, choices: twoChoices, reassign: [{ from: s.choiceIds[1], to: s.choiceIds[2] }] }, org));
    expect(ok.status).toBe(200);
    const row = await db().prepare("SELECT choice_id FROM answers WHERE poll_id = ?").bind(s.pollId).first<{ choice_id: string }>();
    expect(row!.choice_id).toBe(s.choiceIds[2]);
  });

  it("選択肢の記号にメンション記法は使えない", async () => {
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    const res = await call(
      jsonReq(
        "PUT",
        `/api/polls/${s.pollId}/choices`,
        {
          choicesVersion: 1,
          choices: [
            { id: null, symbol: "<@1>", label: "参加", kind: "ok", score: 2, color: "green" },
            { id: null, symbol: "×", label: "不可", kind: "ng", score: 0, color: "red" },
          ],
          reassign: [],
        },
        org,
      ),
    );
    expect(res.status).toBe(400);
  });

  it("公開すると募集メッセージを投稿し、メンションを無効にしている", async () => {
    const calls = mockDiscord((c) => (c.method === "POST" ? { id: "600000000000000001" } : {}));
    const s = await seedPoll({ status: "draft", messageId: null, deadlineAt: null });
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    const res = await call(jsonReq("POST", `/api/polls/${s.pollId}/publish`, {}, org));
    expect(res.status).toBe(200);
    const post = calls.find((c) => c.method === "POST" && c.path === `/channels/300000000000000001/messages`)!;
    expect((post.body as { allowed_mentions: { parse: string[] } }).allowed_mentions.parse).toEqual([]);
    const poll = await db().prepare("SELECT status, message_id, deadline_at FROM polls WHERE id = ?").bind(s.pollId).first<{ status: string; message_id: string; deadline_at: number }>();
    expect(poll!.status).toBe("open");
    expect(poll!.message_id).toBe("600000000000000001");
    expect(poll!.deadline_at).toBeGreaterThan(Date.now() / 1000 + 6 * 86400);
  });

  it("ロールのない調整は、公開すると募集メッセージへの返信で @everyone をメンションする", async () => {
    const calls = mockDiscord((c) => (c.method === "POST" ? { id: "600000000000000001" } : {}));
    const s = await seedPoll({ status: "draft", messageId: null, deadlineAt: null });
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/publish`, {}, org))).status).toBe(200);
    const posts = calls.filter((c) => c.method === "POST" && c.path === `/channels/${CHANNEL}/messages`);
    expect(posts.length).toBe(2);
    const announce = posts[1]!.body as { content: string; allowed_mentions: unknown; message_reference: unknown };
    expect(announce.content).toContain("の募集を始めました。");
    expect(announce.content).toContain("@everyone");
    expect(announce.content).not.toContain(`<@${ALICE}>`);
    expect(announce.allowed_mentions).toEqual({ parse: ["everyone"], replied_user: false });
    expect(announce.message_reference).toEqual({ message_id: "600000000000000001", fail_if_not_exists: false });
  });

  it("ロールが対象の調整は、公開するとそのロールをメンションする", async () => {
    const calls = mockDiscord((c) => (c.method === "POST" ? { id: "600000000000000001" } : {}));
    const s = await seedPoll({ status: "draft", messageId: null, deadlineAt: null });
    await db().prepare("UPDATE polls SET target_type = 'role', target_id = '400000000000000077' WHERE id = ?").bind(s.pollId).run();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/publish`, {}, org))).status).toBe(200);
    const posts = calls.filter((c) => c.method === "POST" && c.path === `/channels/${CHANNEL}/messages`);
    expect(posts.length).toBe(2);
    const announce = posts[1]!.body as { content: string; allowed_mentions: unknown };
    expect(announce.content).toContain("<@&400000000000000077>");
    expect(announce.content).not.toContain("@everyone");
    expect(announce.content).not.toContain(`<@${ALICE}>`);
    expect(announce.allowed_mentions).toEqual({ parse: [], roles: ["400000000000000077"], replied_user: false });
  });

  it("お知らせの投稿に失敗しても、公開は済ませる", async () => {
    let n = 0;
    mockDiscord((c) => (c.method === "POST" ? (n++ === 0 ? { id: "600000000000000001" } : new Response("{}", { status: 403 })) : {}));
    const s = await seedPoll({ status: "draft", messageId: null, deadlineAt: null });
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/publish`, {}, org))).status).toBe(200);
    const poll = await db().prepare("SELECT status FROM polls WHERE id = ?").bind(s.pollId).first<{ status: string }>();
    expect(poll!.status).toBe("open");
  });

  it("確定してもチャンネルにはお知らせしない（［確定をお知らせする］でまとめて投稿する）", async () => {
    const calls = mockDiscord();
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[0], event: null }, org))).status).toBe(200);
    expect(calls.some((c) => c.method === "POST" && c.path === `/channels/${CHANNEL}/messages`)).toBe(false);
  });

  it("確定のお知らせは、ロールがなければ @everyone をメンションする（参加者を 1 人ずつはメンションしない）", async () => {
    const calls = mockDiscord();
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[0], event: null }, org));
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/announce`, { mention: true }, org))).status).toBe(200);
    const post = calls.find((c) => c.method === "POST" && c.path === `/channels/${CHANNEL}/messages`)!.body as { content: string; allowed_mentions: unknown };
    expect(post.content).toContain("の日程のお知らせ");
    expect(post.content).toContain("確定した日時:");
    expect(post.content).toContain("@everyone");
    expect(post.content).not.toContain(`<@${ALICE}>`);
    expect(post.allowed_mentions).toEqual({ parse: ["everyone"], replied_user: false });
  });

  it("確定のお知らせは、ロールの調整ではロールだけをメンションし、メンションなしを選べばメンションしない", async () => {
    const calls = mockDiscord();
    const s = await seedPoll();
    await db().prepare("UPDATE polls SET target_type = 'role', target_id = '400000000000000077' WHERE id = ?").bind(s.pollId).run();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[0], event: null }, org));
    await call(jsonReq("POST", `/api/polls/${s.pollId}/announce`, { mention: true }, org));
    await call(jsonReq("POST", `/api/polls/${s.pollId}/announce`, { mention: false }, org));
    const posts = calls.filter((c) => c.method === "POST" && c.path === `/channels/${CHANNEL}/messages`).map((c) => c.body as { content: string; allowed_mentions: unknown });
    expect(posts[0]!.content).toContain("<@&400000000000000077>");
    expect(posts[0]!.allowed_mentions).toEqual({ parse: [], roles: ["400000000000000077"], replied_user: false });
    expect(posts[1]!.content).not.toContain("<@&");
    expect(posts[1]!.allowed_mentions).toEqual({ parse: [] });
  });

  it("確定日と、前回のお知らせのあとに取り消した日時をまとめて知らせる。知らせた取り消しは次から載せない", async () => {
    const calls = mockDiscord();
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    const slots = await db().prepare("SELECT id, start_at FROM slots WHERE poll_id = ?").bind(s.pollId).all<{ id: string; start_at: number }>();
    const startOf = new Map(slots.results.map((r) => [r.id, r.start_at]));
    await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[0], event: null }, org));
    await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[1], event: null }, org));
    await call(jsonReq("POST", `/api/polls/${s.pollId}/announce`, { mention: false }, org));
    await call(jsonReq("DELETE", `/api/polls/${s.pollId}/fix/${s.slotIds[0]}`, undefined, org));
    await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[2], event: null }, org));
    await call(jsonReq("POST", `/api/polls/${s.pollId}/announce`, { mention: false }, org));
    await call(jsonReq("POST", `/api/polls/${s.pollId}/announce`, { mention: false }, org));
    const posts = calls.filter((c) => c.method === "POST" && c.path === `/channels/${CHANNEL}/messages`).map((c) => (c.body as { content: string }).content);
    expect(posts).toHaveLength(3);
    const [, second, third] = posts as [string, string, string];
    const [fixedPart, cancelPart] = second.split("確定を取り消した日時:");
    expect(fixedPart).toContain(`<t:${startOf.get(s.slotIds[1]!)}:F>`);
    expect(fixedPart).toContain(`<t:${startOf.get(s.slotIds[2]!)}:F>`);
    expect(fixedPart).not.toContain(`<t:${startOf.get(s.slotIds[0]!)}:F>`);
    expect(cancelPart).toContain(`<t:${startOf.get(s.slotIds[0]!)}:F>`);
    expect(third).not.toContain("確定を取り消した日時");
  });

  it("お知らせする確定日も取り消しもなければ 409。参加者はお知らせできない", async () => {
    mockDiscord();
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/announce`, { mention: false }, org))).status).toBe(409);
    const alice = await login(s.pollId, ALICE, "participant");
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/announce`, { mention: false }, alice))).status).toBe(403);
  });

  it("確定のお知らせのメンションは 1 時間に 3 回まで（超えたらメンションなしで投稿する）", async () => {
    const calls = mockDiscord();
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[0], event: null }, org));
    for (let i = 0; i < 4; i++) {
      const res = await call(jsonReq("POST", `/api/polls/${s.pollId}/announce`, { mention: true }, org));
      expect(res.status).toBe(200);
    }
    const posts = calls.filter((c) => c.method === "POST" && c.path === `/channels/${CHANNEL}/messages`).map((c) => c.body as { content: string });
    expect(posts.map((p) => p.content.includes("@everyone"))).toEqual([true, true, true, false]);
  });

  it("予定のリマインドの回が過ぎてから確定した日時は、お知らせに開始までの時間を添え、あとで重ねて送らない", async () => {
    const calls = mockDiscord();
    const s = await seedPoll();
    // 30 分後に始まる予定。リマインドは前日の 0 時なので、必ず過ぎている
    const start = Math.floor(Date.now() / 1000) + 1800;
    await db().prepare("UPDATE slots SET start_at = ?, end_at = ? WHERE id = ?").bind(start, start + 3600, s.slotIds[0]).run();
    await db().prepare("UPDATE polls SET remind_day_offset = 1, remind_hour = 0 WHERE id = ?").bind(s.pollId).run();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[0], event: null }, org));
    await call(jsonReq("POST", `/api/polls/${s.pollId}/announce`, { mention: true }, org));
    const post = calls.find((c) => c.method === "POST" && c.path === `/channels/${CHANNEL}/messages`)!.body as { content: string };
    expect(post.content).toContain(`<t:${start}:R>に始まります`);
    const row = await db().prepare("SELECT day_reminded_at FROM slots WHERE id = ?").bind(s.slotIds[0]).first<{ day_reminded_at: number }>();
    expect(row!.day_reminded_at).toBe(start);
  });

  it("リマインドの日時を PATCH で変えられる（当日か前日、0〜23 時）", async () => {
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    expect((await call(jsonReq("PATCH", `/api/polls/${s.pollId}`, { remindDayOffset: 1, remindHour: 9 }, org))).status).toBe(200);
    const data = (await (await call(jsonReq("GET", `/api/polls/${s.pollId}`, undefined, org))).json()) as { poll: { remindDayOffset: number; remindHour: number } };
    expect(data.poll).toMatchObject({ remindDayOffset: 1, remindHour: 9 });
    expect((await call(jsonReq("PATCH", `/api/polls/${s.pollId}`, { remindHour: 24 }, org))).status).toBe(400);
    expect((await call(jsonReq("PATCH", `/api/polls/${s.pollId}`, { remindDayOffset: 2 }, org))).status).toBe(400);
  });

  it("予定のリマインドの回がまだ先なら、お知らせには開始までの時間を添えない", async () => {
    const calls = mockDiscord();
    const s = await seedPoll();
    const start = Math.floor(Date.now() / 1000) + 30 * 86400;
    await db().prepare("UPDATE slots SET start_at = ?, end_at = ? WHERE id = ?").bind(start, start + 3600, s.slotIds[0]).run();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[0], event: null }, org));
    await call(jsonReq("POST", `/api/polls/${s.pollId}/announce`, { mention: true }, org));
    const post = calls.find((c) => c.method === "POST" && c.path === `/channels/${CHANNEL}/messages`)!.body as { content: string };
    expect(post.content).not.toContain(":R>");
    const row = await db().prepare("SELECT day_reminded_at FROM slots WHERE id = ?").bind(s.slotIds[0]).first<{ day_reminded_at: number | null }>();
    expect(row!.day_reminded_at).toBeNull();
  });

  it("確定のお知らせの投稿に失敗したときは、エラーにし、メンションの回数にもお知らせ済みにも数えない", async () => {
    let fail = 3;
    const calls = mockDiscord((c) => (c.method === "POST" && c.path === `/channels/${CHANNEL}/messages` && fail-- > 0 ? new Response("{}", { status: 500 }) : {}));
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[0], event: null }, org));
    for (let i = 0; i < 3; i++) expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/announce`, { mention: true }, org))).status).toBe(502);
    const row = await db().prepare("SELECT announced_fixed FROM slots WHERE id = ?").bind(s.slotIds[0]).first<{ announced_fixed: number }>();
    expect(row!.announced_fixed).toBe(0);
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/announce`, { mention: true }, org))).status).toBe(200);
    const posts = calls.filter((c) => c.method === "POST" && c.path === `/channels/${CHANNEL}/messages`).map((c) => c.body as { content: string });
    // 失敗した 3 回のあとの 4 回目も、メンションつきで送る
    expect(posts.at(-1)!.content).toContain("@everyone");
  });

  it("手動更新は 1 分に 1 回まで", async () => {
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/sync-message`, {}, org))).status).toBe(200);
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/sync-message`, {}, org))).status).toBe(429);
  });

  it("削除するとデータが消え、セッションも使えなくなる", async () => {
    const s = await seedPoll();
    const alice = await login(s.pollId, ALICE, "participant");
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    expect((await call(jsonReq("DELETE", `/api/polls/${s.pollId}`, {}, org))).status).toBe(200);
    expect((await call(getReq(`/api/polls/${s.pollId}`, alice.cookie))).status).toBe(401);
    const n = await db().prepare("SELECT COUNT(*) AS n FROM answers WHERE poll_id = ?").bind(s.pollId).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it("同時に公開しても、募集メッセージは 1 件だけ投稿する", async () => {
    const calls = mockDiscord((c) => (c.method === "POST" ? { id: "600000000000000002" } : {}));
    const s = await seedPoll({ status: "draft", messageId: null, deadlineAt: null });
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    const [a, b] = await Promise.all([
      call(jsonReq("POST", `/api/polls/${s.pollId}/publish`, {}, org)),
      call(jsonReq("POST", `/api/polls/${s.pollId}/publish`, {}, org)),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    // 募集のお知らせ（メンション）は数えず、募集メッセージ（埋め込みつき）だけを数える
    expect(calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages") && (c.body as { embeds?: unknown }).embeds).length).toBe(1);
  });

  it("投稿に失敗したら、もう一度公開できる", async () => {
    mockDiscord((c) => (c.method === "POST" ? new Response("{}", { status: 403 }) : {}));
    const s = await seedPoll({ status: "draft", messageId: null, deadlineAt: null });
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/publish`, {}, org))).status).toBe(502);
    vi.restoreAllMocks();
    mockDiscord((c) => (c.method === "POST" ? { id: "600000000000000003" } : {}));
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/publish`, {}, org))).status).toBe(200);
  });

  it("確定済みの候補をもう一度確定しようとすると 409", async () => {
    mockDiscord();
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[0], event: null }, org))).status).toBe(200);
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[0], event: null }, org))).status).toBe(409);
  });
});

describe("複数の候補の確定と取り消し", () => {
  it("複数の候補を確定でき、それぞれに Discord イベントを登録する", async () => {
    let n = 0;
    mockDiscord((c) => (c.method === "POST" && c.path.includes("scheduled-events") ? { id: `70000000000000001${n++}` } : {}));
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    const ev = { type: "external", channelId: null, location: "Discord" };
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[0], event: ev }, org))).status).toBe(200);
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[1], event: ev }, org))).status).toBe(200);
    const data = (await (await call(jsonReq("GET", `/api/polls/${s.pollId}`, undefined, org))).json()) as { poll: { status: string }; slots: { id: string; fixedAt: number | null; hasEvent: boolean }[] };
    expect(data.poll.status).toBe("fixed");
    const fixed = data.slots.filter((x) => x.fixedAt !== null);
    expect(fixed.map((x) => x.id).sort()).toEqual([s.slotIds[0], s.slotIds[1]].sort());
    expect(fixed.every((x) => x.hasEvent)).toBe(true);
  });

  it("主催者は確定を取り消せる。イベントを消し（お知らせはしない）、確定した候補がなくなれば募集中に戻る", async () => {
    const calls = mockDiscord((c) => (c.method === "POST" && c.path.includes("scheduled-events") ? { id: "700000000000000020" } : {}));
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[0], event: { type: "external", channelId: null, location: "Discord" } }, org));
    await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[1], event: null }, org));

    expect((await call(jsonReq("DELETE", `/api/polls/${s.pollId}/fix/${s.slotIds[0]}`, undefined, org))).status).toBe(200);
    expect(calls.some((c) => c.method === "DELETE" && c.path.endsWith("/scheduled-events/700000000000000020"))).toBe(true);
    expect(calls.some((c) => c.method === "POST" && c.path === `/channels/${CHANNEL}/messages`)).toBe(false);
    let poll = await db().prepare("SELECT status FROM polls WHERE id = ?").bind(s.pollId).first<{ status: string }>();
    expect(poll!.status).toBe("fixed");

    expect((await call(jsonReq("DELETE", `/api/polls/${s.pollId}/fix/${s.slotIds[1]}`, undefined, org))).status).toBe(200);
    poll = await db().prepare("SELECT status FROM polls WHERE id = ?").bind(s.pollId).first<{ status: string }>();
    expect(poll!.status).toBe("open");
    const left = await db().prepare("SELECT COUNT(*) AS n FROM slots WHERE poll_id = ? AND (fixed_at IS NOT NULL OR discord_event_id IS NOT NULL)").bind(s.pollId).first<{ n: number }>();
    expect(left!.n).toBe(0);

    // 確定していない候補の取り消しは断る
    expect((await call(jsonReq("DELETE", `/api/polls/${s.pollId}/fix/${s.slotIds[0]}`, undefined, org))).status).toBe(409);
  });

  it("データの削除時刻は、いちばん遅い確定日時から 6 か月後。確定がなくなれば締切から 6 か月後に戻る", async () => {
    mockDiscord();
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    const rows = await db().prepare("SELECT id, start_at FROM slots WHERE poll_id = ?").bind(s.pollId).all<{ id: string; start_at: number }>();
    const startOf = new Map(rows.results.map((r) => [r.id, r.start_at]));
    const purge = async () => (await db().prepare("SELECT purge_after, deadline_at FROM polls WHERE id = ?").bind(s.pollId).first<{ purge_after: number; deadline_at: number }>())!;
    const RET = 180 * 86400;
    await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[0], event: null }, org));
    await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[2], event: null }, org));
    expect((await purge()).purge_after).toBe(Math.max(startOf.get(s.slotIds[0]!)!, startOf.get(s.slotIds[2]!)!) + RET);
    await call(jsonReq("DELETE", `/api/polls/${s.pollId}/fix/${s.slotIds[0]}`, undefined, org));
    await call(jsonReq("DELETE", `/api/polls/${s.pollId}/fix/${s.slotIds[2]}`, undefined, org));
    const p = await purge();
    expect(p.purge_after).toBe(p.deadline_at + RET);
  });

  it("参加者は確定を取り消せない", async () => {
    mockDiscord();
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[0], event: null }, org));
    const alice = await login(s.pollId, ALICE, "participant");
    expect((await call(jsonReq("DELETE", `/api/polls/${s.pollId}/fix/${s.slotIds[0]}`, undefined, alice))).status).toBe(403);
  });

  it("調整を削除すると、確定した候補ごとの Discord イベントをすべて削除する", async () => {
    let n = 0;
    const calls = mockDiscord((c) => (c.method === "POST" && c.path.includes("scheduled-events") ? { id: `70000000000000003${n++}` } : {}));
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    const ev = { type: "external", channelId: null, location: "Discord" };
    await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[0], event: ev }, org));
    await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[1], event: ev }, org));
    expect((await call(jsonReq("DELETE", `/api/polls/${s.pollId}`, undefined, org))).status).toBe(200);
    const deleted = calls.filter((c) => c.method === "DELETE" && c.path.includes("/scheduled-events/")).map((c) => c.path.split("/").pop());
    expect(deleted.sort()).toEqual(["700000000000000030", "700000000000000031"]);
  });
});

describe("確定後の回答の記録", () => {
  it("確定時点で未回答だった候補に答えると「未回答から変更」として記録し、送らなかった候補の回答は消さない", async () => {
    const s = await seedPoll();
    const alice = await login(s.pollId, ALICE, "participant");
    await call(jsonReq("PUT", `/api/polls/${s.pollId}/answers/me`, { choicesVersion: 1, answers: [{ slotId: s.slotIds[0], choiceId: s.choiceIds[0] }], comment: null }, alice));
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[1], event: null }, org));
    const res = await call(jsonReq("PUT", `/api/polls/${s.pollId}/answers/me`, { choicesVersion: 1, answers: [{ slotId: s.slotIds[1], choiceId: s.choiceIds[0] }], comment: null }, alice));
    expect(res.status).toBe(200);
    const rows = await db().prepare("SELECT slot_id, prev_choice_id FROM answers WHERE poll_id = ? AND user_id = ? ORDER BY slot_id").bind(s.pollId, ALICE).all<{ slot_id: string; prev_choice_id: string | null }>();
    const bySlot = new Map(rows.results.map((r) => [r.slot_id, r.prev_choice_id]));
    expect(bySlot.get(s.slotIds[1]!)).toBe("");
    expect(bySlot.has(s.slotIds[0]!)).toBe(true);
  });
});

describe("募集メッセージの更新", () => {
  it("募集メッセージがないときは、最終更新時刻を書き換えない", async () => {
    const { syncNow } = await import("../src/polls/sync");
    const s = await seedPoll({ messageId: null });
    await db().prepare("UPDATE polls SET last_synced_at = 123 WHERE id = ?").bind(s.pollId).run();
    expect(await syncNow(env as unknown as Env, s.pollId)).toBe(false);
    const row = await db().prepare("SELECT last_synced_at FROM polls WHERE id = ?").bind(s.pollId).first<{ last_synced_at: number }>();
    expect(row!.last_synced_at).toBe(123);
  });
});

describe("2 回目のレビューの修正", () => {
  it("締切を過ぎて日がたった調整でも、締切を変えなければ保存できる", async () => {
    const s = await seedPoll({ deadlineAt: 1000 });
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    const same = await call(jsonReq("PATCH", `/api/polls/${s.pollId}`, { title: "新しい名前", deadlineAt: 1000 }, org));
    expect(same.status).toBe(200);
    const row = await db().prepare("SELECT title FROM polls WHERE id = ?").bind(s.pollId).first<{ title: string }>();
    expect(row!.title).toBe("新しい名前");
    // 過去の日時に変えるのはこれまでどおり拒否する
    expect((await call(jsonReq("PATCH", `/api/polls/${s.pollId}`, { deadlineAt: 2000 }, org))).status).toBe(400);
  });

  it("確定した候補の日時を変えると、Discord イベントの日時も変える", async () => {
    const calls = mockDiscord((c) => (c.method === "POST" && c.path.includes("scheduled-events") ? { id: "700000000000000010" } : {}));
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[0], event: { type: "external", channelId: null, location: "Discord" } }, org));
    const slots = await db().prepare("SELECT id, start_at, end_at FROM slots WHERE poll_id = ? ORDER BY position").bind(s.pollId).all<{ id: string; start_at: number; end_at: number }>();
    const body = { slots: slots.results.map((x, i) => ({ id: x.id, startAt: i === 0 ? x.start_at + 3600 : x.start_at, endAt: i === 0 ? x.end_at + 3600 : x.end_at, allDay: false })) };
    const res = await call(jsonReq("PUT", `/api/polls/${s.pollId}/slots`, body, org));
    expect(res.status).toBe(200);
    const patch = calls.find((c) => c.method === "PATCH" && c.path.endsWith("/scheduled-events/700000000000000010"));
    expect(patch).toBeTruthy();
    expect((patch!.body as { scheduled_start_time: string }).scheduled_start_time).toBe(new Date((slots.results[0]!.start_at + 3600) * 1000).toISOString());
  });

  it("確定後にひとことだけ保存しても、回答が残っていれば回答済みのまま", async () => {
    const s = await seedPoll();
    const alice = await login(s.pollId, ALICE, "participant");
    await call(jsonReq("PUT", `/api/polls/${s.pollId}/answers/me`, { choicesVersion: 1, answers: [{ slotId: s.slotIds[0], choiceId: s.choiceIds[0] }], comment: null }, alice));
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[0], event: null }, org));
    await call(jsonReq("PUT", `/api/polls/${s.pollId}/answers/me`, { choicesVersion: 1, answers: [], comment: "遅れます" }, alice));
    const p = await db().prepare("SELECT answered_at, comment FROM participants WHERE poll_id = ? AND user_id = ?").bind(s.pollId, ALICE).first<{ answered_at: number | null; comment: string }>();
    expect(p!.answered_at).not.toBeNull();
    expect(p!.comment).toBe("遅れます");
  });
});

describe("3 回目のレビューの修正", () => {
  it("締切は分単位で比べる（秒が違うだけなら変えていないとみなす）", async () => {
    const s = await seedPoll({ deadlineAt: 1_000_037 });
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    const res = await call(jsonReq("PATCH", `/api/polls/${s.pollId}`, { title: "改名", deadlineAt: 1_000_020 }, org));
    expect(res.status).toBe(200);
  });

  it("候補・選択肢の ID が重複していたら拒否する", async () => {
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    const now = Math.floor(Date.now() / 1000) + 86400;
    const dupSlots = { slots: [{ id: s.slotIds[0], startAt: now, endAt: null, allDay: false }, { id: s.slotIds[0], startAt: now + 3600, endAt: null, allDay: false }] };
    expect((await call(jsonReq("PUT", `/api/polls/${s.pollId}/slots`, dupSlots, org))).status).toBe(400);
    const dupChoices = {
      choicesVersion: 1,
      choices: [
        { id: s.choiceIds[0], symbol: "○", label: "参加", kind: "ok", score: 2, color: "green" },
        { id: s.choiceIds[0], symbol: "×", label: "不可", kind: "ng", score: 0, color: "red" },
      ],
      reassign: [],
    };
    expect((await call(jsonReq("PUT", `/api/polls/${s.pollId}/choices`, dupChoices, org))).status).toBe(400);
  });

  it("公開後に選択肢を変えると、回答画面に知らせるための時刻を返す", async () => {
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    const choices = [
      { id: s.choiceIds[0], symbol: "○", label: "参加する", kind: "ok", score: 2, color: "green" },
      { id: s.choiceIds[1], symbol: "△", label: "未定", kind: "maybe", score: 1, color: "yellow" },
      { id: s.choiceIds[2], symbol: "×", label: "不可", kind: "ng", score: 0, color: "red" },
    ];
    expect((await call(jsonReq("PUT", `/api/polls/${s.pollId}/choices`, { choicesVersion: 1, choices, reassign: [] }, org))).status).toBe(200);
    const alice = await login(s.pollId, ALICE, "participant");
    const data = (await (await call(getReq(`/api/polls/${s.pollId}`, alice.cookie))).json()) as { poll: { choicesChangedAt: number | null } };
    expect(data.poll.choicesChangedAt).not.toBeNull();
  });

  it("調整を削除すると、登録済みの Discord イベントも削除する", async () => {
    const calls = mockDiscord((c) => (c.method === "POST" && c.path.includes("scheduled-events") ? { id: "700000000000000011" } : {}));
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[0], event: { type: "external", channelId: null, location: "Discord" } }, org));
    expect((await call(jsonReq("DELETE", `/api/polls/${s.pollId}`, {}, org))).status).toBe(200);
    expect(calls.some((c) => c.method === "DELETE" && c.path.endsWith("/scheduled-events/700000000000000011"))).toBe(true);
  });
});

describe("4 回目のレビューの修正", () => {
  it("募集メッセージが消えていたら、もう一度投稿できる", async () => {
    const calls = mockDiscord((c) => (c.method === "POST" ? { id: "600000000000000099" } : {}));
    const s = await seedPoll({ messageId: null });
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/repost`, {}, org))).status).toBe(200);
    expect(calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages")).length).toBe(1);
    const row = await db().prepare("SELECT message_id, publishing_at FROM polls WHERE id = ?").bind(s.pollId).first<{ message_id: string; publishing_at: number | null }>();
    expect(row).toEqual({ message_id: "600000000000000099", publishing_at: null });
  });

  it("投稿し直すと、古い募集メッセージは削除する", async () => {
    const calls = mockDiscord((c) => (c.method === "POST" ? { id: "600000000000000098" } : {}));
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/repost`, {}, org))).status).toBe(200);
    expect(calls.some((c) => c.method === "DELETE" && c.path.endsWith("/messages/500000000000000001"))).toBe(true);
  });

  it("参加者は投稿し直せない", async () => {
    const s = await seedPoll({ messageId: null });
    const alice = await login(s.pollId, ALICE, "participant");
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/repost`, {}, alice))).status).toBe(403);
  });

  it("ロールの一覧の取得にも回数制限がある", async () => {
    mockDiscord((c) => (c.path.endsWith("/roles") ? [] : {}));
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await call(getReq(`/api/polls/${s.pollId}/roles`, org.cookie))).status;
    expect(last).toBe(429);
  });

  it("参加者が多くても 1 文でまとめて追加できる", async () => {
    const { insertParticipantsStatement } = await import("../src/db");
    const s = await seedPoll({ participants: [] });
    const people = Array.from({ length: 100 }, (_, i) => ({ userId: `4100000000000${String(i).padStart(5, "0")}`, displayName: `名前${i}` }));
    await insertParticipantsStatement(db(), s.pollId, people).run();
    const n = await db().prepare("SELECT COUNT(*) AS n FROM participants WHERE poll_id = ?").bind(s.pollId).first<{ n: number }>();
    expect(n!.n).toBe(100);
  });
});

describe("5 回目のレビューの修正", () => {
  it("古いメッセージの更新が 404 になっても、投稿し直した新しいメッセージの ID は消さない", async () => {
    const { syncNow } = await import("../src/polls/sync");
    const s = await seedPoll();
    // 更新のリクエストを送った時点では古い ID だったが、その間に投稿し直しで新しい ID に変わった、という状況を作る
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await db().prepare("UPDATE polls SET message_id = '600000000000000777' WHERE id = ?").bind(s.pollId).run();
      return new Response("{}", { status: 404 });
    });
    await db().prepare("UPDATE polls SET last_synced_at = 1 WHERE id = ?").bind(s.pollId).run();
    expect(await syncNow(env as unknown as Env, s.pollId)).toBe(false);
    const row = await db().prepare("SELECT message_id FROM polls WHERE id = ?").bind(s.pollId).first<{ message_id: string | null }>();
    expect(row!.message_id).toBe("600000000000000777");
  });

  it("更新は、権利を取ったあとのデータでメッセージを作る", async () => {
    const { syncNow } = await import("../src/polls/sync");
    const calls = mockDiscord();
    const s = await seedPoll();
    await db().prepare("INSERT INTO answers (poll_id, slot_id, user_id, choice_id, updated_at) VALUES (?, ?, ?, ?, ?)").bind(s.pollId, s.slotIds[0], ALICE, s.choiceIds[0], 5).run();
    expect(await syncNow(env as unknown as Env, s.pollId)).toBe(true);
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(JSON.stringify(patch.body)).toContain("回答: 1/3 名");
  });
});

describe("7 回目のレビューの修正", () => {
  it("確定後はリマインドできない", async () => {
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[0], event: null }, org));
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/remind`, {}, org))).status).toBe(409);
  });

  it("リマインドには募集メッセージと同じ［回答する］ボタンを付ける", async () => {
    const calls = mockDiscord();
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/remind`, {}, org))).status).toBe(200);
    const post = calls.find((c) => c.method === "POST" && c.path === `/channels/${CHANNEL}/messages`)!;
    expect(JSON.stringify(post.body)).toContain("募集メッセージの［回答する］から入力できます。");
    expect((post.body as { components: unknown }).components).toEqual([
      { type: 1, components: [{ type: 2, style: 1, label: "回答する", custom_id: `answer:${s.pollId}` }] },
    ]);
  });

  it("選択肢の変更のお知らせは、ひとことだけ保存しても消えず、確認したら消える", async () => {
    // 募集メッセージなし（連続した保存による後追いの更新の待ち時間をテストに持ち込まないため）
    const s = await seedPoll({ messageId: null });
    const alice = await login(s.pollId, ALICE, "participant");
    await call(jsonReq("PUT", `/api/polls/${s.pollId}/answers/me`, { choicesVersion: 1, answers: [{ slotId: s.slotIds[0], choiceId: s.choiceIds[1] }], comment: null }, alice));
    await db().prepare("UPDATE answers SET updated_at = 100 WHERE poll_id = ?").bind(s.pollId).run();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    const choices = [
      { id: s.choiceIds[0], symbol: "○", label: "参加", kind: "ok", score: 2, color: "green" },
      { id: s.choiceIds[1], symbol: "△", label: "遅れて参加", kind: "maybe", score: 1, color: "yellow" },
      { id: s.choiceIds[2], symbol: "×", label: "不可", kind: "ng", score: 0, color: "red" },
    ];
    await call(jsonReq("PUT", `/api/polls/${s.pollId}/choices`, { choicesVersion: 1, choices, reassign: [] }, org));
    const needs = async () => ((await (await call(getReq(`/api/polls/${s.pollId}`, alice.cookie))).json()) as { me: { needsChoicesAck: boolean } }).me.needsChoicesAck;
    expect(await needs()).toBe(true);
    // ひとことだけ保存（回答は同じ）
    await call(jsonReq("PUT", `/api/polls/${s.pollId}/answers/me`, { choicesVersion: 2, answers: [{ slotId: s.slotIds[0], choiceId: s.choiceIds[1] }], comment: "よろしく" }, alice));
    expect(await needs()).toBe(true);
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/choices-ack`, {}, alice))).status).toBe(200);
    expect(await needs()).toBe(false);
  });

  it("主催者の未反映の件数は、読み込んだ回答から数える", async () => {
    const s = await seedPoll();
    await db().prepare("UPDATE polls SET last_synced_at = 50 WHERE id = ?").bind(s.pollId).run();
    await db().prepare("INSERT INTO answers (poll_id, slot_id, user_id, choice_id, updated_at) VALUES (?, ?, ?, ?, 100), (?, ?, ?, ?, 10)").bind(s.pollId, s.slotIds[0], ALICE, s.choiceIds[0], s.pollId, s.slotIds[1], ALICE, s.choiceIds[0]).run();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    const data = (await (await call(getReq(`/api/polls/${s.pollId}`, org.cookie))).json()) as { poll: { pendingChanges: number } };
    expect(data.poll.pendingChanges).toBe(1);
  });
});

describe("8 回目のレビューのあとの確認", () => {
  it("参加者に入っていない主催者のセッションでは、回答を保存できない", async () => {
    const s = await seedPoll({ participants: [ALICE, BOB] });
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    const res = await call(jsonReq("PUT", `/api/polls/${s.pollId}/answers/me`, { choicesVersion: 1, answers: [{ slotId: s.slotIds[0], choiceId: s.choiceIds[0] }], comment: null }, org));
    expect(res.status).toBe(403);
    const n = await db().prepare("SELECT COUNT(*) AS n FROM answers WHERE poll_id = ?").bind(s.pollId).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });
});


describe("エラーの言語（§6.12）", () => {
  it("X-DI-Lang: en なら英語、なければ日本語で返す", async () => {
    const s = await seedPoll({ participants: [ALICE] });
    const res = await call(new Request(`${ORIGIN}/api/polls/${s.pollId}`, { headers: { "X-DI-Lang": "en" } }));
    const body = (await res.json()) as { error: { message: string; messages: { ja: string; en: string } } };
    expect(body.error.message).toMatch(/expired/);
    // 画面で言語を切り替えたときのために、両方の言語も返す
    expect(body.error.messages.en).toBe(body.error.message);
    expect(body.error.messages.ja).toMatch(/有効期限/);
    const ja = await call(getReq(`/api/polls/${s.pollId}`));
    expect(((await ja.json()) as { error: { message: string } }).error.message).toMatch(/有効期限/);
  });

  it("入力チェックの文言も、画面の言語のほうだけを返す", async () => {
    const s = await seedPoll({ participants: [ALICE] });
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    const patch = (lang: string) => {
      const req = jsonReq("PATCH", `/api/polls/${s.pollId}`, { title: "" }, org);
      req.headers.set("X-DI-Lang", lang);
      return call(req);
    };
    const en = ((await (await patch("en")).json()) as { error: { message: string } }).error.message;
    expect(en).toBe("Enter 1 to 100 characters");
    const ja = ((await (await patch("ja")).json()) as { error: { message: string } }).error.message;
    expect(ja).toMatch(/^1〜100 文字で入力してください$/);
  });
});

describe("イベントの場所の既定値（§5.3.1）", () => {
  it("主催者にだけ、サーバーの既定値を返す", async () => {
    const s = await seedPoll({ participants: [ALICE] });
    await db().prepare("INSERT OR REPLACE INTO guild_settings (guild_id, mode, role_id, event_location, event_channel_id, updated_by, updated_at) VALUES (?, 'channel', NULL, '第2会議室', '300000000000000777', ?, 1)").bind(GUILD, ORGANIZER).run();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    const alice = await login(s.pollId, ALICE, "participant");
    type R = { defaultEventLocation: string | null; defaultEventChannelId: string | null };
    const get = async (c: Awaited<ReturnType<typeof login>>) => {
      const r = (await (await call(getReq(`/api/polls/${s.pollId}`, c.cookie))).json()) as R;
      return { location: r.defaultEventLocation, channel: r.defaultEventChannelId };
    };
    expect(await get(org)).toEqual({ location: "第2会議室", channel: "300000000000000777" });
    expect(await get(alice)).toEqual({ location: null, channel: null });
    await db().prepare("DELETE FROM guild_settings").run();
  });
});

describe("サーバーの最近使った時間帯（§6.3.1）", () => {
  const JST = (h: number, m = 0, day = 20) => Math.floor(Date.UTC(2027, 0, day, h - 9, m) / 1000);
  const newSlot = (sh: number, eh: number, day = 20) => ({ id: null, startAt: JST(sh, 0, day), endAt: JST(eh, 0, day), allDay: false });
  const recent = async (pollId: string, cookie: Awaited<ReturnType<typeof login>>) =>
    ((await (await call(getReq(`/api/polls/${pollId}`, cookie.cookie))).json()) as { recentTimes: { start: string; end: string }[] }).recentTimes;

  beforeEach(async () => {
    await db().prepare("DELETE FROM guild_recent_times").run();
  });

  it("新しく追加した候補の時間帯を、新しい順に 3 件まで覚えて主催者に返す", async () => {
    mockDiscord(() => ({}));
    const s = await seedPoll({ status: "draft", messageId: null });
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    const put = (slots: object[]) => call(jsonReq("PUT", `/api/polls/${s.pollId}/slots`, { slots }, org));

    expect(await recent(s.pollId, org)).toEqual([]);
    expect((await put([newSlot(19, 21), newSlot(21, 23, 21), newSlot(19, 21, 22), { id: null, startAt: JST(0, 0, 23), endAt: null, allDay: true }])).status).toBe(200);
    // 終日の候補は覚えない。同じ時間帯は 1 件にまとめる
    expect(await recent(s.pollId, org)).toEqual([{ start: "19:00", end: "21:00" }, { start: "21:00", end: "23:00" }]);

    // 保存済みの候補（id あり）は数えず、新しく足した候補だけを先頭に入れる
    const kept = (await db().prepare("SELECT id, start_at, end_at, all_day FROM slots WHERE poll_id = ?").bind(s.pollId).all<{ id: string; start_at: number; end_at: number | null; all_day: number }>()).results;
    const keep = kept.map((k) => ({ id: k.id, startAt: k.start_at, endAt: k.end_at, allDay: k.all_day === 1 }));
    expect((await put([...keep, newSlot(10, 11, 24)])).status).toBe(200);
    expect(await recent(s.pollId, org)).toEqual([{ start: "10:00", end: "11:00" }, { start: "19:00", end: "21:00" }, { start: "21:00", end: "23:00" }]);

    // 4 件目で一番古いものが落ちる。すでにある時間帯は先頭に移る
    const kept2 = (await db().prepare("SELECT id, start_at, end_at, all_day FROM slots WHERE poll_id = ?").bind(s.pollId).all<{ id: string; start_at: number; end_at: number | null; all_day: number }>()).results;
    const keep2 = kept2.map((k) => ({ id: k.id, startAt: k.start_at, endAt: k.end_at, allDay: k.all_day === 1 }));
    expect((await put([...keep2, newSlot(13, 14, 25), newSlot(21, 23, 26)])).status).toBe(200);
    expect(await recent(s.pollId, org)).toEqual([{ start: "13:00", end: "14:00" }, { start: "21:00", end: "23:00" }, { start: "10:00", end: "11:00" }]);

    // 保存するのは時刻だけで、誰が入れたかは保存しない
    const row = await db().prepare("SELECT * FROM guild_recent_times").first<Record<string, unknown>>();
    expect(Object.keys(row!).sort()).toEqual(["guild_id", "ranges", "updated_at"]);
  });

  it("参加者には返さない", async () => {
    mockDiscord(() => ({}));
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    expect((await call(jsonReq("PUT", `/api/polls/${s.pollId}/slots`, { slots: [newSlot(19, 21)] }, org))).status).toBe(200);
    const alice = await login(s.pollId, ALICE, "participant", "answer");
    expect(await recent(s.pollId, alice)).toEqual([]);
  });

  it("壊れた保存値は空として扱う", async () => {
    mockDiscord(() => ({}));
    const s = await seedPoll({ status: "draft", messageId: null });
    const g = await db().prepare("SELECT guild_id FROM polls WHERE id = ?").bind(s.pollId).first<{ guild_id: string }>();
    await db().prepare("INSERT INTO guild_recent_times (guild_id, ranges, updated_at) VALUES (?, ?, 1)").bind(g!.guild_id, '[{"start":"<b>","end":"22:00"},"x"]').run();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    expect(await recent(s.pollId, org)).toEqual([]);
  });
});

describe("主催者の調整一覧（§6.11）", () => {
  const OTHER_GUILD = "200000000000000999";
  async function listLogin(guildId: string, userId: string) {
    const { issueListLink } = await import("../src/auth");
    const url = await issueListLink(db(), ORIGIN, guildId, userId);
    const res = await call(jsonReq("POST", "/api/session", { token: tokenFromUrl(url) }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { redirect: string }).redirect).toBe(`/g/${guildId}/polls`);
    const cookie = res.headers.get("Set-Cookie")!.split(";")[0]!;
    expect(cookie.startsWith(`__Host-l_${guildId}=`)).toBe(true);
    const list = await call(getReq(`/api/guilds/${guildId}/polls`, cookie));
    const data = (await list.json()) as { csrfToken: string; polls: { id: string; status: string; answered: number; participants: number }[] };
    return { cookie, csrf: data.csrfToken, polls: data.polls };
  }

  it("このサーバーで自分が主催した調整だけを返す", async () => {
    const mine = await seedPoll();
    const draft = await seedPoll({ status: "draft", messageId: null });
    const others = await seedPoll();
    await db().prepare("UPDATE polls SET organizer_id = ? WHERE id = ?").bind(ALICE, others.pollId).run();
    const otherGuild = await seedPoll();
    await db().prepare("UPDATE polls SET guild_id = ? WHERE id = ?").bind(OTHER_GUILD, otherGuild.pollId).run();
    await db().prepare("UPDATE participants SET answered_at = 1 WHERE poll_id = ? AND user_id = ?").bind(mine.pollId, ALICE).run();

    const { polls } = await listLogin("200000000000000001", ORGANIZER);
    const ids = polls.map((p) => p.id);
    expect(ids).toContain(mine.pollId);
    expect(ids).toContain(draft.pollId);
    expect(ids).not.toContain(others.pollId);
    expect(ids).not.toContain(otherGuild.pollId);
    const m = polls.find((p) => p.id === mine.pollId)!;
    expect(m).toMatchObject({ status: "open", answered: 1, participants: 3 });
  });

  it("一覧から開くと、主催者本人のときだけ、その調整のセッションを発行する", async () => {
    const mine = await seedPoll();
    const draft = await seedPoll({ status: "draft", messageId: null });
    const others = await seedPoll();
    await db().prepare("UPDATE polls SET organizer_id = ? WHERE id = ?").bind(ALICE, others.pollId).run();
    const { cookie, csrf } = await listLogin("200000000000000001", ORGANIZER);

    const res = await call(jsonReq("POST", `/api/guilds/200000000000000001/polls/${mine.pollId}/open`, { to: "edit" }, { cookie, csrf }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { redirect: string }).redirect).toBe(`/p/${mine.pollId}/edit`);
    const pollCookie = res.headers.get("Set-Cookie")!.split(";")[0]!;
    expect(pollCookie.startsWith(`__Host-s_${mine.pollId}=`)).toBe(true);
    const detail = await call(getReq(`/api/polls/${mine.pollId}`, pollCookie));
    expect(((await detail.json()) as { me: { role: string } }).me.role).toBe("organizer");

    expect((await call(jsonReq("POST", `/api/guilds/200000000000000001/polls/${others.pollId}/open`, { to: "edit" }, { cookie, csrf }))).status).toBe(404);
    expect((await call(jsonReq("POST", `/api/guilds/200000000000000001/polls/${draft.pollId}/open`, { to: "summary" }, { cookie, csrf }))).status).toBe(409);
    // CSRF トークンがなければ受け付けない
    expect((await call(jsonReq("POST", `/api/guilds/200000000000000001/polls/${mine.pollId}/open`, { to: "edit" }, { cookie }))).status).toBe(403);
  });

  it("一覧から削除できるのは自分の調整だけ", async () => {
    mockDiscord(() => ({}));
    const mine = await seedPoll();
    const others = await seedPoll();
    await db().prepare("UPDATE polls SET organizer_id = ? WHERE id = ?").bind(ALICE, others.pollId).run();
    const { cookie, csrf } = await listLogin("200000000000000001", ORGANIZER);
    expect((await call(jsonReq("DELETE", `/api/guilds/200000000000000001/polls/${others.pollId}`, {}, { cookie, csrf }))).status).toBe(404);
    expect(await db().prepare("SELECT id FROM polls WHERE id = ?").bind(others.pollId).first()).not.toBeNull();
    expect((await call(jsonReq("DELETE", `/api/guilds/200000000000000001/polls/${mine.pollId}`, {}, { cookie, csrf }))).status).toBe(200);
    expect(await db().prepare("SELECT id FROM polls WHERE id = ?").bind(mine.pollId).first()).toBeNull();
  });

  it("別のサーバーの一覧には、そのサーバーのセッションがなければ入れない", async () => {
    const { cookie } = await listLogin("200000000000000001", ORGANIZER);
    expect((await call(getReq(`/api/guilds/${OTHER_GUILD}/polls`, cookie))).status).toBe(401);
    const expired = await call(getReq(`/api/guilds/200000000000000001/polls`));
    expect(expired.status).toBe(401);
    const err = ((await expired.json()) as { error: { code: string; message: string } }).error;
    expect(err.code).toBe("list_session_expired");
    expect(err.message).toContain("もう一度 /schedule を実行し、［作成した調整を管理］を押して、新しいリンクを受け取ってください");
  });

  it("一覧のリンクも 1 回だけ使える", async () => {
    const { issueListLink } = await import("../src/auth");
    const url = await issueListLink(db(), ORIGIN, "200000000000000001", ORGANIZER);
    expect((await call(jsonReq("POST", "/api/session", { token: tokenFromUrl(url) }))).status).toBe(200);
    expect((await call(jsonReq("POST", "/api/session", { token: tokenFromUrl(url) }))).status).toBe(401);
  });
});

describe("使えなかったリンクの案内", () => {
  const msg = async (token: string) => {
    const res = await call(jsonReq("POST", "/api/session", { token }));
    expect(res.status).toBe(401);
    return ((await res.json()) as { error: { code: string; message: string } }).error;
  };
  it("リンクの種類に合わせて、押し直すボタンを案内する", async () => {
    const s = await seedPoll();
    const answer = tokenFromUrl(await issueLink(db(), ORIGIN, s.pollId, ALICE, "participant", "answer"));
    const view = tokenFromUrl(await issueLink(db(), ORIGIN, s.pollId, ALICE, "participant", "view"));
    const edit = tokenFromUrl(await issueLink(db(), ORIGIN, s.pollId, ORGANIZER, "organizer", "edit"));
    // 1 回使ってから、もう一度使う
    for (const t of [answer, view, edit]) await call(jsonReq("POST", "/api/session", { token: t }));
    expect((await msg(answer)).message).toContain("［回答する］を、もう一度押してください");
    expect((await msg(view)).message).toContain("［集計を見る］を、もう一度押してください");
    expect((await msg(edit)).message).toContain("/schedule を実行し、［作成した調整を管理］");
    // 期限切れ
    const old = tokenFromUrl(await issueLink(db(), ORIGIN, s.pollId, ALICE, "participant", "answer"));
    await db().prepare("UPDATE link_tokens SET expires_at = 1").run();
    expect((await msg(old)).message).toContain("［回答する］を、もう一度押してください");
    // 記録がないリンクは、参加者と主催者の両方に向けて案内する
    const unknown = await msg("B".repeat(43));
    expect(unknown.code).toBe("link_expired");
    expect(unknown.message).toContain("参加者は");
    expect(unknown.message).toContain("主催者は");
  });
});
