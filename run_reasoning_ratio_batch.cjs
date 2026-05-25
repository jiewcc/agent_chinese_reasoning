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
];

function analyze(text) {
  const asciiLetters = (text.match(/[A-Za-z]/g) || []).length;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const englishWords = text.match(/[A-Za-z][A-Za-z_-]{2,}/g) || [];
  const englishSentences = text
    .split(/[\n。！？]/)
    .map((line) => line.trim())
    .filter((line) => /[A-Za-z]{3,}/.test(line) && /[a-z][\s,.;:)]/.test(line)).length;
  const englishRatio = asciiLetters / Math.max(1, asciiLetters + cjk);

  return {
    chars: text.length,
    cjk,
    asciiLetters,
    englishRatio: Number(englishRatio.toFixed(4)),
    englishSentenceCount: englishSentences,
    englishWordsSample: Array.from(new Set(englishWords)).slice(0, 20),
    mixed: englishRatio > 0.05 || englishSentences > 0,
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
  const ratios = okRows.map((row) => row.reasoningAnalysis.englishRatio);
  if (ratios.length === 0) {
    return { okCount: 0, failedCount: rows.length };
  }
  const sorted = ratios.slice().sort((a, b) => a - b);
  const sum = ratios.reduce((total, value) => total + value, 0);
  return {
    okCount: okRows.length,
    failedCount: rows.length - okRows.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: Number((sum / ratios.length).toFixed(4)),
    mixedCount: okRows.filter((row) => row.reasoningAnalysis.mixed).length,
  };
}

async function runOne(caseInfo, iteration) {
  const body = JSON.parse(fs.readFileSync(caseInfo.path, "utf8"));
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
    for (let i = 1; i <= REPEAT; i += 1) {
      const row = await runOne(caseInfo, i);
      results.push(row);
      if (row.ok) {
        console.log(
          `${caseInfo.name}\t${i}\tenglishRatio=${row.reasoningAnalysis.englishRatio}\tmixed=${row.reasoningAnalysis.mixed}\tchars=${row.reasoningAnalysis.chars}\tstatus=${row.status}`
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
