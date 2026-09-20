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
   - 请求本地 Go Sidecar（`http://127.0.0.1:9090`）必须使用本地原生 `http.Agent` 并设置 `proxy: false`，严禁通过外部代理访问 Sidecar。
   - 二进制驱动：`tls-sidecar` 在 `src/utils/tls-sidecar.js` 中已支持跨平台动态自适应（Mac 自动匹配 `tls-sidecar-darwin-arm64`，NAS 自动匹配 `tls-sidecar-linux-amd64`）。
4. **Git 版本控制双端同步**：
   - NAS 端拥有完整 Git 仓库与 GitHub SSH 免密推送权限。
   - 在 NAS 端修改并验证后：
     `ssh nas "cd /vol1/1000/apps/AIClient2API && git add . && git commit -m '...' && git push origin main"`
   - 随后在 Mac 本地目录拉取同步：
     `cd /Users/hal9000/Projects/AIClient2API && git pull origin main`

## 2. 常用开发与测试命令

```bash
# 启动本地服务（如在 Mac 本地测试）
npm start

# 检查服务健康状态
curl http://127.0.0.1:3005/
```
