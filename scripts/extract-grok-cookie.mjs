import {
  getChromeProfile1Cookies,
  getChromeForTestingCookies,
  getEgoBrowserCookies
} from '../src/providers/grok/grok-token-refresher.js';

function extractSessionId(token) {
  try {
    if (!token) return '';
    const parts = token.split('.');
    if (parts.length < 2) return '';
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    return payload.session_id || '';
  } catch {
    return '';
  }
}

async function extractAllCookies() {
  const [chrome1, testing, ego] = await Promise.all([
    getChromeProfile1Cookies().catch(() => null),
    getChromeForTestingCookies().catch(() => null),
    getEgoBrowserCookies().catch(() => null),
  ]);

  const result = {};

  if (chrome1?.sso) {
    result['taojiuzhen@gmail.com'] = {
      email: 'taojiuzhen@gmail.com',
      sso: chrome1.sso,
      cf_clearance: chrome1.cf_clearance || '',
      session_id: extractSessionId(chrome1.sso),
      source: 'Chrome Profile 1'
    };
  }

  if (testing?.sso) {
    result['taojiuzhenitunes@gmail.com'] = {
      email: 'taojiuzhenitunes@gmail.com',
      sso: testing.sso,
      cf_clearance: testing.cf_clearance || '',
      session_id: extractSessionId(testing.sso),
      source: 'Chrome for Testing'
    };
  }

  if (ego?.sso) {
    result['taoxy0305@gmail.com'] = {
      email: 'taoxy0305@gmail.com',
      sso: ego.sso,
      cf_clearance: ego.cf_clearance || '',
      session_id: extractSessionId(ego.sso),
      source: 'ego-browser'
    };
  }

  return result;
}

async function main() {
  const args = process.argv.slice(2);
  let emailArg = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--email' && args[i + 1]) {
      emailArg = args[i + 1].toLowerCase().trim();
      i++;
    } else if (args[i].startsWith('--email=')) {
      emailArg = args[i].slice(8).toLowerCase().trim();
    }
  }

  const all = await extractAllCookies();

  if (emailArg) {
    // Exact or partial match
    let matchedKey = Object.keys(all).find(k => k === emailArg);
    if (!matchedKey) {
      matchedKey = Object.keys(all).find(k => k.includes(emailArg) || emailArg.includes(k));
    }

    if (matchedKey && all[matchedKey]) {
      console.log(JSON.stringify({
        ok: true,
        ...all[matchedKey]
      }));
      return;
    }

    console.log(JSON.stringify({
      ok: false,
      error: `No Grok cookie found for email: ${emailArg}`,
      available: Object.keys(all)
    }));
    return;
  }

  console.log(JSON.stringify({
    ok: true,
    cookies: all,
    count: Object.keys(all).length
  }));
}

main().catch(err => {
  console.log(JSON.stringify({
    ok: false,
    error: err.message
  }));
  process.exit(1);
});
