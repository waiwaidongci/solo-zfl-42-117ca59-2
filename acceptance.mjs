// 漆线雕工坊 · 订单与材料库存工作台 可重复验收脚本
// 用法：npm run acceptance
// 覆盖流程：新建订单 → 超期提示 → 发料 → 退料 → 库存不足拦截 → 筛选 → 刷新保留 → 导出 → 恢复
import http from "node:http";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { chromium } from "playwright";

// 无 root 环境下为 Chromium 提供本地解压的系统库（见 README「验收环境」）
const root = path.resolve(import.meta.dirname);
const localLibs = [path.join(root, ".chromium-libs/lib/aarch64-linux-gnu"), path.join(root, ".chromium-libs/usr/lib/aarch64-linux-gnu")]
  .filter(existsSync);
if (localLibs.length) {
  process.env.LD_LIBRARY_PATH = [...localLibs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
}
const results = [];
function check(name, ok, extra = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  —— " + extra : ""}`);
}

const server = http.createServer(async (req, res) => {
  try {
    const file = req.url === "/" ? "index.html" : decodeURIComponent(req.url.slice(1));
    const body = await readFile(path.join(root, file));
    res.writeHead(200, { "content-type": file.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const baseURL = `http://127.0.0.1:${server.address().port}`;

const offsetDay = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const browser = await chromium.launch();
const page = await browser.newPage();
page.setDefaultTimeout(10000);
page.on("dialog", d => d.accept()); // 自动确认 confirm（删除、恢复）

const materialRow = name => page.locator("#materialsTable tbody tr", { hasText: name }).first();
const stockOf = async name => Number(await materialRow(name).locator(".stock-num").innerText());
const orderRow = kw => page.locator("#ordersTable tbody tr[data-order-id]", { hasText: kw }).first();
const txnCount = () => page.locator("#txnTable tbody tr[data-txn-id]").count();

try {
  // 0. 干净初始状态（种子数据）
  await page.goto(baseURL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector("#ordersTable tbody tr[data-order-id]");
  check("初始加载：种子订单、材料就绪", (await page.locator("#materialsTable tbody tr[data-material-id]").count()) >= 5);

  // 1. 新建订单（关联客户、作品、交期、优先级）
  await page.fill('#orderForm input[name="customer"]', "验收客户甲");
  await page.selectOption('#orderForm select[name="workId"]', { index: 0 });
  await page.fill('#orderForm input[name="due"]', offsetDay(7));
  await page.selectOption('#orderForm select[name="priority"]', "高");
  await page.fill('#orderForm input[name="note"]', "验收单");
  await page.click('#orderForm button[type="submit"]');
  const newRow = orderRow("验收客户甲");
  await newRow.waitFor();
  check("新建订单：客户/作品/交期/优先级落表",
    (await newRow.innerText()).includes("高") && (await newRow.innerText()).includes(offsetDay(7)));

  // 2. 超期订单提示
  await page.fill('#orderForm input[name="customer"]', "验收客户乙");
  await page.selectOption('#orderForm select[name="workId"]', { index: 1 });
  await page.fill('#orderForm input[name="due"]', offsetDay(-1));
  await page.selectOption('#orderForm select[name="priority"]', "低");
  await page.click('#orderForm button[type="submit"]');
  await orderRow("验收客户乙").waitFor();
  const banner = page.locator("#overdueBanner");
  const bannerText = await banner.innerText();
  check("超期提示：横幅出现且点名超期订单",
    (await banner.getAttribute("class")).includes("show") && bannerText.includes("超期订单") && bannerText.includes("验收客户乙") && bannerText.includes("鹭岛茶室"));
  check("超期提示：订单行带超期标记", (await orderRow("验收客户乙").getAttribute("class")).includes("overdue"));

  // 3. 发料（关联订单，记录余量变化）
  const before = await stockOf("金粉"); // 种子 250
  await materialRow("金粉").locator(".qtyInput").fill("50");
  const orderVal = await materialRow("金粉").locator(".orderSelect").evaluate(
    (sel, kw) => [...sel.options].find(o => o.text.includes(kw))?.value || "", "验收客户甲");
  await materialRow("金粉").locator(".orderSelect").selectOption(orderVal);
  await materialRow("金粉").locator(".issueBtn").click();
  const afterIssue = await stockOf("金粉");
  const issueTxn = page.locator("#txnTable tbody tr").first();
  check("发料：余量 250 → 200", before === 250 && afterIssue === 200, `实际 ${before} → ${afterIssue}`);
  check("发料：流水记录余量变化与关联订单",
    (await issueTxn.innerText()).includes("发料") && (await issueTxn.innerText()).includes("250 → 200") && (await issueTxn.innerText()).includes("验收客户甲"));

  // 4. 退料（记录余量变化）
  await materialRow("金粉").locator(".qtyInput").fill("20");
  await materialRow("金粉").locator(".returnBtn").click();
  const afterReturn = await stockOf("金粉");
  check("退料：余量 200 → 220", afterReturn === 220, `实际 ${afterReturn}`);
  check("退料：流水记录余量变化", (await page.locator("#txnTable tbody tr").first().innerText()).includes("200 → 220"));

  // 5. 库存不足不能发料
  const txnBefore = await txnCount();
  await materialRow("金粉").locator(".qtyInput").fill("9999");
  await materialRow("金粉").locator(".issueBtn").click();
  check("库存不足：提示且余量不变",
    (await page.locator("#stockError").innerText()).includes("库存不足") && (await stockOf("金粉")) === 220);
  check("库存不足：不产生流水", (await txnCount()) === txnBefore);

  // 6. 筛选（订单优先级 + 仅超期 + 材料类别）
  await page.selectOption("#orderPriorityFilter", "高");
  check("筛选：订单按优先级", (await page.locator("#ordersTable tbody tr[data-order-id]").count()) === 2); // 鹭岛茶室 + 验收客户甲
  await page.selectOption("#orderPriorityFilter", "");
  await page.check("#orderOverdueOnly");
  check("筛选：仅看超期", (await page.locator("#ordersTable tbody tr[data-order-id]").count()) === 2); // 鹭岛茶室 + 验收客户乙
  await page.uncheck("#orderOverdueOnly");
  await page.selectOption("#materialCategoryFilter", "漆线");
  check("筛选：材料按类别", (await page.locator("#materialsTable tbody tr[data-material-id]").count()) === 2);
  await page.click("#clearMaterialFilters");

  // 7. 刷新后数据保留
  await page.reload();
  check("刷新保留：库存与订单不丢",
    (await stockOf("金粉")) === 220 && (await orderRow("验收客户甲").count()) === 1 && (await txnCount()) === txnBefore);

  // 8. 导出 JSON
  const backupPath = path.join(tmpdir(), "zfl42-acceptance-backup.json");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#exportBtn")]);
  await download.saveAs(backupPath);
  const backup = JSON.parse(await readFile(backupPath, "utf8"));
  check("导出：备份包含作品/订单/材料/流水",
    Array.isArray(backup.works) && Array.isArray(backup.orders) && Array.isArray(backup.materials) && Array.isArray(backup.transactions)
    && backup.materials.find(m => m.name === "金粉")?.stock === 220);

  // 9. 破坏现场后恢复
  await orderRow("验收客户甲").locator("button.danger").click(); // 删除订单（confirm 自动确认）
  await materialRow("金粉").locator(".qtyInput").fill("100");
  await materialRow("金粉").locator(".issueBtn").click(); // 金粉 220 → 120
  check("恢复前破坏：订单删除且余量变化", (await orderRow("验收客户甲").count()) === 0 && (await stockOf("金粉")) === 120);
  await page.setInputFiles("#importInput", backupPath);
  await page.waitForFunction(() => document.querySelector("#dataMsg").textContent.includes("已恢复"));
  check("恢复：订单找回、余量回到导出时",
    (await orderRow("验收客户甲").count()) === 1 && (await stockOf("金粉")) === 220);
  await page.reload();
  check("恢复后刷新：数据依然保留", (await orderRow("验收客户甲").count()) === 1 && (await stockOf("金粉")) === 220);

  // 10. 删除拦截：有流水的材料不能删除（保证任何导出都可恢复）
  await materialRow("金粉").locator("button.danger").click();
  await page.waitForFunction(() => document.querySelector("#stockError").textContent.includes("无法删除"));
  check("删除拦截：有流水的材料不能删除", (await materialRow("金粉").count()) === 1);

  // 11. 恢复校验：关联失效 / 坏 JSON / 不可识别文件 → 整份拒绝且现有数据不动
  const storageSnapshot = () => page.evaluate(
    ks => JSON.stringify(ks.map(k => localStorage.getItem(k))),
    ["zfl42Works", "zfl42Orders", "zfl42Materials", "zfl42Txns"]);
  const beforeBad = await storageSnapshot();
  const rejectImport = async (content, marker) => {
    await page.setInputFiles("#importInput", { name: "case.json", mimeType: "application/json", buffer: Buffer.from(content) });
    await page.waitForFunction(m => document.querySelector("#dataMsg").textContent.includes(m), marker);
  };
  const msgHasError = () => page.locator("#dataMsg").getAttribute("class").then(c => c.includes("error"));

  const brokenWork = JSON.parse(JSON.stringify(backup));
  brokenWork.orders[0].workId = "missing-work-id";
  await rejectImport(JSON.stringify(brokenWork), "不存在的作品");
  check("恢复校验：订单引用失效作品被拒绝", await msgHasError());

  const brokenMaterial = JSON.parse(JSON.stringify(backup));
  brokenMaterial.transactions[0].materialId = "missing-material-id";
  await rejectImport(JSON.stringify(brokenMaterial), "不存在的材料");
  check("恢复校验：流水引用失效材料被拒绝", await msgHasError());

  await rejectImport("这不是 JSON {{{", "不是有效的 JSON");
  check("恢复校验：坏 JSON 被拒绝", await msgHasError());

  await rejectImport(JSON.stringify({ hello: "world" }), "没有可识别的数据");
  check("恢复校验：不可识别文件被拒绝", await msgHasError());

  check("恢复校验：拒绝后现有数据未改动", (await storageSnapshot()) === beforeBad);

  // 12. 正常恢复仍然可用
  await page.setInputFiles("#importInput", backupPath);
  await page.waitForFunction(() => document.querySelector("#dataMsg").textContent.includes("已恢复"));
  check("恢复校验：正常备份仍可恢复", (await orderRow("验收客户甲").count()) === 1 && (await stockOf("金粉")) === 220);
} catch (err) {
  check("执行中断", false, err.message);
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter(r => !r.ok);
console.log(`\n验收结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log("未通过项：" + failed.map(f => f.name).join("；"));
  process.exit(1);
}
console.log("全部通过 ✔");
