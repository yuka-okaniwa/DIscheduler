import "./app.css";
import { apiError } from "./lib/api";
import { redrawError, showError } from "./ui/common";
import { answerPage } from "./pages/answer";
import { donePage } from "./pages/done";
import { editPage } from "./pages/edit";
import { linkPage } from "./pages/link";
import { minePage } from "./pages/mine";
import { summaryPage } from "./pages/summary";
import { LANG, setLang, setLangInPlace, tr } from "./lib/i18n";

/** 画面の枠（index.html）の文言と、言語の切り替えボタンを、画面の言語に合わせる（§6.12） */
function applyShell(): void {
  const skip = document.getElementById("skip-link");
  if (skip) skip.textContent = tr("本文へ移動", "Skip to content");
  const loading = document.querySelector(".loading");
  if (loading) loading.textContent = tr("読み込んでいます…", "Loading…");
  document.querySelector(".site-header .brand")?.setAttribute("href", tr("/", "/en/"));
  const security = document.getElementById("footer-security");
  if (security) {
    security.textContent = tr("セキュリティ方針", "Security policy");
    security.setAttribute("href", tr("/security", "/en/security"));
  }
  // 言語の切り替え。もう一方の言語の名前を、その言語で書く
  const sw = document.getElementById("lang-switch");
  if (sw) {
    const other = LANG === "en" ? "ja" : "en";
    sw.textContent = other === "en" ? "English" : "日本語";
    sw.setAttribute("lang", other);
    sw.setAttribute("aria-label", other === "en" ? "Switch to English" : "日本語に切り替える");
    sw.hidden = false;
  }
}

/** 言語の切り替えボタンは、どの画面でも右上に出す */
function setupShell(): void {
  applyShell();
  document.getElementById("lang-switch")?.addEventListener("click", () => {
    const other = LANG === "en" ? "ja" : "en";
    // リンク中継（/l）では読み込み直さない。トークンは読み取ったときに URL から消すので、読み込み直すとエラーの内容が変わってしまうため。
    // その場で枠と、表示中のエラーを描き直す
    if (location.pathname === "/l") {
      setLangInPlace(other, () => {
        applyShell();
        redrawError();
      });
    } else setLang(other);
  });
}

async function route(): Promise<void> {
  const path = location.pathname;
  if (path === "/l") return linkPage();
  const g = /^\/g\/(\d{17,20})\/polls\/?$/.exec(path);
  if (g) return minePage(g[1]!);
  const m = /^\/p\/([A-Za-z0-9_-]{22})(?:\/(edit|answer|done))?\/?$/.exec(path);
  if (!m) return showError(apiError(404, "not_found", "ページが見つかりません。", "Page not found."));
  const id = m[1]!;
  switch (m[2]) {
    case "edit":
      return editPage(id);
    case "answer":
      return answerPage(id);
    case "done":
      return donePage(id);
    default:
      return summaryPage(id);
  }
}

setupShell();
route().catch(showError);
