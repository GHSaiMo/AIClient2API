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
