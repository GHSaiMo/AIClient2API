/**
 * Kiro 上游物理截断自愈恢复系统 (Truncation Recovery System)
 * 
 * 借鉴 kiro-gateway (Issue #56 解决方案)：
 * AWS CodeWhisperer/Kiro API 对单次请求的输出大小（尤其是大 Tool Call 或巨型代码块）有物理硬限制，
 * 会在流中途中断，导致下游 JSON 缺少闭合括号或内容截断。
 * 
 * 该模块在流式异常中断时记录截断状态，在下一轮对话时自动合成带有 [API Limitation] 提示的
 * tool_result 或系统消息，明确告知大模型并非其本身逻辑错误，引导模型转为分步/分段操作，
 * 彻底消除 Agent 陷入“截断 -> 原样重试 -> 再次截断”的死循环。
 */

import crypto from 'crypto';
import logger from '../../utils/logger.js';

// 内存中的截断状态缓存
const toolTruncationCache = new Map();
const contentTruncationCache = new Map();

/**
 * 记录工具调用截断信息
 * @param {string} toolCallId - 工具调用 ID
 * @param {string} toolName - 工具名称
 * @param {Object} diagnostics - 诊断信息
 */
export function saveToolTruncation(toolCallId, toolName, diagnostics = {}) {
    if (!toolCallId) return;
    toolTruncationCache.set(toolCallId, {
        toolCallId,
        toolName: toolName || 'unknown_tool',
        diagnostics,
        timestamp: Date.now()
    });
    logger.debug(`[Kiro Truncation] Saved tool truncation for ${toolCallId} (${toolName})`);
}

/**
 * 获取并消费工具调用截断信息（单次消费即移除）
 * @param {string} toolCallId 
 * @returns {Object|null}
 */
export function getToolTruncation(toolCallId) {
    if (!toolCallId || !toolTruncationCache.has(toolCallId)) return null;
    const info = toolTruncationCache.get(toolCallId);
    toolTruncationCache.delete(toolCallId);
    return info;
}

/**
 * 记录文本内容截断信息
 * @param {string} content 
 * @returns {string} contentHash
 */
export function saveContentTruncation(content) {
    if (!content || typeof content !== 'string') return '';
    const preview = content.slice(0, 500);
    const hash = crypto.createHash('sha256').update(preview).digest('hex').slice(0, 16);
    contentTruncationCache.set(hash, {
        hash,
        preview: preview.slice(0, 200),
        timestamp: Date.now()
    });
    logger.debug(`[Kiro Truncation] Saved content truncation for hash ${hash}`);
    return hash;
}

/**
 * 获取并消费内容截断信息
 * @param {string} content 
 * @returns {Object|null}
 */
export function getContentTruncation(content) {
    if (!content || typeof content !== 'string') return null;
    const preview = content.slice(0, 500);
    const hash = crypto.createHash('sha256').update(preview).digest('hex').slice(0, 16);
    if (!contentTruncationCache.has(hash)) return null;
    const info = contentTruncationCache.get(hash);
    contentTruncationCache.delete(hash);
    return info;
}

/**
 * 生成合成的工具截断错误结果
 * @param {string} toolName 
 * @param {string} toolUseId 
 * @param {Object} diagnostics 
 * @returns {Object}
 */
export function generateTruncationToolResult(toolName, toolUseId, diagnostics = {}) {
    const content = (
        `[API Limitation] Your tool call '${toolName || 'tool'}' was truncated by the upstream API due to output size limits.\n\n` +
        `If the execution resulted in an error or unexpected behavior, this is a DIRECT CONSEQUENCE of the output truncation, ` +
        `not your internal logic. The tool call payload was cut off before it could be fully transmitted.\n\n` +
        `Repeating the exact same operation will be truncated again. Please adapt your approach (for example, split the file write/edit into smaller chunks or use pagination).`
    );

    return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content,
        is_error: true
    };
}

/**
 * 生成合成的内容截断系统提示
 * @returns {string}
 */
export function generateTruncationUserMessage() {
    return (
        `[System Notice] Your previous response was truncated by the API due to output size limitations. ` +
        `This is not an error on your part. If you need to continue, please adapt your approach ` +
        `(e.g., generate in smaller sections or write incrementally) rather than repeating the exact same output.`
    );
}

/**
 * 检查并注入截断恢复消息
 * 遍历传入的消息列表，如果发现上一轮的 tool_use 被记录为截断，自动增强对应的 tool_result
 * @param {Array} messages 
 * @returns {Array} 处理后的消息列表
 */
export function injectTruncationRecovery(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return messages;

    return messages.map(msg => {
        if (!msg) return msg;

        // 如果是包含 tool_result 的 user 消息
        if (msg.role === 'user' && Array.isArray(msg.content)) {
            let modified = false;
            const newContent = msg.content.map(part => {
                if (part && part.type === 'tool_result' && part.tool_use_id) {
                    const truncation = getToolTruncation(part.tool_use_id);
                    if (truncation) {
                        modified = true;
                        logger.info(`[Kiro Truncation] Injected synthetic recovery into tool_result for ${part.tool_use_id}`);
                        const synthetic = generateTruncationToolResult(truncation.toolName, part.tool_use_id, truncation.diagnostics);
                        const existingText = typeof part.content === 'string' ? part.content : JSON.stringify(part.content);
                        return {
                            ...part,
                            content: `${synthetic.content}\n\n[Original Execution Result]:\n${existingText}`,
                            is_error: true
                        };
                    }
                }
                return part;
            });

            if (modified) {
                return { ...msg, content: newContent };
            }
        }

        return msg;
    });
}
