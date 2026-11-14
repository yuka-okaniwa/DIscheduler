// 静的ページ（トップ・マニュアル・セキュリティ方針・回答の完了画面）の言語（docs/design.md §6.12）
// - 英語版は /en/ の下にある。各ページの右上の切り替え（a[data-lang]）で、もう一方の言語のページへ移る
// - 切り替えで選んだ言語は、このブラウザの localStorage（dis.lang。Web 画面と共通）にだけ保存する
// - 選んだ言語がまだなければ、ブラウザの言語（日本語なら日本語、それ以外は英語）のページへ移る。
//   検索エンジンのクローラーは移さない（日本語版と英語版のどちらも、それぞれのアドレスで読まれるように）
(() => {
  const KEY = "dis.lang";
  const page = document.documentElement.lang === "en" ? "en" : "ja";
  const store = (v) => {
    try {
      localStorage.setItem(KEY, v);
    } catch {
      // 保存できないブラウザでは、移った先のページの言語のまま
    }
  };
  const link = document.querySelector("a[data-lang]");
  if (!link) return;
  // # の後ろ（回答の完了画面の #p=、ページ内の見出し）は、もう一方の言語のページでも保つ
  const target = link.getAttribute("href") + location.hash;
  link.setAttribute("href", target);
  link.addEventListener("click", () => store(link.getAttribute("data-lang")));

  let saved = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    saved = null;
  }
  let want;
  if (saved === "ja" || saved === "en") want = saved;
  else {
    if (navigator.webdriver || /bot|crawl|spider|slurp|preview/i.test(navigator.userAgent)) return;
    const first = (navigator.languages && navigator.languages[0]) || navigator.language || "";
    want = /^ja(\b|-|_|$)/i.test(first) ? "ja" : "en";
  }
  if (want === page) return;
  // もう一方の言語のページへ移る（# の後ろはそのまま保つ。回答の完了画面の #p= など）
  location.replace(target);
})();
