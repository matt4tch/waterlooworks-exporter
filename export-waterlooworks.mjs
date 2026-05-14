#!/usr/bin/env node

import { chromium } from "playwright";
import * as cheerio from "cheerio";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const START_URL = "https://waterlooworks.uwaterloo.ca/";
const STORAGE_STATE = "waterlooworks-session.json";
const OUT_DIR = "./export";
const RUN_TIMESTAMP = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
const OUT_BASENAME = `waterlooworks-jobs-${RUN_TIMESTAMP}`;
const OUT_CSV = path.join(OUT_DIR, `${OUT_BASENAME}.csv`);
const OUT_JSON = path.join(OUT_DIR, `${OUT_BASENAME}.json`);

// Conservative delay so you do not hammer WaterlooWorks.
const DELAY_BETWEEN_JOBS_MS = 700;
const DELAY_BETWEEN_PAGES_MS = 1200;

// If WaterlooWorks changes its markup, adjust these first.
const ROW_SELECTOR = "tr, [role='row']";
const CELL_SELECTOR = "td, th, [role='cell'], [role='columnheader']";
const JOB_INFO_MARKER = "Job Posting Information";
const LOADING_OVERLAY_SELECTOR = ".loading--stuff.is--visible, .is--spiral--robot .loading--stuff.is--visible";

const rl = readline.createInterface({ input, output });

function normalizeText(s) {
  return String(s ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function toSnakeCase(label) {
  return normalizeText(label)
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function htmlToText(html) {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();

  // Add line breaks around common block-ish elements before extracting text.
  $("br").replaceWith("\n");
  $("p, div, section, article, header, footer, li, tr, h1, h2, h3, h4, h5, h6").each((_, el) => {
    $(el).prepend("\n");
    $(el).append("\n");
  });

  return normalizeText($.root().text());
}

function parseLabelBlocks(rawText) {
  const lines = rawText
    .split(/\r?\n/)
    .map(normalizeText)
    .filter(Boolean);

  const fields = {};
  let currentKey = null;
  let currentValues = [];

  function flush() {
    if (!currentKey) return;
    const key = toSnakeCase(currentKey);
    const value = normalizeText(currentValues.join("\n"));
    if (key && value) {
      if (fields[key]) fields[key] += "\n" + value;
      else fields[key] = value;
    }
  }

  for (const line of lines) {
    // Examples:
    //   Work Term:
    //   Job Title: Data & Analytics Technician
    const match = line.match(/^([^:]{2,100}):\s*(.*)$/);

    if (match) {
      flush();
      currentKey = match[1];
      currentValues = match[2] ? [match[2]] : [];
    } else if (currentKey) {
      currentValues.push(line);
    }
  }

  flush();
  return fields;
}

function csvEscape(value) {
  const s = String(value ?? "");
  return `"${s.replaceAll('"', '""')}"`;
}

function writeCsv(records, filePath) {
  const baseColumns = [
    "postingId",
    "tableJobTitle",
    "tableOrganization",
    "tableDivision",
    "tableOpenings",
    "tableCity",
    "tableLevel",
    "tableApps",
    "tableDeadline",
  ];

  const dynamicColumns = Array.from(
    new Set(records.flatMap(record => Object.keys(record.parsedFields ?? {})))
  ).sort();

  const columns = [...baseColumns, ...dynamicColumns, "fullText"];

  const rows = [
    columns.join(","),
    ...records.map(record => {
      const flat = {
        ...record.table,
        ...record.parsedFields,
        fullText: record.fullText,
      };
      return columns.map(col => csvEscape(flat[col])).join(",");
    }),
  ];

  fs.writeFileSync(filePath, rows.join("\n"));
}

async function pause(message) {
  await rl.question(`\n${message}\nPress Enter when ready... `);
}

async function waitForWaterlooWorksIdle(page, timeout = 15000) {
  return await page.waitForFunction(selector => {
    function isVisible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity) !== 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    }

    return !Array.from(document.querySelectorAll(selector)).some(isVisible);
  }, LOADING_OVERLAY_SELECTOR, { timeout }).then(() => true).catch(() => false);
}

async function resetHorizontalScroll(page) {
  await page.evaluate(() => {
    window.scrollTo(0, window.scrollY);
    document.documentElement.scrollLeft = 0;
    document.body.scrollLeft = 0;

    for (const el of document.querySelectorAll("*")) {
      if (el.scrollWidth > el.clientWidth) {
        el.scrollLeft = 0;
      }
    }
  }).catch(() => null);
}

async function clickPostingLink(page, linkLocator, fallbackLinkLocator, postingId) {
  const target = (await linkLocator.count().catch(() => 0)) > 0 ? linkLocator : fallbackLinkLocator;

  function waitForPostingResponse() {
    return page.waitForResponse(response => {
      const request = response.request();
      const postData = request.postData() || "";
      return (
        request.method() === "POST" &&
        response.status() >= 200 &&
        response.status() < 400 &&
        postData.includes(`postingId=${postingId}`)
      );
    }, { timeout: 12000 }).catch(() => null);
  }

  await resetHorizontalScroll(page);
  await target.waitFor({ state: "visible", timeout: 15000 });
  await target.scrollIntoViewIfNeeded().catch(() => null);
  await resetHorizontalScroll(page);

  const idle = await waitForWaterlooWorksIdle(page, 15000);
  if (!idle) {
    console.log(`Posting ${postingId}: WaterlooWorks loading overlay appears stuck; using DOM click fallback.`);
    const responsePromise = waitForPostingResponse();
    await target.evaluate(el => el.click());
    return await responsePromise;
  }

  const responsePromise = waitForPostingResponse();
  try {
    await target.click({ timeout: 15000 });
    return await responsePromise;
  } catch (err) {
    const message = err?.message || "";
    const loadingOverlayBlockedClick = message.includes("loading--stuff") || message.includes("intercepts pointer events");
    if (!loadingOverlayBlockedClick) throw err;

    console.log(`Posting ${postingId}: WaterlooWorks overlay intercepted the click; using DOM click fallback.`);
    const fallbackResponsePromise = waitForPostingResponse();
    await target.evaluate(el => el.click());
    return await fallbackResponsePromise;
  }
}

async function getVisiblePostingRows(page) {
  await waitForWaterlooWorksIdle(page).catch(() => null);
  await resetHorizontalScroll(page);

  return await page.locator(ROW_SELECTOR).evaluateAll((rows, cellSelector) => {
    function clean(s) {
      return String(s ?? "").replace(/\s+/g, " ").trim();
    }

    return rows
      .map((row, rowIndex) => {
        const cells = Array.from(row.querySelectorAll(cellSelector))
          .map(cell => clean(cell.innerText))
          .filter(Boolean);

        const rawText = clean(row.innerText);
        const idMatch = rawText.match(/\b\d{6}\b/);
        const link = Array.from(row.querySelectorAll("a[href]")).find(a => clean(a.innerText).length > 0);
        const title = link ? clean(link.innerText) : "";

        if (!idMatch || !title) return null;

        const postingId = idMatch[0];
        const idIndex = cells.findIndex(c => c.includes(postingId));
        const afterId = idIndex >= 0 ? cells.slice(idIndex + 1) : cells;

        return {
          rowIndex,
          postingId,
          title,
          cells,
          table: {
            postingId,
            tableJobTitle: title || afterId[0] || "",
            tableOrganization: afterId[1] || "",
            tableDivision: afterId[2] || "",
            tableOpenings: afterId[3] || "",
            tableCity: afterId[4] || "",
            tableLevel: afterId[5] || "",
            tableApps: afterId[6] || "",
            tableDeadline: afterId[7] || "",
          },
        };
      })
      .filter(Boolean);
  }, CELL_SELECTOR);
}

async function getModalTextFallback(page) {
  await page.getByText(JOB_INFO_MARKER, { exact: false }).first().waitFor({ timeout: 10000 });

  const candidateSelectors = [
    "[role='dialog']",
    ".modal-content",
    ".modal-dialog",
    ".cdk-overlay-pane",
    ".mat-dialog-container",
    ".mat-mdc-dialog-container",
  ];

  for (const selector of candidateSelectors) {
    const loc = page.locator(selector).filter({ hasText: JOB_INFO_MARKER }).last();
    if ((await loc.count().catch(() => 0)) > 0) {
      const text = await loc.innerText().catch(() => "");
      if (text.includes(JOB_INFO_MARKER)) return normalizeText(text);
    }
  }

  // Last-resort DOM walk from the marker to a large parent container.
  return await page.evaluate(markerText => {
    function clean(s) {
      return String(s ?? "")
        .replace(/\u00a0/g, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    const all = Array.from(document.querySelectorAll("body *"));
    const marker = all.find(el => clean(el.textContent) === markerText || clean(el.textContent).startsWith(markerText));
    if (!marker) return clean(document.body.innerText);

    let best = marker;
    let node = marker.parentElement;

    while (node && node !== document.body) {
      const text = clean(node.innerText);
      const rect = node.getBoundingClientRect();
      if (text.includes(markerText) && text.length > clean(best.innerText).length && rect.width > 300 && rect.height > 200) {
        best = node;
      }
      node = node.parentElement;
    }

    return clean(best.innerText || document.body.innerText);
  }, JOB_INFO_MARKER);
}

async function closeJobModal(page) {
  const closeLocators = [
    page.getByRole("button", { name: /^close$/i }),
    page.getByRole("button", { name: /close/i }),
    page.locator("button[aria-label*='close' i]"),
    page.locator("[role='button'][aria-label*='close' i]"),
    page.locator("button:has-text('×')"),
    page.locator("button:has-text('X')"),
  ];

  for (const loc of closeLocators) {
    if ((await loc.count().catch(() => 0)) > 0) {
      await loc.last().click().catch(() => null);
      await sleep(300);
      await waitForWaterlooWorksIdle(page).catch(() => null);
      await resetHorizontalScroll(page);
      return;
    }
  }

  await page.keyboard.press("Escape").catch(() => null);
  await sleep(300);
  await waitForWaterlooWorksIdle(page).catch(() => null);
  await resetHorizontalScroll(page);
}

async function scrapeOnePosting(page, row) {
  const { postingId, title } = row;

  const rowLocator = page.locator(ROW_SELECTOR).filter({ hasText: postingId }).first();
  const linkLocator = rowLocator.getByRole("link", { name: title, exact: true }).first();
  const fallbackLinkLocator = rowLocator.locator("a[href]").first();

  const response = await clickPostingLink(page, linkLocator, fallbackLinkLocator, postingId);

  let fullText = "";
  let source = "modal";

  if (response) {
    const html = await response.text();
    const text = htmlToText(html);
    if (text.includes(JOB_INFO_MARKER)) {
      fullText = text;
      source = "network-html";
    }
  }

  if (!fullText) {
    fullText = await getModalTextFallback(page);
  }

  await closeJobModal(page);

  return {
    table: row.table,
    parsedFields: parseLabelBlocks(fullText),
    fullText,
    source,
  };
}

async function goToNextPage(page) {
  // WaterlooWorks table pagination has markup like:
  //   .pagination .pagination__link[aria-label='Go to next page']
  // Avoid broad "Next Page" selectors because hidden PDF controls also use that label.

  await page.keyboard.press("Escape").catch(() => null);
  await sleep(300);
  await waitForWaterlooWorksIdle(page).catch(() => null);
  await resetHorizontalScroll(page);

  const beforeIds = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("tr, [role='row']"))
      .map(row => row.innerText.match(/[0-9]{6}/)?.[0])
      .filter(Boolean)
      .join("|");
  }).catch(() => "");

  const clicked = await page.evaluate(() => {
    const paginations = Array.from(document.querySelectorAll(".pagination"));

    function isVisible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity) !== 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    }

    function isDisabled(el) {
      return Boolean(
        el.classList.contains("disabled") ||
        el.getAttribute("aria-disabled") === "true" ||
        el.closest(".disabled") ||
        el.closest("[aria-disabled='true']")
      );
    }

    const visiblePaginations = paginations.filter(isVisible);
    if (visiblePaginations.length === 0) return null;

    // Prefer the pagination closest to the bottom of the viewport/page.
    visiblePaginations.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    const pagination = visiblePaginations[0];

    // First try the explicit right-arrow next-page link.
    let next = pagination.querySelector("a.pagination__link[aria-label='Go to next page']");

    if (!next || !isVisible(next) || isDisabled(next)) {
      // Fallback: click the page number immediately after the active page.
      const links = Array.from(pagination.querySelectorAll("a.pagination__link"));
      const activeIndex = links.findIndex(link => link.classList.contains("active"));
      if (activeIndex >= 0) {
        next = links.slice(activeIndex + 1).find(link => {
          const text = (link.innerText || link.textContent || "").trim();
          return /^[0-9]+$/.test(text) && isVisible(link) && !isDisabled(link);
        });
      }
    }

    if (!next || !isVisible(next) || isDisabled(next)) return null;

    next.scrollIntoView({ block: "center", inline: "center" });
    next.click();

    return {
      text: (next.innerText || next.textContent || "").trim(),
      ariaLabel: next.getAttribute("aria-label"),
      className: String(next.className || ""),
    };
  });

  if (!clicked) {
    console.log("No visible enabled WaterlooWorks table Next button found. Assuming this is the last page.");
    return false;
  }

  console.log("Clicked WaterlooWorks pagination control:", clicked);
  await sleep(DELAY_BETWEEN_PAGES_MS);
  await waitForWaterlooWorksIdle(page, 30000).catch(() => null);
  await resetHorizontalScroll(page);

  const changed = await page.waitForFunction(oldIds => {
    const newIds = Array.from(document.querySelectorAll("tr, [role='row']"))
      .map(row => row.innerText.match(/[0-9]{6}/)?.[0])
      .filter(Boolean)
      .join("|");
    return newIds && newIds !== oldIds;
  }, beforeIds, { timeout: 7000 }).then(() => true).catch(() => false);

  if (!changed) {
    console.log("Clicked pagination, but the visible table did not change. Treating this as the last page.");
    return false;
  }

  return true;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: false,
    args: ["--start-maximized"],
  });

  const context = await browser.newContext({
    storageState: fs.existsSync(STORAGE_STATE) ? STORAGE_STATE : undefined,
    viewport: null,
  });

  const page = await context.newPage();
  await page.goto(START_URL, { waitUntil: "domcontentloaded" });

  await pause(
    "Log in if needed, apply any WaterlooWorks filters you want, and navigate to the job postings table.\n" +
    "The script will export all postings visible under the current filters, across pages."
  );

  await context.storageState({ path: STORAGE_STATE });

  const records = [];
  const seen = new Set();
  let pageNumber = 1;

  while (true) {
    console.log(`\n=== Table page ${pageNumber} ===`);

    const rows = await getVisiblePostingRows(page);
    const uniqueRows = rows.filter(row => !seen.has(row.postingId));

    console.log(`Found ${rows.length} visible posting rows; ${uniqueRows.length} new.`);

    for (let i = 0; i < uniqueRows.length; i++) {
      const row = uniqueRows[i];
      console.log(`[${records.length + 1}] ${row.postingId} — ${row.title}`);

      try {
        const record = await scrapeOnePosting(page, row);
        records.push(record);
        seen.add(row.postingId);

        fs.writeFileSync(OUT_JSON, JSON.stringify(records, null, 2));
        writeCsv(records, OUT_CSV);
      } catch (err) {
        console.error(`Failed on posting ${row.postingId} (${row.title}):`, err.message);
        await closeJobModal(page).catch(() => null);
      }

      await sleep(DELAY_BETWEEN_JOBS_MS);
    }

    const moved = await goToNextPage(page);
    if (!moved) break;
    pageNumber++;
  }

  writeCsv(records, OUT_CSV);
  fs.writeFileSync(OUT_JSON, JSON.stringify(records, null, 2));

  console.log(`\nDone.`);
  console.log(`CSV:  ${OUT_CSV}`);
  console.log(`JSON: ${OUT_JSON}`);
  console.log(`Rows exported: ${records.length}`);

  await browser.close();
  rl.close();
}

main().catch(err => {
  console.error(err);
  rl.close();
  process.exit(1);
});
