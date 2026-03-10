import fetch from "node-fetch";
import express from "express";

process.env.PLAYWRIGHT_BROWSERS_PATH = "./playwright-browsers";

let browser = null;

const url = "https://eplus.jp/sf/detail/0473460001";
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
const DETAIL_NAV_TIMEOUT = 60000; // 詳細ページ遷移後の読み込み待ち（クリック後が遅いため延長）
const FIVE_XX_RETRY_COUNT = 3;   // 5xx 時の同一チェック内リトライ回数
const FIVE_XX_RETRY_WAIT_MS = 15000; // 5xx リトライまでの待機（ミリ秒）
const DETAIL_CHECK_INTERVAL = 30000;

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

/** 起動時（デプロイ完了時）に1回だけ送る通知（現在の一覧を公演ごとに送信） */
async function sendStartupTestNotification() {
  try {
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

async function checkPage() {
  try {
    let res;
    for (let attempt = 0; attempt < FIVE_XX_RETRY_COUNT; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT);

      res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      });

      clearTimeout(timeout);

      if (res.ok) break;

      if (res.status >= 500 && attempt < FIVE_XX_RETRY_COUNT - 1) {
        console.log("5xx:", res.status, "→", attempt + 2, "/", FIVE_XX_RETRY_COUNT, "回目を", FIVE_XX_RETRY_WAIT_MS / 1000, "秒後にリトライ");
        await sleep(FIVE_XX_RETRY_WAIT_MS);
        continue;
      }

      if (!res.ok) {
        console.log("Fetch failed:", res.status);
        if (res.status >= 500) {
          console.log("今回のチェックはスキップ、次回の間隔で再試行します");
          return;
        }
        throw new Error("Fetch status error");
      }
    }

    const html = await res.text();
    const allBlocks = parseAllBlocks(html);

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

// ===== 個ページ監視（一覧の「最後のボタン」をクリックして詳細へ遷移） =====
/**
 * 一覧HTMLから、最後の詳細ボタンの onclick 内 window.location.href='URL' を抽出。
 * 通知仕様は変更しない（通知URL＝一覧ページのみ。詳細URLは内部チェック専用）。
 */
function getDetailUrlFromListHtml(html) {
  const blocks = parseAllBlocks(html);
  const last = blocks.length > 0 ? blocks[blocks.length - 1] : null;

  let onclickValue = null;
  let detailUrl = null;
  const onclickRe = /onclick="([^"]*?window\.location\.href='([^']+)'[^"]*)"/g;
  let m;
  while ((m = onclickRe.exec(html)) !== null) {
    onclickValue = m[1];
    detailUrl = m[2].replace(/&amp;/g, "&").trim();
  }

  return {
    url: detailUrl,
    onclickValue: onclickValue || undefined,
    公演日: last ? last.公演日 : "",
    公演時間: last ? last.公演時間 : "",
    公演タイトル: last ? last.公演タイトル || "" : "",
  };
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

let lastDetailState = null;
let detailRetrying = false;

const MAX_HTML_SIZE = 400000;

/** page.content() が navigating で失敗する場合に待機してリトライする */
async function getPageContentWithRetry(page, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await page.content();
    } catch (e) {
      const isNavigating = /navigating|changing the content/i.test(e.message);
      if (isNavigating && i < maxRetries - 1) {
        await sleep(2500);
        continue;
      }
      throw e;
    }
  }
}

/**
 * Playwright で一覧を開き、最後の「詳細」ボタンをクリックして遷移し、詳細ページの HTML を取得。
 * ログ用に一覧 HTML も返す。
 */
async function fetchDetailHtmlWithPlaywright(listUrl) {
  const { chromium } = await import("playwright");
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });
  }
  let context;
  try {
    context = await browser.newContext({ userAgent: USER_AGENT });
    const page = await context.newPage();
    await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
    await page.waitForLoadState("load", { timeout: 10000 }).catch(() => {});
    let listHtml = await getPageContentWithRetry(page);
    listHtml = listHtml.slice(0, MAX_HTML_SIZE);

    const maxDetailAttempts = 2; // 遷移エラー時は一覧を更新してから再遷移する
    let detailHtml = null;
    for (let attempt = 0; attempt < maxDetailAttempts; attempt++) {
      if (attempt > 0) {
        // 一覧へ戻って更新してから詳細へ再度遷移する
        await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
        await page.waitForLoadState("load", { timeout: 10000 }).catch(() => {});
        await sleep(1000);
      }
      const buttons = await page.$$('button[onclick*="window.location.href"]');
      if (buttons.length === 0) {
        throw new Error("詳細ボタンが見つかりません");
      }
      await buttons[buttons.length - 1].click({ timeout: 10000, noWaitAfter: true });
      await page.waitForLoadState("domcontentloaded", { timeout: DETAIL_NAV_TIMEOUT });
      await page.waitForLoadState("load", { timeout: 10000 }).catch(() => {});
      await sleep(2000);
      // 当日引換券テーブル（ticketDate）が JS で描画されるまで最大10秒待つ
      await page
        .waitForFunction(
          () => document.body && document.body.innerHTML.includes("ticketDate"),
          { timeout: 10000 }
        )
        .catch(() => {});
      try {
        detailHtml = await getPageContentWithRetry(page);
        // 画面遷移エラーページ（<h1 class="heading01"><span>画面遷移エラー</span></h1>）の場合は一覧を更新して再遷移
        if (detailHtml && detailHtml.includes("画面遷移エラー")) {
          if (attempt === maxDetailAttempts - 1) {
            throw new Error("画面遷移エラーページが表示されました");
          }
          console.log("[detail] 画面遷移エラーページのため一覧を更新して再遷移します");
          detailHtml = null;
          continue;
        }
        break;
      } catch (e) {
        if (attempt === maxDetailAttempts - 1) throw e;
        if (/navigating|changing the content/i.test(e.message)) {
          console.log("[detail] 遷移エラーのため一覧を更新して再遷移します");
          continue;
        }
        throw e;
      }
    }
    detailHtml = (detailHtml || "").slice(0, MAX_HTML_SIZE);
    await page.close();

    return { listHtml, detailHtml };
  } catch (e) {
    // ブラウザが落ちた・切断されたと判断できる場合は次回に再起動する
    if (/browser|context|target|closed|Connection/i.test(e.message)) {
      browser = null;
      console.log("[detail] ブラウザ再接続のため次回起動し直します");
    }
    throw e;
  } finally {
    if (context) await context.close();
  }
}

async function checkDetailPage() {
  console.log("[detail] 詳細ページチェック開始");
  try {
    let html = "";

    // Playwright で一覧を開き、最後のボタンをクリックして詳細へ遷移
    for (let attempt = 0; attempt < FIVE_XX_RETRY_COUNT; attempt++) {
      if (attempt > 0) {
        console.log(
          "[detail] 再試行:",
          attempt + 1,
          "/",
          FIVE_XX_RETRY_COUNT,
          "回目を",
          FIVE_XX_RETRY_WAIT_MS / 1000,
          "秒後"
        );
        await sleep(FIVE_XX_RETRY_WAIT_MS);
      }

      try {
        console.log("[detail] 一覧ページを開いています…");
        const { listHtml, detailHtml } = await fetchDetailHtmlWithPlaywright(url);
        html = detailHtml;
        console.log("[detail] 詳細ページに入りました");

        const { url: extractedUrl, onclickValue, 公演日, 公演時間, 公演タイトル } =
          getDetailUrlFromListHtml(listHtml);
        if (extractedUrl) {
          console.log("[detail] onclick:", onclickValue ?? "(なし)");
          console.log("[detail] extracted url:", extractedUrl);
          console.log(
            "[detail] 一番最後のボタン（クリックして遷移）:",
            "date=" + 公演日,
            "time=" + 公演時間,
            "title=" + 公演タイトル
          );
        }
        break;
      } catch (e) {
        console.log("[detail] Playwright error:", e.message);
        if (attempt < FIVE_XX_RETRY_COUNT - 1) continue;
        html = "";
        break;
      }
    }

    if (!html) {
      console.log("[detail] 詳細ページの取得に失敗しました。次回の間隔で再試行します。");
      return;
    }

    if (!html.includes("ticketDate")) {
      const len = html.length;
      const hasTicket = /ticket|チケット|券/.test(html);
      console.log(
        "[detail] ページ取得失敗（テーブル無し）",
        "html長=" + len,
        hasTicket ? "（ticket等の文字はあり）" : ""
      );
      return;
    }

    console.log("[detail] 当日引換券テーブルを解析中");
    const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)];
    const availableDates = [];
    const dateStatuses = []; // 日付ごとの ○/△/×（×でも通知用）

    for (const row of rows) {
      // 日付: <div class="ticketDate">…</div> 内のテキスト（入れ子span対応）
      const ticketDateDiv = row[1].match(/<div class="ticketDate">([\s\S]*?)<\/div>/);
      if (!ticketDateDiv) continue;

      const dateRaw = ticketDateDiv[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      const date = dateRaw;

      // 当日引換券の列のみ（1列目のtd）。見切席当日引換券は見ない
      const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)];
      if (cells.length < 1) continue;

      const firstCell = cells[0][1]; // 当日引換券のセル
      const status = firstCell.includes("○")
        ? "○"
        : firstCell.includes("△")
          ? "△"
          : "×"; // 受付終了・休演・× はすべて ×
      dateStatuses.push(`${date} ${status}`);

      // 当日引換券 在庫チェック（○ or △ のみ復活通知対象）
      if (firstCell.includes("○") || firstCell.includes("△")) {
        availableDates.push(date);
      }
    }

    const state = JSON.stringify(availableDates);
    const isDetailFirstRun = lastDetailState === null; // 初回は通知しない（起動時・再デプロイ時の全件通知を防ぐ）

    // 初回だけ × 含めて全状態を通知（一度通知の形を見たい用）
    if (isDetailFirstRun && dateStatuses.length > 0) {
      const testMessage = [
        "📋 当日引換券の状態（初回通知）",
        "",
        ...dateStatuses,
        "",
        url,
      ].join("\n");
      if (LINE_TOKEN && LINE_USER_ID) {
        try {
          const lineRes = await fetch("https://api.line.me/v2/bot/message/push", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${LINE_TOKEN}`,
            },
            body: JSON.stringify({
              to: LINE_USER_ID,
              messages: [{ type: "text", text: testMessage }],
            }),
          });
          if (lineRes.ok) console.log("[detail] 初回通知: LINE送信 OK");
          else console.log("[detail] 初回通知: LINEエラー", await lineRes.text());
        } catch (e) {
          console.log("[detail] 初回通知: LINE送信失敗", e.message);
        }
      }
      await sendChatworkMessage(testMessage);
    }

    // 当日引換券の列のみ：×→△ または ×→○ になった公演日があれば通知
    if (!isDetailFirstRun && state !== lastDetailState && availableDates.length > 0) {

      const message = [
        "🎫 当日引換券が復活！",
        "",
        ...availableDates,
        "",
        url,
      ].join("\n");

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
          console.log("[detail] LINE通知送信:", availableDates.length);
        } else {
          const err = await lineRes.text();
          console.log("[detail] LINEエラー:", err);
        }
      }
      await sendChatworkMessage(message);
    }

    lastDetailState = state;

    console.log("[detail] checked:", new Date().toISOString());
    detailRetrying = false;
  } catch (e) {
    console.log("[detail] error:", e.message);
    if (!detailRetrying) {
      detailRetrying = true;
      console.log("[detail]", RETRY_DELAY / 1000, "秒後に再試行します");
      setTimeout(() => {
        checkDetailPage().finally(() => {
          detailRetrying = false;
        });
      }, RETRY_DELAY);
    }
  }
}

function scheduleNextDetailCheck() {
  setTimeout(async () => {
    await checkDetailPage().catch((e) => console.error("[detail] interval error:", e.message));
    scheduleNextDetailCheck();
  }, DETAIL_CHECK_INTERVAL);
}

checkDetailPage().catch((e) => console.error("[detail] startup error:", e.message));
scheduleNextDetailCheck();
