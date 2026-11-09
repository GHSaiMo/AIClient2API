import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE = path.join(ROOT, 'configs', 'local-identities.json');

const DEFAULTS = {
    // Grok：Chrome Default profile 所属账号
    grokChromeDefault: 'chrome-default@example.invalid',
    // Chrome Profile 1 所属账号（Grok / Gemini 兜底）
    chromeProfile1: 'chrome-profile1@example.invalid',
    // ego-browser 所属账号（Grok）
    grokEgo: 'ego@example.invalid',
    // Gemini ego-browser 取不到 GAUSR 时的兜底账号
    geminiEgoFallback: 'gemini-ego@example.invalid',
};

let cache = null;

/**
 * 读取本地身份映射（configs/local-identities.json，已加入 .gitignore，不入库）。
 * 缺失时使用占位值，功能性匹配会失效，需在 Mac/NAS 各放一份真实文件。
 */
export function getLocalIdentities() {
    if (cache) return cache;
    let local = {};
    try {
        local = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch {
        // 文件不存在或解析失败，使用默认占位
    }
    cache = { ...DEFAULTS, ...local };
    return cache;
}
