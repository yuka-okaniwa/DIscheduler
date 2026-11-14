#!/usr/bin/env bash
# デプロイ前に public/ の静的ページへ設定値を埋め込む（docs/design.md §6.10, §14）
#
#   DISCORD_APPLICATION_ID  必須。招待リンクの client_id（数字 17〜20 桁）
#   DONATION_URL            任意。寄付リンクの URL（https://...）。Ko-fi のときは、リンクの近くに説明を入れる
#                           （日本語のページは __DONATION_NOTE__、英語版のページ（en/）は __DONATION_NOTE_EN__）
#   ADMAX_ID                任意。忍者AdMax の広告枠の ID（英小文字と数字の 32 文字）。LP とセキュリティ方針ページの広告の枠
#   PUBLIC_ORIGIN           任意。正式な公開アドレス（https://...。末尾の / なし）。LP の正規 URL（canonical）と構造化データ
#
# 正式な公開アドレスの表示切り替え:
#   <!-- origin:start --> ... <!-- origin:end -->  PUBLIC_ORIGIN があるときだけ残し、__PUBLIC_ORIGIN__ を置き換える
#
# 寄付リンクの表示切り替え:
#   <!-- donation:start --> ... <!-- donation:end -->        寄付リンクがあるときだけ残す
#   <!-- no-donation:start --> ... <!-- no-donation:end -->  寄付リンクがないときだけ残す
# どちらの場合も、目印のコメント自体は取り除く。
#
# 広告の表示切り替え（ADMAX_ID。docs/design.md §6.10.1）:
#   <!-- ad:start --> ... <!-- ad:end -->        広告の ID があるときだけ残す
#   <!-- no-ad:start --> ... <!-- no-ad:end -->  広告の ID がないときだけ残す
#   広告の ID があるときは、広告の枠の Worker（ads/public/frame.html）に ID を埋め込む。
#   広告の ID がないときは、広告の表示を切り替えるスクリプト（assets/ad-consent.js）も消す。
#
# 使い方: scripts/prepare-public.sh [対象ディレクトリ（既定: public）]
set -euo pipefail

dir="${1:-public}"
shopt -s nullglob
files=("$dir"/*.html "$dir"/manual/*.html "$dir"/en/*.html "$dir"/en/manual/*.html)
if (( ${#files[@]} == 0 )); then
  echo "::error::$dir に HTML がありません" >&2
  exit 1
fi

fail() { echo "::error::$1" >&2; exit 1; }

# --- 招待リンク ---
app_id="${DISCORD_APPLICATION_ID:-}"
[[ "$app_id" =~ ^[0-9]{17,20}$ ]] || fail "DISCORD_APPLICATION_ID が未設定か、形式が正しくありません"

# --- 寄付リンク ---
donation_url="${DONATION_URL:-}"
if [[ -n "$donation_url" ]]; then
  # https の URL で、決まった文字だけでできているかを確かめる（HTML や置換の書き換えを防ぐ）
  # src/shared/text.ts の DONATION_URL_PATTERN と同じ規則（変えるときは両方そろえる）
  [[ "$donation_url" =~ ^https://[A-Za-z0-9.-]+(/[A-Za-z0-9._~/-]*)?$ ]] \
    || fail "DONATION_URL の形式が正しくありません（https:// で始まる URL を指定してください）"
fi

# --- 正式な公開アドレス ---
public_origin="${PUBLIC_ORIGIN:-}"
if [[ -n "$public_origin" ]]; then
  [[ "$public_origin" =~ ^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || fail "PUBLIC_ORIGIN の形式が正しくありません（例: https://discheduler.etlits.dev。末尾の / なし）"
fi

# --- 広告 ---
donation_note=""
donation_note_en=""
if [[ "$donation_url" =~ ^https://(www\.)?ko-fi\.com(/|$) ]]; then
  # src/shared/text.ts の KOFI_DONATION_NOTE・KOFI_DONATION_NOTE_EN と同じ文にする（変えるときは両方そろえる）
  donation_note="支援は Ko-fi（海外の支援サービス）で受け付けています。画面は英語ですが、金額を選んで、PayPal で支払えます。"
  donation_note_en="Support is accepted through Ko-fi. Choose an amount and pay with PayPal."
fi

admax_id="${ADMAX_ID:-}"
if [[ -n "$admax_id" ]]; then
  [[ "$admax_id" =~ ^[0-9a-f]{32}$ ]] || fail "ADMAX_ID の形式が正しくありません（広告コードの https://adm.shinobi.jp/s/ に続く 32 文字を指定してください）"
fi

for f in "${files[@]}"; do
  sed -i "s/__DISCORD_APPLICATION_ID__/${app_id}/g" "$f"

  if [[ -n "$donation_url" ]]; then
    perl -0pi -e 's/<!-- no-donation:start -->.*?<!-- no-donation:end -->//gs; s/<!-- donation:(start|end) -->//g' "$f"
    sed -i "s#__DONATION_URL__#${donation_url}#g" "$f"
    # 支援サービスの説明。src/shared/text.ts の donationNote と同じ文にする（変えるときは両方そろえる）。説明がなければ、その段落ごと消す
    if [[ -n "$donation_note" ]]; then
      sed -i -e "s#__DONATION_NOTE__#${donation_note}#g" -e "s#__DONATION_NOTE_EN__#${donation_note_en}#g" "$f"
    else
      perl -0pi -e 's#<p class="[^"]*">__DONATION_NOTE(_EN)?__</p>\s*##g' "$f"
    fi
  else
    perl -0pi -e 's/<!-- donation:start -->.*?<!-- donation:end -->//gs; s/<!-- no-donation:(start|end) -->//g' "$f"
  fi

  if [[ -n "$admax_id" ]]; then
    perl -0pi -e 's/<!-- no-ad:start -->.*?<!-- no-ad:end -->//gs; s/<!-- (ad):(start|end) -->//g' "$f"
    sed -i "s/__ADMAX_ID__/${admax_id}/g" "$f"
  else
    perl -0pi -e 's/<!-- ad:start -->.*?<!-- ad:end -->//gs; s/<!-- no-ad:(start|end) -->//g' "$f"
  fi

  if [[ -n "$public_origin" ]]; then
    perl -0pi -e 's/<!-- origin:(start|end) -->//g' "$f"
    sed -i "s#__PUBLIC_ORIGIN__#${public_origin}#g" "$f"
  else
    perl -0pi -e 's/<!-- origin:start -->.*?<!-- origin:end -->//gs' "$f"
  fi

  # 置き換え漏れ・目印の残りがあれば止める
  if grep -qE "__DISCORD_APPLICATION_ID__|__DONATION_URL__|__DONATION_NOTE__|__DONATION_NOTE_EN__|__ADMAX_ID__|__PUBLIC_ORIGIN__|<!-- (no-)?(donation|ad|origin):" "$f"; then
    fail "$f の置き換えに失敗しました"
  fi
done

ads_frame="${ADS_FRAME_FILE:-$(dirname "$0")/../ads/public/frame.html}"
if [[ -z "$admax_id" ]]; then
  rm -f "$dir/assets/ad-consent.js"
  echo "広告: なし（広告の枠を表示しません）"
else
  sed -i "s/__ADMAX_ID__/${admax_id}/g" "$ads_frame"
  if grep -q "__ADMAX_ID__" "$ads_frame"; then fail "$ads_frame の置き換えに失敗しました"; fi
  echo "広告: あり"
fi

if [[ -n "$donation_url" ]]; then
  echo "寄付リンク: あり"
else
  echo "寄付リンク: なし（寄付の欄を表示しません）"
fi
