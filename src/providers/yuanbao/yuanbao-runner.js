import http from 'http';
import { randomUUID } from 'crypto';

const PORT = parseInt(process.env.YUANBAO_RUNNER_PORT || '9094', 10);
const HOST = process.env.YUANBAO_RUNNER_HOST || '0.0.0.0';

let isProcessing = false;
const queue = [];

async function getOrInitPage() {
  const task = await taskSpace("yuanbao_service");
  const page = task.page("p1");
  const currentUrl = await page.url();
  if (!currentUrl || !currentUrl.includes('yuanbao.tencent.com/chat')) {
    console.log('[Yuanbao Runner] Navigating to yuanbao chat...');
    await page.goto("https://yuanbao.tencent.com/chat");
    await page.waitForLoadState("domcontentloaded");
    await new Promise(r => setTimeout(r, 2000));
  }
  return { task, page };
}

async function executeChat(prompt, isStream, res, modelName) {
  const { page } = await getOrInitPage();
  const reqId = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  // 1. Click new chat entry to ensure a completely clean thread
  try {
    await page.click('.yb-new-chat-entry');
  } catch {
    await page.evaluate(() => {
      const entry = document.querySelector('.yb-new-chat-entry') || document.querySelector('.yb-new-chat-entry__item');
      if (entry) entry.click();
    });
  }
  
  // Wait until old bubbles are cleared
  for (let c = 0; c < 10; c++) {
    await new Promise(r => setTimeout(r, 200));
    const count = await page.evaluate(() => document.querySelectorAll('.hyc-common-markdown').length);
    if (count === 0) break;
  }

  // 2. Count existing markdown bubbles before our message (should be 0)
  const initialBubbleCount = await page.evaluate(() => {
    return document.querySelectorAll('.hyc-common-markdown').length;
  });

  // 3. Type prompt
  await page.click(".ql-editor");
  await page.evaluate((text) => {
    const editor = document.querySelector(".ql-editor");
    editor.focus();
    document.execCommand('insertText', false, text);
  }, prompt);
  await new Promise(r => setTimeout(r, 600));

  // 4. Click send
  await page.click('[aria-label="发送"]');
  console.log(`[Yuanbao Runner] Sent prompt (${prompt.length} chars), waiting for response...`);

  if (isStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
  }

  let lastSentLen = 0;
  let fullText = "";
  const maxWait = 120; // Up to 120 seconds for long video summaries
  let started = false;

  for (let i = 0; i < maxWait * 2; i++) {
    await new Promise(r => setTimeout(r, 500));
    
    // Read text only from the newly generated assistant bubble
    const currentText = await page.evaluate((prevCount) => {
      const els = Array.from(document.querySelectorAll('.hyc-common-markdown'));
      if (els.length > prevCount) {
        return els[els.length - 1].innerText;
      }
      return "";
    }, initialBubbleCount);

    if (currentText.length > 0) {
      started = true;
      fullText = currentText;
      if (isStream && currentText.length > lastSentLen) {
        const delta = currentText.slice(lastSentLen);
        lastSentLen = currentText.length;
        const chunk = {
          id: reqId,
          object: "chat.completion.chunk",
          created,
          model: modelName,
          choices: [{
            index: 0,
            delta: { content: delta },
            finish_reason: null
          }]
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    }

    // Check if generation is done
    if (started && i >= 4) {
      const snap = await page.snapshot();
      const isGenerating = snap.includes("停止回答");
      if (!isGenerating) {
        console.log(`[Yuanbao Runner] Generation finished in ${(i * 0.5).toFixed(1)}s! Total text len: ${fullText.length}`);
        break;
      }
    }
  }

  if (isStream) {
    const finalChunk = {
      id: reqId,
      object: "chat.completion.chunk",
      created,
      model: modelName,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: "stop"
      }]
    };
    res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
    res.write(`data: [DONE]\n\n`);
    res.end();
  } else {
    const completion = {
      id: reqId,
      object: "chat.completion",
      created,
      model: modelName,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: fullText
        },
        finish_reason: "stop"
      }],
      usage: {
        prompt_tokens: Math.ceil(prompt.length / 2),
        completion_tokens: Math.ceil(fullText.length / 2),
        total_tokens: Math.ceil((prompt.length + fullText.length) / 2)
      }
    };
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(completion));
  }
}

function processQueue() {
  if (isProcessing || queue.length === 0) return;
  isProcessing = true;
  const item = queue.shift();
  executeChat(item.prompt, item.isStream, item.res, item.model)
    .catch(err => {
      console.error('[Yuanbao Runner] Error handling request:', err);
      if (!item.res.headersSent) {
        item.res.writeHead(500, { 'Content-Type': 'application/json' });
        item.res.end(JSON.stringify({ error: { message: err.message } }));
      }
    })
    .finally(() => {
      isProcessing = false;
      processQueue();
    });
}

const server = http.createServer((req, res) => {
  // CORS
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*'
    });
    return res.end();
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', engine: 'yuanbao-ego-browser', timestamp: Date.now() }));
  }

  if (req.method === 'GET' && (req.url === '/v1/models' || req.url === '/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'yuanbao-hunyuan', object: 'model', owned_by: 'tencent-yuanbao' },
        { id: 'yuanbao-deepseek-r1', object: 'model', owned_by: 'tencent-yuanbao' },
        { id: 'yuanbao-deepseek-v3', object: 'model', owned_by: 'tencent-yuanbao' },
        { id: 'yuanbao', object: 'model', owned_by: 'tencent-yuanbao' }
      ]
    }));
  }

  if (req.method === 'POST' && (req.url === '/v1/chat/completions' || req.url === '/chat/completions')) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const json = JSON.parse(body || '{}');
        const isStream = json.stream === true;
        const model = json.model || 'yuanbao-hunyuan';
        const messages = json.messages || [];
        
        // Find last user message
        const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
        let prompt = '';
        if (lastUserMsg) {
          if (typeof lastUserMsg.content === 'string') {
            prompt = lastUserMsg.content;
          } else if (Array.isArray(lastUserMsg.content)) {
            prompt = lastUserMsg.content.map(c => c.text || '').join('\n');
          }
        }
        if (!prompt && json.prompt) {
          prompt = json.prompt;
        }

        if (!prompt) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'Missing user message content' } }));
        }

        queue.push({ prompt, isStream, res, model });
        processQueue();
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid JSON body: ' + e.message } }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Not found' } }));
});

server.listen(PORT, HOST, () => {
  console.log(`[Yuanbao Runner] Server listening on ${HOST}:${PORT}`);
});
