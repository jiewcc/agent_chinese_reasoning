const fs = require("fs");
const http = require("http");
const https = require("https");
const { URL } = require("url");

const API_URL =
  process.env.WQ_API_URL ||
  "http://public-wlf2-ge131-kce-node29.idchb2az2.hb2.kwaidc.com:50150/v1/chat/completions";
const apiKey = process.env.WQ_API_KEY || "dummy";
const REPEAT = Number(process.env.REPEAT || 20);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 120000);
const OUTPUT_PATH = process.env.OUTPUT_PATH || "reasoning_ratio_batch_results.json";

const CASES = [
  {
    name: "baseline",
    path:
      process.env.BASELINE_BODY ||
      "test_request_bodies/after_read_skill_failures_baseline.json",
  },
  {
    name: "chinese_cognitive_few_shot",
    path:
      process.env.CHINESE_BODY ||
      "test_request_bodies/after_read_skill_failures_chinese_cognitive_few_shot.json",
  },
  {
    name: "chinese_cognitive_few_shot_first_turn",
    path:
      process.env.CHINESE_BODY ||
      "test_request_bodies/after_read_skill_failures_chinese_cognitive_few_shot.json",
    transform: "first_turn",
  },
];

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

function buildRequestBody(caseInfo) {
  const body = JSON.parse(fs.readFileSync(caseInfo.path, "utf8"));
  if (caseInfo.transform !== "first_turn") return body;

  const systemMessage = body.messages.find((message) => message.role === "system");
  const userMessages = body.messages.filter((message) => message.role === "user");
  const lastUserMessage = userMessages[userMessages.length - 1];

  if (!systemMessage || !lastUserMessage) {
    throw new Error(`Cannot build first_turn body from ${caseInfo.path}`);
  }

  return {
    ...body,
    messages: [systemMessage, lastUserMessage],
  };
}

async function runOne(caseInfo, iteration) {
  const body = buildRequestBody(caseInfo);
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
    const reasoningAnalysis = analyze(parsed.reasoning);
      return {
        caseName: caseInfo.name,
        iteration,
        status: response.status,
        ok: response.status >= 200 && response.status < 300 && !parseError,
        durationMs: Date.now() - startedAt,
        finishReason: parsed.finishReason,
        reasoningAnalysis,
        reasoningContent: parsed.reasoning,
        reasoningPreview: parsed.reasoning.slice(0, 300),
        parseError: parseError || undefined,
        rawPreview:
        response.status >= 200 && response.status < 300 && !parseError
          ? undefined
          : response.raw.slice(0, 500),
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

async function main() {
  const results = [];
  for (const caseInfo of CASES) {
    console.log(`\n# ${caseInfo.name}`);
    console.log(`request_body=${caseInfo.path}`);
    if (caseInfo.transform) {
      console.log(`transform=${caseInfo.transform}`);
    }
    for (let i = 1; i <= REPEAT; i += 1) {
      const row = await runOne(caseInfo, i);
      results.push(row);
      if (row.ok) {
        console.log(
          `${caseInfo.name}\t${i}\tlanguage=${row.reasoningAnalysis.language}\tleading=${row.reasoningAnalysis.leadingLanguageChars || ""}\tchars=${row.reasoningAnalysis.chars}\tstatus=${row.status}`
        );
        console.log("reasoning_content:");
        console.log(row.reasoningContent || "");
        console.log("---");
      } else {
        console.log(
          `${caseInfo.name}\t${i}\tFAILED\tstatus=${row.status || ""}\terror=${
            row.transportError || row.parseError || ""
          }`
        );
      }
    }
  }

  const summary = {};
  for (const caseInfo of CASES) {
    summary[caseInfo.name] = summarize(
      results.filter((row) => row.caseName === caseInfo.name)
    );
  }

  const output = {
    apiUrl: API_URL,
    repeat: REPEAT,
    cases: CASES,
    summary,
    results,
  };
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));

  console.log("\n# summary");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nSaved: ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
