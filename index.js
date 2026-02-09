import fetch from "node-fetch";
import express from "express";

// ====== 設定 ======
const url = "https://eplus.jp/sf/detail/0473460001";
const LINE_TOKEN = "53HSL37fngc+EuTIdX2tBlWHdwb4evtfo1ZRLb1XK1uETtS9FeBOLqHVCUQvO7YVssWAI/W1NfQ8yUPVIuQFY7425HbkBwzLmj2Ljt7zT0xcNhKgcNj/P5C631nktl1O44WQb2m+JLWQ/lF+CYUdxQdB04t89/1O/w1cDnyilFU=";
const LINE_USER_ID = "Uaa7df44a6257eecb60409c763c087be5";
const INTERVAL = 30000; // 30秒
// ===================

// ボタンごとの状態管理
let lastStates = {};

// HTML から href を取得する関数
function extractHref(onclick) {
  const match = onclick.match(/window\.location\.href='([^']+)'/);
  return match ? match[1] : null;
}

// ページチェック関数（最新版）
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

    // 日付取得（最初の要素だけ）
    const dateMatch = html.match(/class="block-ticket-article__date">([^<]+)</);
    const ticketDate = dateMatch ? dateMatch[1].trim() : "不明";

    // 時間取得（最初の要素だけ）
    const timeMatch = html.match(/class="block-ticket-article__time">([\s\S]*?)</);
    let ticketTimeRaw = timeMatch ? timeMatch[1] : "不明";

    // ticketTime を整形（改行・空白除去、見やすく）
    const ticketTime = ticketTimeRaw
      .split(/\r?\n/)           // 改行で分割
      .map(line => line.trim())  // 前後空白削除
      .filter(line => line)      // 空行を削除
      .join('\n');               // 改行で再結合

    // 発売前ボタン（uk-button-数字は無視）
    const preButtons = [...html.matchAll(/class="button button--default" onclick="([^"]+)"/g)];

    // 発売後ボタン
    const releasedButtons = [...html.matchAll(/class="button button--primary"/g)];

    // 発売前ボタンごとに状態確認
    preButtons.forEach((match, idx) => {
      const onclick = match[1];
      const href = extractHref(onclick);
      const id = `btn-${idx}`;

      if (!lastStates[id]) lastStates[id] = false;

      const isReleased = releasedButtons.length > 0; // 1つでも発売後ボタンがあれば発売開始

      if (isReleased && !lastStates[id]) {
        // 発売前 → 発売 に切り替わった
        lastStates[id] = true;

        // LINE通知メッセージ作成
        const message = `🎉 e+チケット発売開始！
日付: ${ticketDate}
${ticketTime}
リンク: ${href}

一覧ページ: ${url}`;

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
          })
            .then(() => console.log("LINE通知送信:", href))
            .catch(err => console.log("LINE通知エラー:", err.message));
        } else {
          console.log("LINE_TOKEN または LINE_USER_ID が未設定");
        }

      } else if (!isReleased && lastStates[id]) {
        // 発売前に戻った場合も状態更新（念のため）
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