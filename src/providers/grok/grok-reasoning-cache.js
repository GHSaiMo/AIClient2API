/**
 * Grok / xAI 思考重放缓存系统 (Reasoning Replay Cache)
 * 
 * 借鉴 CLIProxyAPI (xai_reasoning_replay.go) 机制：
 * xAI Responses API 会在上游返回带有 encrypted_content 的加密思考块或摘要。
 * 当下游客户端（如 Claude 协议客户端或标准 OpenAI ChatClient）在下一轮对话发送历史时，
 * 通常会丢弃这些加密字段，导致上游模型缓存失效、思考能力退化或重复思考。
 * 
 * 该模块负责在本地缓存上游生成的加密 Reasoning Item，并在后续对话中自动安全重放补全，
 * 同时提供租户隔离与 TTL 清理。
 */

import crypto from 'crypto';
import logger from '../../utils/logger.js';

class GrokReasoningCacheManager {
    constructor(options = {}) {
        this.cache = new Map(); // key -> { items, timestamp }
        this.ttlMs = options.ttlMs || 30 * 60 * 1000; // 30 分钟默认 TTL
        this.maxEntries = options.maxEntries || 2000;
    }

    /**
     * 构建隔离的会话键
     * @param {string} callerId - 下游 API Key 或客户端标识
     * @param {string} sessionKey - 对话会话键或历史哈希
     * @param {string} model - 模型名称
     * @returns {string}
     */
    buildScopedKey(callerId, sessionKey, model) {
        const callerHash = callerId ? crypto.createHash('sha256').update(callerId).digest('hex').slice(0, 12) : 'global';
        const cleanSession = (sessionKey || '').trim() || 'default_session';
        const cleanModel = (model || '').trim().toLowerCase() || 'grok';
        return `${callerHash}:${cleanModel}:${cleanSession}`;
    }

    /**
     * 从消息历史生成稳定的会话键
     * @param {Array} messages 
     * @returns {string}
     */
    generateSessionKeyFromMessages(messages) {
        if (!Array.isArray(messages) || messages.length === 0) return 'empty';
        // 使用首条消息内容生成稳定键
        const firstMsg = messages[0];
        const text = typeof firstMsg.content === 'string' ? firstMsg.content : JSON.stringify(firstMsg.content);
        return crypto.createHash('sha256').update(text.slice(0, 300)).digest('hex').slice(0, 16);
    }

    /**
     * 缓存思考重放项
     * @param {string} scopedKey 
     * @param {Array<Object>} items - 思考项列表
     */
    set(scopedKey, items) {
        if (!scopedKey || !Array.isArray(items) || items.length === 0) return;

        // LRU 简易容量控制
        if (this.cache.size >= this.maxEntries) {
            const oldestKey = this.cache.keys().next().value;
            this.cache.delete(oldestKey);
        }

        this.cache.set(scopedKey, {
            items: items.map(item => ({ ...item })),
            timestamp: Date.now()
        });

        logger.debug(`[Grok Reasoning Cache] Cached ${items.length} item(s) for key: ${scopedKey}`);
    }

    /**
     * 获取缓存的思考项
     * @param {string} scopedKey 
     * @returns {Array<Object>|null}
     */
    get(scopedKey) {
        if (!scopedKey || !this.cache.has(scopedKey)) return null;

        const entry = this.cache.get(scopedKey);
        if (Date.now() - entry.timestamp > this.ttlMs) {
            this.cache.delete(scopedKey);
            return null;
        }

        return entry.items;
    }

    /**
     * 清理会话缓存
     * @param {string} scopedKey 
     */
    delete(scopedKey) {
        if (scopedKey) this.cache.delete(scopedKey);
    }

    /**
     * 在请求输入中应用思考重放项
     * 如果请求中已有 reasoning 项则跳过，否则自动在最新用户指令前或对应 assistant 轮次注入
     * @param {Array<Object>} inputItems - Responses API 的 input 数组
     * @param {string} scopedKey 
     * @returns {Array<Object>} 注入后的 input 数组
     */
    applyReplayToInput(inputItems, scopedKey) {
        if (!Array.isArray(inputItems) || inputItems.length === 0) return inputItems;

        const cachedItems = this.get(scopedKey);
        if (!cachedItems || cachedItems.length === 0) return inputItems;

        // 检查 input 中是否已经存在 reasoning 类型的项目
        const hasReasoning = inputItems.some(item => 
            item && (item.type === 'reasoning' || item.type === 'thought')
        );

        if (hasReasoning) {
            return inputItems;
        }

        // 寻找最后一个 assistant 消息位置或首个位置插入
        logger.info(`[Grok Reasoning Cache] Replaying ${cachedItems.length} reasoning item(s) for key: ${scopedKey}`);
        
        const result = [];
        let injected = false;

        for (let i = 0; i < inputItems.length; i++) {
            const item = inputItems[i];
            if (!injected && (item.role === 'assistant' || item.type === 'message' && item.role === 'assistant')) {
                result.push(...cachedItems);
                injected = true;
            }
            result.push(item);
        }

        if (!injected) {
            // 在末尾项之前插入
            if (result.length > 1) {
                result.splice(result.length - 1, 0, ...cachedItems);
            } else {
                result.unshift(...cachedItems);
            }
        }

        return result;
    }
}

export const grokReasoningCache = new GrokReasoningCacheManager();
