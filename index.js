import fetch from "node-fetch";
import express from "express";

// --------------------
// 設定
// --------------------
const url = "https://eplus.jp/sf/detail/0473460001";

// 発売前の監視対象クラス（uk-button-数字必須）
const preReleaseRegex = /button button--default uk-button-\d+/;

// 発売後の判定（切り替えトリガー）
const postReleaseRegex = /button--primary/;

const LINE_TOKEN = "53HSL37fngc+EuTIdX2tBlWHdwb4evtfo1ZRLb1XK1uETtS9FeBOLqHVCUQvO7YVssWAI/W1NfQ8yUPVIuQFY7425HbkBwzLmj2Ljt7zT0xcNhKgcNj/P5C631nktl1O44WQb2m+JLWQ/lF+CYUdxQdB04t89/1O/w1cDnyilFU=";
const LINE_USER_ID = "Uaa7df44a6257eecb60409c763c087be5";

// false=発売前, true=発売後
let lastState = false;

// --------------------
// LINE通知関数
// --------------------
async function sendLine(message) {
  try {
    await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${LINE_TOKEN}`
      },
      body: JSON.stringify({
        to: LINE_USER_ID,
        messages: [{ type: "text", text: message }]
      })
    });
    console.log("LINE sent:\n", message);
  } catch (err) {
    console.error("LINE send error:", err);
  }
}

// --------------------
// class監視関数
// --------------------
async function checkPage() {
  try {
    const res = await fetch(url);
    const html = await res.text();

    const preRelease = preReleaseRegex.test(html);
    const postRelease = postReleaseRegex.test(html);

    // 発売後に切り替わった場合のみ通知
    if (!lastState && preRelease && postRelease) {
      // 複数チケット対応（まとめ通知）
      const dateMatches = [...html.matchAll(/class="block-ticket-article__date">([^<]+)</g)];
      const timeMatches = [...html.matchAll(/class="block-ticket-article__time">([^<]+)</g)];
      const buttonMatches = [...html.matchAll(/onclick="window\.location\.href='([^']+)'/g)];

      let messageLines = ["🎉 e+チケット発売開始！"];

      for (let i = 0; i < dateMatches.length; i++) {
        const ticketDate = dateMatches[i] ? dateMatches[i][1].trim() : "日付不明";
        const ticketTime = timeMatches[i] ? timeMatches[i][1].trim() : "時間不明";
        const ticketLink = buttonMatches[i] ? buttonMatches[i][1] : "リンク不明";

        messageLines.push(`${i + 1}. ${ticketDate} ${ticketTime} → ${ticketLink}`);
      }

      messageLines.push(`一覧ページ: ${url}`);
      const message = messageLines.join("\n");

      console.log(message);
      await sendLine(message);

      lastState = true;
    }

    // 発売前の監視対象ならログ出力
    if (!lastState && preRelease) {
      console.log("Still pre-release (monitored ticket)");
    }

  } catch (err) {
    console.error("Error fetching page:", err);
  }
}

// --------------------
// 30秒ごとに監視開始
// --------------------
console.log("Watcher started (e+ production):", new Date().toISOString());

setInterval(() => {
  checkPage();
}, 30000);

// --------------------
// Render用ダミーWebサーバー
// --------------------
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("Watcher running"));
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
