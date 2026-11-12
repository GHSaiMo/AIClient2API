import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

import { extractChatGPTSessionCookies } from '../src/providers/chatgpt/chatgpt-cookie-extractor.js';
import { refreshSessionFromCookies, fetchUserInfo } from '../src/providers/chatgpt/chatgpt-token-service.js';
import { MODEL_PROVIDER } from '../src/utils/common.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const LOCAL_CONFIG_PATH = path.resolve(ROOT, 'configs/config.json');
const LOCAL_POOLS_PATH = path.resolve(ROOT, 'configs/provider_pools.json');
const NAS_APP_DIR = '/vol1/1000/apps/AIClient2API';
const NAS_POOLS_PATH = `${NAS_APP_DIR}/configs/provider_pools.json`;

function parseArgs(argv) {
    const args = {
        browser: 'ego',
        profile: 'Profile 4',
        local: false,
        nas: false,
        restartNas: true,
    };
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--browser' && argv[i + 1]) args.browser = argv[++i];
        else if (arg === '--profile' && argv[i + 1]) args.profile = argv[++i];
        else if (arg === '--local') args.local = true;
        else if (arg === '--nas') args.nas = true;
        else if (arg === '--both') {
            args.local = true;
            args.nas = true;
        } else if (arg === '--no-restart-nas') {
            args.restartNas = false;
        }
    }
    if (!args.local && !args.nas) {
        args.local = true;
        args.nas = true;
    }
    return args;
}

function loadLocalProxyConfig() {
    try {
        const cfg = JSON.parse(fs.readFileSync(LOCAL_CONFIG_PATH, 'utf8'));
        return {
            MODEL_PROVIDER: MODEL_PROVIDER.CHATGPT_WEB,
            PROXY_URL: cfg.PROXY_URL || 'http://127.0.0.1:7890',
            PROXY_ENABLED_PROVIDERS: [MODEL_PROVIDER.CHATGPT_WEB],
        };
    } catch {
        return {
            MODEL_PROVIDER: MODEL_PROVIDER.CHATGPT_WEB,
            PROXY_URL: 'http://127.0.0.1:7890',
            PROXY_ENABLED_PROVIDERS: [MODEL_PROVIDER.CHATGPT_WEB],
        };
    }
}

function upsertChatGPTPoolNode(pools, nodeData) {
    const list = Array.isArray(pools['chatgpt-web']) ? [...pools['chatgpt-web']] : [];
    const targetEmail = String(nodeData.email || '').trim().toLowerCase();
    const existingIdx = targetEmail
        ? list.findIndex(item => String(item.email || '').trim().toLowerCase() === targetEmail)
        : -1;

    const nowIso = new Date().toISOString();
    if (existingIdx >= 0) {
        const existing = list[existingIdx];
        list[existingIdx] = {
            ...existing,
            customName: nodeData.customName || existing.customName,
            email: nodeData.email || existing.email,
            accountType: nodeData.accountType || existing.accountType,
            access_token: nodeData.access_token,
            cookie_header: nodeData.cookie_header,
            quota: nodeData.quota ?? existing.quota ?? null,
            restore_at: nodeData.restore_at ?? existing.restore_at ?? null,
            browser: nodeData.browser,
            profile: nodeData.profile,
            checkModelName: existing.checkModelName || 'gpt-image-2',
            checkHealth: existing.checkHealth ?? false,
            isHealthy: true,
            isDisabled: false,
            needsRefresh: false,
            errorCount: 0,
            lastErrorTime: null,
            lastErrorMessage: null,
            lastHealthCheckTime: nowIso,
            lastRefreshTime: Date.now(),
        };
    } else {
        list.push({
            uuid: crypto.randomUUID(),
            customName: nodeData.customName,
            email: nodeData.email,
            accountType: nodeData.accountType,
            access_token: nodeData.access_token,
            cookie_header: nodeData.cookie_header,
            quota: nodeData.quota ?? null,
            restore_at: nodeData.restore_at ?? null,
            browser: nodeData.browser,
            profile: nodeData.profile,
            checkModelName: 'gpt-image-2',
            checkHealth: false,
            isHealthy: true,
            isDisabled: false,
            lastUsed: null,
            usageCount: 0,
            errorCount: 0,
            lastErrorTime: null,
            lastHealthCheckTime: nowIso,
            lastErrorMessage: null,
            needsRefresh: false,
            refreshCount: 0,
            _lastSelectionSeq: 0,
            lastRefreshTime: Date.now(),
        });
    }

    return {
        ...pools,
        'chatgpt-web': list,
    };
}

async function main() {
    if (process.platform !== 'darwin') {
        console.error('❌ 此脚本需在 macOS 上运行以提取 Ego Lite / Chrome 浏览器 Cookie。');
        process.exit(1);
    }

    const args = parseArgs(process.argv);
    console.log(`=== 开始同步 ChatGPT Web 登录态 (${args.browser} / ${args.profile}) ===\n`);

    const extracted = extractChatGPTSessionCookies({
        preferredBrowser: args.browser,
        preferredProfile: args.profile,
    });
    if (!extracted?.cookieHeader) {
        console.error('❌ 未能从 Ego Lite 或 Chrome 提取到有效的 ChatGPT Session Cookie。');
        process.exit(1);
    }
    console.log(`✓ 已提取浏览器 Cookie (${extracted.source})`);

    const reqConfig = loadLocalProxyConfig();
    const sessionInfo = await refreshSessionFromCookies(extracted.cookieHeader, reqConfig);
    console.log(`✓ 会话换取成功: ${sessionInfo.email || 'unknown'} (plan: ${sessionInfo.accountType}, expires: ${sessionInfo.expires || 'N/A'})`);

    let userInfo = null;
    try {
        userInfo = await fetchUserInfo(sessionInfo.access_token, reqConfig, {}, sessionInfo.cookie_header);
        console.log(`✓ 账号探测成功: type=${userInfo.type}, image_gen_quota=${userInfo.quota}, status=${userInfo.status}`);
    } catch (err) {
        console.warn(`! 账号探测可选步骤告警: ${err.message}`);
    }

    const nodeData = {
        customName: `${sessionInfo.email || 'chatgpt-web'} (${extracted.source})`,
        email: sessionInfo.email || userInfo?.email || null,
        accountType: userInfo?.type || sessionInfo.accountType || 'free',
        access_token: sessionInfo.access_token,
        cookie_header: sessionInfo.cookie_header,
        quota: userInfo?.quota ?? null,
        restore_at: userInfo?.restore_at ?? null,
        browser: extracted.browser,
        profile: extracted.profile,
    };

    if (args.local) {
        const localPools = JSON.parse(fs.readFileSync(LOCAL_POOLS_PATH, 'utf8'));
        const updatedLocal = upsertChatGPTPoolNode(localPools, nodeData);
        fs.writeFileSync(LOCAL_POOLS_PATH, JSON.stringify(updatedLocal, null, 2) + '\n', 'utf8');
        console.log(`✓ 已增量更新本地 ${LOCAL_POOLS_PATH} 中的 chatgpt-web (${updatedLocal['chatgpt-web'].length} 个节点)`);
    }

    if (args.nas) {
        console.log('\n--- 定向同步至 NAS 生产环境 (192.168.50.39) ---');
        let wasActive = false;
        try {
            wasActive = execSync('ssh nas "systemctl is-active aiclient2api"').toString().trim() === 'active';
        } catch {
            wasActive = false;
        }
        if (wasActive) {
            execSync('ssh nas "echo jz0305 | sudo -S systemctl stop aiclient2api"', { stdio: 'inherit' });
        }
        try {
            const rawNas = execSync(`ssh nas "cat ${NAS_POOLS_PATH}"`, { maxBuffer: 20 * 1024 * 1024 }).toString('utf8');
            const nasPools = JSON.parse(rawNas);
            const updatedNas = upsertChatGPTPoolNode(nasPools, nodeData);
            const payloadJson = JSON.stringify(updatedNas, null, 2) + '\n';
            execSync(`ssh nas "cat > ${NAS_POOLS_PATH}.tmp && mv ${NAS_POOLS_PATH}.tmp ${NAS_POOLS_PATH} && chmod 600 ${NAS_POOLS_PATH}"`, {
                input: payloadJson,
                stdio: ['pipe', 'inherit', 'inherit'],
            });
            console.log(`✓ 已增量更新 NAS ${NAS_POOLS_PATH} 中的 chatgpt-web (${updatedNas['chatgpt-web'].length} 个节点)`);
        } finally {
            if (args.restartNas && wasActive) {
                execSync('ssh nas "echo jz0305 | sudo -S systemctl start aiclient2api"', { stdio: 'inherit' });
                console.log('✓ 已重新拉起 NAS aiclient2api 服务');
            }
        }
    }
}

main().catch((err) => {
    console.error('❌ 同步失败:', err.message);
    process.exit(1);
});
