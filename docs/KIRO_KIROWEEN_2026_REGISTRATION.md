# Kiroween 2026 黑客松参赛与 Kiro 双账号登记档案

> **登记时间**：2026-11-01 18:24 (UTC+8)  
> **所属项目**：AIClient2API (`/Users/hal9000/Projects/AIClient2API`)  
> **关联目标**：储备 AWS Kiro 平台 4,000 × 2 = **8,000 Credits**（总价值约 **$320**）正价大模型算力，用于支持 AIClient2API 的上游 Provider 代理与逆向协议调度（Claude 3.5 Sonnet / Claude 3 Opus / GPT-5 等）。

---

## 1. 活动概况与核心指标

| 项目 | 内容 |
| :--- | :--- |
| **活动全称** | Kiroween 2026 Hackathon (AWS Kiro 万圣节年度黑客松) |
| **奖金池** | $100,000 USD |
| **参赛津贴** | **4,000 Kiro Credits / 账号**（相当于官方加购价 **$160 / 账号**，折合各 2 个月 Pro+ 额度） |
| **支持模型** | Claude 全家桶（Claude 3.5 Sonnet, Claude 3 Opus）、GPT-5 正价原生不缩水 |
| **申请截止** | **2026 年 12 月 2 日 04:00 (北京时间)** |
| **额度到账周期** | 提交申请后 48 个工作小时内（约 2 个工作日） |
| **额度有效期** | **截至 2026 年 12 月 31 日**（过期清零，需在年底前消费） |
| **官方报名入口** | [https://kiroween.devpost.com/](https://kiroween.devpost.com/) |
| **Kiro Web 控制台**| [https://app.kiro.dev/](https://app.kiro.dev/) |
| **津贴申领表单** | [Kiroween 2026 Credits Request Form (Google Forms)](https://docs.google.com/forms/d/e/1FAIpQLSftsMeJiN3UlSplnFlQ84hHFGEW9v-eQvAs5FdTJU6zfwNrog/viewform) |

---

## 2. 已成功注册并提交的账号矩阵 (Account Matrix)

已在 Ego Lite 浏览器中完成 **Devpost 独立参赛报名** 与 **Google 官方津贴表单** 的双重核验提交，两个账号各自具备完全独立的 Entrant 参赛身份与 Kiro User ID。

| 账号编号 | 主邮箱 / Google 账号 | Devpost 参赛用户名 | Devpost 参赛主页 | Kiro 授权方式 | 生效 Kiro User ID | 选定赛道分类 | 申领状态 |
| :---: | :--- | :--- | :--- | :--- | :--- | :--- | :---: |
| **01** | `taojiuzhen@gmail.com` | `GHSaiMo` | [devpost.com/GHSaiMo](https://devpost.com/GHSaiMo) | GitHub OAuth | `d-9067c98495.f4e80448-9091-70e4-f790-a5074d9cddfb` | `Category: Resurrection` | ✅ 您的回复已记录 |
| **02** | `taoxy0305@gmail.com` | `taoxy0305` | [devpost.com/taoxy0305](https://devpost.com/taoxy0305) | Google OAuth | `d-9067c98495.6438d4d8-b0e1-70a7-4a09-708ce0b136c2` | `Category: Frankenstein` | ✅ 您的回复已记录 |

---

## 3. 详细账号档案与表单快照

### 3.1 账号 01 (`taojiuzhen@gmail.com`)

* **Devpost 身份**：`GHSaiMo`（单人参赛，地区 United States）
* **Kiro 登录方式**：GitHub 授权登录
* **Kiro User ID**：`d-9067c98495.f4e80448-9091-70e4-f790-a5074d9cddfb`
* **申报赛道与项目**：
  * Category: Resurrection
  * Project Idea: Planning to build a modern AI-powered terminal workspace that revives classic text-mode UI (TUI) tools using Kiro's spec-driven development and parallel agent workflows.
* **审核通知邮箱**：`taojiuzhen@gmail.com`

### 3.2 账号 02 (`taoxy0305@gmail.com`)

* **Devpost 身份**：`taoxy0305`（单人参赛，地区 United States）
* **Kiro 登录方式**：Google 授权登录
* **Kiro User ID**：`d-9067c98495.6438d4d8-b0e1-70a7-4a09-708ce0b136c2`
* **申报赛道与项目**：
  * Category: Frankenstein
  * Project Idea: Planning to build a multi-agent orchestration pipeline connecting legacy CLI tools with modern reasoning LLMs using Kiro's spec-driven development.
* **审核通知邮箱**：`taoxy0305@gmail.com`

---

## 4. 与 AIClient2API 项目的集成指引

当两笔 4,000 Credits 到账后，将获得合计 **8,000 Credits**，可作为 AIClient2API 的高质量双节点轮询池：

1. **凭证提取与本地轮询**：
   * 将两组 Session Cookie / JWT 鉴权 Token 分别保存于：
     * `AIClient2API/.cookies/kiro_account_1.json` (`taojiuzhen`)
     * `AIClient2API/.cookies/kiro_account_2.json` (`taoxy0305`)
   * 通过多账号负载均衡器实现请求轮询与故障转移（Failover）。
2. **Provider 适配层路由**：
   * `kiro/claude-3-5-sonnet` -> AWS 原生 Claude 3.5 Sonnet
   * `kiro/claude-3-opus` -> AWS 原生 Claude 3 Opus
   * `kiro/gpt-5` -> 原生 GPT-5 接口
3. **有效期风控**：
   * 两笔积分均将于 **2026-12-31** 强制过期，建议在 11 月与 12 月中下旬作为高并发或复杂代码生成任务的主力消耗源。
