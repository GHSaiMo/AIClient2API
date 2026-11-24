import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync, spawn } from 'child_process';
import logger from '../../utils/logger.js';
import { getLocalIdentities } from '../../utils/local-identities.js';

function queryCookiesWithPython(dbPath) {
    if (!fs.existsSync(dbPath)) return [];
    try {
        const code = [
            "import sqlite3, shutil, json",
            "p = '" + dbPath + "'",
            "tmp = '/tmp/cookie_query_' + str(abs(hash(p))) + '.db'",
            "shutil.copy2(p, tmp)",
            "conn = sqlite3.connect(tmp)",
            "c = conn.cursor()",
            "c.execute(\"SELECT name, hex(encrypted_value) FROM cookies WHERE host_key LIKE '%grok.com%' AND name IN ('sso', 'sso-rw', 'cf_clearance')\")",
            "rows = c.fetchall()",
            "conn.close()",
            "print(json.dumps(rows))"
        ].join("\n");
        const out = execSync("python3", { input: code, encoding: 'utf8', timeout: 5000 });
        return JSON.parse(out.trim() || '[]');
    } catch (e) {
        logger.debug(`[GrokRefresher] SQLite query failed: ${e.message}`);
        return [];
    }
}

function cleanDecryptedCookie(buf, key, iv) {
    try {
        if (buf.slice(0, 3).toString() === 'v10') buf = buf.slice(3);
        const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
        let dec = Buffer.concat([decipher.update(buf), decipher.final()]);
        // macOS Chromium Cookies 拥有 32 字节的前缀签名
        if (dec.length > 32) {
            return dec.slice(32).toString('utf8');
        }
        return dec.toString('utf8');
    } catch {
        return '';
    }
}

/**
 * 1. 从 Google Chrome 读取 Cookies (针对 Chrome 登录账户)
 * 优先检查 preferredProfile / Default，并扫描其他 Profile 目录
 */
export async function getChromeCookies(preferredProfile = null) {
    const chromeBase = path.resolve(process.env.HOME || '', 'Library/Application Support/Google/Chrome');
    if (!fs.existsSync(chromeBase)) return null;

    const candidates = [];
    if (preferredProfile) {
        candidates.push(path.join(chromeBase, preferredProfile, 'Cookies'));
    }
    // 默认优先 Default，其次扫描 Profile 1, Profile 2 等
    candidates.push(path.join(chromeBase, 'Default/Cookies'));
    try {
        const dirs = fs.readdirSync(chromeBase, { withFileTypes: true });
        for (const d of dirs) {
            if (d.isDirectory() && d.name.startsWith('Profile')) {
                const p = path.join(chromeBase, d.name, 'Cookies');
                if (!candidates.includes(p)) candidates.push(p);
            }
        }
    } catch {
        // ignore
    }

    try {
        const secOut = execSync('security find-generic-password -ga Chrome 2>&1').toString();
        const password = secOut.match(/password: "(.*)"/)?.[1];
        if (!password) return null;

        const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
        const iv = Buffer.alloc(16, ' ');

        for (const dbPath of candidates) {
            if (!fs.existsSync(dbPath)) continue;
            const rows = queryCookiesWithPython(dbPath);
            if (!rows.length) continue;

            const result = {};
            for (const [name, hexVal] of rows) {
                const dec = cleanDecryptedCookie(Buffer.from(hexVal, 'hex'), key, iv);
                if (dec) result[name] = dec;
            }
            if (result.sso) {
                return result;
            }
        }
        return null;
    } catch (err) {
        logger.error(`[GrokRefresher] Chrome cookie extraction failed: ${err.message}`);
        return null;
    }
}

/**
 * 兼容旧接口：从 Google Chrome (Profile 1) 读取 Cookies
 */
export async function getChromeProfile1Cookies() {
    return getChromeCookies('Profile 1');
}

/**
 * 兼容旧接口：Chrome for Testing
 */
export async function getChromeForTestingCookies() {
    const dbPath = path.resolve('/Users/hal9000/Projects/message-runtime/data/playwright-profiles/truthsocial/Default/Cookies');
    if (!fs.existsSync(dbPath)) return null;

    try {
        const key = crypto.pbkdf2Sync('mock_password', 'saltysalt', 1003, 16, 'sha1');
        const iv = Buffer.alloc(16, ' ');

        const rows = queryCookiesWithPython(dbPath);
        if (!rows.length) return null;

        const result = {};
        for (const [name, hexVal] of rows) {
            const dec = cleanDecryptedCookie(Buffer.from(hexVal, 'hex'), key, iv);
            if (dec) result[name] = dec;
        }
        return result;
    } catch (err) {
        logger.error(`[GrokRefresher] Chrome for Testing cookie extraction failed: ${err.message}`);
        return null;
    }
}

export async function getEgoBrowserCookies(preferredProfile = null) {
    const egoBase = path.resolve(process.env.HOME || '', 'Library/Application Support/Citro Labs/ego lite');
    if (!fs.existsSync(egoBase)) return null;

    const candidates = [];
    if (preferredProfile) {
        candidates.push(path.join(egoBase, preferredProfile, 'Cookies'));
    }
    candidates.push(path.join(egoBase, 'Default/Cookies'));
    try {
        const dirs = fs.readdirSync(egoBase, { withFileTypes: true });
        for (const d of dirs) {
            if (d.isDirectory() && d.name.startsWith('Profile')) {
                const p = path.join(egoBase, d.name, 'Cookies');
                if (!candidates.includes(p)) candidates.push(p);
            }
        }
    } catch {
        // ignore
    }

    try {
        const secOut = execSync('security find-generic-password -ga "ego" 2>&1').toString();
        const password = secOut.match(/password: "(.*)"/)?.[1];
        if (!password) return null;

        const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
        const iv = Buffer.alloc(16, ' ');

        for (const dbPath of candidates) {
            if (!fs.existsSync(dbPath)) continue;
            const rows = queryCookiesWithPython(dbPath);
            if (!rows.length) continue;

            const result = {};
            for (const [name, hexVal] of rows) {
                const dec = cleanDecryptedCookie(Buffer.from(hexVal, 'hex'), key, iv);
                if (dec) result[name] = dec;
            }
            if (result.sso) {
                return result;
            }
        }
        return null;
    } catch (err) {
        logger.error(`[GrokRefresher] ego lite cookie extraction failed: ${err.message}`);
        return null;
    }
}

const MAC99_COOKIE_MARKER = '__GROK_MAC99_COOKIES__:';
const MAC99_SSH_BIN = fs.existsSync('/usr/bin/ssh') ? '/usr/bin/ssh' : 'ssh';

/**
 * 从远端 mac99 (192.168.50.99) 正在运行的 Ego Lite 浏览器通过 ego-browser CLI 提取 Grok Cookies
 * 使用非阻塞异步 SSH + 固定超时，并在 finally 中释放临时 taskSpace
 */
export async function getMac99EgoBrowserCookies(options = {}) {
    const identities = getLocalIdentities();
    const host = String(options.host || process.env.GROK_MAC99_HOST || identities.grokMac99Host || 'mac99').trim();
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 7000;
    if (!host) return null;

    const remoteNodeScript = [
        'const task = await taskSpace("grok-cookie-sync");',
        'try {',
        '  const page = task.page("p1");',
        '  let cookies = [];',
        '  try {',
        '    const res = await page.cdp("Network.getCookies", { urls: ["https://grok.com", "https://accounts.x.ai", "https://x.ai"] });',
        '    cookies = res?.cookies || [];',
        '  } catch {}',
        '  if (!cookies.some(c => c.name === "sso")) {',
        '    try {',
        '      const res = await task.cdp("Storage.getCookies", {});',
        '      cookies = (res?.cookies || []).filter(c => /grok\\.com|x\\.ai/i.test(c.domain || ""));',
        '    } catch {}',
        '  }',
        '  const out = {};',
        '  for (const c of cookies) {',
        '    if (c.name === "sso" || c.name === "sso-rw" || c.name === "cf_clearance") {',
        '      out[c.name] = c.value;',
        '    }',
        '  }',
        `  console.log(${JSON.stringify(MAC99_COOKIE_MARKER)} + JSON.stringify(out));`,
        '} finally {',
        '  await task.finish({ keep: [] }).catch(() => {});',
        '}',
        ''
    ].join('\n');

    const remoteCmd = 'export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"; ego-browser nodejs';

    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let settled = false;

        const finish = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };

        const child = spawn(
            MAC99_SSH_BIN,
            [
                '-o', 'BatchMode=yes',
                '-o', 'ConnectTimeout=3',
                '-o', 'ServerAliveInterval=3',
                '-o', 'ServerAliveCountMax=1',
                host,
                remoteCmd
            ],
            { stdio: ['pipe', 'pipe', 'pipe'] }
        );

        const timer = setTimeout(() => {
            logger.warn(`[GrokRefresher] mac99 (${host}) ego lite cookie extraction timed out after ${timeoutMs}ms`);
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
            finish(null);
        }, timeoutMs);

        child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

        child.on('error', (err) => {
            logger.warn(`[GrokRefresher] Failed to spawn ssh for ${host}: ${err.message}`);
            finish(null);
        });

        child.on('close', (code) => {
            try {
                // ego-browser nodejs 在管道模式下可能将 console.log 输出到 stderr，合并双流提取带标记的 JSON
                const combined = `${stdout}\n${stderr}`;
                const lines = combined.split(/\r?\n/);
                for (let i = lines.length - 1; i >= 0; i--) {
                    const idx = lines[i].indexOf(MAC99_COOKIE_MARKER);
                    if (idx !== -1) {
                        const jsonStr = lines[i].slice(idx + MAC99_COOKIE_MARKER.length).trim();
                        const parsed = JSON.parse(jsonStr);
                        if (parsed && parsed.sso) {
                            return finish(parsed);
                        }
                        break;
                    }
                }
                if (code !== 0) {
                    logger.warn(`[GrokRefresher] mac99 (${host}) ego lite extraction exited with code ${code}`);
                }
                finish(null);
            } catch (err) {
                logger.warn(`[GrokRefresher] Failed to parse mac99 (${host}) cookie payload: ${err.message}`);
                finish(null);
            }
        });

        try {
            child.stdin.write(remoteNodeScript);
            child.stdin.end();
        } catch (err) {
            logger.warn(`[GrokRefresher] Failed to write remote script to ${host}: ${err.message}`);
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
            finish(null);
        }
    });
}

function normalizeEmailFromConfig(config = {}) {
    const rawEmail = String(config.email || '').toLowerCase().trim();
    if (rawEmail) return rawEmail;
    const rawCustom = String(config.customName || '').toLowerCase().trim();
    const match = rawCustom.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/);
    return match ? match[0] : rawCustom;
}

function isEmailMatch(candidate, target) {
    if (!candidate || !target) return false;
    const a = String(candidate).toLowerCase().trim();
    const b = String(target).toLowerCase().trim();
    return a === b || a.includes(b) || b.includes(a);
}

/**
 * 根据邮箱或者配置，自动从对应的浏览器（Mac本地、mac99远端或通过Mac Cookie Bridge远程）刷新 Grok SSO
 * @param {Object} config - 提供商配置对象
 * @returns {Promise<{ sso: string, cf_clearance?: string, email?: string, source?: string } | null>}
 */
export async function refreshGrokToken(config = {}) {
    let email = normalizeEmailFromConfig(config);
    // 识别并规避默认占位邮箱或无效邮箱（如 user@grok.com）
    const isPlaceholderEmail = !email || email === 'user@grok.com' || email.startsWith('user@') || email.includes('example.com');
    if (isPlaceholderEmail) {
        email = '';
    }
    logger.info(`[GrokRefresher] Attempting to refresh Grok credentials for email/id: ${email || config.uuid}`);

    let cookies = null;

    // 1. 如果在 Linux 环境（如飞牛 NAS）或者显式配置了 MAC_COOKIE_BRIDGE_URL，优先向 Mac Cookie Bridge 实时拉取
    const bridgeBaseUrl = String(
        config.MAC_COOKIE_BRIDGE_URL ||
        process.env.MAC_COOKIE_BRIDGE_URL ||
        (process.platform === 'linux' ? 'http://192.168.50.9:7899' : '')
    ).trim().replace(/\/+$/, '');

    if (bridgeBaseUrl) {
        try {
            logger.info(`[GrokRefresher] Pulling Grok cookies from Mac bridge at ${bridgeBaseUrl} for ${email || 'default'}`);
            const queryUrl = email
                ? `${bridgeBaseUrl}/api/grok-cookies?email=${encodeURIComponent(email)}`
                : `${bridgeBaseUrl}/api/grok-cookies`;

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 12000);
            const res = await fetch(queryUrl, { signal: controller.signal });
            clearTimeout(timer);

            if (res.ok) {
                let data = await res.json();
                // 仅在未指定真实邮箱（占位节点）时才拉取全量列表兜底；指定真实邮箱未命中时严禁串号回退到其他账号
                if ((!data || !data.ok) && !email) {
                    logger.info(`[GrokRefresher] Default query not fulfilled on bridge, attempting fallback to available cookies...`);
                    try {
                        const fbController = new AbortController();
                        const fbTimer = setTimeout(() => fbController.abort(), 12000);
                        const fallbackRes = await fetch(`${bridgeBaseUrl}/api/grok-cookies`, { signal: fbController.signal });
                        clearTimeout(fbTimer);
                        if (fallbackRes.ok) {
                            data = await fallbackRes.json();
                        }
                    } catch (fbErr) {
                        logger.debug(`[GrokRefresher] Fallback query failed: ${fbErr.message}`);
                    }
                }
                if (data && data.ok) {
                    if (data.sso) {
                        if (!email || !data.email || isEmailMatch(data.email, email)) {
                            cookies = {
                                sso: data.sso,
                                cf_clearance: data.cf_clearance || '',
                                email: data.email,
                                source: data.source
                            };
                        } else {
                            logger.warn(`[GrokRefresher] Bridge returned mismatched email '${data.email}' for '${email}'; refusing cross-account overwrite`);
                        }
                    } else if (data.cookies && email && data.cookies[email]) {
                        cookies = {
                            sso: data.cookies[email].sso,
                            cf_clearance: data.cookies[email].cf_clearance || '',
                            email: data.cookies[email].email || email,
                            source: data.cookies[email].source
                        };
                    } else if (data.cookies) {
                        const matchedEntry = email
                            ? Object.entries(data.cookies).find(([k, v]) => isEmailMatch(k, email) || isEmailMatch(v?.email, email))
                            : null;
                        // 指定邮箱时仅允许匹配目标账号，严禁回退到其他无关账号导致串号覆盖
                        const target = matchedEntry ? matchedEntry[1] : (!email ? Object.values(data.cookies)[0] : null);
                        if (target?.sso) {
                            logger.info(`[GrokRefresher] Matched cookie from: ${target.email || target.source || 'default'}`);
                            cookies = {
                                sso: target.sso,
                                cf_clearance: target.cf_clearance || '',
                                email: target.email,
                                source: target.source
                            };
                        } else if (email) {
                            logger.warn(`[GrokRefresher] No matching cookie on bridge for '${email}'; refusing cross-account fallback`);
                        }
                    }
                } else if (email) {
                    logger.warn(`[GrokRefresher] Bridge did not return cookie for '${email}': ${data?.error || 'not found'}`);
                }
            } else {
                logger.warn(`[GrokRefresher] Mac bridge returned HTTP ${res.status}`);
            }
        } catch (err) {
            logger.warn(`[GrokRefresher] Failed to pull cookies from Mac bridge: ${err.message}`);
        }
    }

    // 2. 如果桥接未成功获取，且当前处于 macOS 本地，则按身份定向从本机浏览器或 mac99 远端提取
    if (!cookies && process.platform === 'darwin') {
        const identities = getLocalIdentities();
        if (email) {
            if (isEmailMatch(email, identities.grokMac99Ego)) {
                const remote = await getMac99EgoBrowserCookies();
                if (remote?.sso) {
                    cookies = { ...remote, email: identities.grokMac99Ego, source: 'mac99 ego-browser' };
                }
            } else if (isEmailMatch(email, identities.grokEgo)) {
                const ego = await getEgoBrowserCookies();
                if (ego?.sso) {
                    cookies = { ...ego, email: identities.grokEgo, source: 'ego-browser' };
                }
            } else if (isEmailMatch(email, identities.chromeProfile1)) {
                const c1 = await getChromeProfile1Cookies();
                if (c1?.sso) {
                    cookies = { ...c1, email: identities.chromeProfile1, source: 'Chrome Profile 1' };
                }
            } else if (isEmailMatch(email, identities.grokChromeDefault)) {
                const c0 = await getChromeCookies();
                if (c0?.sso) {
                    cookies = { ...c0, email: identities.grokChromeDefault, source: 'Google Chrome' };
                }
            } else {
                logger.warn(`[GrokRefresher] No local/mac99 browser mapping configured for '${email}'; refusing cross-account fallback`);
            }
        } else {
            // 未指定特定邮箱（占位节点），按顺序兜底尝试提取
            cookies = await getChromeCookies() || await getEgoBrowserCookies() || await getMac99EgoBrowserCookies();
        }
    }

    if (cookies && cookies.sso) {
        logger.info(`[GrokRefresher] Successfully refreshed Grok SSO for ${cookies.email || email || config.uuid}`);
        return {
            sso: cookies.sso,
            cf_clearance: cookies.cf_clearance || '',
            email: cookies.email,
            source: cookies.source
        };
    }

    logger.warn(`[GrokRefresher] Failed to refresh Grok credentials for ${email || config.uuid}`);
    return null;
}
