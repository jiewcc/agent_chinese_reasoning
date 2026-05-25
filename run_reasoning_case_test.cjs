const fs = require("fs");
const http = require("http");
const https = require("https");
const { URL } = require("url");

const API_URL =
  process.env.WQ_API_URL ||
  "http://wanqing.internal/api/gateway/v1/endpoints/chat/completions";
const MODEL = process.env.WQ_MODEL || "ep-fyrgbs-1775030342152426027";
const BODY_PATH = process.env.REQUEST_BODY || "request_body.json";
const SCENARIO = process.env.CASE_SCENARIO || "full";
const REQUEST_DUMP_DIR = process.env.REQUEST_DUMP_DIR || "test_request_bodies";
const RESPONSE_DUMP_DIR = process.env.RESPONSE_DUMP_DIR || "test_model_responses";

const apiKey = process.env.WQ_API_KEY;
if (!apiKey && process.env.DUMP_ONLY !== "1") {
  console.error("Missing WQ_API_KEY. Please export it before running this script.");
  process.exit(2);
}

const base = JSON.parse(fs.readFileSync(BODY_PATH, "utf8"));

const chineseCognitiveFewShot = `

# 中文认知框架
你是一个用中文思考的助手。在分析任何问题时，先用中文建立思维框架，再执行具体步骤。

对于数据查询任务，中文思维框架包含三个判断：业务对象、时间范围、查询路径。完成这三个判断后，再执行工具调用。

## 思考内容规则
- 思考内容只写中文业务概念，不写工具名、函数名、参数名、字段名、枚举名、英文错误原文。
- 常见英文缩写在思考内容中改写为中文：投入产出比、人气成本、花费、观看数、成交金额。
- 工具调用失败时，只用中文说明「工具参数名需要修正」或「需要按技能说明重新选择路径」，不要复述英文报错。
- 思考内容最多两句，结尾必须包含「数据已准备就绪，正在渲染正文...」。

## 中文思考示例
用户：查直播标准推广最近一周的直播间人气成本数据
思考内容：用户要查标准推广直播的人气成本，时间为最近一周，已选定直播概览查询路径。数据已准备就绪，正在渲染正文...

用户：查最近一周全站直播推广投入产出比和人气成本数据
思考内容：用户要查全站直播推广的投入产出比和人气成本，时间为最近一周，已选定直播概览查询路径。数据已准备就绪，正在渲染正文...

用户：工具返回参数名缺失错误
思考内容：上一次工具调用参数名不匹配，需要修正参数名后继续同一条查询路径。数据已准备就绪，正在渲染正文...
`;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function applyScenario(body) {
  if (SCENARIO === "second_query_start") {
    body.messages = body.messages.slice(0, 8);
  } else if (SCENARIO === "after_read_skill_failures") {
    body.messages = body.messages.slice(0, 19);
  } else if (SCENARIO === "after_skill_success") {
    body.messages = body.messages.slice(0, 26);
  }
}

function baseRequest() {
  const body = clone(base);
  body.model = MODEL;
  body.stream = true;
  applyScenario(body);
  return body;
}

function withChineseCognitiveFewShot() {
  const body = baseRequest();
  body.messages[0].content += chineseCognitiveFewShot;
  return body;
}

const variants = [
  ["baseline", baseRequest],
  ["chinese_cognitive_few_shot", withChineseCognitiveFewShot],
];

function dumpJson(dir, name, payload) {
  fs.mkdirSync(dir, { recursive: true });
  const path = `${dir}/${SCENARIO}_${name}.json`;
  fs.writeFileSync(path, JSON.stringify(payload, null, 2));
  return path;
}

function analyze(text) {
  const asciiLetters = (text.match(/[A-Za-z]/g) || []).length;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const englishWords = text.match(/[A-Za-z][A-Za-z_-]{2,}/g) || [];
  const englishSentences = text
    .split(/[\n。！？]/)
    .map((line) => line.trim())
    .filter((line) => /[A-Za-z]{3,}/.test(line) && /[a-z][\s,.;:)]/.test(line)).length;
  const ratio = asciiLetters / Math.max(1, asciiLetters + cjk);

  return {
    chars: text.length,
    cjk,
    asciiLetters,
    englishRatio: Number(ratio.toFixed(4)),
    englishSentenceCount: englishSentences,
    englishWordsSample: Array.from(new Set(englishWords)).slice(0, 30),
    mixed: ratio > 0.05 || englishSentences > 0,
  };
}

function requestText(urlString, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const data = JSON.stringify(body);
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
        timeout: Number(process.env.REQUEST_TIMEOUT_MS || 120000),
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            raw,
          });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error("request timeout"));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function parseSseLine(line, acc) {
  if (!line.startsWith("data:")) return;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return;
  const json = JSON.parse(payload);
  const choice = (json.choices || [])[0] || {};
  const delta = choice.delta || {};
  const message = choice.message || {};
  acc.reasoning +=
    delta.reasoning_content ||
    delta.reasoning ||
    message.reasoning_content ||
    message.reasoning ||
    "";
  acc.content += delta.content || message.content || "";
  if (delta.tool_calls || message.tool_calls) {
    acc.toolCalls.push.apply(acc.toolCalls, delta.tool_calls || message.tool_calls);
  }
  if (choice.finish_reason) acc.finishReason = choice.finish_reason;
}

function parseNonStream(raw, acc) {
  const json = JSON.parse(raw);
  const choice = (json.choices || [])[0] || {};
  acc.reasoning =
    (choice.message && (choice.message.reasoning_content || choice.message.reasoning)) ||
    (choice.delta && choice.delta.reasoning_content) ||
    "";
  acc.content = (choice.message && choice.message.content) || (choice.delta && choice.delta.content) || "";
  acc.toolCalls = (choice.message && choice.message.tool_calls) || (choice.delta && choice.delta.tool_calls) || [];
  acc.finishReason = choice.finish_reason || "";
}

async function callVariant(name, makeBody) {
  const body = makeBody();
  const requestBodyPath = dumpJson(REQUEST_DUMP_DIR, name, body);
  const startedAt = Date.now();
  const response = await requestText(API_URL, body);
  const acc = { reasoning: "", content: "", finishReason: "", toolCalls: [] };
  let parseError = "";

  try {
    const contentType = String(response.headers["content-type"] || "");
    if (contentType.includes("text/event-stream")) {
      response.raw.split(/\r?\n/).forEach((line) => parseSseLine(line, acc));
    } else {
      parseNonStream(response.raw, acc);
    }
  } catch (error) {
    parseError = error && error.message ? error.message : String(error);
  }

  const responseDump = {
    name,
    scenario: SCENARIO,
    requestBodyPath,
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    durationMs: Date.now() - startedAt,
    finishReason: acc.finishReason,
    reasoningAnalysis: analyze(acc.reasoning),
    reasoningPreview: acc.reasoning.slice(0, 1200),
    contentPreview: acc.content.slice(0, 800),
    toolCallsPreview: acc.toolCalls.slice(0, 10),
    parseError: parseError || undefined,
    rawPreview: response.status >= 200 && response.status < 300 && !parseError ? undefined : response.raw.slice(0, 1200),
    reasoning: acc.reasoning,
    content: acc.content,
    toolCalls: acc.toolCalls,
    rawResponse: response.status >= 200 && response.status < 300 && !parseError ? undefined : response.raw,
  };
  const responsePath = dumpJson(RESPONSE_DUMP_DIR, name, responseDump);

  return Object.assign({}, responseDump, {
    responsePath,
    reasoning: undefined,
    content: undefined,
    toolCalls: undefined,
    rawResponse: undefined,
  });
}

async function main() {
  const results = [];
  for (const pair of variants) {
    const name = pair[0];
    const makeBody = pair[1];
    console.error(`Running ${name}...`);
    if (process.env.DUMP_ONLY === "1") {
      const body = makeBody();
      results.push({
        name,
        scenario: SCENARIO,
        requestBodyPath: dumpJson(REQUEST_DUMP_DIR, name, body),
      });
      continue;
    }
    try {
      results.push(await callVariant(name, makeBody));
    } catch (error) {
      results.push({
        name,
        ok: false,
        transportError: error && error.message ? error.message : String(error),
      });
    }
  }

  fs.writeFileSync("reasoning_case_results.json", JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
