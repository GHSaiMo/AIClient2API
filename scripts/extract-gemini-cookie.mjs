import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  getChromeGoogleCookies,
  getEgoGoogleCookies,
  detectAllLocalGoogleAccounts,
  getGeminiWebCookieHeader
} from '../src/utils/gemini-cookie-extractor.js';

export async function testGeminiArgon(cookieHeader, authUser = null, port = 4995) {
  const binaryPath = path.resolve('gemini-web-sidecar/gemini-web-sidecar-darwin-arm64');
  if (!fs.existsSync(binaryPath)) {
    return { ok: false, error: 'Sidecar binary not found' };
  }

  const env = {
    ...process.env,
    PORT: String(port),
    GEMINI_COOKIES: cookieHeader,
    APP_ENV: 'production',
    LOG_LEVEL: 'warn'
  };
  if (authUser !== null && authUser !== undefined) {
    env.GEMINI_AUTH_USER = String(authUser);
  }

  const proc = spawn(binaryPath, [], {
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  return new Promise((resolve) => {
    let resolved = false;
    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        try { proc.kill('SIGKILL'); } catch {}
      }
    };

    const timeout = setTimeout(() => {
      cleanup();
      resolve({ ok: false, error: 'Health check timeout after 20s' });
    }, 20000);

    const checkInterval = setInterval(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/openai/v1/models`);
        if (res.ok) {
          const json = await res.json();
          if (Array.isArray(json.data) && json.data.length > 0) {
            const hasArgon = json.data.some(m => m.id === 'gemini-4-argon');
            if (hasArgon) {
              try {
                const chatRes = await fetch(`http://127.0.0.1:${port}/openai/v1/chat/completions`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    model: 'gemini-4-argon',
                    messages: [{ role: 'user', content: 'hi' }],
                    stream: false
                  })
                });
                const chatJson = await chatRes.json();
                if (chatJson.choices && chatJson.choices.length > 0) {
                  clearInterval(checkInterval);
                  clearTimeout(timeout);
                  cleanup();
                  resolve({
                    ok: true,
                    models: json.data.map(m => m.id),
                    reply: chatJson.choices[0].message?.content || ''
                  });
                  return;
                }
              } catch {
                // waiting
              }
            }
          }
        }
      } catch {}
    }, 1200);
  });
}

async function main() {
  const args = process.argv.slice(2);
  let emailArg = '';
  let doTest = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--email' && args[i + 1]) {
      emailArg = args[i + 1].toLowerCase().trim();
      i++;
    } else if (args[i].startsWith('--email=')) {
      emailArg = args[i].slice(8).toLowerCase().trim();
    } else if (args[i] === '--test') {
      doTest = true;
    }
  }

  const allAccounts = detectAllLocalGoogleAccounts();

  if (emailArg) {
    let matched = allAccounts.find(a => a.email.toLowerCase() === emailArg);
    if (!matched) {
      matched = allAccounts.find(a => a.email.toLowerCase().includes(emailArg));
    }

    if (matched) {
      console.log(JSON.stringify({
        ok: true,
        ...matched
      }));
      return;
    }

    console.log(JSON.stringify({
      ok: false,
      error: `No Gemini cookies found for email: ${emailArg}`,
      available: allAccounts.map(a => a.email)
    }));
    return;
  }

  if (doTest) {
    console.log(`Discovered ${allAccounts.length} candidate accounts.`);
    const results = [];
    let port = 4991;
    for (const acc of allAccounts) {
      console.log(`Testing [${acc.email}] (${acc.source}) on port ${port}...`);
      const res = await testGeminiArgon(acc.cookieHeader, acc.authUser, port);
      console.log(`  -> ${res.ok ? '✅ PASS' : '❌ FAIL (' + res.error + ')'}`);
      results.push({
        ...acc,
        testResult: res
      });
      port++;
    }

    const working = results.filter(r => r.testResult.ok);
    console.log(`\n==== Test Summary ====`);
    console.log(`Total: ${results.length}, Working: ${working.length}`);
    working.forEach(w => console.log(`✓ ${w.email} (${w.source})`));

    console.log(JSON.stringify({ ok: true, results, workingCount: working.length }, null, 2));
    return;
  }

  console.log(JSON.stringify({
    ok: true,
    accounts: allAccounts,
    count: allAccounts.length
  }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
