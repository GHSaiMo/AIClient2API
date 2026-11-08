import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const BASELINE_DIR = path.resolve(ROOT, 'configs/baselines');
const BASELINE_POOLS_PATH = path.join(BASELINE_DIR, 'provider_pools.baseline.json');
const TARGET_POOLS_PATH = path.resolve(ROOT, 'configs/provider_pools.json');

const BASELINE_CONFIG_PATH = path.join(BASELINE_DIR, 'config.baseline.json');
const TARGET_CONFIG_PATH = path.resolve(ROOT, 'configs/config.json');

async function main() {
    console.log('=== AIClient2API 黄金基准凭据池一键恢复工具 ===');

    if (!fs.existsSync(BASELINE_POOLS_PATH)) {
        console.error(`❌ 基准文件不存在: ${BASELINE_POOLS_PATH}`);
        process.exit(1);
    }

    // 1. 本地恢复
    console.log(`[1/3] 正在恢复本地 configs/provider_pools.json ...`);
    fs.copyFileSync(BASELINE_POOLS_PATH, TARGET_POOLS_PATH);

    if (fs.existsSync(BASELINE_CONFIG_PATH)) {
        console.log(`[2/3] 正在核验本地 configs/config.json ...`);
        const currentCfg = JSON.parse(fs.readFileSync(TARGET_CONFIG_PATH, 'utf8'));
        const baselineCfg = JSON.parse(fs.readFileSync(BASELINE_CONFIG_PATH, 'utf8'));
        // 保持本地端口/代理不变，仅同步基准模型提供商设置
        currentCfg.MODEL_PROVIDER = baselineCfg.MODEL_PROVIDER;
        currentCfg.PROXY_ENABLED_PROVIDERS = baselineCfg.PROXY_ENABLED_PROVIDERS;
        currentCfg.TLS_SIDECAR_ENABLED_PROVIDERS = baselineCfg.TLS_SIDECAR_ENABLED_PROVIDERS;
        fs.writeFileSync(TARGET_CONFIG_PATH, JSON.stringify(currentCfg, null, 2), 'utf8');
    }

    console.log('✅ 本地凭据池已按基准黄金版本恢复完成！');

    // 2. 如果指定了 --sync-nas 或在 Mac 端默认询问
    const syncNas = process.argv.includes('--sync-nas') || (!process.argv.includes('--local-only') && process.platform === 'darwin');
    if (syncNas) {
        console.log(`\n[3/3] 同步黄金基准至飞牛 NAS (192.168.50.39) 生产环境 ...`);
        try {
            execSync(`scp "${BASELINE_POOLS_PATH}" nas:/vol1/1000/apps/AIClient2API/configs/provider_pools.json`, { stdio: 'inherit', cwd: ROOT });
            execSync(`ssh nas "mkdir -p /vol1/1000/apps/AIClient2API/configs/baselines"`, { stdio: 'inherit', cwd: ROOT });
            execSync(`scp "${BASELINE_POOLS_PATH}" nas:/vol1/1000/apps/AIClient2API/configs/baselines/provider_pools.baseline.json`, { stdio: 'inherit', cwd: ROOT });
            execSync(`ssh nas "echo jz0305 | sudo -S systemctl restart aiclient2api"`, { stdio: 'inherit', cwd: ROOT });
            console.log('🎉 NAS 生产环境黄金基准已恢复并重启成功！');
        } catch (err) {
            console.error('❌ NAS 同步失败:', err.message);
        }
    }
}

main().catch(console.error);
