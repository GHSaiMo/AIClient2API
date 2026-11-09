import {
  getChromeCookies,
  getChromeProfile1Cookies,
  getEgoBrowserCookies
} from '../src/providers/grok/grok-token-refresher.js';
import { getLocalIdentities } from '../src/utils/local-identities.js';

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
  const [chromeCookies, chrome1, ego] = await Promise.all([
    getChromeCookies().catch(() => null),
    getChromeProfile1Cookies().catch(() => null),
    getEgoBrowserCookies().catch(() => null),
  ]);

  const result = {};

  // Google Chrome (默认 Default profile，包含 对应账号)
  if (chromeCookies?.sso) {
    result[getLocalIdentities().grokChromeDefault] = {
      email: getLocalIdentities().grokChromeDefault,
      sso: chromeCookies.sso,
      cf_clearance: chromeCookies.cf_clearance || '',
      session_id: extractSessionId(chromeCookies.sso),
      source: 'Google Chrome'
    };
  }

  // Google Chrome Profile 1 (针对备用 profile，如果与 Default 互斥)
  if (chrome1?.sso && chrome1.sso !== chromeCookies?.sso) {
    result[getLocalIdentities().chromeProfile1] = {
      email: getLocalIdentities().chromeProfile1,
      sso: chrome1.sso,
      cf_clearance: chrome1.cf_clearance || '',
      session_id: extractSessionId(chrome1.sso),
      source: 'Chrome Profile 1'
    };
  }

  // ego-browser (针对 对应账号)
  if (ego?.sso) {
    result[getLocalIdentities().grokEgo] = {
      email: getLocalIdentities().grokEgo,
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
