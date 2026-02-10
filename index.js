import fetch from "node-fetch";
import express from "express";

// ====== 設定 ======
const url = "https://eplus.jp/sf/detail/0473460001";
const LINE_TOKEN = "53HSL37fngc+EuTIdX2tBlWHdwb4evtfo1ZRLb1XK1uETtS9FeBOLqHVCUQvO7YVssWAI/W1NfQ8yUPVIuQFY7425HbkBwzLmj2Ljt7zT0xcNhKgcNj/P5C631nktl1O44WQb2m+JLWQ/lF+CYUdxQdB04t89/1O/w1cDnyilFU=";
const LINE_USER_ID = "Uaa7df44a6257eecb60409c763c087be5";
const INTERVAL = 30000; // 30秒
const FETCH_TIMEOUT = 10000; // 10秒
// ===================

// Render用ダミーサーバー
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("Watcher running"));
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

console.log("Watcher started:", new Date().toISOString());

// 前回チケットがあったか
let wasReleased = false;

// onclick から href を抜き出す
function extractHref(onclick) {
  const match = onclick.match(/window\.location\.href='([^']+)'/);
  return match ? match[1] : "";
}

// 時間テキスト整形
function cleanTime(text) {
  return text
    .replace(/\s+/g, " ")
    .replace(/（/g, "\n（")
    .trim();
}

async function checkPage() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      console.log("Fetch failed:", res.status);
      return; // 503などでは落ちない
    }

    const html = await res.text();

    // 発売中ボタン検出
    const releasedButtons = [
      ...html.matchAll(
        /class="button button--primary"[^>]*onclick="([^"]+)"/g
      )
    ];

    const isReleasedNow = releasedButtons.length > 0;

    // 日付
    const dateMatch = html.match(
      /class="block-ticket-article__date">([^<]+)</
    );
    const ticketDate = dateMatch ? dateMatch[1].trim() : "不明";

    // 時間
    const timeMatch = html.match(
      /class="block-ticket-article__time">([\s\S]*?)<\/span>/
    );
    const ticketTime = timeMatch ? cleanTime(timeMatch[1]) : "不明";

    // チケットなし → 状態リセット
    if (!isReleasedNow) {
      wasReleased = false;
      console.log("Checked at:", new Date().toISOString(), "(no tickets)");
      return;
    }

    // すでに発売中として処理済み
    if (wasReleased) {
      console.log(
        "Checked at:",
        new Date().toISOString(),
        "(already released)"
      );
      return;
    }

    // ===== 発売 or 戻りチケ検知 =====
    const links = releasedButtons
      .map(m => extractHref(m[1]))
      .filter(Boolean)
      .join("\n");

    const message = `🎉 e+チケット販売中！

日付:
${ticketDate}

開演:
${ticketTime}

リンク:
${links}

一覧ページ:
${url}`;

    await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LINE_TOKEN}`,
      },
      body: JSON.stringify({
        to: LINE_USER_ID,
        messages: [{ type: "text", text: message }],
      }),
    });

    wasReleased = true;
    console.log("Detected ticket availability & sent LINE notification");

  } catch (err) {
    clearTimeout(timeout);

    if (err.name === "AbortError") {
      console.log("Fetch timeout, will retry at next interval");
      return;  // 次の30秒後のチェックで再試行
    }

    console.log("Error during check:", err.message);
  }
}

// 監視開始
setInterval(checkPage, INTERVAL);
checkPage();
