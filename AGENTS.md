# AIClient2API 项目约定与 Agent 指南

本项目为 AI 模型统一代理与格式转换网关（支持 Antigravity / Gemini CLI、Claude Kiro OAuth、Grok 等）。

## 1. 运行态感知与环境路由 (Runtime & Host Manifest)

> [!IMPORTANT]
> **生产常驻环境**：本项目生产常驻服务已迁移至局域网 **飞牛 NAS (192.168.50.39)**。
> - **NAS 服务路径**：`/vol1/1000/apps/AIClient2API`
> - **NAS 进程守护**：systemd 服务 `aiclient2api`（监听 `:3005`，本地透明中继映射 `:3005`）
> - **NAS 代理配置**：使用 `socks5://192.168.50.9:7898`（Mac 宿主机代理中继出网）
> - **Mac 本地目录**：`/Users/hal9000/Projects/AIClient2API`（作为离线开发、源码同步与归档备份）

### Agent 行为准则 (必须遵守)：

1. **意图路由与确认机制**：
   - 若用户需求涉及 **“排查日志”、“服务报错”、“连接重置”、“模型调用失败”、“重启服务” 或 “热修复线上问题”**，Agent 应**直接定位为 NAS 生产环境**，调用 `nas-ops` 技能通过 SSH 访问 NAS。
   - 若用户需求为 **“修改代码 / 添加功能”** 但未明确指明环境，Agent **必须先询问用户确认**：
     > “当前本项目常驻运行于 NAS (192.168.50.39) 生产环境。请问您是希望**直接修改并生效 NAS 线上服务**，还是**在 Mac 本地进行代码开发**？”
2. **NAS 生产环境操作流 (nas-ops)**：
   - 远程执行 / 日志查看：
     - 日志：`ssh nas "journalctl -u aiclient2api -n 50 -f"` 或通过 Tmux / Web 控制台窗口 `aiclient2api`
     - 重启服务：`ssh nas "echo jz0305 | sudo -S systemctl restart aiclient2api"`
     - 健康检查：`curl -s http://127.0.0.1:3005/v1/models`
3. **跨平台架构适配与 Sidecar 规则**：
   - 请求本地 Go Sidecar 必须使用本地原生 Dispatcher / Agent 并设置禁用外部代理，严禁通过外部代理访问 Sidecar。
   - 二进制驱动：`tls-sidecar` 在 `src/utils/tls-sidecar.js` 中已支持跨平台动态自适应（Mac 自动匹配 `tls-sidecar-darwin-arm64`，NAS 自动匹配 `tls-sidecar-linux-amd64`）。
   - **端口配置区分**：
     - **NAS 生产环境**：`TLS_SIDECAR_PORT: 9090`
     - **Mac 本地环境**：`TLS_SIDECAR_PORT: 9095`（避让本地 FlClash 占用的 9090 端口）
   - **Grok Cookie 动态提取自适应**：
     - **NAS 端**：通过网络向 Mac Cookie Bridge (`http://192.168.50.9:7899`) 拉取
     - **Mac 本地**：原生直接读取并解密 macOS Keychain 与本地 Google Chrome / ego lite 数据库（30ms 毫秒级原生直取）
4. **双端流量调度与一键切换 (Canary 灰度测试)**：
   - 本地提供一键流量切换工具 `./scripts/switch-traffic.sh`：
     - **切至本地开发版**：`./scripts/switch-traffic.sh local`（自动通知 `lan-proxy-bridge` 释放 3005 端口并拉起 Mac 本地服务）
     - **切回 NAS 生产版**：`./scripts/switch-traffic.sh nas`（自动关闭本地服务并通知 `lan-proxy-bridge` 恢复 3005 转发到 NAS）
     - **查看当前状态**：`./scripts/switch-traffic.sh status`
5. **Git 版本控制双端同步**：
   - NAS 端拥有完整 Git 仓库与 GitHub SSH 免密推送权限。
   - 在 NAS 端修改并验证后：
     `ssh nas "cd /vol1/1000/apps/AIClient2API && git add . && git commit -m '...' && git push origin main"`
   - 随后在 Mac 本地目录拉取同步：
     `cd /Users/hal9000/Projects/AIClient2API && git pull origin main`
6. **模块化定向同步准则 (严禁全量自作主张同步)**：
   - **严格按需同步**：只有用户明确要求同步哪个模块的账号（如“同步 Codex 账号”、“导入 Kiro”），才仅对该指定模块执行同步。**严禁自作主张触发全量同步，严禁顺带冲刷同步未指定模块的账号池**（如未被要求的 Grok、Kiro 等）。
   - **保护固定/停用状态**：部分模块有明确的基准限制（例如 `grok-web`/`grok-cli` 特定节点已按黄金基准冻结禁用），绝对禁止私自新增或恢复启用。
   - **执行命令必须带参限制范围**：调用凭据同步工具时必须显式指定目标模块（如 `node scripts/sync-cockpit-credentials.mjs --codex`），禁止无参数或使用 `--all` 导致隐式全量冲刷。

## 2. 常用开发与测试命令

```bash
# 查看当前流量指向（Mac 本地 vs NAS 生产）
./scripts/switch-traffic.sh status

# 一键切换流量到 Mac 本地开发版（运行在 tmux: aiclient2api-local）
./scripts/switch-traffic.sh local

# 一键切回 NAS 生产版（透明中继到 192.168.50.39:3005）
./scripts/switch-traffic.sh nas

# 检查服务健康状态
curl http://127.0.0.1:3005/
```

## 3. 黄金基准凭据池规范与回滚约定

> [!IMPORTANT]
> **基准凭据池黄金版本**（2026-11-12 更新归档）：
> - 用户已完成全量失效凭据的移除与清洗，并将当前截面（含供应商列表、账户凭据、健康状态及启用/禁用开关）定为**唯一准则基准**。
> - 归档路径：`configs/baselines/provider_pools.baseline.json` 与 `configs/baselines/snapshot-2026-11-12/`（含完整凭据文件副本、`config.nas.json`、`config.local.json`、`plugins.nas.json` 及 `manifest.json`，双端同步）。
> - **回滚准则**：后续无论发生任何配置错乱、重启异常、自动关联异常或重置需求，**必须严格以此基准凭据池为准进行回滚恢复**，严禁使用旧的历史备份冲刷覆盖。
> - **各供应商基准节点规模与开关状态（共 6 个 Provider，29 个节点）**：
>   - `claude-kiro-oauth`: 16 个节点，全部启用且健康 (`isDisabled: false`, `isHealthy: true`)
>   - `openai-codex-oauth`: 9 个节点，全部启用且健康 (`isDisabled: false`, `isHealthy: true`)
>   - `grok-cli-oauth`: 1 个节点，禁用 (`isDisabled: true`, `isHealthy: true`)
>   - `grok-web`: 1 个节点，禁用 (`isDisabled: true`, `isHealthy: true`)
>   - `gemini-web`: 1 个节点 (`gemini-4-argon`)，启用且健康 (`isDisabled: false`, `isHealthy: true`)
>   - `yuanbao-web`: 1 个节点 (`yuanbao-hunyuan`)，启用且健康 (`isDisabled: false`, `isHealthy: true`)
> - **入库副本**：完整基准含凭据保持 git 忽略；脱敏版位于 `configs/baseline-redacted/provider_pools.baseline.redacted.json`（`node scripts/export-redacted-baseline.mjs` 生成，仅供结构/状态参考，不可直接用于恢复）。
> - **定向增量原则**：后续若添加新账号，仅更新对应供应商配置与基准，禁止非受邀全量冲刷。

### 标准回退执行指南 (Agent 直接读取执行)

当用户要求“回退到黄金基准”或重启后发生 Provider/账户凭据/启用开关错乱时，后续 Agent 直接按以下流程执行：

1. **常规回退（恢复号池 Provider、账户凭据与启用/禁用开关，并重启 NAS 服务）**：
   ```bash
   # 先停止 NAS 服务，避免运行期 _debouncedSave 覆盖刚写入的配置文件
   ssh nas "echo jz0305 | sudo -S systemctl stop aiclient2api"

   # 一键恢复本地与 NAS 的 provider_pools.json（含全部开关与凭据）并拉起 NAS 服务
   node scripts/restore-baseline-pools.mjs
   ```

2. **完整截面全量回退（当 `configs/{kiro,codex,grok-cli}` 凭据文件、`config.json` 或 `plugins.json` 也受损/被误改时执行）**：
   ```bash
   # 1) 停止 NAS 服务
   ssh nas "echo jz0305 | sudo -S systemctl stop aiclient2api"

   # 2) 恢复双端 OAuth 凭据文件副本（kiro / codex / grok-cli）
   rsync -avz configs/baselines/snapshot-2026-11-12/creds/ configs/
   rsync -avz configs/baselines/snapshot-2026-11-12/creds/ nas:/vol1/1000/apps/AIClient2API/configs/

   # 3) 恢复双端主配置与 NAS 插件开关
   cp configs/baselines/snapshot-2026-11-12/config.local.json configs/config.json
   scp configs/baselines/snapshot-2026-11-12/config.nas.json nas:/vol1/1000/apps/AIClient2API/configs/config.json
   scp configs/baselines/snapshot-2026-11-12/plugins.nas.json nas:/vol1/1000/apps/AIClient2API/configs/plugins.json

   # 4) 恢复号池配置与开关并启动 NAS 服务
   node scripts/restore-baseline-pools.mjs
   ```

3. **回退后必检验收**：
   ```bash
   ssh nas "cd /vol1/1000/apps/AIClient2API && systemctl is-active aiclient2api && node -e \"const p=JSON.parse(require('fs').readFileSync('configs/provider_pools.json','utf8')); for(const [k,v] of Object.entries(p)) console.log(k, 'total:', v.length, 'enabled:', v.filter(x=>!x.isDisabled).length, 'disabled:', v.filter(x=>x.isDisabled).length, 'healthy:', v.filter(x=>x.isHealthy).length);\""
   ```
   验收期望输出：`aiclient2api` 为 `active`，且节点数量与开关状态严格匹配上述基准（`claude-kiro-oauth` 16/16 启用、`openai-codex-oauth` 9/9 启用、`grok-cli-oauth` 1/1 禁用、`grok-web` 1/1 禁用、`gemini-web` 1/1 启用、`yuanbao-web` 1/1 启用）；详细节点清单可对照 `configs/baselines/snapshot-2026-11-12/manifest.json`。

