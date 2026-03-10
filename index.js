import "dotenv/config";
import fetch from "node-fetch";
import express from "express";

process.env.PLAYWRIGHT_BROWSERS_PATH = "./playwright-browsers";

let browser = null;

// onlineticket（FCサイト）: 会員番号・パスワードでログインしてから一覧を監視
const url = process.env.WATCH_URL || "https://w1.onlineticket.jp/sf/tkt18/detail/0473460001?P6=464";
// ここにFCの会員番号とパスワードを直接入力してください
const MEMBER_ID = "099345"; // 会員番号
const PASSWORD = "rina1227";  // パスワード
const LINE_TOKEN = "53HSL37fngc+EuTIdX2tBlWHdwb4evtfo1ZRLb1XK1uETtS9FeBOLqHVCUQvO7YVssWAI/W1NfQ8yUPVIuQFY7425HbkBwzLmj2Ljt7zT0xcNhKgcNj/P5C631nktl1O44WQb2m+JLWQ/lF+CYUdxQdB04t89/1O/w1cDnyilFU=";
const LINE_USER_ID = "C755fb6ffbd64b76818fd0a4dac5b130f";
// Chatwork（常にLINEとChatworkの両方に送信）。環境変数 CHATWORK_TOKEN / CHATWORK_ROOM_ID か、下記に直接指定。空ならChatworkは送らない
// ルームIDは「数字だけ」か「ルームURL」（#!rid の後ろの数字を自動抽出）
const _cwRoomRaw = (process.env.CHATWORK_ROOM_ID || "rid425373870").trim();
const CHATWORK_TOKEN = (process.env.CHATWORK_TOKEN || "f03fec5446114f0da54c391afcbab29e").trim();
const CHATWORK_ROOM_ID = _cwRoomRaw.match(/rid(\d+)/)?.[1] || _cwRoomRaw.replace(/\D/g, "") || "";



const NORMAL_INTERVAL = 30000;
const BATTLE_INTERVAL = 15000;
const RETRY_DELAY = 5000;
const TIMEOUT = 15000;
const LOGIN_TIMEOUT = 25000; // ログイン・ページ読み込み待ち
const FIVE_XX_RETRY_COUNT = 3;   // 5xx 時の同一チェック内リトライ回数
const FIVE_XX_RETRY_WAIT_MS = 15000; // 5xx リトライまでの待機（ミリ秒）

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 10000;
app.get("/", (req, res) => res.send("Watcher running"));
app.post("/webhook", (req, res) => {
  console.log("Webhook受信:");
  console.log(JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});
app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  console.log("Watcher started:", new Date().toISOString());
  await sendStartupTestNotification();
});

// Render などでサービス停止時（SIGTERM）にブラウザを閉じてから終了する
process.on("SIGTERM", async () => {
  if (browser) {
    await browser.close().catch(() => {});
  }
  process.exit(0);
});

let retrying = false;
// 各ボタンの前回の状態。key = 公演日-公演時間-詳細リンク → true=primary, false=default
// default→primary になったときだけ通知し、primary→default になったら false に戻す（再販でまた通知できる）
let lastButtonState = new Map();
// 初回の一覧チェックでは通知しない（起動時・再デプロイ時に全件通知されないようにする）
let listCheckInitialized = false;

function isBattleTime() {
  const now = new Date();
  const japan = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const hour = japan.getHours();
  const minute = japan.getMinutes();

  if (hour === 11 && minute >= 55) return true;
  if (hour === 12 && minute <= 30) return true;
  return false;
}

/**
 * ページ内の全ボタン（primary も default も）をブロック単位で取得する。
 * 戻り: { 公演日, 公演時間, 公演タイトル, 詳細リンク, isPrimary }[]
 */
function parseAllBlocks(html) {
  const items = [];
  const detailLinkRe = /window\.location\.href='([^']+)'/g;

  const dateClassRe = /class="[^"]*block-ticket-article__date[^"]*"[^>]*>([\s\S]*?)<\/\w+>/g;
  const timeClassRe = /class="[^"]*block-ticket-article__time[^"]*"[^>]*>([\s\S]*?)<\/\w+>/g;
  const titleClassRe = /class="[^"]*block-ticket__title[^"]*"[^>]*>([\s\S]*?)<\/\w+>/g;

  const blockStarts = [];
  let dm;
  while ((dm = dateClassRe.exec(html)) !== null) {
    blockStarts.push({ index: dm.index, dateText: dm[1].replace(/\s+/g, " ").trim() });
  }

  const MIN_BLOCK_LEN = 3000;
  for (let i = 0; i < blockStarts.length; i++) {
    const blockStart = blockStarts[i].index;
    const nextStart = i + 1 < blockStarts.length ? blockStarts[i + 1].index : html.length;
    const blockEnd = Math.max(nextStart, blockStart + MIN_BLOCK_LEN);
    const block = html.slice(blockStart, Math.min(blockEnd, html.length));

    const hasPrimary = block.includes("button--primary");
    const hasDefault = block.includes("button--default");
    if (!hasPrimary && !hasDefault) continue;

    const 公演日 = blockStarts[i].dateText;
    timeClassRe.lastIndex = 0;
    const timeMatch = timeClassRe.exec(block);
    const 公演時間Raw = timeMatch ? timeMatch[1] : "";
    const 公演時間 = 公演時間Raw.replace(/\s+/g, " ").trim();
    titleClassRe.lastIndex = 0;
    const titleMatch = titleClassRe.exec(block);
    const 公演タイトル = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : "";

    const links = [];
    const seenUrls = new Set();
    let linkMatch;
    detailLinkRe.lastIndex = 0;
    while ((linkMatch = detailLinkRe.exec(block)) !== null) {
      const href = linkMatch[1].replace(/&amp;/g, "&").trim();
      if (seenUrls.has(href)) continue;
      seenUrls.add(href);
      links.push(href);
    }

    items.push({
      公演日,
      公演時間,
      公演タイトル,
      詳細リンク: links,
      isPrimary: hasPrimary,
    });
  }

  return items;
}

function buildNotificationMessage(item, pageUrl) {
  const lines = [
    "🎉 チケット戻ったよ！🎾",
    "",
    `公演日：${item.公演日}`,
    `${item.公演時間 || "—"}`,
  ];

  for (const link of item.詳細リンク) {
    lines.push(link);
  }

  lines.push("");
  lines.push(`ページURL`);
  lines.push(pageUrl);

  return lines.join("\n");
}

/** Chatwork にメッセージを送信（TOKEN と ROOM_ID が設定されている場合のみ） */
async function sendChatworkMessage(text) {
  if (!CHATWORK_TOKEN || !CHATWORK_ROOM_ID) return;
  const roomId = String(CHATWORK_ROOM_ID).trim();
  if (!roomId) return;
  const apiUrl = `https://api.chatwork.com/v2/rooms/${roomId}/messages`;
  const body = new URLSearchParams({ body: text }).toString();
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "X-ChatWorkToken": CHATWORK_TOKEN,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (res.ok) {
    console.log("Chatwork通知送信 OK");
  } else {
    const errBody = await res.text();
    console.error("Chatwork API エラー:", res.status, errBody);
  }
}

/** 起動時（デプロイ完了時）に1回だけ送る通知 */
async function sendStartupTestNotification() {
  try {
    if (isOnlineticket()) {
      const msg = "onlineticket 監視開始\n会員ログインして一覧を監視します。\n\n" + url;
      if (LINE_TOKEN && LINE_USER_ID) {
        await fetch("https://api.line.me/v2/bot/message/push", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${LINE_TOKEN}` },
          body: JSON.stringify({ to: LINE_USER_ID, messages: [{ type: "text", text: msg }] }),
        }).catch(() => {});
      }
      await sendChatworkMessage(msg);
      return;
    }
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    });
    if (!res.ok) {
      const fallback = "一覧の取得に失敗しました。\n\nページURL\n" + url;
      if (LINE_TOKEN && LINE_USER_ID) {
        try {
          await fetch("https://api.line.me/v2/bot/message/push", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${LINE_TOKEN}` },
            body: JSON.stringify({ to: LINE_USER_ID, messages: [{ type: "text", text: fallback }] }),
          });
        } catch (e) {}
      }
      await sendChatworkMessage(fallback);
      return;
    }
    const html = await res.text();
    const blocks = parseAllBlocks(html);
    for (const b of blocks) {
      const message = buildNotificationMessage(
        { 公演日: b.公演日, 公演時間: b.公演時間, 詳細リンク: b.詳細リンク },
        url
      );
      if (LINE_TOKEN && LINE_USER_ID) {
        try {
          const lineRes = await fetch("https://api.line.me/v2/bot/message/push", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${LINE_TOKEN}` },
            body: JSON.stringify({ to: LINE_USER_ID, messages: [{ type: "text", text: message }] }),
          });
          if (lineRes.ok) console.log("起動通知: LINE送信 OK");
          else console.log("起動通知: LINEエラー", await lineRes.text());
        } catch (e) {
          console.log("起動通知: LINE送信失敗", e.message);
        }
      }
      await sendChatworkMessage(message);
    }
  } catch (e) {
    const fallback = "一覧の取得に失敗しました。\n\nページURL\n" + url;
    if (LINE_TOKEN && LINE_USER_ID) {
      try {
        await fetch("https://api.line.me/v2/bot/message/push", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${LINE_TOKEN}` },
          body: JSON.stringify({ to: LINE_USER_ID, messages: [{ type: "text", text: fallback }] }),
        });
      } catch (err) {}
    }
    await sendChatworkMessage(fallback);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * onlineticket: Playwright でページを開き、ログインフォームがあれば会員番号・パスワードを入力して送信し、一覧 HTML を取得する。
 */
async function fetchListHtmlWithLogin(pageUrl, memberId, password) {
  const { chromium } = await import("playwright");
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
  }
  const context = await browser.newContext({ userAgent: USER_AGENT });
  const page = await context.newPage();
  try {
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: LOGIN_TIMEOUT });
    await page.waitForLoadState("load", { timeout: 15000 }).catch(() => {});
    await sleep(2000);

    const needLogin =
      (memberId && password && (await page.locator('input[type="password"]').count()) > 0) ||
      (memberId && password && (await page.getByText("会員番号", { exact: false }).count()) > 0);

    if (needLogin && memberId && password) {
      // 会員番号: onlineticket は name="ninsho_key1_1" / id="form-number-12"
      const memberSelectors = [
        'input[name="ninsho_key1_1"]',
        'input[id="form-number-12"]',
        'input[placeholder="会員番号"]',
        'input[name="memberNo"]',
        'input[name="member_no"]',
        'input[name="loginId"]',
        'input[name="userId"]',
        'input[id="memberNo"]',
        'input[id="member_no"]',
        'input[type="text"]',
      ];
      let filled = false;
      for (const sel of memberSelectors) {
        try {
          const el = page.locator(sel).first();
          if ((await el.count()) > 0) {
            await el.fill(memberId);
            filled = true;
            break;
          }
        } catch (_) {}
      }
      if (!filled) {
        console.log("[login] 会員番号入力欄が見つかりません。HTMLの name/id を確認してください。");
      }

      // パスワード: onlineticket は name="ninsho_key1_2" / id="form-number-13"
      const pwSel = page.locator('input[name="ninsho_key1_2"], input[id="form-number-13"], input[placeholder="パスワード"]').first();
      if ((await pwSel.count()) > 0) await pwSel.fill(password);
      else await page.locator('input[type="password"]').first().fill(password);

      const submitSelectors = ['input[type="submit"]', 'button[type="submit"]', 'button:has-text("ログイン")', 'a:has-text("ログイン")', '[type="submit"]'];
      for (const sel of submitSelectors) {
        try {
          const btn = page.locator(sel).first();
          if ((await btn.count()) > 0) {
            await btn.click();
            break;
          }
        } catch (_) {}
      }

      await page.waitForLoadState("load", { timeout: 15000 }).catch(() => {});
      await sleep(3000);
    }

    const html = await page.content();
    await context.close();
    return html;
  } catch (e) {
    await context.close().catch(() => {});
    throw e;
  }
}

/**
 * onlineticket 一覧HTMLを解析。eplus と同様の形 { 公演日, 公演時間, 公演タイトル, 詳細リンク, isPrimary }[] を返す。
 * サイトのHTMLに合わせて class 名や正規表現を調整する必要がある場合があります。
 */
function parseOnlineticketBlocks(html) {
  const items = [];
  // 日付・時間・ボタンを含むブロックを探す（汎用: テーブル行 or ブロック）
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  const dateLike = /(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}|\d{1,2}\/\d{1,2}\s*[\(（][月火水木金土日][\)）])/;
  const timeLike = /(\d{1,2}\s*:\s*\d{2}|開演\s*[：:]\s*\d{1,2})/;
  let m;
  while ((m = rowRegex.exec(html)) !== null) {
    const block = m[1];
    const dateMatch = block.match(dateLike);
    const timeMatch = block.match(timeLike);
    const 公演日 = dateMatch ? dateMatch[1].replace(/\s+/g, " ").trim() : "";
    const 公演時間 = timeMatch ? timeMatch[1].replace(/\s+/g, " ").trim() : "";
    const linkMatch = block.match(/href=["']([^"']+)["']/);
    const 詳細リンク = linkMatch ? [linkMatch[1].replace(/&amp;/g, "&")] : [];
    const isPrimary =
      /button--primary|btn--primary|予約可|申込可|購入可|primary|is-available|enabled/.test(block) &&
      !/disabled|soldout|完売|受付終了/.test(block);
    const hasDefault = /button|btn|予約|申込|購入/.test(block);
    if (公演日 || 公演時間 || 詳細リンク.length) {
      items.push({
        公演日,
        公演時間,
        公演タイトル: "",
        詳細リンク,
        isPrimary: hasDefault ? isPrimary : false,
      });
    }
  }
  if (items.length > 0) return items;

  // テーブルで取れなければ eplus 風の class で試す（onlineticket が同じ構造の場合）
  return parseAllBlocks(html);
}

function isOnlineticket() {
  return /onlineticket\.jp/i.test(url);
}

async function checkPage() {
  try {
    let html = "";

    if (isOnlineticket()) {
      if (!MEMBER_ID || !PASSWORD) {
        console.log("ONLINETICKET_MEMBER_ID と ONLINETICKET_PASSWORD を設定してください");
        return;
      }
      for (let attempt = 0; attempt < FIVE_XX_RETRY_COUNT; attempt++) {
        try {
          html = await fetchListHtmlWithLogin(url, MEMBER_ID, PASSWORD);
          break;
        } catch (e) {
          console.log("[login] error:", e.message);
          if (attempt < FIVE_XX_RETRY_COUNT - 1) {
            await sleep(FIVE_XX_RETRY_WAIT_MS);
            continue;
          }
          throw e;
        }
      }
    } else {
      let res;
      for (let attempt = 0; attempt < FIVE_XX_RETRY_COUNT; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), TIMEOUT);
        res = await fetch(url, {
          signal: controller.signal,
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        });
        clearTimeout(timeout);
        if (res.ok) break;
        if (res.status >= 500 && attempt < FIVE_XX_RETRY_COUNT - 1) {
          console.log("5xx:", res.status, "→ リトライ");
          await sleep(FIVE_XX_RETRY_WAIT_MS);
          continue;
        }
        if (!res.ok) throw new Error("Fetch status error");
      }
      html = await res.text();
    }

    const allBlocks = isOnlineticket() ? parseOnlineticketBlocks(html) : parseAllBlocks(html);

    for (const block of allBlocks) {
      const link = block.詳細リンク.length ? block.詳細リンク[0].replace(/&amp;/g, "&").trim() : "";
      const key = `${block.公演日}-${block.公演時間}-${link}`;
      const wasPrimary = lastButtonState.get(key);

      // default → primary になったときだけ通知（初回は listCheckInitialized が false なので通知しない）
      if (block.isPrimary && wasPrimary !== true && listCheckInitialized) {
        const message = buildNotificationMessage(
          { 公演日: block.公演日, 公演時間: block.公演時間, 詳細リンク: block.詳細リンク },
          url
        );

        if (LINE_TOKEN && LINE_USER_ID) {
          const lineRes = await fetch("https://api.line.me/v2/bot/message/push", {
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

          if (lineRes.ok) {
            console.log("LINE通知送信:", block.公演日, block.公演時間);
          } else {
            const errBody = await lineRes.text();
            console.error("LINE API エラー:", lineRes.status, errBody);
          }
        }
        await sendChatworkMessage(message);
      }

      lastButtonState.set(key, block.isPrimary);
    }

    // 今回のページに無い key は削除（公演が一覧から消えた場合）
    for (const key of lastButtonState.keys()) {
      const found = allBlocks.some((b) => {
        const l = b.詳細リンク.length ? b.詳細リンク[0].replace(/&amp;/g, "&").trim() : "";
        return `${b.公演日}-${b.公演時間}-${l}` === key;
      });
      if (!found) lastButtonState.delete(key);
    }

    listCheckInitialized = true; // 2回目以降は「変化があったときだけ」通知する
    console.log("Checked at:", new Date().toISOString());
    retrying = false;
  } catch (err) {
    console.log("Fetch timeout or error");

    if (!retrying) {
      retrying = true;
      console.log("Retrying in 5 seconds...");
      setTimeout(checkPage, RETRY_DELAY);
    }
  }
}

function scheduleNextCheck() {
  const interval = isBattleTime() ? BATTLE_INTERVAL : NORMAL_INTERVAL;

  setTimeout(async () => {
    await checkPage().catch(() => {});
    scheduleNextCheck();
  }, interval);
}

scheduleNextCheck();
