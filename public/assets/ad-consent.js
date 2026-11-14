// 広告の表示と、広告会社の Cookie・トラッキングへの同意（docs/design.md §6.10.1）
// - 既定は「表示する」。ブラウザで Global Privacy Control（追跡しないでほしいという設定）が有効なら、既定を「表示しない」にする
// - 「表示しない」を選ぶと広告の枠を読み込まない。広告会社には何も送らない
// - 選んだ内容は、このブラウザの localStorage にだけ保存する（サーバーには送らない）
// CSP（Trusted Types）を守るため、innerHTML などは使わず DOM の API だけで組み立てる
(() => {
  const KEY = "discheduler.ads";
  const FRAME_URL = "https://ads.etlits.dev/frame";
  // ページの言語（<html lang>）に合わせて文言を選ぶ（英語版のページは /en/ の下。docs/design.md §6.12）
  const en = document.documentElement.lang === "en";
  const t = (ja, enText) => (en ? enText : ja);

  const saved = () => {
    try {
      const v = localStorage.getItem(KEY);
      return v === "granted" || v === "denied" ? v : null;
    } catch {
      return null;
    }
  };
  const save = (v) => {
    try {
      localStorage.setItem(KEY, v);
    } catch {
      // 保存できないブラウザでは、このページを開いている間だけ反映する
    }
  };
  let choice = saved() ?? (navigator.globalPrivacyControl === true ? "denied" : "granted");

  const el = (tag, attrs, text) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text) e.textContent = text;
    return e;
  };

  function render() {
    for (const slot of document.querySelectorAll("[data-ad-slot]")) {
      const box = slot.querySelector(".ad-box");
      const note = slot.querySelector(".ad-choice");
      if (!box || !note) continue;
      if (choice === "granted") {
        box.replaceChildren(
          el("iframe", {
            src: FRAME_URL,
            title: t("広告", "Advertisement"),
            width: "300",
            height: "250",
            loading: "lazy",
            // 別オリジンの枠なので allow-same-origin を付けても本体には触れられない。
            // allow-top-navigation を付けないので、広告がこのページごと別のサイトへ移動させることはできない
            sandbox: "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox",
          }),
        );
        const btn = el("button", { type: "button", class: "ad-toggle" }, t("広告と広告会社の Cookie を拒否する", "Decline ads and the ad network's cookies"));
        btn.addEventListener("click", () => update("denied"));
        note.replaceChildren(btn);
      } else {
        box.replaceChildren(el("p", { class: "ad-off" }, t("広告を表示していません。広告会社には何も送っていません。", "Ads are off. Nothing is sent to the ad network.")));
        const btn = el("button", { type: "button", class: "ad-toggle" }, t("広告を表示する（広告会社の Cookie を許可）", "Show ads (allow the ad network's cookies)"));
        btn.addEventListener("click", () => update("granted"));
        note.replaceChildren(btn);
      }
    }
  }

  function update(v) {
    choice = v;
    save(v);
    render();
  }

  render();
})();
