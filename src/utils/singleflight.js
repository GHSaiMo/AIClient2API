/**
 * Singleflight 并发请求合并器 (Go singleflight.Group 的 Node.js 实现)
 * 
 * 借鉴 CLIProxyAPI 机制：
 * 在多并发请求同时触发相同操作（如特定节点的 OAuth Token 刷新）时，
 * 仅允许一个底层异步任务执行，其余并发调用共享同一个 Promise 结果。
 * 执行完成后自动清理状态，彻底杜绝并发刷新导致的 OAuth Rate Limit 与写文件冲突。
 */

export class SingleflightGroup {
    constructor() {
        this.calls = new Map(); // key -> Promise
    }

    /**
     * 执行操作并合并并发重复调用
     * @param {string} key - 操作唯一键（如 'refresh:uuid_123'）
     * @param {Function} fn - 返回 Promise 的异步执行函数
     * @returns {Promise<any>}
     */
    async do(key, fn) {
        if (!key) {
            return await fn();
        }

        if (this.calls.has(key)) {
            return await this.calls.get(key);
        }

        const promise = (async () => {
            try {
                return await fn();
            } finally {
                this.calls.delete(key);
            }
        })();

        this.calls.set(key, promise);
        return await promise;
    }

    /**
     * 当前正在执行的 Singleflight 任务数量
     * @returns {number}
     */
    get activeCount() {
        return this.calls.size;
    }

    /**
     * 清理所有在途状态
     */
    reset() {
        this.calls.clear();
    }
}

export const globalSingleflight = new SingleflightGroup();
