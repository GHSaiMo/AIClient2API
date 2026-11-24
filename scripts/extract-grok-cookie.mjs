import {
  getChromeCookies,
  getChromeProfile1Cookies,
  getEgoBrowserCookies,
  getMac99EgoBrowserCookies
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

function formatEntry(email, raw, source) {
  return {
    email,
    sso: raw.sso,
    cf_clearance: raw.cf_clearance || '',
    session_id: extractSessionId(raw.sso),
    source
  };
}

function isEmailMatch(identityEmail, query) {
  if (!identityEmail || !query) return false;
  const a = identityEmail.toLowerCase().trim();
  const b = query.toLowerCase().trim();
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * 指定邮箱时的定向提取：避免查本机账号时触发 mac99 SSH，也避免查 mac99 账号时白读本机 Keychain
 */
async function extractTargetedCookie(emailArg) {
  const ids = getLocalIdentities();

  if (isEmailMatch(ids.grokMac99Ego, emailArg)) {
    const mac99 = await getMac99EgoBrowserCookies().catch(() => null);
    return mac99?.sso ? formatEntry(ids.grokMac99Ego, mac99, 'mac99 ego-browser') : null;
  }

  if (isEmailMatch(ids.grokChromeDefault, emailArg)) {
    const chromeCookies = await getChromeCookies().catch(() => null);
    return chromeCookies?.sso ? formatEntry(ids.grokChromeDefault, chromeCookies, 'Google Chrome') : null;
  }

  if (isEmailMatch(ids.grokEgo, emailArg)) {
    const ego = await getEgoBrowserCookies().catch(() => null);
    return ego?.sso ? formatEntry(ids.grokEgo, ego, 'ego-browser') : null;
  }

  if (isEmailMatch(ids.chromeProfile1, emailArg)) {
    const chrome1 = await getChromeProfile1Cookies().catch(() => null);
    return chrome1?.sso ? formatEntry(ids.chromeProfile1, chrome1, 'Chrome Profile 1') : null;
  }

  return undefined; // 未命中已知身份，交由全量扫描匹配
}

async function extractAllCookies() {
  const ids = getLocalIdentities();
  const [chromeCookies, chrome1, ego, mac99Ego] = await Promise.all([
    getChromeCookies().catch(() => null),
    getChromeProfile1Cookies().catch(() => null),
    getEgoBrowserCookies().catch(() => null),
    getMac99EgoBrowserCookies().catch(() => null),
  ]);

  const result = {};

  // Google Chrome (默认 Default profile)
  if (chromeCookies?.sso) {
    result[ids.grokChromeDefault] = formatEntry(ids.grokChromeDefault, chromeCookies, 'Google Chrome');
  }

  // Google Chrome Profile 1 (备用 profile，如果与 Default 互斥)
  if (chrome1?.sso && chrome1.sso !== chromeCookies?.sso) {
    result[ids.chromeProfile1] = formatEntry(ids.chromeProfile1, chrome1, 'Chrome Profile 1');
  }

  // 本机 ego-browser
  if (ego?.sso) {
    result[ids.grokEgo] = formatEntry(ids.grokEgo, ego, 'ego-browser');
  }

  // 远端 mac99 ego-browser
  if (mac99Ego?.sso) {
    result[ids.grokMac99Ego] = formatEntry(ids.grokMac99Ego, mac99Ego, 'mac99 ego-browser');
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

  if (emailArg) {
    const targeted = await extractTargetedCookie(emailArg);
    if (targeted) {
      console.log(JSON.stringify({
        ok: true,
        ...targeted
      }));
      return;
    }
    if (targeted === null) {
      console.log(JSON.stringify({
        ok: false,
        error: `No Grok cookie found for email: ${emailArg}`
      }));
      return;
    }

    const all = await extractAllCookies();
    let matchedKey = Object.keys(all).find(k => k.toLowerCase() === emailArg);
    if (!matchedKey) {
      matchedKey = Object.keys(all).find(k => k.toLowerCase().includes(emailArg) || emailArg.includes(k.toLowerCase()));
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

  const all = await extractAllCookies();
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
