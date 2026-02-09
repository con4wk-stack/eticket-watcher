import fetch from "node-fetch";
import express from "express";

// ====== 設定 ======
const url = "https://eplus.jp/sf/detail/0473460001";
const LINE_TOKEN = "53HSL37fngc+EuTIdX2tBlWHdwb4evtfo1ZRLb1XK1uETtS9FeBOLqHVCUQvO7YVssWAI/W1NfQ8yUPVIuQFY7425HbkBwzLmj2Ljt7zT0xcNhKgcNj/P5C631nktl1O44WQb2m+JLWQ/lF+CYUdxQdB04t89/1O/w1cDnyilFU=";
const LINE_USER_ID = "Uaa7df44a6257eecb60409c763c087be5";
const INTERVAL = 30000; // 30秒
// ===================

// Render用ダミーサーバー
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("Watcher running"));
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

console.log("Watcher started:", new Date().toISOString());

// ボタンごとの状態管理
let lastStates = {};

// HTML から href を取得する関数
function extractHref(onclick) {
  const match = onclick.match(/window\.location\.href='([^']+)'/);
  return match ? match[1] : null;
}

// ページチェック関数
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

    let html = await res.text();

    //テスト用記述
    html = html.replace(/class="button button--default uk-button-\d+"/g, 'class="button button--primary"');

    // 日付・時間取得（最初の要素だけ）
    const dateMatch = html.match(/class="block-ticket-article__date">([^<]+)</);
    const timeMatch = html.match(/class="block-ticket-article__time">([^<]+)</);
    const ticketDate = dateMatch ? dateMatch[1].trim() : "不明";
    const ticketTime = timeMatch ? timeMatch[1].trim() : "不明";

    // 発売前ボタンの正規表現
    const preButtons = [...html.matchAll(/class="button button--default uk-button-\d+" onclick="([^"]+)"/g)];

    // 発売後ボタンの正規表現
    const releasedButtons = [...html.matchAll(/class="button button--primary"/g)];

    // 発売前ボタンごとに状態確認
    preButtons.forEach((match, idx) => {
      const onclick = match[1];
      const href = extractHref(onclick);
      const id = `btn-${idx}`;

      if (!lastStates[id]) lastStates[id] = false;

      // 発売前から発売に切り替わったか
      const isReleased = releasedButtons.length > 0;
      if (isReleased && !lastStates[id]) {
        lastStates[id] = true;

        // 通知メッセージ
        const message = `🎉 e+チケット発売開始！\n日付: ${ticketDate} ${ticketTime}\nリンク: ${href}\n一覧ページ: ${url}`;

        // LINE通知
        if (LINE_TOKEN && LINE_USER_ID) {
          fetch("https://api.line.me/v2/bot/message/push", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${LINE_TOKEN}`,
            },
            body: JSON.stringify({
              to: LINE_USER_ID,
              messages: [{ type: "text", text: message }],
            }),
          }).then(() => console.log("LINE通知送信:", href))
            .catch(err => console.log("LINE通知エラー:", err.message));
        } else {
          console.log("LINE_TOKEN または LINE_USER_ID が未設定");
        }
      } else if (!isReleased && lastStates[id]) {
        // 再度発売前に戻った場合も状態更新
        lastStates[id] = false;
      }
    });

    console.log("Checked at:", new Date().toISOString());
  } catch (err) {
    console.log("Error during check:", err.message);
  }
}

// 監視開始
setInterval(checkPage, INTERVAL);
checkPage();
