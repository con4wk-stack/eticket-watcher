import fetch from "node-fetch";
import express from "express";

// ========== 設定 ==========
const url = "https://eplus.jp/sf/detail/0473460001";
const LINE_TOKEN = "53HSL37fngc+EuTIdX2tBlWHdwb4evtfo1ZRLb1XK1uETtS9FeBOLqHVCUQvO7YVssWAI/W1NfQ8yUPVIuQFY7425HbkBwzLmj2Ljt7zT0xcNhKgcNj/P5C631nktl1O44WQb2m+JLWQ/lF+CYUdxQdB04t89/1O/w1cDnyilFU=";
const LINE_USER_ID = "Uaa7df44a6257eecb60409c763c087be5";
const INTERVAL = 30000; // 30秒
// =========================

// Render 用ダミーサーバー
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("Watcher running"));
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

let lastState = false;

console.log("Watcher started (e+ production):", new Date().toISOString());

async function checkPage() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10秒タイムアウト

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      console.log("Fetch failed:", res.status);
      return;
    }

    const html = await res.text();

    // 発売前ボタンの正規表現
    const preReleaseMatches = [...html.matchAll(/class="button button--default uk-button-\d+"/g)];

    // 発売後ボタンの正規表現
    const isReleased = /class="button button--primary"/.test(html);

    // class切り替わりチェック
    if (isReleased && !lastState) {
      lastState = true;

      // 日付・時間取得
      const dateMatch = html.match(/class="block-ticket-article__date">([^<]+)</);
      const timeMatch = html.match(/class="block-ticket-article__time">([^<]+)</);

      const ticketDate = dateMatch ? dateMatch[1].trim() : "不明";
      const ticketTime = timeMatch ? timeMatch[1].trim() : "不明";

      // リンク取得
      const buttonMatches = [...html.matchAll(/onclick="window\.location\.href='([^']+)'/g)];
      const links = buttonMatches.map(m => m[1]);

      // 通知メッセージ作成
      let message = `🎉 e+チケット発売開始！\n`;
      links.forEach((link, i) => {
        message += `${i + 1}. ${ticketDate} ${ticketTime} → ${link}\n`;
      });
      message += `一覧ページ: ${url}`;

      // LINE通知
      if (LINE_TOKEN && LINE_USER_ID) {
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
        console.log("LINE通知送信完了");
      } else {
        console.log("LINE_TOKEN または LINE_USER_ID が未設定");
      }
    } else {
      console.log("Still pre-release:", new Date().toISOString());
    }
  } catch (err) {
    console.log("Error during check:", err.message);
  }
}

// 監視開始
setInterval(checkPage, INTERVAL);
checkPage();
