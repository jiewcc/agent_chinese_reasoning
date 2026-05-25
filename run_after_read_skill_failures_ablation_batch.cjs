const assert = require("assert");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { URL } = require("url");

const API_URL =
  process.env.WQ_API_URL ||
  "http://public-wlf2-ge131-kce-node29.idchb2az2.hb2.kwaidc.com:50150/v1/chat/completions";
const apiKey = process.env.WQ_API_KEY || "dummy";
const REPEAT = Number(process.env.REPEAT || 20);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 120000);

const BASELINE_BODY =
  process.env.BASELINE_BODY ||
  "test_request_bodies/after_read_skill_failures_baseline.json";
const CHINESE_BODY =
  process.env.CHINESE_BODY ||
  "test_request_bodies/after_read_skill_failures_chinese_cognitive_few_shot.json";
const REQUEST_DUMP_DIR =
  process.env.REQUEST_DUMP_DIR ||
  "test_request_bodies/after_read_skill_failures_baseline_cases";
const RESPONSE_DUMP_DIR =
  process.env.RESPONSE_DUMP_DIR || "test_model_responses";
const OUTPUT_PREFIX =
  process.env.OUTPUT_PREFIX || "after_read_skill_failures_ablation";

const CHANGE_DEFINITIONS = {
  1: {
    name: "reasoning_content_system_constraint",
    description:
      "将 system prompt 中的 thinking 约束改成明确约束 reasoning_content 必须为中文。",
  },
  2: {
    name: "user_json_instruction_chinese",
    description: "将 messages[1]、messages[7]、messages[18] 中的 JSON 输出格式说明从英文改成中文。",
  },
  3: {
    name: "reasoning_few_shot_chinese",
    description: "将 skill 读取失败后的三段 assistant reasoning_content 示例从英文改成中文。",
  },
};

const CASES = [
  { name: "baseline", changes: [] },
  { name: "change_1_reasoning_content_system_constraint", changes: [1] },
  { name: "change_2_user_json_instruction_chinese", changes: [2] },
  { name: "change_3_reasoning_few_shot_chinese", changes: [3] },
  { name: "change_1_2", changes: [1, 2] },
  { name: "change_1_3", changes: [1, 3] },
  { name: "change_2_3", changes: [2, 3] },
  { name: "chinese_cognitive_few_shot", changes: [1, 2, 3] },
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function applyChange(body, chineseBody, changeId) {
  if (changeId === 1) {
    body.messages[0].content = chineseBody.messages[0].content;
    return;
  }

  if (changeId === 2) {
    for (const messageIndex of [1, 7, 18]) {
      body.messages[messageIndex].content = chineseBody.messages[messageIndex].content;
    }
    return;
  }

  if (changeId === 3) {
    for (const messageIndex of [8, 11, 14]) {
      body.messages[messageIndex].reasoning_content =
        chineseBody.messages[messageIndex].reasoning_content;
    }
    return;
  }

  throw new Error(`Unknown change id: ${changeId}`);
}

function buildBody(baselineBody, chineseBody, changes) {
  const body = clone(baselineBody);
  for (const changeId of changes) {
    applyChange(body, chineseBody, changeId);
  }
  return body;
}

function bodyPathFor(caseInfo) {
  return path.join(REQUEST_DUMP_DIR, `${caseInfo.name}.json`);
}

function generateRequestBodies() {
  const baselineBody = readJson(BASELINE_BODY);
  const chineseBody = readJson(CHINESE_BODY);

  const generated = CASES.map((caseInfo) => {
    const body = buildBody(baselineBody, chineseBody, caseInfo.changes);
    const requestBodyPath = bodyPathFor(caseInfo);
    writeJson(requestBodyPath, body);
    return {
      ...caseInfo,
      requestBodyPath,
      changeDescriptions: caseInfo.changes.map((id) => CHANGE_DEFINITIONS[id]),
    };
  });

  assert.deepStrictEqual(
    readJson(bodyPathFor(CASES[0])),
    baselineBody,
    "Generated baseline body must match baseline input"
  );
  assert.deepStrictEqual(
    readJson(bodyPathFor(CASES[CASES.length - 1])),
    chineseBody,
    "Generated 1+2+3 body must match chinese_cognitive_few_shot input"
  );

  return generated;
}

const TECHNICAL_LEADING_TERMS = new Set([
  "API",
  "CJK",
  "ID",
  "JSON",
  "RFC8259",
  "ROI",
  "SSE",
]);

function isCjkChar(char) {
  return /[\u4e00-\u9fff]/.test(char);
}

function isAsciiLetter(char) {
  return /[A-Za-z]/.test(char);
}

function shouldSkipLeadingAsciiToken(token) {
  return (
    TECHNICAL_LEADING_TERMS.has(token) ||
    /[_-]/.test(token) ||
    /[a-z][A-Z]/.test(token) ||
    /^[A-Z0-9]{2,}$/.test(token)
  );
}

function firstLanguageChars(text, limit = 2) {
  const chars = [];
  let i = 0;
  while (i < text.length && chars.length < limit) {
    const char = text[i];

    if (char === "`") {
      const end = text.indexOf("`", i + 1);
      i = end === -1 ? i + 1 : end + 1;
      continue;
    }

    if (isCjkChar(char)) {
      chars.push(char);
      i += 1;
      continue;
    }

    if (isAsciiLetter(char)) {
      const match = text.slice(i).match(/^[A-Za-z][A-Za-z0-9_-]*/);
      const token = match ? match[0] : char;
      if (chars.length === 0 && shouldSkipLeadingAsciiToken(token)) {
        i += token.length;
        continue;
      }
      for (const tokenChar of token) {
        if (isAsciiLetter(tokenChar)) chars.push(tokenChar);
        if (chars.length >= limit) break;
      }
      i += token.length;
      continue;
    }

    i += 1;
  }
  return chars;
}

function languageFromChars(chars) {
  const cjk = chars.filter(isCjkChar).length;
  const asciiLetters = chars.filter(isAsciiLetter).length;
  if (chars.length === 0) return "empty";
  if (cjk > asciiLetters) return "chinese";
  if (asciiLetters > cjk) return "english";
  return "mixed";
}

function analyze(text) {
  const leadingLanguageChars = firstLanguageChars(text);
  const language = languageFromChars(leadingLanguageChars);

  return {
    chars: text.length,
    leadingLanguageChars: leadingLanguageChars.join(""),
    language,
    isChinese: language === "chinese",
    isEnglish: language === "english",
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
        timeout: REQUEST_TIMEOUT_MS,
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
  if (choice.finish_reason) acc.finishReason = choice.finish_reason;
}

function parseResponse(response) {
  const acc = { reasoning: "", content: "", finishReason: "" };
  const contentType = String(response.headers["content-type"] || "");
  if (contentType.includes("text/event-stream")) {
    response.raw.split(/\r?\n/).forEach((line) => parseSseLine(line, acc));
  } else {
    const json = JSON.parse(response.raw);
    const choice = (json.choices || [])[0] || {};
    acc.reasoning =
      (choice.message && (choice.message.reasoning_content || choice.message.reasoning)) ||
      (choice.delta && choice.delta.reasoning_content) ||
      "";
    acc.content =
      (choice.message && choice.message.content) ||
      (choice.delta && choice.delta.content) ||
      "";
    acc.finishReason = choice.finish_reason || "";
  }
  return acc;
}

function summarize(rows) {
  const okRows = rows.filter((row) => row.ok && row.reasoningAnalysis);
  if (okRows.length === 0) {
    return { okCount: 0, failedCount: rows.length };
  }

  return {
    okCount: okRows.length,
    failedCount: rows.length - okRows.length,
    chineseCount: okRows.filter((row) => row.reasoningAnalysis.language === "chinese").length,
    englishCount: okRows.filter((row) => row.reasoningAnalysis.language === "english").length,
    mixedCount: okRows.filter((row) => row.reasoningAnalysis.language === "mixed").length,
    emptyCount: okRows.filter((row) => row.reasoningAnalysis.language === "empty").length,
  };
}

async function runOne(caseInfo, iteration) {
  const body = readJson(caseInfo.requestBodyPath);
  const startedAt = Date.now();

  try {
    const response = await requestText(API_URL, body);
    let parsed = { reasoning: "", content: "", finishReason: "" };
    let parseError = "";
    try {
      parsed = parseResponse(response);
    } catch (error) {
      parseError = error && error.message ? error.message : String(error);
    }

    return {
      caseName: caseInfo.name,
      iteration,
      status: response.status,
      ok: response.status >= 200 && response.status < 300 && !parseError,
      durationMs: Date.now() - startedAt,
      finishReason: parsed.finishReason,
      reasoningAnalysis: analyze(parsed.reasoning),
      reasoning_content: parsed.reasoning,
      contentPreview: parsed.content.slice(0, 500),
      parseError: parseError || undefined,
      rawPreview:
        response.status >= 200 && response.status < 300 && !parseError
          ? undefined
          : response.raw.slice(0, 1000),
    };
  } catch (error) {
    return {
      caseName: caseInfo.name,
      iteration,
      ok: false,
      durationMs: Date.now() - startedAt,
      transportError: error && error.message ? error.message : String(error),
    };
  }
}

async function runCase(caseInfo) {
  const results = [];
  console.log(`\n# ${caseInfo.name}`);
  console.log(`request_body=${caseInfo.requestBodyPath}`);
  console.log(`changes=${caseInfo.changes.join("+") || "none"}`);

  for (let i = 1; i <= REPEAT; i += 1) {
    const row = await runOne(caseInfo, i);
    results.push(row);
    if (row.ok) {
      console.log(
        `${caseInfo.name}\t${i}\tlanguage=${row.reasoningAnalysis.language}\tleading=${row.reasoningAnalysis.leadingLanguageChars || ""}\tchars=${row.reasoningAnalysis.chars}\tstatus=${row.status}`
      );
    } else {
      console.log(
        `${caseInfo.name}\t${i}\tFAILED\tstatus=${row.status || ""}\terror=${
          row.transportError || row.parseError || ""
        }`
      );
    }
  }

  const output = {
    apiUrl: API_URL,
    repeat: REPEAT,
    case: caseInfo,
    summary: summarize(results),
    results,
  };
  const caseOutputPath = path.join(RESPONSE_DUMP_DIR, `${OUTPUT_PREFIX}_${caseInfo.name}.json`);
  writeJson(caseOutputPath, output);
  return { ...output, outputPath: caseOutputPath };
}

async function main() {
  const cases = generateRequestBodies();

  if (process.env.DUMP_ONLY === "1") {
    console.log(
      JSON.stringify(
        {
          requestDumpDir: REQUEST_DUMP_DIR,
          cases,
        },
        null,
        2
      )
    );
    return;
  }

  const caseOutputs = [];
  for (const caseInfo of cases) {
    caseOutputs.push(await runCase(caseInfo));
  }

  const combined = {
    apiUrl: API_URL,
    repeat: REPEAT,
    requestDumpDir: REQUEST_DUMP_DIR,
    responseDumpDir: RESPONSE_DUMP_DIR,
    cases,
    summary: Object.fromEntries(
      caseOutputs.map((output) => [output.case.name, output.summary])
    ),
    caseOutputPaths: caseOutputs.map((output) => output.outputPath),
  };
  const combinedOutputPath = path.join(RESPONSE_DUMP_DIR, `${OUTPUT_PREFIX}_summary.json`);
  writeJson(combinedOutputPath, combined);

  console.log("\n# summary");
  console.log(JSON.stringify(combined.summary, null, 2));
  console.log(`\nSaved summary: ${combinedOutputPath}`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
