# 🚀 快速开始
省流，新手看这里就行

## 下载一个有脚本功能的手机浏览器

推荐[下载 Via](https://viayoo.com/zh-cn/)，简单且轻量


## 进入 Via
找到**设置**、**脚本**并进入，点击右上角加号，推荐使用**下载脚本**。

按需安装即可，也可以两个都安装：
**对话管理增强**：
[点击查看介绍](#ds-enhance-对话管理)
```
https://gh-proxy.com/https://raw.githubusercontent.com/conch-6/DeepseekWeb-enhance-Termux/main/ds-enhance.user.js
```
**MCP**：
[点击查看介绍](#ds-mcp-bridge-mcp-工具调用-tts-朗读)
```
https://gh-proxy.com/https://raw.githubusercontent.com/conch-6/DeepseekWeb-enhance-Termux/main/ds-mcp-bridge.user.js
```

3. 打开 chat.deepseek.com 或 chatgpt.com，页面中出现悬浮按钮即安装成功

---

## 运行mcp需要终端环境，推荐 [Termux](https://github.com/termux/termux-app)
注：仅使用**对话管理增强**不使用**MCP**的话，直接跳过这一步即可，就可以直接用了。

依次执行：
```
git clone https://github.com/conch-6/DeepseekWeb-enhance-Termux && cd DeepseekWeb-enhance-Termux
```
```
cd server
```
```
pip install -r requirements.txt
```
```
python server.py
```

---

# 以下为原仓库内容

# DS Enhance

多站点 AI Chat 浏览器增强工具集。包含两个独立脚本，共享基础设施。

## 项目概览

| 脚本 | 定位 | 按钮颜色 |
|------|------|---------|
| [**ds-enhance**](./ds-enhance.user.js) | 对话管理增强（删除、Fork、分类、搜索、导出、重命名） | 蓝色 |
| [**ds-mcp-bridge**](./ds-mcp-bridge.user.js) | MCP 工具调用 + TTS 朗读 + 多站点适配（DeepSeek / ChatGPT） | 绿色 |

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展
2. 在 Tampermonkey 中新建脚本，粘贴对应 `.user.js` 文件内容并保存
3. 打开 [chat.deepseek.com](https://chat.deepseek.com) 或 [chatgpt.com](https://chatgpt.com)，页面左下角出现悬浮按钮即安装成功

---

## DS Enhance — 对话管理
[返回之前阅读的位置](#进入-via)
### 功能

| 功能 | 说明 |
|------|------|
| **批量删除** | 勾选多个对话一键删除，支持清空全部 |
| **Fork 对话** | 完整复制对话，或从指定消息节点开始分支 |
| **会话分类** | 创建自定义标签，给对话打分类（数据存本地，支持导入/导出） |
| **搜索** | 按标题实时搜索对话历史 |
| **导出** | 导出对话为 JSON 或 Markdown 文件 |
| **批量重命名** | 直接重命名、添加前缀/后缀、查找替换、序号命名 |

**快捷键：** `Ctrl+Shift+D` 切换面板

<img width="1102" height="662" alt="图片" src="https://github.com/user-attachments/assets/371ae615-d054-47f5-a7de-b2d8d9b696c4" />

<img width="1080" height="608" alt="2026-04-25 20-58-07(1)" src="https://github.com/user-attachments/assets/8a4f1eb3-b3fb-4ced-b613-d0d001d41625" />


### 技术原理

通过 Bearer Token（从 `localStorage.userToken` 读取）调用 DeepSeek 内部 API：

- `POST /api/v0/chat_session/delete` — 删除对话
- `POST /api/v0/chat_session/update_title` — 重命名
- `GET /api/v0/chat_session/fetch_page` — 获取对话列表
- `GET /api/v0/chat/history_messages` — 获取消息历史
- `POST /api/v0/share/create` + `POST /api/v0/share/fork` — Fork 对话

---

## DS MCP Bridge — MCP 工具调用 + TTS 朗读
[返回之前阅读的位置](#进入-via)
让 AI Chat 具备调用本地工具的能力（执行 Shell 命令、读写文件、网络搜索等），并支持 TTS 语音朗读。

### 支持站点

| 站点 | 状态 |
|------|------|
| [chat.deepseek.com](https://chat.deepseek.com) | ✅ 完整支持 |
| [chatgpt.com](https://chatgpt.com) / [chat.openai.com](https://chat.openai.com) | 🔧 基础适配（开发中） |

### 架构

```
DeepSeek Chat (浏览器)
    ↓ SSE 流被油猴脚本拦截
    ↓ 检测到工具调用指令 (```mcp:tool_name```)
    ↓
MCP Server (localhost:8024)     ← 本地 Python 服务
    ↓ JSON-RPC 2.0
    ↓
工具执行 → 结果返回 → 注入对话
```

### 安装

1. 安装油猴脚本 `ds-mcp-bridge.user.js`（同上）
2. 启动本地 MCP 服务器：

```bash
cd server
pip install -r requirements.txt
python server.py
```

3. 在 DeepSeek 页面点击绿色齿轮按钮，确认连接状态为"已连接"

**快捷键：** `Ctrl+Shift+M` 切换面板

### 面板功能

| Tab | 说明 |
|-----|------|
| **状态** | 连接状态、已注册工具列表，支持重试/刷新 |
| **测试** | 选择工具 → 自动显示参数表单 → 执行 → 查看结果 |
| **MCP 服务器** | 预设工具市场、外部 MCP 服务器管理 |
| **设置** | MCP 地址、模块开关、TTS 配置（引擎/语音/自动朗读） |

### 内置工具

| 工具 | 说明 |
|------|------|
| `execute_command` | 执行 Shell 命令 |
| `get_cwd` | 获取当前工作目录 |
| `list_directory` | 列出目录内容 |
| `read_file` | 读取文件 |
| `write_file` | 写入文件 |
| `bing_search` | Bing 搜索（需配置 API Key） |
| `crawl_webpage` | 抓取网页内容 |

### 外部 MCP 服务器

除了内置工具，还可以接入任意外部 MCP 服务器。在 `server/mcp.json` 的 `mcpServers` 中配置即可：

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_xxx" }
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/docs"]
    },
    "my-remote": {
      "url": "http://192.168.1.100:3000/mcp"
    }
  }
}
```

支持两种传输方式：

| 传输方式 | 配置字段 | 说明 |
|---------|---------|------|
| **stdio** | `command` + `args` + `env` | 启动子进程，通过 stdin/stdout 通信（最常用） |
| **HTTP** | `url` + `headers` | 连接远程 MCP 服务器（支持 SSE） |

外部服务器的工具会自动合并到工具列表中，DeepSeek 可直接调用。

### 工具调用方式

在对话中让 DeepSeek 输出特定格式即可触发工具调用：

    请帮我执行以下工具：
    ```mcp:execute_command
    {"command": "ls -la"}
    ```

或开启"自动执行"模式后，直接用自然语言描述需求，由 DeepSeek 决定调用哪个工具。

---

### TTS 朗读

AI 回复旁显示 🔊 按钮，支持手动朗读和自动朗读。

| TTS 引擎 | 说明 | 配置 |
|---------|------|------|
| **Edge TTS** | 免费，无需 API Key，中文质量好 | 直接可用 |
| **OpenAI 兼容** | 支持 OpenAI、SiliconFlow 等任何兼容 API | 需配置 API Key / Base URL / 模型 |
| **自定义 HTTP** | 接入任意 TTS API | 需配置 URL / 请求模板 |

设置页支持语音筛选（按语言、性别），内置 21 个常用语音，连通 server 后加载完整 322 个语音列表。

### 模块开关

所有功能模块可独立开关：

| 模块 | 说明 |
|------|------|
| 🔧 MCP 工具调用 | 拦截 AI 回复并执行本地工具 |
| 🔊 TTS 朗读 | 显示朗读按钮 |
| 🔊 自动朗读 | AI 回复完成后自动播放（等待文本稳定后触发） |

### 工具结果文件化

当 AI 调用 `read_file` 或 `list_directory` 时，结果不会直接填满聊天窗口，而是作为文件上下文自动注入到下次对话请求中。

## 项目结构

```
ds-enhance/
├── ds-enhance.user.js      # 油猴脚本 — 对话管理增强 (~1064 行)
├── ds-mcp-bridge.user.js   # 油猴脚本 — MCP + TTS + 多站点适配 (~1680 行)
├── shared/
│   └── shared-header.js    # 共享基础设施（FAB、面板、toast、工具函数）
├── server/                 # MCP 服务器端
│   ├── server.py           # FastAPI 服务 (HTTP → JSON-RPC 2.0 → 工具)
│   ├── requirements.txt    # Python 依赖
│   ├── mcp.json            # 工具配置
│   └── tools/
│       ├── shell.py        # 本地文件和命令操作工具
│       ├── search.py       # 网络搜索和网页抓取工具
│       ├── mcp_external.py # 外部 MCP 服务器代理
│       ├── tts.py          # TTS 语音合成（Edge/OpenAI/HTTP）
│       └── file_processor.py # 文件处理（PDF/文本/图片）
├── README.md
├── CHANGELOG.md
└── LICENSE
```

## 开发

- `shared/shared-header.js` 是共享基础设施的参考源，两个脚本各自内联所需部分
- `server/` 可独立运行和测试：`python server.py` 启动后访问 `http://localhost:8024/health`
- 编辑 `.user.js` 后在 Tampermonkey 中刷新脚本即可

## TODO

### DS Enhance
- [ ] Fork 选择起点时增加助手回复预览
- [ ] 搜索支持日期范围过滤
- [ ] 导出 Markdown 支持树形分支结构
- [ ] 批量操作失败重试机制

### DS MCP Bridge
- [x] SSE 拦截（DeepSeek 原生 SSE 格式 + OpenAI 兼容格式）
- [x] 工具调用检测（正则 + flex match 双策略）
- [x] 工具调用结果自动注入对话
- [x] TTS 朗读（Edge / OpenAI 兼容 / 自定义 HTTP）
- [x] 自动朗读（文本稳定后自动播放）
- [x] 适配器架构（DeepSeek + ChatGPT 样板）
- [x] 模块开关（MCP / TTS / 自动朗读）
- [x] 工具结果文件化（read_file 结果自动注入上下文）
- [ ] 工具白名单/黑名单
- [x] 支持外部 MCP 服务器（stdio/HTTP 传输）
- [ ] 完善 ChatGPT 适配器选择器

## License

[GPL-3.0](./LICENSE)

## 致谢

- [MCP Bridge](https://github.com/WongJingGitt/mcp_bridge) — 本项目的 SSE 解析、请求拦截、工具注入等核心思路参考了 WongJingGitt 的 MCP Bridge 浏览器扩展，特此感谢
- [吾爱破解 — DeepSeek 结合 MCP 让 AI 操控你的电脑](https://www.52pojie.cn/forum.php?mod=viewthread&tid=2087748&highlight=deepseek%2B%BD%C5%B1%BE) — 参考帖子，提供了宝贵的思路

## 友情链接

[Linuxdo](https://linux.do)
