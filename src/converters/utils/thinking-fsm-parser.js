/**
 * 3-State FSM 思考流解析器 (Finite State Machine Thinking Stream Parser)
 * 
 * 借鉴 kiro-gateway thinking_parser.py 机制：
 * 解决流式输出中 `<thinking>` 和 `</thinking>` 标签跨 Chunk 截断导致标签泄漏或思考内容错位的问题。
 * 
 * 3 种状态：
 * 0: BEFORE_THINKING - 处于前置文本区，等待 <thinking> 标签
 * 1: IN_THINKING     - 处于思考区，产出 thinking 事件
 * 2: AFTER_THINKING  - 处于思考后文本区，产出 text 事件
 */

export const FSM_STATE = {
    BEFORE_THINKING: 0,
    IN_THINKING: 1,
    AFTER_THINKING: 2
};

const START_TAG = '<thinking>';
const END_TAG = '</thinking>';
const MAX_TAG_LEN = Math.max(START_TAG.length, END_TAG.length);

export class ThinkingStreamFSM {
    constructor(options = {}) {
        this.state = FSM_STATE.BEFORE_THINKING;
        this.buffer = '';
        this.stripLeadingNewline = options.stripLeadingNewline !== false;
        this._hasEncounteredThinking = false;
        this.collectedThinking = '';
        this.collectedText = '';
    }

    /**
     * 检查当前 buffer 末尾是否存在潜在标签前缀（跨 Chunk 缓冲检测）
     * @param {string} text 
     * @param {string} targetTag 
     * @returns {number} 潜在前缀的长度，0 表示无潜在前缀
     */
    _findPotentialTagPrefixLen(text, targetTag) {
        for (let i = 1; i < targetTag.length; i++) {
            const prefix = targetTag.slice(0, i);
            if (text.endsWith(prefix)) {
                return prefix.length;
            }
        }
        return 0;
    }

    /**
     * 喂入新到达的文本 Chunk 并返回解析后的事件列表
     * @param {string} chunk 
     * @returns {Array<{ type: 'thinking'|'text', content: string }>}
     */
    feed(chunk) {
        if (!chunk) return [];
        this.buffer += chunk;
        const events = [];

        let keepLooping = true;
        while (keepLooping && this.buffer.length > 0) {
            switch (this.state) {
                case FSM_STATE.BEFORE_THINKING: {
                    const startIdx = this.buffer.indexOf(START_TAG);
                    if (startIdx !== -1) {
                        // 发现完整 <thinking> 标签
                        const before = this.buffer.slice(0, startIdx);
                        if (before) {
                            events.push({ type: 'text', content: before });
                            this.collectedText += before;
                        }
                        this.buffer = this.buffer.slice(startIdx + START_TAG.length);
                        // 去除紧随 <thinking> 后的单个换行
                        if (this.stripLeadingNewline) {
                            if (this.buffer.startsWith('\r\n')) this.buffer = this.buffer.slice(2);
                            else if (this.buffer.startsWith('\n')) this.buffer = this.buffer.slice(1);
                        }
                        this.state = FSM_STATE.IN_THINKING;
                        this._hasEncounteredThinking = true;
                    } else {
                        // 检查是否存在跨 Chunk 的部分 <thinking> 标签前缀（如 "<th"）
                        const prefixLen = this._findPotentialTagPrefixLen(this.buffer, START_TAG);
                        if (prefixLen > 0) {
                            const safeLen = this.buffer.length - prefixLen;
                            if (safeLen > 0) {
                                const safePart = this.buffer.slice(0, safeLen);
                                events.push({ type: 'text', content: safePart });
                                this.collectedText += safePart;
                                this.buffer = this.buffer.slice(safeLen);
                            }
                            keepLooping = false; // 剩余部分暂留 buffer 待下一 chunk 判定
                        } else {
                            // 纯正常文本，全部发出
                            events.push({ type: 'text', content: this.buffer });
                            this.collectedText += this.buffer;
                            this.buffer = '';
                        }
                    }
                    break;
                }

                case FSM_STATE.IN_THINKING: {
                    const endIdx = this.buffer.indexOf(END_TAG);
                    if (endIdx !== -1) {
                        // 发现完整 </thinking> 标签
                        const thinkingContent = this.buffer.slice(0, endIdx);
                        if (thinkingContent) {
                            events.push({ type: 'thinking', content: thinkingContent });
                            this.collectedThinking += thinkingContent;
                        }
                        this.buffer = this.buffer.slice(endIdx + END_TAG.length);
                        // 去除紧随 </thinking> 后的单个换行
                        if (this.stripLeadingNewline) {
                            if (this.buffer.startsWith('\r\n')) this.buffer = this.buffer.slice(2);
                            else if (this.buffer.startsWith('\n')) this.buffer = this.buffer.slice(1);
                        }
                        this.state = FSM_STATE.AFTER_THINKING;
                    } else {
                        // 检查是否存在跨 Chunk 的部分 </thinking> 标签前缀
                        const prefixLen = this._findPotentialTagPrefixLen(this.buffer, END_TAG);
                        if (prefixLen > 0) {
                            const safeLen = this.buffer.length - prefixLen;
                            if (safeLen > 0) {
                                const safePart = this.buffer.slice(0, safeLen);
                                events.push({ type: 'thinking', content: safePart });
                                this.collectedThinking += safePart;
                                this.buffer = this.buffer.slice(safeLen);
                            }
                            keepLooping = false;
                        } else {
                            events.push({ type: 'thinking', content: this.buffer });
                            this.collectedThinking += this.buffer;
                            this.buffer = '';
                        }
                    }
                    break;
                }

                case FSM_STATE.AFTER_THINKING: {
                    events.push({ type: 'text', content: this.buffer });
                    this.collectedText += this.buffer;
                    this.buffer = '';
                    break;
                }
            }
        }

        return events;
    }

    /**
     * 流结束时冲刷剩余 buffer
     * @returns {Array<{ type: 'thinking'|'text', content: string }>}
     */
    flush() {
        if (!this.buffer) return [];
        const remaining = this.buffer;
        this.buffer = '';

        if (this.state === FSM_STATE.IN_THINKING) {
            this.collectedThinking += remaining;
            return [{ type: 'thinking', content: remaining }];
        } else {
            this.collectedText += remaining;
            return [{ type: 'text', content: remaining }];
        }
    }

    /**
     * 静态辅助方法：全量字符串解析
     * @param {string} fullText 
     * @returns {{ thinking: string, text: string }}
     */
    static parseAll(fullText) {
        const fsm = new ThinkingStreamFSM();
        fsm.feed(fullText);
        fsm.flush();
        return {
            thinking: fsm.collectedThinking,
            text: fsm.collectedText
        };
    }
}
