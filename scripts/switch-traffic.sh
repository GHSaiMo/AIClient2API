#!/usr/bin/env bash
#
# scripts/switch-traffic.sh
# AIClient2API 双端流量调度与一键切换工具 (Mac Local <-> NAS Production)
#
set -e

PROJECT_DIR="/Users/hal9000/Projects/AIClient2API"
LOCAL_MODE_FILE="${PROJECT_DIR}/.local_mode"
TMUX_BRIDGE_SESSION="lan-proxy-bridge"
TMUX_LOCAL_SESSION="aiclient2api-local"
PORT=3005

restart_bridge() {
    echo "🔄 正在通知 lan-proxy-bridge 重新加载路由规则..."
    if tmux has-session -t "${TMUX_BRIDGE_SESSION}" 2>/dev/null; then
        tmux send-keys -t "${TMUX_BRIDGE_SESSION}" C-c
        sleep 1
        tmux send-keys -t "${TMUX_BRIDGE_SESSION}" "python3 /Users/hal9000/Projects/tmux/bin/lan_proxy_bridge.py" Enter
        sleep 1.5
    else
        echo "⚠️  Tmux 会话 ${TMUX_BRIDGE_SESSION} 未运行，请检查服务。"
    fi
}

get_port_owner() {
    lsof -n -P -iTCP:${PORT} -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $1, "(PID:" $2 ")"}' | head -n 1
}

switch_to_local() {
    echo "=========================================="
    echo "🚀 正在切换流量目标至: [Mac 本地开发版]"
    echo "=========================================="

    # 1. 创建本地标识文件
    touch "${LOCAL_MODE_FILE}"
    echo "✅ 已启用本地模式标识: ${LOCAL_MODE_FILE}"

    # 2. 重启 Bridge，释放 3005 端口
    restart_bridge

    # 3. 检查端口是否已释放
    local retries=5
    while [ $retries -gt 0 ]; do
        local owner=$(get_port_owner)
        if [ -z "$owner" ]; then
            break
        fi
        echo "⏳ 等待端口 ${PORT} 释放 (当前占用: ${owner})..."
        sleep 1
        retries=$((retries - 1))
    done

    # 4. 启动本地 AIClient2API 服务
    local start_cmd="npm start"
    if command -v bun >/dev/null 2>&1 || [ -x "$HOME/.bun/bin/bun" ]; then
        start_cmd="bun run start"
    fi

    if tmux has-session -t "${TMUX_LOCAL_SESSION}" 2>/dev/null; then
        echo "🔄 重启已有本地 Tmux 会话: ${TMUX_LOCAL_SESSION}"
        tmux send-keys -t "${TMUX_LOCAL_SESSION}" C-c
        sleep 1
        tmux send-keys -t "${TMUX_LOCAL_SESSION}" "cd ${PROJECT_DIR} && export PATH=\"\$HOME/.bun/bin:\$PATH\" && ${start_cmd}" Enter
    else
        echo "🚀 创建新 Tmux 会话启动本地服务: ${TMUX_LOCAL_SESSION}"
        tmux new-session -d -s "${TMUX_LOCAL_SESSION}" "bash -c 'cd ${PROJECT_DIR} && export PATH=\"\$HOME/.bun/bin:\$PATH\" && ${start_cmd}; exec bash'"
    fi

    # 5. 等待本地服务就绪
    echo "⏳ 等待本地服务初始化..."
    local ready=0
    for i in {1..15}; do
        if curl -s -m 2 http://127.0.0.1:${PORT}/v1/models >/dev/null 2>&1 || curl -s -m 2 http://127.0.0.1:${PORT}/ >/dev/null 2>&1; then
            ready=1
            break
        fi
        sleep 1
    done

    if [ $ready -eq 1 ]; then
        echo "=========================================="
        echo "🎉 切换成功！当前 127.0.0.1:${PORT} 已由 Mac 本地服务提供"
        echo "   - 运行进程: $(get_port_owner)"
        echo "   - 查看日志: tmux attach -t ${TMUX_LOCAL_SESSION}"
        echo "   - 切回命令: ./scripts/switch-traffic.sh nas"
        echo "=========================================="
    else
        echo "❌ 本地服务启动超时，请检查 Tmux 日志: tmux attach -t ${TMUX_LOCAL_SESSION}"
        exit 1
    fi
}

switch_to_nas() {
    echo "=========================================="
    echo "🛡️  正在切换流量目标至: [NAS 线上生产版]"
    echo "=========================================="

    # 1. 停止本地 Node 服务
    if tmux has-session -t "${TMUX_LOCAL_SESSION}" 2>/dev/null; then
        echo "🛑 正在停止本地 Tmux 服务: ${TMUX_LOCAL_SESSION}"
        tmux kill-session -t "${TMUX_LOCAL_SESSION}" 2>/dev/null || true
    fi

    # 杀死可能残留的本地 3005 进程
    local pids=$(lsof -tiTCP:${PORT} -sTCP:LISTEN 2>/dev/null || true)
    if [ -n "$pids" ]; then
        for pid in $pids; do
            local cmd=$(ps -p $pid -o comm= 2>/dev/null || true)
            if [[ "$cmd" == *"node"* || "$cmd" == *"bun"* ]]; then
                echo "🛑 杀死残留本地 Node/Bun 进程 (PID: $pid)"
                kill -9 $pid 2>/dev/null || true
            fi
        done
        sleep 1
    fi

    # 2. 移除本地模式标识文件
    rm -f "${LOCAL_MODE_FILE}"
    echo "✅ 已移除本地模式标识文件"

    # 3. 重启 Bridge，接管 3005 转发到 NAS
    restart_bridge

    # 4. 验证中继到 NAS 的连通性
    echo "⏳ 验证 NAS 生产服务中继连通性..."
    local ready=0
    for i in {1..10}; do
        if curl -s -m 2 http://127.0.0.1:${PORT}/v1/models >/dev/null 2>&1 || curl -s -m 2 http://127.0.0.1:${PORT}/ >/dev/null 2>&1; then
            ready=1
            break
        fi
        sleep 1
    done

    if [ $ready -eq 1 ]; then
        echo "=========================================="
        echo "🎉 切换成功！当前 127.0.0.1:${PORT} 已恢复透明中继到 NAS (192.168.50.39:${PORT})"
        echo "   - 转发中继: $(get_port_owner)"
        echo "   - 查看 NAS 日志: tmux attach -t aiclient2api"
        echo "=========================================="
    else
        echo "⚠️  未能探测到服务响应，请检查 NAS 端服务状态: ssh nas 'systemctl status aiclient2api'"
        exit 1
    fi
}

show_status() {
    echo "=========================================="
    echo "📊 AIClient2API 当前流量与端口状态"
    echo "=========================================="
    local owner=$(get_port_owner)
    echo "  - 监听端口: 127.0.0.1:${PORT}"
    echo "  - 占用进程: ${owner:-[未监听]}"

    if [ -f "${LOCAL_MODE_FILE}" ]; then
        echo "  - 目标模式: 💻 [Mac 本地开发分支 (feat/undici-client-migration)]"
        if tmux has-session -t "${TMUX_LOCAL_SESSION}" 2>/dev/null; then
            echo "  - 本地 Tmux: 运行中 (tmux attach -t ${TMUX_LOCAL_SESSION})"
        else
            echo "  - 本地 Tmux: ⚠️ 未找到 ${TMUX_LOCAL_SESSION} 会话"
        fi
    else
        echo "  - 目标模式: 🏠 [NAS 生产稳定分支 (main @ 192.168.50.39:3005)]"
        echo "  - 中继状态: 由 lan-proxy-bridge 透明转发"
    fi

    echo ""
    echo "🌐 健康探测:"
    if curl -s -m 2 http://127.0.0.1:${PORT}/ >/dev/null 2>&1; then
        echo "  - HTTP 根端点: ✅ 正常 (200 OK)"
    else
        echo "  - HTTP 根端点: ❌ 异常"
    fi
    echo "=========================================="
}

case "$1" in
    local)
        switch_to_local
        ;;
    nas)
        switch_to_nas
        ;;
    status)
        show_status
        ;;
    *)
        echo "用法: $0 {local|nas|status}"
        echo ""
        echo "  local  - 切换流量至 Mac 本地开发服务 (释放 3005 转发并启动本地服务)"
        echo "  nas    - 切换流量至 NAS 生产服务 (停止本地服务并恢复 3005 转发到 NAS)"
        echo "  status - 查看当前流量指向与服务状态"
        exit 1
        ;;
esac
