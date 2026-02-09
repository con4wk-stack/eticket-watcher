// index.js
import fetch from "node-fetch";

// --------------------
// 設定部分
// --------------------

// 監視対象（テスト用に疑似HTMLを使います）
let html = '<div class="button-class-name">Buy</div>'; // classがある状態
const targetClass = "button-class-name";               // 監視したいclass

// LINE設定
const LINE_TOKEN = "53HSL37fngc+EuTIdX2tBlWHdwb4evtfo1ZRLb1XK1uETtS9FeBOLqHVCUQvO7YVssWAI/W1NfQ8yUPVIuQFY7425HbkBwzLmj2Ljt7zT0xcNhKgcNj/P5C631nktl1O44WQb2m+JLWQ/lF+CYUdxQdB04t89/1O/w1cDnyilFU=";
const LINE_USER_ID = "Uaa7df44a6257eecb60409c763c087be5";

let lastState = false; // 前回の状態

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
    console.log("LINE sent:", message);
  } catch (err) {
    console.error("LINE send error:", err);
  }
}

// --------------------
// class監視関数
// --------------------
async function checkPage() {
  try {
    // --- 実運用時は下をコメントアウトして fetch に置き換える ---
    // const res = await fetch("監視対象のURL");
    // html = await res.text();

    const isAvailable = html.includes(targetClass);

    // 前回と状態が変わったら通知
    if (isAvailable !== lastState) {
      const message = `Class changed! Available: ${isAvailable} at ${new Date().toISOString()}`;
      console.log(message);
      await sendLine(message);
      lastState = isAvailable;
    }
  } catch (err) {
    console.error("Error checking page:", err);
  }
}

// --------------------
// 30秒ごとに監視開始
// --------------------
console.log("Watcher started:", new Date().toISOString());

setInterval(() => {
  checkPage();
}, 30000);