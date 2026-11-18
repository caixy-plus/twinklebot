import test from "node:test";
import assert from "node:assert/strict";

import {
  parseMarkdownBlocks,
  tokenizeInlineMarkdown,
  isSafeMarkdownUrl,
  splitTableRowCells,
} from "../public/dist/markdown-utils.js";
import {
  extractMessageSegments,
  splitIntoMessageChunksWithMarkup,
} from "../public/dist/preview-utils.js";

test("parseMarkdownBlocks parses GFM tables including the visitor IP table from user screenshot", () => {
  const md = [
    "访客明细如下：",
    "",
    "| IP | 地区 | 访问次数 |",
    "| :--- | :---: | ---: |",
    "| 17.166.20.190 | 美国 加州 库比蒂诺 | 1 |",
    "| 195.178.110.159 | 安道尔 Andorra la Vella | 1 |",
    "| 35.196.148.157 | 美国 南卡罗来纳州 查尔斯顿 | 1 |",
    "| 40.77.167.224 | 美国 弗吉尼亚州 Boydton | 1 |",
    "| 43.165.167.69 | 日本 东京都 东京 | 1 |",
  ].join("\n");

  const blocks = parseMarkdownBlocks(md);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, "paragraph");
  assert.equal(blocks[0].text, "访客明细如下：");

  const tbl = blocks[1];
  assert.equal(tbl.type, "table");
  assert.deepEqual(tbl.headers, ["IP", "地区", "访问次数"]);
  assert.deepEqual(tbl.alignments, ["left", "center", "right"]);
  assert.equal(tbl.rows.length, 5);
  assert.deepEqual(tbl.rows[0], ["17.166.20.190", "美国 加州 库比蒂诺", "1"]);
  assert.deepEqual(tbl.rows[4], ["43.165.167.69", "日本 东京都 东京", "1"]);
  assert.ok(tbl.tsv.includes("17.166.20.190\t美国 加州 库比蒂诺\t1"));
});

test("splitTableRowCells respects escaped pipes and pipes inside inline code", () => {
  const row = "| `a | b` | 转义 \\| 竖线 | **正常** |";
  const cells = splitTableRowCells(row);
  assert.deepEqual(cells, ["`a | b`", "转义 | 竖线", "**正常**"]);
});

test("extractMessageSegments supports 4-backtick outer fences containing 3-backtick inner blocks and tilde fences", () => {
  const raw = [
    "下面是 Markdown 示例：",
    "````markdown",
    "# 标题",
    "```bash",
    "echo hello",
    "```",
    "````",
    "~~~python",
    "print('ok')",
    "~~~",
  ].join("\n");

  const segs = extractMessageSegments(raw);
  const fences = segs.filter((s: any) => s.type === "fence");
  assert.equal(fences.length, 2);
  assert.equal(fences[0].lang, "markdown");
  assert.ok(fences[0].code.includes("```bash\necho hello\n```"));
  assert.equal(fences[1].lang, "python");
  assert.equal(fences[1].code, "print('ok')");
});

test("splitIntoMessageChunksWithMarkup merges short intro or heading with following GFM table", () => {
  const raw = [
    "第一段独立总结。",
    "",
    "访客明细如下：",
    "",
    "| IP | 地区 | 访问次数 |",
    "| --- | --- | --- |",
    "| 17.166.20.190 | 美国 | 1 |",
  ].join("\n");

  const chunks = splitIntoMessageChunksWithMarkup(raw);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], "第一段独立总结。");
  assert.ok(chunks[1].startsWith("访客明细如下："));
  assert.ok(chunks[1].includes("| IP | 地区 | 访问次数 |"));
});

test("tokenizeInlineMarkdown handles bold, italic, strikethrough, code, links, snake_case protection, and blocks javascript: URLs", () => {
  const line =
    "请调用 `schedule_manage` 工具（或 `bot_manage`），查看 **加粗 *斜体* 文本**、~~废弃项~~、[官方文档](https://example.com/docs) 与 https://api.ipify.org。恶意链接 [点我](javascript:alert(1)) 不应成为 a 标签。";
  const tokens = tokenizeInlineMarkdown(line);

  // snake_case outside backticks must also remain plain text
  const snakeTokens = tokenizeInlineMarkdown("使用 schedule_manage_tool 和 caddy_access_log 变量");
  assert.equal(snakeTokens.some((t: any) => t.type === "em"), false);

  const codeTokens = tokens.filter((t: any) => t.type === "code");
  assert.deepEqual(
    codeTokens.map((t: any) => t.text),
    ["schedule_manage", "bot_manage"]
  );

  const strongTok = tokens.find((t: any) => t.type === "strong");
  assert.ok(strongTok);
  assert.ok(strongTok.children.some((c: any) => c.type === "em" && c.text === "斜体"));

  const delTok = tokens.find((t: any) => t.type === "del");
  assert.ok(delTok);
  assert.equal(delTok.text, "废弃项");

  const linkTokens = tokens.filter((t: any) => t.type === "link");
  assert.equal(linkTokens.length, 2);
  assert.equal(linkTokens[0].href, "https://example.com/docs");
  assert.equal(linkTokens[1].href, "https://api.ipify.org");

  assert.equal(isSafeMarkdownUrl("javascript:alert(1)"), false);
  assert.equal(isSafeMarkdownUrl("data:text/html,<script>alert(1)</script>"), false);
  assert.equal(isSafeMarkdownUrl("https://example.com"), true);
});

test("parseMarkdownBlocks supports headings h1-h6, task lists, ordered list start numbers, and nested lists", () => {
  const md = [
    "### 第三级标题",
    "##### 第五级标题",
    "- [x] 已完成步骤",
    "- [ ] 待办步骤",
    "  - 子任务 A",
    "  - 子任务 B",
    "3. 第三项起步",
    "4. 第四项",
  ].join("\n");

  const blocks = parseMarkdownBlocks(md);
  assert.equal(blocks[0].type, "heading");
  assert.equal(blocks[0].level, 3);
  assert.equal(blocks[1].type, "heading");
  assert.equal(blocks[1].level, 5);

  const taskList: any = blocks[2];
  assert.equal(taskList.type, "list");
  assert.equal(taskList.ordered, false);
  assert.equal(taskList.items.length, 2);
  assert.equal(taskList.items[0].task, true);
  assert.equal(taskList.items[0].checked, true);
  assert.equal(taskList.items[1].task, true);
  assert.equal(taskList.items[1].checked, false);
  assert.equal(taskList.items[1].children.length, 2);
  assert.equal(taskList.items[1].children[0].text, "子任务 A");

  const ol = blocks[3];
  assert.equal(ol.type, "list");
  assert.equal(ol.ordered, true);
  assert.equal(ol.start, 3);
  assert.equal(ol.items.length, 2);
});

test("parseMarkdownBlocks and tokenizeInlineMarkdown support file:// document links and attachment_file blocks", () => {
  const blocks = parseMarkdownBlocks(
    "[B站汇总.docx](file:///Users/demo/Downloads/B%E7%AB%99%E6%B1%87%E6%80%BB.docx)\n[文件附件: report.pdf · 路径: /tmp/report.pdf]"
  );
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], {
    type: "attachment_file",
    name: "B站汇总.docx",
    path: "/Users/demo/Downloads/B站汇总.docx",
  });
  assert.deepEqual(blocks[1], {
    type: "attachment_file",
    name: "report.pdf",
    path: "/tmp/report.pdf",
  });

  const inlineTokens = tokenizeInlineMarkdown("请打开 [总结.docx](file:///tmp/%E6%80%BB%E7%BB%93.docx) 查看");
  const fileTok = inlineTokens.find((t: any) => t.type === "file_link");
  assert.ok(fileTok);
  assert.equal(fileTok.text, "总结.docx");
  assert.equal(fileTok.path, "/tmp/总结.docx");
  assert.equal(isSafeMarkdownUrl("file:///etc/passwd"), false);
  assert.equal(
    isSafeMarkdownUrl("https://cloud.example.com/api/workspace/file?path=a.png"),
    true
  );
});
