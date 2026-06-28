// ==UserScript==
// @name         DS MCP Bridge
// @namespace    https://github.com/calendar0917/ds-enhance
// @version      4.2.0
// @description  AI Chat 增强 — MCP 工具调用 + TTS 朗读 + 多站点适配
// @author       ds-enhance
// @match        https://chat.deepseek.com/*
// @match        https://chat.openai.com/*
// @match        https://chatgpt.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const SCRIPT_PREFIX = '[Bridge]';
  const DEFAULT_MCP_URL = 'http://localhost:8024/mcp';
  const TOOL_CALL_RE = /```mcp:([\w.-]+)\n([\s\S]*?)```/g;
  const SYSTEM_HINT_START = '[系统指令]';
  const SYSTEM_HINT_END = '[系统指令结束]';
  const AUTO_SEND_KEY = 'auto_send';
  const DEFAULT_AUTO_SEND = true;

  // ═══════════════════════════════════════════════════════════════
  //  Module Toggles (top-level so XHR/fetch hooks can access)
  // ═══════════════════════════════════════════════════════════════
  const MODULE_DEFAULTS = { mcp: true, tts: true, ttsAutoPlay: false };
  function getModuleEnabled(mod) { return GM_getValue('mod_' + mod, MODULE_DEFAULTS[mod]); }
  function setModuleEnabled(mod, val) { GM_setValue('mod_' + mod, val); }
  function getAutoSendEnabled() { return GM_getValue(AUTO_SEND_KEY, DEFAULT_AUTO_SEND); }

  // ═══════════════════════════════════════════════════════════════
  //  Adapter Registry — Multi-site support
  // ═══════════════════════════════════════════════════════════════
  const ADAPTERS = {
    deepseek: {
      id: 'deepseek',
      name: 'DeepSeek Chat',
      match: (url) => /chat\.deepseek\.com/.test(url),
      selectors: {
        assistantMessages: '.ds-markdown--block, [class*="markdown"]',
        inputBox: 'textarea, [contenteditable="true"][placeholder]',
      },
      getRequestPattern: () => /completion/,
    },
    chatgpt: {
      id: 'chatgpt',
      name: 'ChatGPT',
      match: (url) => /chat\.openai\.com|chatgpt\.com/.test(url),
      selectors: {
        assistantMessages: '[data-message-author-role="assistant"]',
        inputBox: 'textarea[id="prompt-textarea"], #prompt-textarea',
      },
      getRequestPattern: () => /backend-api\/conversation/,
    },
  };

  function detectAdapter() {
    const url = location.href;
    for (const [id, adapter] of Object.entries(ADAPTERS)) {
      if (adapter.match(url)) {
        console.log(`${SCRIPT_PREFIX} Detected adapter: ${adapter.name}`);
        return adapter;
      }
    }
    console.log(`${SCRIPT_PREFIX} No adapter matched for: ${url}`);
    return null;
  }

  const currentAdapter = detectAdapter();

  // ═══════════════════════════════════════════════════════════════
  //  File Context (tool results only — native upload handled by DS)
  // ═══════════════════════════════════════════════════════════════
  const _toolFiles = [];

  function addToolFileResult(filename, text, mimeType) {
    _toolFiles.push({ filename, _textContent: text, mime_type: mimeType || 'text/plain' });
  }

  function injectToolFileContext(bodyStr) {
    if (!_toolFiles.length || !bodyStr) return bodyStr;
    try {
      const parsed = JSON.parse(bodyStr);
      let ctx = '\n\n[上传文件内容]\n';
      for (const f of _toolFiles) {
        ctx += `\n--- ${f.filename} ---\n${f._textContent}\n`;
      }
      if (parsed.prompt && typeof parsed.prompt === 'string') {
        parsed.prompt += ctx;
      } else if (parsed.messages?.length) {
        const lastMsg = parsed.messages[parsed.messages.length - 1];
        if (typeof lastMsg.content === 'string') lastMsg.content += ctx;
        else if (Array.isArray(lastMsg.content)) {
          const tp = lastMsg.content.find(p => p.type === 'text');
          if (tp) tp.text += ctx;
        }
      }
      console.log(`${SCRIPT_PREFIX} Injected ${_toolFiles.length} tool file context(s)`);
      _toolFiles.length = 0;
      return JSON.stringify(parsed);
    } catch { return bodyStr; }
  }

  // ═══════════════════════════════════════════════════════════════
  //  MCP Client (GM_xmlhttpRequest to bypass CORS)
  // ═══════════════════════════════════════════════════════════════
  class MCPClient {
    constructor(url) {
      this.url = url;
      this.sessionId = null;
      this._nextId = 1;
      this.connected = false;
    }

    _post(body) {
      return new Promise((resolve, reject) => {
        const headers = {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
        };
        if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
        GM_xmlhttpRequest({
          method: 'POST', url: this.url, headers,
          data: JSON.stringify(body),
          onload: (resp) => {
            try {
              const text = resp.responseText;
              if (resp.responseHeaders?.includes('text/event-stream')) {
                for (const line of text.split('\n')) {
                  if (line.startsWith('data: ')) { resolve(JSON.parse(line.slice(6))); return; }
                }
                reject(new Error('No data in SSE response'));
              } else {
                resolve(JSON.parse(text));
              }
            } catch (e) { reject(new Error(`Parse error: ${e.message}`)); }
          },
          onerror: (e) => reject(new Error(`Network error: ${e.error || 'connection refused'}`)),
          ontimeout: () => reject(new Error('Request timed out')),
          timeout: 30000,
        });
      });
    }

    async _rpc(method, params = {}) {
      const id = this._nextId++;
      const resp = await this._post({ jsonrpc: '2.0', id, method, params });
      if (resp.error) throw new Error(`MCP error: ${resp.error.message}`);
      return resp.result;
    }

    async initialize() {
      try {
        const result = await this._rpc('initialize', {
          protocolVersion: '2025-03-26', capabilities: {},
          clientInfo: { name: 'ds-mcp-bridge', version: '2.0.0' },
        });
        this.sessionId = result.sessionId;
        this.connected = true;
        await this._post({ jsonrpc: '2.0', method: 'notifications/initialized' });
        console.log(`${SCRIPT_PREFIX} MCP connected: ${this.sessionId}`);
        return true;
      } catch (e) { console.error(`${SCRIPT_PREFIX} Init failed:`, e.message); this.connected = false; return false; }
    }

    async listTools() {
      if (!this.connected) await this.initialize();
      const result = await this._rpc('tools/list');
      return result.tools || [];
    }

    async callTool(name, args = {}) {
      if (!this.connected) await this.initialize();
      return this._rpc('tools/call', { name, arguments: args });
    }

    async checkHealth() {
      try {
        const resp = await new Promise((resolve, reject) => {
          GM_xmlhttpRequest({
            method: 'GET', url: this.url.replace('/mcp', '/health'),
            onload: (r) => resolve(JSON.parse(r.responseText)),
            onerror: (e) => reject(e), timeout: 5000,
          });
        });
        return resp.status === 'ok';
      } catch { return false; }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  TTS Client — Text-to-Speech via server API
  // ═══════════════════════════════════════════════════════════════
  class TTSClient {
    constructor() {
      this.audio = null;
      this.playing = false;
      this.currentText = '';
    }

    getBaseUrl() {
      const mcpUrl = GM_getValue('mcp_url', DEFAULT_MCP_URL);
      try { return new URL(mcpUrl).origin; }
      catch { return mcpUrl.replace(/\/[^/]*$/, ''); }
    }

    async synthesize(text) {
      const voice = GM_getValue('tts_voice', 'zh-CN-XiaoxiaoNeural');
      const provider = GM_getValue('tts_provider', 'edge');
      const body = { text, voice, provider };
      if (provider === 'openai') {
        body.api_key = GM_getValue('tts_api_key', '');
        body.base_url = GM_getValue('tts_base_url', 'https://api.openai.com/v1');
        body.model = GM_getValue('tts_model', 'tts-1');
      }
      const url = this.getBaseUrl() + '/api/tts';
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'POST', url,
          headers: { 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
          data: JSON.stringify(body),
          responseType: 'blob',
          onload: (resp) => {
            if (resp.status !== 200) {
              try { const err = JSON.parse(resp.responseText); reject(new Error(err.error || 'TTS failed')); }
              catch { reject(new Error('TTS HTTP ' + resp.status)); }
              return;
            }
            resolve(URL.createObjectURL(resp.response));
          },
          onerror: () => reject(new Error('TTS 网络错误')),
          ontimeout: () => reject(new Error('TTS 超时')),
          timeout: 60000,
        });
      });
    }

    async play(text) {
      this.stop();
      this.currentText = text;
      try {
        const audioUrl = await this.synthesize(text);
        this.audio = new Audio(audioUrl);
        this.playing = true;
        this.audio.onended = () => { this.playing = false; };
        await this.audio.play();
      } catch (e) {
        console.warn(`${SCRIPT_PREFIX} TTS server failed, falling back to Web Speech:`, e.message);
        this._fallbackPlay(text);
      }
    }

    _fallbackPlay(text) {
      if (!('speechSynthesis' in window)) { toast('TTS 不可用', 'error'); return; }
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = 1.0;
      this.playing = true;
      u.onend = () => { this.playing = false; };
      window.speechSynthesis.speak(u);
    }

    stop() {
      if (this.audio) { this.audio.pause(); this.audio.currentTime = 0; this.audio = null; this.playing = false; }
      if (window.speechSynthesis) { window.speechSynthesis.cancel(); this.playing = false; }
    }
  }

  const ttsClient = new TTSClient();

  // ═══════════════════════════════════════════════════════════════
  //  Tool Registry & Hint Builder
  // ═══════════════════════════════════════════════════════════════
  let toolRegistry = [];

  function buildToolHint() {
    if (!toolRegistry.length) return '';
    let hint = `${SYSTEM_HINT_START} 你拥有以下 MCP 工具。当用户的需求可以用工具完成时，你必须在回复中调用工具。`;
    hint += ' 调用格式：用代码块写 ```mcp:工具名``` 后紧跟一个 JSON 代码块写参数。\n\n';
    hint += '示例：\n```mcp:execute_command\n{"command": "ls -la"}\n```\n\n';
    hint += '可用工具列表：\n';
    toolRegistry.forEach(t => {
      hint += `- ${t.name}: ${t.description || ''}`;
      const req = t.inputSchema?.required;
      if (req?.length) hint += ` (参数: ${req.join(', ')})`;
      hint += '\n';
    });
    hint += '\n如果不需要工具就正常回答。需要工具时一定要调用。';
    hint += '\n\n当收到用户发送的 <tool_result> 包裹的文本时，这是你之前调用的工具的执行结果。请基于结果继续回答用户的问题。';
    hint += `\n${SYSTEM_HINT_END}`;
    return hint;
  }

  function modifyRequest(bodyStr) {
    if (!toolRegistry.length || !bodyStr) return bodyStr;
    try {
      const parsed = JSON.parse(bodyStr);
      const hint = buildToolHint();
      if (!hint) return bodyStr;
      if (bodyStr.includes(`${SYSTEM_HINT_START} 你拥有以下 MCP 工具`)) return bodyStr;

      if (parsed.prompt && typeof parsed.prompt === 'string') {
        parsed.prompt = hint + '\n\n' + parsed.prompt;
        return injectToolFileContext(JSON.stringify(parsed));
      }
      if (parsed.messages?.length) {
        const lastMsg = parsed.messages[parsed.messages.length - 1];
        const content = lastMsg?.content;
        if (typeof content === 'string') {
          lastMsg.content = hint + '\n\n' + content;
          return injectToolFileContext(JSON.stringify(parsed));
        }
        if (Array.isArray(content)) {
          const textPart = content.find(p => p.type === 'text');
          if (textPart && !textPart.text.includes('[系统指令]')) {
            textPart.text = hint + '\n\n' + textPart.text;
            return injectToolFileContext(JSON.stringify(parsed));
          }
        }
      }
    } catch { /* not JSON */ }
    return bodyStr;
  }

  // ═══════════════════════════════════════════════════════════════
  //  SSE Parsing — DeepSeek native format + OpenAI compatible
  // ═══════════════════════════════════════════════════════════════
  const executedCalls = new Set();
  let _streamDebounce = null;

  function checkForToolCalls(content) {
    if (!content || !toolRegistry.length) return;

    // Strategy 1: Match ```mcp:tool_name\n{...}\n```
    const re = new RegExp(TOOL_CALL_RE.source, 'g');
    let match;
    while ((match = re.exec(content)) !== null) {
      const toolName = match[1];
      const rawArgs = match[2].trim();
      let args = {};
      try { args = JSON.parse(rawArgs); }
      catch { args = { input: rawArgs }; }

      const key = toolName + ':' + JSON.stringify(args);
      if (executedCalls.has(key)) continue;
      executedCalls.add(key);

      console.log(`${SCRIPT_PREFIX} Tool call: ${toolName}`, args);
      executeToolCall(toolName, args);
    }

    // Strategy 2: Match registered tool names directly
    // Handles SSE token boundary truncation
    for (const tool of toolRegistry) {
      const name = tool.name;
      const idx = content.indexOf(name);
      if (idx === -1) continue;

      const afterName = content.substring(idx + name.length);
      const braceStart = afterName.indexOf('{');
      if (braceStart === -1) continue;

      const braceEnd = afterName.indexOf('}', braceStart);
      if (braceEnd === -1) continue;

      const jsonStr = afterName.substring(braceStart, braceEnd + 1);
      let args = {};
      try { args = JSON.parse(jsonStr); }
      catch { args = { input: jsonStr }; }

      const key = name + ':' + JSON.stringify(args);
      if (executedCalls.has(key)) continue;
      executedCalls.add(key);

      console.log(`${SCRIPT_PREFIX} Tool call: ${name}`, args);
      executeToolCall(name, args);
    }
  }

  function parseSSEChunk(rawText) {
    let content = '';
    const lines = rawText.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;

      const jsonStr = trimmed.slice(6).trim();
      if (jsonStr === '[DONE]') continue;

      try {
        const obj = JSON.parse(jsonStr);

        // DeepSeek native: {"p":"response/content","o":"SET","v":"text"}
        const v = obj.v;
        if (typeof v === 'string' && v.length > 0) {
          const p = obj.p || '';
          if (!p.includes('fragments') && !p.includes('status')) {
            content += v;
          }
          continue;
        }

        // OpenAI streaming: choices[0].delta.content
        const c = obj?.choices?.[0]?.delta?.content;
        if (c) { content += c; continue; }

        // OpenAI non-streaming: choices[0].message.content
        const mc = obj?.choices?.[0]?.message?.content;
        if (mc) { content += mc; continue; }

      } catch { /* not JSON, skip */ }
    }

    return content;
  }

  // ═══════════════════════════════════════════════════════════════
  //  XHR Hook — SSE stream reading via progress events
  // ═══════════════════════════════════════════════════════════════
  const XHRProto = unsafeWindow.XMLHttpRequest.prototype;
  const origOpen = XHRProto.open;
  const origSend = XHRProto.send;
  const xhrMeta = new WeakMap();

  XHRProto.open = function (method, url, ...rest) {
    xhrMeta.set(this, { url, method });
    return origOpen.apply(this, [method, url, ...rest]);
  };

  XHRProto.send = function (body) {
    const meta = xhrMeta.get(this);
    if (!meta) return origSend.apply(this, [body]);

    const isCompletion = meta.url.includes('completion');
    if (isCompletion && getModuleEnabled('mcp')) {
      if (body) body = modifyRequest(body);

      let requestContent = '';
      let requestLastParsed = 0;

      this.addEventListener('progress', function () {
        try {
          const rt = this.responseText || '';
          if (rt.length <= requestLastParsed) return;
          const newPart = rt.substring(requestLastParsed);
          // Only parse up to the last complete line to avoid dropping
          // incomplete `data:` lines split across progress events
          const lastNewline = newPart.lastIndexOf('\n');
          if (lastNewline < 0) return; // no complete line yet
          requestLastParsed += lastNewline + 1;
          const completePart = newPart.substring(0, lastNewline + 1);
          const newContent = parseSSEChunk(completePart);
          if (newContent) requestContent += newContent;

          if (_streamDebounce) clearTimeout(_streamDebounce);
          _streamDebounce = setTimeout(() => {
            if (requestContent) checkForToolCalls(requestContent);
          }, 1000);
        } catch { /* ignore */ }
      });

      this.addEventListener('load', function () {
        try {
          const rt = this.responseText || '';
          if (rt.length > requestLastParsed) {
            const newPart = rt.substring(requestLastParsed);
            const finalContent = parseSSEChunk(newPart);
            if (finalContent) requestContent += finalContent;
          }
        } catch { /* ignore */ }
        if (_streamDebounce) clearTimeout(_streamDebounce);
        checkForToolCalls(requestContent);
      });
    }

    return origSend.apply(this, [body]);
  };

  // ── Hook fetch (backup) ──
  const origFetch = unsafeWindow.fetch;

  unsafeWindow.fetch = async function (...args) {
    const url = (typeof args[0] === 'string') ? args[0] : args[0]?.url;

    if (url && url.includes('completion') && getModuleEnabled('mcp')) {
      if (args[1]?.body) {
        args[1].body = modifyRequest(args[1].body);
      }

      const response = await origFetch.apply(this, args);
      const contentType = response.headers?.get('content-type') || '';

      const clone = response.clone();
      clone.text().then(text => {
        const content = parseSSEChunk(text);
        if (content) checkForToolCalls(content);
      }).catch(() => { });

      return response;
    }

    return origFetch.apply(this, args);
  };

  // ═══════════════════════════════════════════════════════════════
  //  Tool Execution & Result Injection
  // ═══════════════════════════════════════════════════════════════
  async function executeToolCall(toolName, args) {
    const mcpUrl = GM_getValue('mcp_url', DEFAULT_MCP_URL);
    const client = new MCPClient(mcpUrl);

    try {
      toast(`调用工具: ${toolName}...`, 'info');
      const result = await client.callTool(toolName, args);
      const resultText = result?.content?.[0]?.text || '(no result)';
      const isError = result?.isError;

      toast(isError ? `${toolName} 失败` : `${toolName} 完成`, isError ? 'error' : 'success');

      if (!isError && (toolName === 'read_file' || toolName === 'list_directory')) {
        const filename = (args.path || args.filename || 'tool_result.txt').split('/').pop().split('\\').pop();
        addToolFileResult(filename, resultText, 'text/plain');
        toast(`📁 ${filename} 已添加到文件列表`, 'success');
        injectResultToChat(`[工具 ${toolName} 的结果已作为文件添加，共 ${resultText.length} 字符。发送下条消息时会自动附带文件内容。]`);
      } else {
        injectResultToChat(isError ? `Error: ${resultText}` : resultText);
      }
    } catch (e) {
      toast(`工具调用失败: ${e.message}`, 'error');
      console.error(`${SCRIPT_PREFIX} Tool error:`, e);
      injectResultToChat(`Error: ${e.message}`);
    }
  }

  function injectResultToChat(resultText) {
    setTimeout(async () => {
      const wrappedText = `<tool_result>\n${resultText}\n</tool_result>`;

      const input = findInputElement();
      if (!input) {
        toast('找不到聊天输入框', 'error');
        return;
      }

      input.focus();
      await sleep(200);
      setInputValue(input, wrappedText);
      await sleep(500);

      if (!getAutoSendEnabled()) {
        toast('工具结果已填入输入框', 'info');
        return;
      }

      simulateEnter(input);
      await sleep(300);
      const sendBtn = findSendButton();
      if (sendBtn) sendBtn.click();

      toast('工具结果已发送', 'success');
    }, 1500);
  }

  function findInputElement() {
    for (const ta of document.querySelectorAll('textarea')) {
      if (isVisible(ta)) return ta;
    }
    const editables = document.querySelectorAll('[contenteditable="true"]');
    for (const el of editables) {
      if (isVisible(el) && el.getAttribute('placeholder')) return el;
    }
    for (const el of editables) {
      if (isVisible(el)) return el;
    }
    return null;
  }

  function findSendButton() {
    const selectors = [
      'button[aria-label*="send"]', 'button[aria-label*="Send"]',
      'button[aria-label*="发送"]', 'button[aria-label*="Submit"]',
      'button[type="submit"]', 'div[role="button"][aria-label*="send"]',
      'div[role="button"][aria-label*="发送"]',
    ];
    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn && isVisible(btn)) return btn;
    }
    return null;
  }

  function isVisible(el) {
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  function setInputValue(element, value) {
    const isCE = element.contentEditable === 'true';

    if (isCE) {
      element.focus();
      const sel = unsafeWindow.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      sel.removeAllRanges();
      sel.addRange(range);

      element.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true, cancelable: true, inputType: 'insertText', data: value,
      }));

      try { document.execCommand('insertText', false, value); }
      catch { element.textContent = value; }

      range.selectNodeContents(element);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      const setter = Object.getOwnPropertyDescriptor(
        unsafeWindow.HTMLTextAreaElement.prototype, 'value'
      )?.set || Object.getOwnPropertyDescriptor(
        unsafeWindow.HTMLInputElement.prototype, 'value'
      )?.set;

      if (setter) setter.call(element, value);
      else element.value = value;
    }

    [
      new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: value }),
      new Event('change', { bubbles: true }),
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Unidentified' }),
      new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Unidentified' }),
    ].forEach(e => element.dispatchEvent(e));
  }

  function simulateEnter(element) {
    const init = {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true,
    };
    element.dispatchEvent(new KeyboardEvent('keydown', init));
    element.dispatchEvent(new KeyboardEvent('keypress', init));
    element.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ═══════════════════════════════════════════════════════════════
  //  Toast
  // ═══════════════════════════════════════════════════════════════
  function toast(msg, type = 'info') {
    if (!document.body) return;
    const colors = { info: '#2a2a3e', success: '#0d3320', error: '#3d0f0f' };
    const el = document.createElement('div');
    el.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:1000001;background:${colors[type]};color:#eee;padding:12px 22px;border-radius:10px;font-size:14px;box-shadow:0 4px 20px rgba(0,0,0,.5);font-family:system-ui;transition:opacity .3s;`;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3500);
  }

  // ═══════════════════════════════════════════════════════════════
  //  CSS
  // ═══════════════════════════════════════════════════════════════
  const PANEL_CSS = `
#mcp-fab{position:fixed;z-index:999999;width:48px;height:48px;border-radius:50%;background:#16a34a;color:#fff;border:none;font-size:22px;cursor:grab;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 12px rgba(22,163,74,.4);user-select:none;-webkit-user-select:none;touch-action:none}
#mcp-fab:active{cursor:grabbing}
#mcp-fab:hover{transform:scale(1.1);box-shadow:0 4px 20px rgba(22,163,74,.6)}
#mcp-fab svg{width:24px;height:24px;fill:currentColor}
#mcp-fab.disconnected{background:#dc2626;box-shadow:0 2px 12px rgba(220,38,38,.4)}
#mcp-fab.disconnected:hover{box-shadow:0 4px 20px rgba(220,38,38,.6)}
#mcp-panel{position:fixed;z-index:999998;width:460px;max-width:calc(100vw - 20px);max-height:75vh;background:#16161e;color:#eee;border:1px solid #333;border-radius:14px;box-shadow:0 8px 40px rgba(0,0,0,.6);font-family:system-ui;font-size:14px;display:none;flex-direction:column;overflow:hidden}
/* 移动端适配 */
@media (max-width: 600px) {
  #mcp-fab{width:42px;height:42px}
  #mcp-fab svg{width:20px;height:20px}
  #mcp-panel{width:100vw!important;max-width:100vw!important;left:0!important;bottom:0!important;top:auto!important;height:80vh;max-height:80vh;border-radius:14px 14px 0 0}
  .ext-card, .mcp-modal-box{min-width:auto!important;width:calc(100vw - 24px)!important;max-width:calc(100vw - 24px)!important}
  .mcp-bd{padding:10px}
  .ext-preset-card{width:calc(100% - 4px)!important}
}
    #mcp-panel.open{display:flex}
    #mcp-panel .hd{padding:14px 18px;border-bottom:1px solid #2a2a3a;display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
    #mcp-panel .hd h3{margin:0;font-size:15px;font-weight:600}
    #mcp-panel .hd .ver{font-size:11px;color:#666;margin-left:8px}
    #mcp-panel .hd .cls{background:none;border:none;color:#888;font-size:20px;cursor:pointer;padding:0 4px}
    #mcp-panel .hd .cls:hover{color:#fff}

    #mcp-tabs{display:flex;border-bottom:1px solid #2a2a3a;overflow-x:auto;scrollbar-width:none;flex-shrink:0}
    #mcp-tabs::-webkit-scrollbar{display:none}
    #mcp-tabs button{flex:0 0 auto;padding:9px 14px;background:none;border:none;color:#888;font-size:12px;cursor:pointer;border-bottom:2px solid transparent;transition:color .15s,border-color .15s;white-space:nowrap}
    #mcp-tabs button.active{color:#7aa2f7;border-bottom-color:#7aa2f7}
    #mcp-tabs button:hover{color:#ccc}

    .mcp-bd{flex:1;overflow-y:auto;padding:12px 14px}
    .mcp-sec{display:none}.mcp-sec.active{display:block}

    .mcp-btn{padding:6px 12px;border-radius:8px;border:1px solid #444;background:#222;color:#eee;font-size:12px;cursor:pointer;transition:background .15s}
    .mcp-btn:hover{background:#333}
    .mcp-btn.pri{background:#16a34a;border-color:#16a34a;color:#fff}
    .mcp-btn.pri:hover{background:#15803d}
    .mcp-input{width:100%;padding:8px 12px;border-radius:8px;border:1px solid #444;background:#1a1a28;color:#eee;font-size:13px;box-sizing:border-box;outline:none}
    .mcp-input:focus{border-color:#7aa2f7}
    .mcp-input::placeholder{color:#555}
    .mcp-sel{width:100%;padding:7px 10px;border:1px solid #444;border-radius:8px;background:#1a1a28;color:#eee;font-size:13px;outline:none}
    .mcp-sel option{background:#1a1a28}

    .mcp-tool{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;transition:background .1s;font-size:13px}
    .mcp-tool:hover{background:#1e1e2e}
    .mcp-tool .name{color:#7aa2f7;font-weight:500}
    .mcp-tool .desc{color:#888;font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

    .mcp-result{margin-top:10px;padding:10px;background:#1a1a28;border-radius:8px;font-size:12px;white-space:pre-wrap;word-break:break-all;max-height:300px;overflow-y:auto;color:#aaa;font-family:monospace}
    .mcp-result.error{color:#f87171}
    .mcp-label{font-size:12px;color:#888;margin-bottom:4px;display:block}
    .mcp-label-row{display:flex;align-items:center;gap:8px;margin-bottom:6px}
    .mcp-status{font-size:13px;padding:8px 0}
    .mcp-status .ok{color:#4ade80}
    .mcp-status .err{color:#f87171}

    .ext-card{padding:10px 12px;border:1px solid #333;border-radius:10px;margin-bottom:8px;background:#1a1a28}
    .ext-card-hd{display:flex;align-items:center;justify-content:space-between;gap:8px}
    .ext-card-name{font-weight:600;color:#7aa2f7;font-size:14px}
    .ext-card-transport{font-size:11px;color:#666;background:#222;padding:2px 6px;border-radius:4px}
    .ext-card-status{font-size:12px;display:flex;align-items:center;gap:4px}
    .ext-card-status .dot{width:7px;height:7px;border-radius:50%;display:inline-block}
    .ext-card-status .dot-green{background:#4ade80}.ext-card-status .dot-red{background:#f87171}.ext-card-status .dot-gray{background:#666}
    .ext-card-tools{font-size:11px;color:#888;margin-top:6px}
    .ext-card-actions{display:flex;gap:6px;margin-top:8px}
    .ext-card-actions .mcp-btn{font-size:11px;padding:4px 10px}
    .ext-form-row{margin-bottom:8px}
    .ext-form-row label{font-size:11px;color:#888;display:block;margin-bottom:3px}
    .ext-form-row input{font-size:12px}
    .ext-add-toggle{font-size:12px;color:#7aa2f7;cursor:pointer;border:none;background:none;padding:0;margin-top:6px}
    .ext-add-toggle:hover{text-decoration:underline}
    .ext-section{margin-top:10px;padding-top:10px;border-top:1px solid #2a2a3a}

    /* TTS Button */
    .mcp-tts-btn {
      display:inline-flex;align-items:center;gap:4px;
      padding:4px 8px;border-radius:6px;border:1px solid transparent;
      background:transparent;color:#999;font-size:12px;cursor:pointer;
      transition:background .15s,color .15s,border-color .15s;user-select:none;
      white-space:nowrap;line-height:1;height:28px;box-sizing:border-box;
    }
    .mcp-tts-btn:hover { background:#2a2a3e;color:#e0e0e0;border-color:#555; }
    .mcp-tts-btn.playing { color:#4ade80;background:#1a3a28;border-color:#16a34a; }
    .mcp-tts-btn.paused { color:#fbbf24;background:#3a2a18;border-color:#d97706; }

    /* Module toggles */
    .mcp-toggle-row { display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid #2a2a3a; }
    .mcp-toggle-label { font-size:13px;color:#ccc; }
    .mcp-toggle-desc { font-size:11px;color:#666;margin-top:2px; }
    .mcp-switch { position:relative;width:36px;height:20px;flex-shrink:0; }
    .mcp-switch input { opacity:0;width:0;height:0; }
    .mcp-switch .slider { position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:#333;border-radius:10px;transition:.2s; }
    .mcp-switch .slider:before { position:absolute;content:"";height:16px;width:16px;left:2px;bottom:2px;background:#888;border-radius:50%;transition:.2s; }
    .mcp-switch input:checked + .slider { background:#16a34a; }
    .mcp-switch input:checked + .slider:before { transform:translateX(16px);background:#fff; }

    .mcp-code-action {
      display:inline-flex;align-items:center;justify-content:center;
      height:24px;padding:0 8px;margin-left:4px;border-radius:5px;
      border:1px solid #444;background:#222;color:#ddd;font-size:12px;
      line-height:1;cursor:pointer;white-space:nowrap;box-sizing:border-box;
    }
    .mcp-code-action:hover { background:#333;color:#fff;border-color:#666; }
    .mcp-code-action.resend { background:#14351f;border-color:#16a34a;color:#8df0ad; }
    .mcp-code-action.resend:hover { background:#166534;color:#fff; }
    pre.mcp-code-hidden, code.mcp-code-hidden, .mcp-code-hidden pre, .mcp-code-hidden code { display:none !important; }
    .mcp-sys-fold {
      margin:8px 0;padding:8px 10px;border:1px solid #333;border-radius:8px;
      background:#15151f;color:#ccc;font-size:13px;line-height:1.55;
    }
    .mcp-sys-fold-hd { display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:pointer;user-select:none; }
    .mcp-sys-fold-title { color:#7aa2f7;font-weight:600; }
    .mcp-sys-fold-toggle { color:#999;font-size:12px; }
    .mcp-sys-fold-body { display:none;margin-top:8px;white-space:pre-wrap;color:#999;font-size:12px; }
    .mcp-sys-fold.open .mcp-sys-fold-body { display:block; }

  `;

  // ═══════════════════════════════════════════════════════════════
  //  FAB + Panel
  // ═══════════════════════════════════════════════════════════════
  function waitForDOM() {
    return new Promise(resolve => {
      if (document.body) resolve();
      else new MutationObserver(() => { if (document.body) resolve(); })
        .observe(document.documentElement, { childList: true });
    });
  }

  waitForDOM().then(() => {
    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    document.head.appendChild(style);

  // FAB
  const fab = document.createElement('button');
  fab.id = 'mcp-fab';
  fab.innerHTML = '<svg viewBox="0 0 500 450"><path d="M277.82816229116946,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM269.4272076372315,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM273.6276849642005,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM282.0286396181384,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM286.2291169451074,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM265.22673031026255,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM290.4295942720764,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM294.6300715990454,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM261.0262529832936,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM256.8257756563246,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM298.83054892601433,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM391.24105011933176,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM395.4415274463007,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM399.6420047732697,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM403.84248210023867,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM408.0429594272077,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM412.2434367541766,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM303.0310262529833,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM416.4439140811456,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM420.6443914081146,145.71599045346062h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM252.62529832935562,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM256.8257756563246,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM261.0262529832936,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM265.22673031026255,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM269.4272076372315,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM273.6276849642005,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM277.82816229116946,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM282.0286396181384,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM286.2291169451074,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM290.4295942720764,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM294.6300715990454,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM298.83054892601433,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM303.0310262529833,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM391.24105011933176,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM395.4415274463007,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM399.6420047732697,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM403.84248210023867,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM408.0429594272077,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM412.2434367541766,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM416.4439140811456,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM420.6443914081146,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM424.84486873508354,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM307.2315035799523,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM429.04534606205254,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM248.42482100238664,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM433.2458233890215,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM311.43198090692124,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM244.22434367541766,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM437.44630071599045,149.9164677804296h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM244.22434367541766,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM248.42482100238664,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM252.62529832935562,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM256.8257756563246,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM261.0262529832936,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM265.22673031026255,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM269.4272076372315,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM273.6276849642005,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM277.82816229116946,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM282.0286396181384,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM286.2291169451074,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM290.4295942720764,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM294.6300715990454,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM298.83054892601433,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM303.0310262529833,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM307.2315035799523,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM311.43198090692124,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM391.24105011933176,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM395.4415274463007,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM399.6420047732697,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM403.84248210023867,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM408.0429594272077,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM412.2434367541766,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM416.4439140811456,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM420.6443914081146,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM424.84486873508354,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM429.04534606205254,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM433.2458233890215,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM437.44630071599045,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM315.63245823389025,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM441.64677804295945,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM240.0238663484487,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM59.40334128878282,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM445.8472553699284,154.11694510739858h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM59.40334128878282,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM235.82338902147973,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM240.0238663484487,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM244.22434367541766,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM248.42482100238664,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM252.62529832935562,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM256.8257756563246,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM261.0262529832936,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM265.22673031026255,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM269.4272076372315,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM273.6276849642005,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM277.82816229116946,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM282.0286396181384,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM286.2291169451074,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM290.4295942720764,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM294.6300715990454,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM298.83054892601433,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM303.0310262529833,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM307.2315035799523,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM311.43198090692124,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM315.63245823389025,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM319.8329355608592,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM391.24105011933176,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM395.4415274463007,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM399.6420047732697,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM403.84248210023867,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM408.0429594272077,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM412.2434367541766,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM416.4439140811456,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM420.6443914081146,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM424.84486873508354,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM429.04534606205254,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM433.2458233890215,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM437.44630071599045,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM441.64677804295945,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM445.8472553699284,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM147.61336515513128,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM450.0477326968974,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM231.62291169451075,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM324.03341288782815,158.31742243436753h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM59.40334128878282,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM147.61336515513128,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM231.62291169451075,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM235.82338902147973,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM240.0238663484487,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM244.22434367541766,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM248.42482100238664,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM252.62529832935562,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM256.8257756563246,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM261.0262529832936,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM265.22673031026255,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM269.4272076372315,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM273.6276849642005,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM277.82816229116946,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM282.0286396181384,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM286.2291169451074,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM290.4295942720764,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM294.6300715990454,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM298.83054892601433,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM303.0310262529833,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM307.2315035799523,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM311.43198090692124,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM315.63245823389025,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM319.8329355608592,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM324.03341288782815,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM391.24105011933176,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM395.4415274463007,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM399.6420047732697,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM403.84248210023867,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM408.0429594272077,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM412.2434367541766,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM416.4439140811456,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM420.6443914081146,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM424.84486873508354,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM429.04534606205254,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM433.2458233890215,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM437.44630071599045,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM441.64677804295945,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM445.8472553699284,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM450.0477326968974,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM454.24821002386636,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM63.60381861575179,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM227.42243436754177,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM143.4128878281623,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM328.23389021479716,162.5178997613365h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM59.40334128878282,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM63.60381861575179,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM143.4128878281623,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM147.61336515513128,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM227.42243436754177,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM231.62291169451075,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM235.82338902147973,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM240.0238663484487,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM244.22434367541766,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM248.42482100238664,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM252.62529832935562,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM256.8257756563246,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM261.0262529832936,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM265.22673031026255,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM269.4272076372315,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM273.6276849642005,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM277.82816229116946,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM282.0286396181384,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM286.2291169451074,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM290.4295942720764,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM294.6300715990454,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM298.83054892601433,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM303.0310262529833,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM307.2315035799523,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM311.43198090692124,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM315.63245823389025,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM319.8329355608592,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM324.03341288782815,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM328.23389021479716,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM391.24105011933176,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM395.4415274463007,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM399.6420047732697,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM403.84248210023867,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM408.0429594272077,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM412.2434367541766,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM416.4439140811456,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM420.6443914081146,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM424.84486873508354,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM429.04534606205254,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM433.2458233890215,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM437.44630071599045,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM441.64677804295945,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM445.8472553699284,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM450.0477326968974,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM454.24821002386636,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM458.4486873508353,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM223.2219570405728,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM67.80429594272076,166.7183770883055h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM59.40334128878282,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM63.60381861575179,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM67.80429594272076,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM143.4128878281623,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM147.61336515513128,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM223.2219570405728,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM227.42243436754177,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM231.62291169451075,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM235.82338902147973,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM240.0238663484487,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM244.22434367541766,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM248.42482100238664,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM252.62529832935562,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM256.8257756563246,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM261.0262529832936,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM265.22673031026255,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM269.4272076372315,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM273.6276849642005,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM277.82816229116946,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM282.0286396181384,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM286.2291169451074,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM290.4295942720764,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM294.6300715990454,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM298.83054892601433,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM303.0310262529833,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM307.2315035799523,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM311.43198090692124,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM315.63245823389025,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM319.8329355608592,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM324.03341288782815,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM328.23389021479716,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM391.24105011933176,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM395.4415274463007,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM399.6420047732697,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM403.84248210023867,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM408.0429594272077,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM412.2434367541766,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM416.4439140811456,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM420.6443914081146,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM424.84486873508354,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM429.04534606205254,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM433.2458233890215,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM437.44630071599045,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM441.64677804295945,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM445.8472553699284,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM450.0477326968974,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM454.24821002386636,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM458.4486873508353,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM332.4343675417661,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM139.21241050119332,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM462.6491646778043,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM219.02147971360384,170.91885441527447h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM59.40334128878282,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM63.60381861575179,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM67.80429594272076,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM139.21241050119332,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM143.4128878281623,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM147.61336515513128,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM219.02147971360384,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM223.2219570405728,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM227.42243436754177,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM231.62291169451075,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM235.82338902147973,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM240.0238663484487,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM244.22434367541766,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM248.42482100238664,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM252.62529832935562,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM256.8257756563246,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM261.0262529832936,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM265.22673031026255,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM269.4272076372315,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM286.2291169451074,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM290.4295942720764,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM294.6300715990454,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM298.83054892601433,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM303.0310262529833,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM307.2315035799523,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM311.43198090692124,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM315.63245823389025,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM319.8329355608592,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM324.03341288782815,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM328.23389021479716,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM332.4343675417661,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM412.2434367541766,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM416.4439140811456,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM420.6443914081146,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM424.84486873508354,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM429.04534606205254,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM433.2458233890215,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM437.44630071599045,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM441.64677804295945,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM445.8472553699284,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM450.0477326968974,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM454.24821002386636,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM458.4486873508353,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM462.6491646778043,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM72.00477326968974,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM135.01193317422434,175.11933174224345h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM59.40334128878282,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM63.60381861575179,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM67.80429594272076,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM72.00477326968974,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM135.01193317422434,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM139.21241050119332,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM143.4128878281623,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM147.61336515513128,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM219.02147971360384,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM223.2219570405728,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM227.42243436754177,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM231.62291169451075,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM235.82338902147973,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM240.0238663484487,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM244.22434367541766,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM248.42482100238664,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM252.62529832935562,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM256.8257756563246,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM298.83054892601433,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM303.0310262529833,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM307.2315035799523,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM311.43198090692124,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM315.63245823389025,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM319.8329355608592,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM324.03341288782815,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM328.23389021479716,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM332.4343675417661,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM424.84486873508354,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM429.04534606205254,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM433.2458233890215,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM437.44630071599045,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM441.64677804295945,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM445.8472553699284,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM450.0477326968974,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM454.24821002386636,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM458.4486873508353,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM462.6491646778043,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM336.6348448687351,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM214.82100238663486,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM466.8496420047733,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM76.20525059665871,179.3198090692124h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM59.40334128878282,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM63.60381861575179,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM67.80429594272076,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM72.00477326968974,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM76.20525059665871,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM135.01193317422434,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM139.21241050119332,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM143.4128878281623,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM147.61336515513128,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM214.82100238663486,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM219.02147971360384,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM223.2219570405728,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM227.42243436754177,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM231.62291169451075,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM235.82338902147973,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM240.0238663484487,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM244.22434367541766,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM248.42482100238664,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM252.62529832935562,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM303.0310262529833,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM307.2315035799523,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM311.43198090692124,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM315.63245823389025,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM319.8329355608592,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM324.03341288782815,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM328.23389021479716,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM332.4343675417661,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM429.04534606205254,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM433.2458233890215,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM437.44630071599045,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM441.64677804295945,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM445.8472553699284,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM450.0477326968974,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM454.24821002386636,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM458.4486873508353,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM462.6491646778043,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM466.8496420047733,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM130.8114558472554,183.52028639618138h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM59.40334128878282,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM63.60381861575179,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM67.80429594272076,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM72.00477326968974,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM76.20525059665871,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM130.8114558472554,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM135.01193317422434,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM139.21241050119332,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM143.4128878281623,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM147.61336515513128,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM214.82100238663486,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM219.02147971360384,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM223.2219570405728,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM227.42243436754177,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM231.62291169451075,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM235.82338902147973,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM240.0238663484487,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM244.22434367541766,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM248.42482100238664,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM307.2315035799523,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM311.43198090692124,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM315.63245823389025,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM319.8329355608592,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM324.03341288782815,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM433.2458233890215,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM437.44630071599045,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM441.64677804295945,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM445.8472553699284,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM450.0477326968974,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM454.24821002386636,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM458.4486873508353,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM462.6491646778043,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM466.8496420047733,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM210.62052505966588,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM80.4057279236277,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM126.6109785202864,187.72076372315036h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM59.40334128878282,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM63.60381861575179,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM67.80429594272076,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM72.00477326968974,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM76.20525059665871,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM80.4057279236277,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM126.6109785202864,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM130.8114558472554,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM135.01193317422434,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM139.21241050119332,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM143.4128878281623,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM147.61336515513128,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM210.62052505966588,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM214.82100238663486,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM219.02147971360384,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM223.2219570405728,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM227.42243436754177,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM231.62291169451075,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM235.82338902147973,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM240.0238663484487,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM244.22434367541766,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM307.2315035799523,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM311.43198090692124,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM315.63245823389025,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM437.44630071599045,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM441.64677804295945,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM445.8472553699284,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM450.0477326968974,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM454.24821002386636,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM458.4486873508353,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM462.6491646778043,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM466.8496420047733,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM84.60620525059666,191.92124105011933h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM59.40334128878282,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM63.60381861575179,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM67.80429594272076,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM72.00477326968974,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM76.20525059665871,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM80.4057279236277,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM84.60620525059666,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM126.6109785202864,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM130.8114558472554,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM135.01193317422434,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM139.21241050119332,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM143.4128878281623,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM147.61336515513128,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM210.62052505966588,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM214.82100238663486,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM219.02147971360384,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM223.2219570405728,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM227.42243436754177,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM231.62291169451075,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM235.82338902147973,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM240.0238663484487,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM244.22434367541766,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM437.44630071599045,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM441.64677804295945,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM445.8472553699284,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM450.0477326968974,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM454.24821002386636,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM458.4486873508353,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM462.6491646778043,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM466.8496420047733,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM122.41050119331743,196.1217183770883h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM59.40334128878282,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM63.60381861575179,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM67.80429594272076,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM72.00477326968974,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM76.20525059665871,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM80.4057279236277,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM84.60620525059666,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM122.41050119331743,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM126.6109785202864,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM130.8114558472554,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM135.01193317422434,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM139.21241050119332,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM143.4128878281623,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM147.61336515513128,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM206.4200477326969,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM210.62052505966588,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM214.82100238663486,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM219.02147971360384,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM223.2219570405728,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM227.42243436754177,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM231.62291169451075,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM235.82338902147973,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM240.0238663484487,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM437.44630071599045,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM441.64677804295945,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM445.8472553699284,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM450.0477326968974,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM454.24821002386636,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM458.4486873508353,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM462.6491646778043,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM466.8496420047733,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM88.80668257756564,200.32219570405726h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM59.40334128878282,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM63.60381861575179,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM67.80429594272076,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM72.00477326968974,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM76.20525059665871,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM80.4057279236277,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM84.60620525059666,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM88.80668257756564,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM118.21002386634845,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM122.41050119331743,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM126.6109785202864,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM130.8114558472554,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM135.01193317422434,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM139.21241050119332,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM143.4128878281623,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM147.61336515513128,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM206.4200477326969,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM210.62052505966588,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM214.82100238663486,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM219.02147971360384,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM223.2219570405728,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM227.42243436754177,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM231.62291169451075,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM235.82338902147973,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM240.0238663484487,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM437.44630071599045,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM441.64677804295945,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM445.8472553699284,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM450.0477326968974,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM454.24821002386636,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM458.4486873508353,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM462.6491646778043,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM466.8496420047733,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM433.2458233890215,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM93.0071599045346,204.52267303102627h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM59.40334128878282,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM63.60381861575179,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM67.80429594272076,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM72.00477326968974,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM76.20525059665871,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM80.4057279236277,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM84.60620525059666,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM88.80668257756564,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM93.0071599045346,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM118.21002386634845,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM122.41050119331743,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM126.6109785202864,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM130.8114558472554,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM135.01193317422434,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM139.21241050119332,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM143.4128878281623,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM147.61336515513128,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM206.4200477326969,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM210.62052505966588,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM214.82100238663486,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM219.02147971360384,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM223.2219570405728,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM227.42243436754177,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM231.62291169451075,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM235.82338902147973,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM240.0238663484487,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM433.2458233890215,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM437.44630071599045,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM441.64677804295945,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM445.8472553699284,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM450.0477326968974,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM454.24821002386636,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM458.4486873508353,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM462.6491646778043,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM466.8496420047733,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM114.00954653937947,208.72315035799522h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM63.60381861575179,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM67.80429594272076,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM72.00477326968974,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM76.20525059665871,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM80.4057279236277,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM84.60620525059666,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM88.80668257756564,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM93.0071599045346,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM114.00954653937947,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM118.21002386634845,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM122.41050119331743,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM126.6109785202864,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM130.8114558472554,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM135.01193317422434,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM139.21241050119332,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM143.4128878281623,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM206.4200477326969,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM210.62052505966588,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM214.82100238663486,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM219.02147971360384,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM223.2219570405728,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM227.42243436754177,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM231.62291169451075,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM235.82338902147973,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM433.2458233890215,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM437.44630071599045,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM441.64677804295945,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM445.8472553699284,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM450.0477326968974,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM454.24821002386636,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM458.4486873508353,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM462.6491646778043,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM466.8496420047733,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM97.20763723150358,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM429.04534606205254,212.9236276849642h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM67.80429594272076,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM72.00477326968974,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM76.20525059665871,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM80.4057279236277,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM84.60620525059666,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM88.80668257756564,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM93.0071599045346,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM97.20763723150358,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM109.8090692124105,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM114.00954653937947,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM118.21002386634845,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM122.41050119331743,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM126.6109785202864,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM130.8114558472554,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM135.01193317422434,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM139.21241050119332,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM206.4200477326969,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM210.62052505966588,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM214.82100238663486,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM219.02147971360384,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM223.2219570405728,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM227.42243436754177,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM231.62291169451075,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM235.82338902147973,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM429.04534606205254,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM433.2458233890215,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM437.44630071599045,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM441.64677804295945,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM445.8472553699284,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM450.0477326968974,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM454.24821002386636,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM458.4486873508353,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM462.6491646778043,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM466.8496420047733,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM424.84486873508354,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM101.40811455847256,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM420.6443914081146,217.12410501193318h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM67.80429594272076,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM72.00477326968974,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM76.20525059665871,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM80.4057279236277,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM84.60620525059666,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM88.80668257756564,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM93.0071599045346,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM97.20763723150358,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM101.40811455847256,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM109.8090692124105,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM114.00954653937947,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM118.21002386634845,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM122.41050119331743,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM126.6109785202864,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM130.8114558472554,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM135.01193317422434,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM139.21241050119332,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM206.4200477326969,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM210.62052505966588,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM214.82100238663486,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM219.02147971360384,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM223.2219570405728,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM227.42243436754177,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM231.62291169451075,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM235.82338902147973,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM420.6443914081146,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM424.84486873508354,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM429.04534606205254,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM433.2458233890215,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM437.44630071599045,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM441.64677804295945,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM445.8472553699284,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM450.0477326968974,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM454.24821002386636,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM458.4486873508353,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM462.6491646778043,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM416.4439140811456,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM105.60859188544153,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM412.2434367541766,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM391.24105011933176,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM395.4415274463007,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM399.6420047732697,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM403.84248210023867,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM408.0429594272077,221.32458233890213h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM72.00477326968974,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM76.20525059665871,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM80.4057279236277,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM84.60620525059666,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM88.80668257756564,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM93.0071599045346,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM97.20763723150358,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM101.40811455847256,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM105.60859188544153,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM109.8090692124105,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM114.00954653937947,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM118.21002386634845,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM122.41050119331743,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM126.6109785202864,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM130.8114558472554,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM135.01193317422434,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM206.4200477326969,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM210.62052505966588,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM214.82100238663486,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM219.02147971360384,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM223.2219570405728,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM227.42243436754177,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM231.62291169451075,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM235.82338902147973,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM391.24105011933176,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM395.4415274463007,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM399.6420047732697,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM403.84248210023867,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM408.0429594272077,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM412.2434367541766,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM416.4439140811456,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM420.6443914081146,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM424.84486873508354,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM429.04534606205254,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM433.2458233890215,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM437.44630071599045,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM441.64677804295945,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM445.8472553699284,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM450.0477326968974,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM454.24821002386636,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM458.4486873508353,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM462.6491646778043,225.52505966587114h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM76.20525059665871,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM80.4057279236277,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM84.60620525059666,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM88.80668257756564,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM93.0071599045346,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM97.20763723150358,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM101.40811455847256,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM105.60859188544153,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM109.8090692124105,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM114.00954653937947,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM118.21002386634845,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM122.41050119331743,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM126.6109785202864,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM130.8114558472554,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM206.4200477326969,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM210.62052505966588,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM214.82100238663486,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM219.02147971360384,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM223.2219570405728,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM227.42243436754177,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM231.62291169451075,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM235.82338902147973,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM391.24105011933176,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM395.4415274463007,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM399.6420047732697,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM403.84248210023867,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM408.0429594272077,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM412.2434367541766,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM416.4439140811456,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM420.6443914081146,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM424.84486873508354,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM429.04534606205254,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM433.2458233890215,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM437.44630071599045,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM441.64677804295945,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM445.8472553699284,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM450.0477326968974,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM454.24821002386636,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM458.4486873508353,229.7255369928401h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM76.20525059665871,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM80.4057279236277,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM84.60620525059666,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM88.80668257756564,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM93.0071599045346,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM97.20763723150358,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM101.40811455847256,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM105.60859188544153,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM109.8090692124105,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM114.00954653937947,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM118.21002386634845,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM122.41050119331743,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM126.6109785202864,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM130.8114558472554,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM206.4200477326969,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM210.62052505966588,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM214.82100238663486,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM219.02147971360384,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM223.2219570405728,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM227.42243436754177,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM231.62291169451075,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM235.82338902147973,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM391.24105011933176,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM395.4415274463007,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM399.6420047732697,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM403.84248210023867,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM408.0429594272077,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM412.2434367541766,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM416.4439140811456,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM420.6443914081146,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM424.84486873508354,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM429.04534606205254,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM433.2458233890215,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM437.44630071599045,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM441.64677804295945,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM445.8472553699284,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM450.0477326968974,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM454.24821002386636,233.92601431980907h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM80.4057279236277,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM84.60620525059666,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM88.80668257756564,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM93.0071599045346,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM97.20763723150358,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM101.40811455847256,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM105.60859188544153,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM109.8090692124105,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM114.00954653937947,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM118.21002386634845,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM122.41050119331743,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM126.6109785202864,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM206.4200477326969,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM210.62052505966588,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM214.82100238663486,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM219.02147971360384,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM223.2219570405728,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM227.42243436754177,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM231.62291169451075,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM235.82338902147973,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM391.24105011933176,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM395.4415274463007,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM399.6420047732697,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM403.84248210023867,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM408.0429594272077,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM412.2434367541766,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM416.4439140811456,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM420.6443914081146,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM424.84486873508354,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM429.04534606205254,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM433.2458233890215,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM437.44630071599045,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM441.64677804295945,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM445.8472553699284,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM450.0477326968974,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM240.0238663484487,238.12649164677805h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM84.60620525059666,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM88.80668257756564,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM93.0071599045346,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM97.20763723150358,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM101.40811455847256,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM105.60859188544153,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM109.8090692124105,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM114.00954653937947,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM118.21002386634845,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM122.41050119331743,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM206.4200477326969,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM210.62052505966588,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM214.82100238663486,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM219.02147971360384,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM223.2219570405728,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM227.42243436754177,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM231.62291169451075,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM235.82338902147973,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM240.0238663484487,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM391.24105011933176,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM395.4415274463007,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM399.6420047732697,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM403.84248210023867,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM408.0429594272077,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM412.2434367541766,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM416.4439140811456,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM420.6443914081146,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM424.84486873508354,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM429.04534606205254,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM433.2458233890215,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM437.44630071599045,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM441.64677804295945,242.326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM84.60620525059666,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM88.80668257756564,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM93.0071599045346,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM97.20763723150358,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM101.40811455847256,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM105.60859188544153,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM109.8090692124105,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM114.00954653937947,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM118.21002386634845,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM122.41050119331743,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM206.4200477326969,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM210.62052505966588,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM214.82100238663486,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM219.02147971360384,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM223.2219570405728,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM227.42243436754177,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM231.62291169451075,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM235.82338902147973,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM240.0238663484487,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM391.24105011933176,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM395.4415274463007,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM399.6420047732697,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM403.84248210023867,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM408.0429594272077,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM412.2434367541766,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM416.4439140811456,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM420.6443914081146,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM424.84486873508354,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM429.04534606205254,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM433.2458233890215,246.527446300716h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM88.80668257756564,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM93.0071599045346,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM97.20763723150358,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM101.40811455847256,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM105.60859188544153,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM109.8090692124105,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM114.00954653937947,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM118.21002386634845,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM210.62052505966588,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM214.82100238663486,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM219.02147971360384,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM223.2219570405728,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM227.42243436754177,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM231.62291169451075,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM235.82338902147973,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM240.0238663484487,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM244.22434367541766,250.72792362768496h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM93.0071599045346,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM97.20763723150358,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM101.40811455847256,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM105.60859188544153,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM109.8090692124105,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM114.00954653937947,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM210.62052505966588,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM214.82100238663486,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM219.02147971360384,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM223.2219570405728,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM227.42243436754177,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM231.62291169451075,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM235.82338902147973,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM240.0238663484487,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM244.22434367541766,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM311.43198090692124,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM307.2315035799523,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM315.63245823389025,254.92840095465394h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM93.0071599045346,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM97.20763723150358,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM101.40811455847256,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM105.60859188544153,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM109.8090692124105,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM114.00954653937947,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM210.62052505966588,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM214.82100238663486,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM219.02147971360384,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM223.2219570405728,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM227.42243436754177,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM231.62291169451075,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM235.82338902147973,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM240.0238663484487,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM244.22434367541766,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM307.2315035799523,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM311.43198090692124,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM315.63245823389025,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM319.8329355608592,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM248.42482100238664,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM324.03341288782815,259.1288782816229h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM214.82100238663486,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM219.02147971360384,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM223.2219570405728,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM227.42243436754177,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM231.62291169451075,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM235.82338902147973,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM240.0238663484487,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM244.22434367541766,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM248.42482100238664,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM303.0310262529833,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM307.2315035799523,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM311.43198090692124,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM315.63245823389025,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM319.8329355608592,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM324.03341288782815,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM328.23389021479716,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM252.62529832935562,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM332.4343675417661,263.32935560859187h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM214.82100238663486,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM219.02147971360384,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM223.2219570405728,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM227.42243436754177,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM231.62291169451075,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM235.82338902147973,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM240.0238663484487,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM244.22434367541766,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM248.42482100238664,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM252.62529832935562,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM303.0310262529833,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM307.2315035799523,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM311.43198090692124,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM315.63245823389025,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM319.8329355608592,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM324.03341288782815,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM328.23389021479716,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM332.4343675417661,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM298.83054892601433,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM256.8257756563246,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM336.6348448687351,267.5298329355609h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM219.02147971360384,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM223.2219570405728,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM227.42243436754177,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM231.62291169451075,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM235.82338902147973,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM240.0238663484487,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM244.22434367541766,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM248.42482100238664,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM252.62529832935562,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM256.8257756563246,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM294.6300715990454,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM298.83054892601433,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM303.0310262529833,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM307.2315035799523,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM311.43198090692124,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM315.63245823389025,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM319.8329355608592,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM324.03341288782815,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM328.23389021479716,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM332.4343675417661,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM261.0262529832936,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM290.4295942720764,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM265.22673031026255,271.7303102625298h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM219.02147971360384,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM223.2219570405728,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM227.42243436754177,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM231.62291169451075,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM235.82338902147973,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM240.0238663484487,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM244.22434367541766,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM248.42482100238664,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM252.62529832935562,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM256.8257756563246,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM261.0262529832936,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM265.22673031026255,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM269.4272076372315,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM286.2291169451074,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM290.4295942720764,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM294.6300715990454,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM298.83054892601433,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM303.0310262529833,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM307.2315035799523,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM311.43198090692124,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM315.63245823389025,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM319.8329355608592,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM324.03341288782815,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM328.23389021479716,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM332.4343675417661,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM273.6276849642005,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM282.0286396181384,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM277.82816229116946,275.9307875894988h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM223.2219570405728,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM227.42243436754177,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM231.62291169451075,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM235.82338902147973,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM240.0238663484487,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM244.22434367541766,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM248.42482100238664,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM252.62529832935562,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM256.8257756563246,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM261.0262529832936,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM265.22673031026255,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM269.4272076372315,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM273.6276849642005,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM277.82816229116946,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM282.0286396181384,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM286.2291169451074,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM290.4295942720764,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM294.6300715990454,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM298.83054892601433,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM303.0310262529833,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM307.2315035799523,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM311.43198090692124,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM315.63245823389025,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM319.8329355608592,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM324.03341288782815,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM328.23389021479716,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,280.1312649164678h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM227.42243436754177,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM231.62291169451075,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM235.82338902147973,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM240.0238663484487,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM244.22434367541766,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM248.42482100238664,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM252.62529832935562,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM256.8257756563246,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM261.0262529832936,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM265.22673031026255,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM269.4272076372315,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM273.6276849642005,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM277.82816229116946,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM282.0286396181384,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM286.2291169451074,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM290.4295942720764,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM294.6300715990454,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM298.83054892601433,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM303.0310262529833,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM307.2315035799523,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM311.43198090692124,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM315.63245823389025,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM319.8329355608592,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM324.03341288782815,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM328.23389021479716,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,284.3317422434368h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM231.62291169451075,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM235.82338902147973,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM240.0238663484487,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM244.22434367541766,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM248.42482100238664,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM252.62529832935562,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM256.8257756563246,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM261.0262529832936,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM265.22673031026255,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM269.4272076372315,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM273.6276849642005,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM277.82816229116946,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM282.0286396181384,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM286.2291169451074,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM290.4295942720764,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM294.6300715990454,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM298.83054892601433,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM303.0310262529833,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM307.2315035799523,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM311.43198090692124,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM315.63245823389025,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM319.8329355608592,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM324.03341288782815,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,288.53221957040574h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM240.0238663484487,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM244.22434367541766,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM248.42482100238664,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM252.62529832935562,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM256.8257756563246,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM261.0262529832936,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM265.22673031026255,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM269.4272076372315,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM273.6276849642005,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM277.82816229116946,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM282.0286396181384,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM286.2291169451074,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM290.4295942720764,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM294.6300715990454,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM298.83054892601433,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM303.0310262529833,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM307.2315035799523,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM311.43198090692124,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM315.63245823389025,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,292.7326968973747h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM244.22434367541766,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM248.42482100238664,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM252.62529832935562,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM256.8257756563246,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM261.0262529832936,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM265.22673031026255,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM269.4272076372315,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM273.6276849642005,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM277.82816229116946,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM282.0286396181384,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM286.2291169451074,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM290.4295942720764,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM294.6300715990454,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM298.83054892601433,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM303.0310262529833,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM307.2315035799523,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM311.43198090692124,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,296.9331742243437h4.200477326968974v4.200477326968974h-4.200477326968974ZM30,301.13365155131265h4.200477326968974v4.200477326968974h-4.200477326968974ZM34.20047732696897,301.13365155131265h4.200477326968974v4.200477326968974h-4.200477326968974ZM38.400954653937944,301.13365155131265h4.200477326968974v4.200477326968974h-4.200477326968974ZM42.60143198090692,301.13365155131265h4.200477326968974v4.200477326968974h-4.200477326968974ZM46.801909307875896,301.13365155131265h4.200477326968974v4.200477326968974h-4.200477326968974ZM51.00238663484487,301.13365155131265h4.200477326968974v4.200477326968974h-4.200477326968974ZM55.20286396181385,301.13365155131265h4.200477326968974v4.200477326968974h-4.200477326968974ZM151.81384248210026,301.13365155131265h4.200477326968974v4.200477326968974h-4.200477326968974ZM156.0143198090692,301.13365155131265h4.200477326968974v4.200477326968974h-4.200477326968974ZM160.2147971360382,301.13365155131265h4.200477326968974v4.200477326968974h-4.200477326968974ZM164.41527446300717,301.13365155131265h4.200477326968974v4.200477326968974h-4.200477326968974ZM168.61575178997614,301.13365155131265h4.200477326968974v4.200477326968974h-4.200477326968974ZM172.81622911694512,301.13365155131265h4.200477326968974v4.200477326968974h-4.200477326968974ZM177.01670644391407,301.13365155131265h4.200477326968974v4.200477326968974h-4.200477326968974ZM181.21718377088305,301.13365155131265h4.200477326968974v4.200477326968974h-4.200477326968974ZM256.8257756563246,301.13365155131265h4.200477326968974v4.200477326968974h-4.200477326968974ZM261.0262529832936,301.13365155131265h4.200477326968974v4.200477326968974h-4.200477326968974ZM265.22673031026255,301.13365155131265h4.200477326968974v4.200477326968974h-4.200477326968974ZM269.4272076372315,301.13365155131265h4.200477326968974v4.200477326968974h-4.200477326968974ZM273.6276849642005,301.13365155131265h4.200477326968974v4.200477326968974h-4.200477326968974ZM277.82816229116946,301.13365155131265h4.200477326968974v4.200477326968974h-4.200477326968974ZM282.0286396181384,301.13365155131265h4.200477326968974v4.200477326968974h-4.200477326968974ZM286.2291169451074,301.13365155131265h4.200477326968974v4.200477326968974h-4.200477326968974ZM290.4295942720764,301.13365155131265h4.200477326968974v4.200477326968974h-4.200477326968974ZM294.6300715990454,301.13365155131265h4.200477326968974v4.200477326968974h-4.200477326968974ZM298.83054892601433,301.13365155131265h4.200477326968974v4.200477326968974h-4.200477326968974ZM353.436754176611,301.13365155131265h4.200477326968974v4.200477326968974h-4.200477326968974ZM357.63723150358,301.13365155131265h4.200477326968974v4.200477326968974h-4.200477326968974ZM361.83770883054893,301.13365155131265h4.200477326968974v4.200477326968974h-4.200477326968974ZM366.0381861575179,301.13365155131265h4.200477326968974v4.200477326968974h-4.200477326968974ZM370.2386634844869,301.13365155131265h4.200477326968974v4.200477326968974h-4.200477326968974ZM374.43914081145584,301.13365155131265h4.200477326968974v4.200477326968974h-4.200477326968974ZM378.63961813842485,301.13365155131265h4.200477326968974v4.200477326968974h-4.200477326968974ZM382.8400954653938,301.13365155131265h4.200477326968974v4.200477326968974h-4.200477326968974ZM387.0405727923628,301.13365155131265h4.200477326968974v4.200477326968974h-4.200477326968974Z"/></svg>';
  fab.title = 'DS MCP Bridge (可拖动)';
  document.body.appendChild(fab);

    // Panel
    const panel = document.createElement('div');
    panel.id = 'mcp-panel';
    panel.innerHTML = `
      <div class="hd">
        <h3>DS MCP Bridge <span class="ver">v4.2.0</span></h3>
        <button class="cls">&times;</button>
      </div>
      <div id="mcp-tabs">
        <button class="active" data-tab="status">状态</button>
        <button data-tab="test">测试</button>
        <button data-tab="ext">MCP 服务器</button>
        <button data-tab="settings">设置</button>
      </div>
      <div class="mcp-bd">
        <div class="mcp-sec active" id="mcp-sec-status"></div>
        <div class="mcp-sec" id="mcp-sec-test"></div>
        <div class="mcp-sec" id="mcp-sec-ext"></div>
        <div class="mcp-sec" id="mcp-sec-settings"></div>
      </div>
    `;
    document.body.appendChild(panel);

    // Close button
    panel.querySelector('.cls').onclick = () => panel.classList.remove('open');

    // ── Drag ──
      const FAB_POS_KEY = 'mcp_fab_pos';

  // ── Drag ──
  let fabDragged = false, fabSX, fabSY, fabOX, fabOY;
  const DRAG_TH = 5;

  function posPanel() {
    // 手机端直接靠底部全宽展示
    if (window.innerWidth <= 600) {
      panel.style.left = '0px';
      panel.style.bottom = '0px';
      panel.style.top = 'auto';
      panel.style.maxHeight = '80vh';
      return;
    }
    
    const r = fab.getBoundingClientRect();
    const TOP_MARGIN = 50; // Never cover the top bar

    // Horizontal: right-align with FAB, clamp to viewport
    let l = r.right - 460;
    if (l + 460 > window.innerWidth - 10) l = window.innerWidth - 470;
    if (l < 10) l = 10;
    panel.style.left = l + 'px';

    // Try to place panel above the FAB
    const gap = 10;
    const spaceAbove = r.top - gap - TOP_MARGIN;
    const maxH = Math.min(window.innerHeight * 0.75, window.innerHeight - 2 * TOP_MARGIN);

    if (spaceAbove >= 200) {
      // Enough space above FAB — open upward
      panel.style.bottom = (window.innerHeight - r.top + gap) + 'px';
      panel.style.top = 'auto';
    } else {
      // Not enough space above — pin to top margin, let content scroll
      panel.style.top = TOP_MARGIN + 'px';
      panel.style.bottom = 'auto';
    }
    panel.style.maxHeight = maxH + 'px';
  }

  fab.addEventListener('pointerdown', (e) => {
    if (e.button) return;
    fabDragged = false;
    fabSX = e.clientX;
    fabSY = e.clientY;
    const r = fab.getBoundingClientRect();
    fabOX = e.clientX - r.left;
    fabOY = e.clientY - r.top;
    const mv = (e) => {
      if (!fabDragged && Math.abs(e.clientX - fabSX) + Math.abs(e.clientY - fabSY) < DRAG_TH) return;
      fabDragged = true;
      fab.style.left = Math.max(0, Math.min(innerWidth - 48, e.clientX - fabOX)) + 'px';
      fab.style.top = Math.max(0, Math.min(innerHeight - 48, e.clientY - fabOY)) + 'px';
      fab.style.bottom = 'auto';
      fab.style.right = 'auto';
    };
    const up = () => {
      document.removeEventListener('pointermove', mv);
      document.removeEventListener('pointerup', up);
      if (!fabDragged) {
        panel.classList.toggle('open');
        if (panel.classList.contains('open')) {
          posPanel();
          refreshStatus();
        }
      } else {
        if (panel.classList.contains('open')) posPanel();
        // 保存位置到 localStorage
        localStorage.setItem(FAB_POS_KEY, JSON.stringify({ left: fab.style.left, top: fab.style.top }));
      }
    };
    document.addEventListener('pointermove', mv);
    document.addEventListener('pointerup', up);
    e.preventDefault();
  });

  // 恢复上次位置
  const savedPos = JSON.parse(localStorage.getItem(FAB_POS_KEY) || 'null');
  if (savedPos && savedPos.left && savedPos.top) {
    fab.style.left = savedPos.left;
    fab.style.top = savedPos.top;
    fab.style.right = 'auto';
  } else {
    fab.style.right = '20px';
    fab.style.left = 'auto';
    fab.style.top = (innerHeight - 68) + 'px';
  }

    // ── Tabs ──
    panel.querySelectorAll('#mcp-tabs button').forEach(btn => {
      btn.onclick = () => {
        panel.querySelectorAll('#mcp-tabs button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.tab;
        panel.querySelectorAll('.mcp-sec').forEach(s => s.classList.remove('active'));
        panel.querySelector(`#mcp-sec-${tab}`).classList.add('active');
      };
    });

    // ── Shortcut ──
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'M') {
        e.preventDefault();
        panel.classList.toggle('open');
        if (panel.classList.contains('open')) { posPanel(); refreshStatus(); }
      }
    });

    // ═══════════════════════════════════════════════════════════════
    //  Tab: Status
    // ═══════════════════════════════════════════════════════════════
    const secStatus = panel.querySelector('#mcp-sec-status');

    async function refreshStatus() {
      const mcpUrl = GM_getValue('mcp_url', DEFAULT_MCP_URL);
      secStatus.innerHTML = '<div class="mcp-status">连接中...</div>';
      const client = new MCPClient(mcpUrl);
      const healthy = await client.checkHealth();

      if (!healthy) {
        fab.classList.add('disconnected');
        toolRegistry = [];
        secStatus.innerHTML = `
          <div class="mcp-status"><span class="err">未连接</span> — 服务器未运行</div>
          <div style="font-size:12px;color:#666;margin-top:8px">
            请先启动 MCP 服务器：<br>
            <code style="color:#7aa2f7">cd server && python server.py</code>
          </div>
          <div style="margin-top:12px">
            <button class="mcp-btn pri" id="mcp-retry">重试连接</button>
          </div>
        `;
        secStatus.querySelector('#mcp-retry').onclick = refreshStatus;
        return;
      }

      // Fetch health info for external server status
      let healthInfo = null;
      try {
        const resp = await new Promise((resolve, reject) => {
          GM_xmlhttpRequest({
            method: 'GET', url: mcpUrl.replace('/mcp', '/health'),
            onload: (r) => resolve(JSON.parse(r.responseText)),
            onerror: (e) => reject(e), timeout: 5000,
          });
        });
        healthInfo = resp;
      } catch { }

      const tools = await client.listTools();
      toolRegistry = tools;
      fab.classList.remove('disconnected');

      // Separate builtin vs external tools
      const extServers = healthInfo?.external_servers || [];
      const extToolNames = new Set();
      extServers.forEach(s => s.tools?.forEach(t => extToolNames.add(t)));

      let toolList = '';
      tools.forEach(t => {
        const desc = t.description || '';
        const req = t.inputSchema?.required;
        const params = req?.length ? ` (${req.join(', ')})` : '';
        const badge = extToolNames.has(t.name)
          ? '<span style="font-size:10px;color:#f0ad4e;margin-left:4px">ext</span>' : '';
        toolList += `<div class="mcp-tool"><span class="name">${esc(t.name)}${esc(params)}${badge}</span><span class="desc">${esc(desc)}</span></div>`;
      });

      // External servers info
      let extInfo = '';
      if (extServers.length > 0) {
        extInfo = '<div style="margin-top:12px;padding-top:10px;border-top:1px solid #2a2a3a">';
        extInfo += '<div style="font-size:12px;color:#888;margin-bottom:6px">外部 MCP 服务器</div>';
        extServers.forEach(s => {
          const icon = s.connected ? '&#10003;' : '&#10007;';
          const color = s.connected ? '#4ade80' : '#f87171';
          extInfo += `<div style="font-size:12px;color:#aaa;margin-bottom:4px"><span style="color:${color}">${icon}</span> <strong>${esc(s.name)}</strong> (${s.transport}) — ${s.tools?.length || 0} tools</div>`;
        });
        extInfo += '</div>';
      }

      const builtinCount = tools.length - extToolNames.size;
      const summary = extServers.length > 0
        ? `${tools.length} 个工具 (${builtinCount} 内置 + ${extToolNames.size} 外部)`
        : `${tools.length} 个工具`;

      secStatus.innerHTML = `
        <div class="mcp-status"><span class="ok">已连接</span> — ${summary}</div>
        ${extInfo}
        <div style="margin-top:8px">${toolList || '<div style="color:#665">无可用工具</div>'}</div>
        <div style="margin-top:12px">
          <button class="mcp-btn pri" id="mcp-refresh">刷新</button>
        </div>
      `;
      secStatus.querySelector('#mcp-refresh').onclick = refreshStatus;
      console.log(`${SCRIPT_PREFIX} ready — ${tools.length} tools (${extToolNames.size} external)`);
    }

    // ═══════════════════════════════════════════════════════════════
    //  Health Check — 自动轮询 + 断线提示 + 自动重连
    // ═══════════════════════════════════════════════════════════════
    let _healthConnected = null; // null = unknown, true/false = last known state

    async function checkConnection() {
      const mcpUrl = GM_getValue('mcp_url', DEFAULT_MCP_URL);
      try {
        const resp = await new Promise((resolve, reject) => {
          GM_xmlhttpRequest({
            method: 'GET',
            url: mcpUrl.replace('/mcp', '/health'),
            onload: (r) => {
              try { resolve(JSON.parse(r.responseText)); }
              catch { reject(new Error('invalid response')); }
            },
            onerror: () => reject(new Error('network error')),
            timeout: 5000,
          });
        });

        const nowOk = resp.status === 'ok';
        if (_healthConnected === false && nowOk) {
          // 刚恢复连接 — 自动重新加载工具列表
          toast('服务器已恢复连接，正在重新加载...', 'success');
          refreshStatus();
        } else if (_healthConnected === null && nowOk) {
          // 首次检测到已连接
        }
        _healthConnected = nowOk;
        fab.classList.toggle('disconnected', !nowOk);
      } catch {
        if (_healthConnected !== false) {
          _healthConnected = false;
          fab.classList.add('disconnected');
          toolRegistry = [];
          toast('服务器连接断开，请检查 MCP 服务器是否运行中', 'error');
        }
      }
    }

    // 首次检测 + 每 30 秒轮询
    checkConnection();
    setInterval(checkConnection, 30000);

    // ═══════════════════════════════════════════════════════════════
    //  Tab: Test
    // ═══════════════════════════════════════════════════════════════
    const secTest = panel.querySelector('#mcp-sec-test');

    function renderTestTab() {
      if (!toolRegistry.length) {
        secTest.innerHTML = '<div style="color:#665;font-size:13px">请先在"状态"页连接服务器</div>';
        return;
      }

      let opts = '<option value="">选择工具...</option>';
      toolRegistry.forEach(t => { opts += `<option value="${t.name}">${t.name}</option>`; });

      secTest.innerHTML = `
        <div class="mcp-label-row">
          <label class="mcp-label" style="margin:0">工具</label>
        </div>
        <select class="mcp-sel" id="mcp-test-sel">${opts}</select>
        <div id="mcp-test-info" style="margin-top:8px;font-size:12px;color:#666"></div>
        <div id="mcp-test-args" style="margin-top:10px"></div>
        <div style="margin-top:10px">
          <button class="mcp-btn pri" id="mcp-test-run">执行</button>
        </div>
        <div id="mcp-test-result"></div>
      `;

      const sel = secTest.querySelector('#mcp-test-sel');
      const info = secTest.querySelector('#mcp-test-info');
      const argsDiv = secTest.querySelector('#mcp-test-args');
      const resultDiv = secTest.querySelector('#mcp-test-result');

      sel.onchange = () => {
        const tool = toolRegistry.find(t => t.name === sel.value);
        if (!tool) { info.textContent = ''; argsDiv.innerHTML = ''; return; }
        info.textContent = tool.description || '';
        const schema = tool.inputSchema || {};
        const props = schema.properties || {};
        const required = schema.required || [];
        let fields = '';
        for (const [key, prop] of Object.entries(props)) {
          const req = required.includes(key) ? ' *' : '';
          const ph = prop.description || prop.type || '';
          fields += `<div style="margin-bottom:6px">
            <label class="mcp-label">${key}${req}</label>
            <input class="mcp-input" data-arg="${key}" placeholder="${ph}" />
          </div>`;
        }
        if (!fields) fields = '<div style="color:#666;font-size:12px">此工具无需参数</div>';
        argsDiv.innerHTML = fields;
      };

      secTest.querySelector('#mcp-test-run').onclick = async () => {
        const toolName = sel.value;
        if (!toolName) { toast('请选择工具', 'error'); return; }
        const args = {};
        argsDiv.querySelectorAll('.mcp-input').forEach(inp => {
          const key = inp.dataset.arg;
          const val = inp.value.trim();
          if (val) {
            try { args[key] = JSON.parse(val); }
            catch { args[key] = val; }
          }
        });

        resultDiv.innerHTML = '<div class="mcp-result">执行中...</div>';
        const mcpUrl = GM_getValue('mcp_url', DEFAULT_MCP_URL);
        const client = new MCPClient(mcpUrl);
        try {
          const result = await client.callTool(toolName, args);
          const text = result?.content?.[0]?.text || '(no result)';
          const isErr = result?.isError;
          resultDiv.innerHTML = `<div class="mcp-result${isErr ? ' error' : ''}">${esc(text)}</div>`;
        } catch (e) {
          resultDiv.innerHTML = `<div class="mcp-result error">Error: ${esc(e.message)}</div>`;
        }
      };
    }

    // Watch for tab switch to render test tab
    panel.querySelectorAll('#mcp-tabs button').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.tab === 'test') renderTestTab();
        if (btn.dataset.tab === 'ext') renderExtTab();
      });
    });

    // ═══════════════════════════════════════════════════════════════
    //  Tab: External MCP Servers
    // ═══════════════════════════════════════════════════════════════
    const secExt = panel.querySelector('#mcp-sec-ext');

    function getExtBaseUrl() {
      const mcpUrl = GM_getValue('mcp_url', DEFAULT_MCP_URL);
      try { return new URL(mcpUrl).origin; }
      catch { return mcpUrl.replace(/\/[^/]*$/, ''); }
    }

    function getBaseUrl() {
      const mcpUrl = GM_getValue('mcp_url', DEFAULT_MCP_URL);
      // Extract origin from any MCP URL: http://host:port/mcp → http://host:port
      try {
        const u = new URL(mcpUrl);
        return u.origin;
      } catch {
        // Fallback: strip last path segment
        return mcpUrl.replace(/\/[^/]*$/, '');
      }
    }

    function extApiUrl(path) {
      return getBaseUrl() + path;
    }

    async function extApiCall(path, method = 'GET', body) {
      const url = extApiUrl(path);
      return new Promise((resolve, reject) => {
        const opts = {
          method, url, timeout: 15000,
          headers: { 'Content-Type': 'application/json' },
          onload: (r) => {
            try { resolve(JSON.parse(r.responseText)); }
            catch { reject(new Error('Invalid JSON')); }
          },
          onerror: (e) => reject(new Error(e.error || 'Network error')),
          ontimeout: () => reject(new Error('Timeout')),
        };
        if (body) opts.data = JSON.stringify(body);
        GM_xmlhttpRequest(opts);
      });
    }

    let extFormOpen = false;

    let presetParamForm = null; // {presetId, preset} when param form is open

    async function renderExtTab() {
      secExt.innerHTML = '<div style="color:#888;font-size:13px">加载中...</div>';

      // Fetch presets and servers in parallel
      let presets = [], servers = [];
      try {
        const [presetData, serverData] = await Promise.all([
          extApiCall('/api/presets'),
          extApiCall('/api/external-servers'),
        ]);
        presets = presetData.presets || [];
        servers = serverData.servers || [];
      } catch (e) {
        secExt.innerHTML = `<div style="color:#f87171;font-size:13px">连接失败: ${esc(e.message)}</div>`;
        return;
      }

      const installedIds = new Set(servers.map(s => s.name));
      let html = '';

      // ═══ Preset Marketplace ═══
      html += '<div style="font-size:12px;font-weight:600;color:#ccc;margin-bottom:8px">工具预设</div>';

      // Group by category
      const categories = {};
      presets.forEach(p => {
        const cat = p.category || '其他';
        if (!categories[cat]) categories[cat] = [];
        categories[cat].push(p);
      });

      for (const [cat, items] of Object.entries(categories)) {
        html += `<div style="font-size:10px;color:#666;margin:6px 0 3px">${esc(cat)}</div>`;
        html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:6px">';
        items.forEach(p => {
          const installed = installedIds.has(p.id);
          const hasParams = p.params?.length > 0;
          const btnText = installed ? (hasParams ? '重新配置' : '已启用') : (hasParams ? '配置' : '启用');
          const btnClass = 'ext-preset-install';
          const btnStyle = installed
            ? (hasParams
              ? 'background:#222;color:#7aa2f7;border-color:#7aa2f7'
              : 'background:#1a3a2a;color:#4ade80;border-color:#4ade80;pointer-events:none')
            : 'background:#222;color:#7aa2f7;border-color:#7aa2f7';
          html += `
            <div class="ext-preset-card ext-preset-install" data-preset-id="${esc(p.id)}" style="padding:6px 8px;border:1px solid ${installed ? '#2a4a3a' : '#333'};border-radius:6px;background:${installed ? '#1a2a22' : '#1a1a28'}">
              <div style="display:flex;justify-content:space-between;align-items:center">
                <span style="font-size:12px;font-weight:500;color:#ccc">${esc(p.name)}</span>
                <button class="${btnClass} mcp-btn" data-preset-id="${esc(p.id)}" style="${btnStyle};font-size:10px;padding:1px 7px">${btnText}</button>
              </div>
              <div style="font-size:10px;color:#888;margin-top:2px">${esc(p.description)}</div>
            </div>
          `;
        });
        html += '</div>';
      }

      // ═══ Param form (shown when configuring a preset) ═══
      if (presetParamForm) {
        const p = presetParamForm;
        html += `
          <div class="ext-section" id="ext-param-form">
            <div style="font-size:13px;font-weight:600;color:#ccc;margin-bottom:8px">配置: ${esc(p.name)}</div>
        `;
        p.params.forEach(param => {
          const req = param.required ? ' *' : '';
          const inputType = param.secret ? 'password' : 'text';
          html += `
            <div style="margin-bottom:6px">
              <label style="font-size:11px;color:#888;display:block;margin-bottom:2px">${esc(param.label)}${req}</label>
              <input class="mcp-input ext-param-input" data-key="${esc(param.key)}" type="${inputType}"
                     placeholder="${esc(param.placeholder || '')}" style="font-size:12px" />
            </div>
          `;
        });
        html += `
            <div style="margin-top:8px;display:flex;gap:6px">
              <button class="mcp-btn pri" id="ext-param-submit">安装</button>
              <button class="mcp-btn" id="ext-param-cancel">取消</button>
            </div>
          </div>
        `;
      }

      // ═══ Installed Servers ═══
      if (servers.length > 0) {
        html += '<div class="ext-section">';
        html += '<div style="font-size:12px;font-weight:600;color:#ccc;margin-bottom:6px">已安装</div>';
        servers.forEach(s => {
          const dotClass = s.status === 'running' ? 'dot-green' : s.status === 'stopped' ? 'dot-gray' : 'dot-red';
          const statusText = s.status === 'running' ? '运行中' : s.status === 'stopped' ? '已停止' : '异常';
          const statusColor = s.status === 'running' ? '#4ade80' : s.status === 'stopped' ? '#888' : '#f87171';
          const toolsStr = s.tools?.length ? s.tools.join(', ') : '—';

          let actions = '';
          if (s.status === 'running') {
            actions = `<button class="mcp-btn ext-stop" data-name="${esc(s.name)}" style="font-size:11px;padding:3px 8px">停止</button>`;
          } else {
            actions = `<button class="mcp-btn pri ext-start" data-name="${esc(s.name)}" style="font-size:11px;padding:3px 8px">启动</button>`;
          }
          actions += `<button class="mcp-btn ext-remove" data-name="${esc(s.name)}" style="color:#f87171;border-color:#f87171;font-size:11px;padding:3px 8px">删除</button>`;

          html += `
            <div class="ext-card" style="padding:8px 10px;margin-bottom:6px">
              <div class="ext-card-hd">
                <div style="display:flex;align-items:center;gap:8px">
                  <span class="ext-card-name" style="font-size:13px">${esc(s.name)}</span>
                  <span class="ext-card-transport">${s.transport}</span>
                </div>
                <span class="ext-card-status"><span class="dot ${dotClass}"></span><span style="color:${statusColor}">${statusText}</span></span>
              </div>
              <div class="ext-card-tools" style="font-size:10px">工具: ${esc(toolsStr)}</div>
              <div class="ext-card-actions" style="margin-top:6px">${actions}</div>
            </div>
          `;
        });
        html += '</div>';
      }

      // Add form — JSON import
      const defaultJson = JSON.stringify({
        "mcpServers": {
          "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] },
          "fetch": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-fetch"] }
        }
      }, null, 2);

      html += `<div style="margin-top:10px"><button class="ext-add-toggle" id="ext-add-btn">+ 导入 JSON 配置</button></div>`;
      html += `<div id="ext-add-form" style="display:${extFormOpen ? 'block' : 'none'};margin-top:6px">`;
      html += `
        <div style="font-size:10px;color:#888;margin-bottom:4px">
          支持粘贴任意格式的 MCP 配置 JSON，可同时导入多个
        </div>
        <textarea id="ext-f-json" style="width:100%;height:120px;padding:6px;border-radius:6px;border:1px solid #444;background:#0d0d18;color:#a0a0c0;font-size:10px;font-family:monospace;resize:vertical;box-sizing:border-box;outline:none;line-height:1.4" spellcheck="false">${esc(defaultJson)}</textarea>
        <div style="margin-top:6px;display:flex;gap:6px">
          <button class="mcp-btn pri" id="ext-add-submit" style="font-size:11px;padding:4px 10px">导入并启动</button>
          <button class="mcp-btn" id="ext-add-cancel" style="font-size:11px;padding:4px 10px">取消</button>
        </div>
      </div>`;

      html += `<div style="margin-top:8px"><button class="mcp-btn" id="ext-refresh" style="font-size:11px">刷新</button></div>`;

      secExt.innerHTML = html;

      // ── Preset install/configure buttons ──
      secExt.querySelectorAll('.ext-preset-install').forEach(btn => {
        btn.onclick = async (e) => {
          e.stopPropagation();
          const presetId = btn.dataset.presetId;
          const preset = presets.find(p => p.id === presetId);
          if (!preset) return;

          if (preset.params?.length > 0) {
            // Show param form (works for both new install and re-configure)
            presetParamForm = preset;
            renderExtTab();
          } else if (!installedIds.has(presetId)) {
            // One-click install (only for no-params presets that aren't installed)
            try {
              const result = await extApiCall(`/api/presets/${presetId}/install`, 'POST', {});
              if (result.ok) {
                toast(`${preset.name} 已安装，${result.tools?.length || 0} 个工具`, 'success');
                renderExtTab();
                refreshStatus();
              } else {
                toast(result.error || '安装失败', 'error');
              }
            } catch (e) { toast(e.message, 'error'); }
          }
        };
      });

      // ── Param form submit ──
      const paramSubmit = secExt.querySelector('#ext-param-submit');
      if (paramSubmit) {
        paramSubmit.onclick = async () => {
          const params = {};
          secExt.querySelectorAll('.ext-param-input').forEach(inp => {
            params[inp.dataset.key] = inp.value.trim();
          });
          try {
            const result = await extApiCall(`/api/presets/${presetParamForm.id}/install`, 'POST', { params });
            if (result.ok) {
              toast(`${presetParamForm.name} 已安装，${result.tools?.length || 0} 个工具`, 'success');
              presetParamForm = null;
              renderExtTab();
              refreshStatus();
            } else {
              toast(result.error || '安装失败', 'error');
            }
          } catch (e) { toast(e.message, 'error'); }
        };
      }
      const paramCancel = secExt.querySelector('#ext-param-cancel');
      if (paramCancel) {
        paramCancel.onclick = () => { presetParamForm = null; renderExtTab(); };
      }

      // ── Existing server management bindings ──

      // Add form toggle
      secExt.querySelector('#ext-add-btn')?.addEventListener('click', () => {
        extFormOpen = !extFormOpen;
        secExt.querySelector('#ext-add-form').style.display = extFormOpen ? 'block' : 'none';
      });

      // Cancel
      secExt.querySelector('#ext-add-cancel')?.addEventListener('click', () => {
        extFormOpen = false;
        secExt.querySelector('#ext-add-form').style.display = 'none';
      });

      // Submit JSON import
      secExt.querySelector('#ext-add-submit')?.addEventListener('click', async () => {
        const raw = secExt.querySelector('#ext-f-json').value.trim();
        if (!raw) { toast('请粘贴 JSON 配置', 'error'); return; }

        let parsed;
        try { parsed = JSON.parse(raw); }
        catch (e) { toast(`JSON 解析失败: ${e.message}`, 'error'); return; }

        // Auto-unwrap common wrappers
        if (parsed.mcpServers && typeof parsed.mcpServers === 'object') parsed = parsed.mcpServers;
        else if (parsed.servers && typeof parsed.servers === 'object') parsed = parsed.servers;

        let entries;
        if (parsed.name && typeof parsed.name === 'string') {
          const { name, ...cfg } = parsed;
          entries = { [name]: cfg };
        } else if (parsed.command || parsed.url) {
          toast('缺少 name 字段', 'error'); return;
        } else {
          entries = parsed;
        }

        try {
          const result = await extApiCall('/api/external-servers', 'POST', { mcpServers: entries });
          let added = 0, errors = [];
          for (const r of (result.results || [])) {
            if (r.ok) added++;
            else errors.push(`${r.name}: ${r.error || '未知错误'}`);
          }
          if (added > 0) {
            toast(`已添加 ${added} 个服务器`, 'success');
            extFormOpen = false;
            renderExtTab();
            refreshStatus();
          }
          errors.forEach(e => toast(e, 'error'));
        } catch (e) { toast(`请求失败: ${e.message || '网络错误'}`, 'error'); }
      });

      // Start/Stop/Remove
      secExt.querySelectorAll('.ext-start').forEach(btn => {
        btn.onclick = async () => {
          const name = btn.dataset.name;
          try {
            const result = await extApiCall(`/api/external-servers/${name}/start`, 'POST');
            toast(result.ok ? `${name} 已启动` : result.error, result.ok ? 'success' : 'error');
            renderExtTab(); refreshStatus();
          } catch (e) { toast(e.message, 'error'); }
        };
      });

      secExt.querySelectorAll('.ext-stop').forEach(btn => {
        btn.onclick = async () => {
          const name = btn.dataset.name;
          try {
            const result = await extApiCall(`/api/external-servers/${name}/stop`, 'POST');
            toast(result.ok ? `${name} 已停止` : result.error, result.ok ? 'success' : 'error');
            renderExtTab(); refreshStatus();
          } catch (e) { toast(e.message, 'error'); }
        };
      });

      secExt.querySelectorAll('.ext-remove').forEach(btn => {
        btn.onclick = async () => {
          const name = btn.dataset.name;
          if (!confirm(`确定删除 ${name}？`)) return;
          try {
            const result = await extApiCall(`/api/external-servers/${name}`, 'DELETE');
            toast(result.ok ? `${name} 已删除` : result.error, result.ok ? 'success' : 'error');
            renderExtTab(); refreshStatus();
          } catch (e) { toast(e.message, 'error'); }
        };
      });

      // Refresh
      secExt.querySelector('#ext-refresh')?.addEventListener('click', renderExtTab);

      // Start/Stop/Remove
      secExt.querySelectorAll('.ext-start').forEach(btn => {
        btn.onclick = async () => {
          const name = btn.dataset.name;
          try {
            const result = await extApiCall(`/api/external-servers/${name}/start`, 'POST');
            toast(result.ok ? `${name} 已启动` : result.error, result.ok ? 'success' : 'error');
            renderExtTab(); refreshStatus();
          } catch (e) { toast(e.message, 'error'); }
        };
      });

      secExt.querySelectorAll('.ext-stop').forEach(btn => {
        btn.onclick = async () => {
          const name = btn.dataset.name;
          try {
            const result = await extApiCall(`/api/external-servers/${name}/stop`, 'POST');
            toast(result.ok ? `${name} 已停止` : result.error, result.ok ? 'success' : 'error');
            renderExtTab(); refreshStatus();
          } catch (e) { toast(e.message, 'error'); }
        };
      });

      secExt.querySelectorAll('.ext-remove').forEach(btn => {
        btn.onclick = async () => {
          const name = btn.dataset.name;
          if (!confirm(`确定删除 ${name}？`)) return;
          try {
            const result = await extApiCall(`/api/external-servers/${name}`, 'DELETE');
            toast(result.ok ? `${name} 已删除` : result.error, result.ok ? 'success' : 'error');
            renderExtTab(); refreshStatus();
          } catch (e) { toast(e.message, 'error'); }
        };
      });

      // Refresh
      secExt.querySelector('#ext-refresh').onclick = renderExtTab;
    }

    // ═══════════════════════════════════════════════════════════════
    //  Tab: Settings
    // ═══════════════════════════════════════════════════════════════
    const secSettings = panel.querySelector('#mcp-sec-settings');
    secSettings.innerHTML = `
      <div>
        <label class="mcp-label">MCP 服务器地址</label>
        <input class="mcp-input" id="mcp-cfg-url" value="${GM_getValue('mcp_url', DEFAULT_MCP_URL)}" />
      </div>
      <div style="margin-top:16px">
        <label class="mcp-label">模块开关</label>
        <div class="mcp-toggle-row">
          <div><div class="mcp-toggle-label">🔧 MCP 工具调用</div><div class="mcp-toggle-desc">拦截 AI 回复并执行本地工具</div></div>
          <label class="mcp-switch"><input type="checkbox" id="mod-toggle-mcp" ${getModuleEnabled('mcp') ? 'checked' : ''} /><span class="slider"></span></label>
        </div>
        <div class="mcp-toggle-row">
          <div><div class="mcp-toggle-label">📨 工具结果自动发送</div><div class="mcp-toggle-desc">工具结果填入输入框后自动提交</div></div>
          <label class="mcp-switch"><input type="checkbox" id="mcp-cfg-autosend" ${getAutoSendEnabled() ? 'checked' : ''} /><span class="slider"></span></label>
        </div>
        <div class="mcp-toggle-row">
          <div><div class="mcp-toggle-label">🔊 TTS 朗读</div><div class="mcp-toggle-desc">AI 回复旁显示朗读按钮</div></div>
          <label class="mcp-switch"><input type="checkbox" id="mod-toggle-tts" ${getModuleEnabled('tts') ? 'checked' : ''} /><span class="slider"></span></label>
        </div>
        <div class="mcp-toggle-row">
          <div><div class="mcp-toggle-label">🔊 自动朗读</div><div class="mcp-toggle-desc">AI 回复完成后自动 TTS 播放</div></div>
          <label class="mcp-switch"><input type="checkbox" id="mod-toggle-ttsAutoPlay" ${getModuleEnabled('ttsAutoPlay') ? 'checked' : ''} /><span class="slider"></span></label>
        </div>
      </div>
      <div style="margin-top:16px">
        <label class="mcp-label">TTS 设置</label>
        <div class="mcp-toggle-row">
          <div><div class="mcp-toggle-label">引擎</div><div class="mcp-toggle-desc">TTS 提供者</div></div>
          <select class="mcp-sel" id="mcp-tts-provider" style="width:auto">
            <option value="edge" ${GM_getValue('tts_provider', 'edge') === 'edge' ? 'selected' : ''}>Edge TTS (免费)</option>
            <option value="openai" ${GM_getValue('tts_provider', 'edge') === 'openai' ? 'selected' : ''}>OpenAI 兼容</option>
          </select>
        </div>
        <div style="margin-top:8px">
          <label class="mcp-label">语音</label>
          <div style="display:flex;gap:6px;margin-bottom:6px">
            <select class="mcp-sel" id="mcp-tts-voice-filter-locale" style="width:auto;font-size:11px">
              <option value="">全部语言</option>
              <option value="zh-">中文</option>
              <option value="en-">英语</option>
              <option value="ja-">日语</option>
              <option value="ko-">韩语</option>
            </select>
            <select class="mcp-sel" id="mcp-tts-voice-filter-gender" style="width:auto;font-size:11px">
              <option value="">全部性别</option>
              <option value="Female">女声</option>
              <option value="Male">男声</option>
            </select>
          </div>
          <select class="mcp-sel" id="mcp-tts-voice" style="width:100%">
            <option value="${GM_getValue('tts_voice', 'zh-CN-XiaoxiaoNeural')}">加载中...</option>
          </select>
          <div id="mcp-tts-voice-status" style="font-size:10px;color:#666;margin-top:4px"></div>
        </div>
        <div id="mcp-tts-adv" style="display:${GM_getValue('tts_provider', 'edge') !== 'edge' ? 'block' : 'none'};margin-top:8px;padding:8px;background:#1a1a28;border-radius:8px;border:1px solid #333">
          <div style="font-size:11px;color:#888;margin-bottom:6px">OpenAI 兼容配置</div>
          <div style="margin-bottom:6px"><label class="mcp-label">API Key</label><input class="mcp-input" id="mcp-tts-apikey" type="password" value="${GM_getValue('tts_api_key', '')}" placeholder="sk-..." style="font-size:12px" /></div>
          <div style="margin-bottom:6px"><label class="mcp-label">Base URL</label><input class="mcp-input" id="mcp-tts-baseurl" value="${GM_getValue('tts_base_url', 'https://api.openai.com/v1')}" style="font-size:12px" /></div>
          <div><label class="mcp-label">模型</label><input class="mcp-input" id="mcp-tts-model" value="${GM_getValue('tts_model', 'tts-1')}" placeholder="tts-1 / tts-1-hd" style="font-size:12px" /></div>
        </div>
      </div>
      <div style="margin-top:8px;font-size:11px;color:#555">适配器: ${currentAdapter ? currentAdapter.name : '无'}</div>
      <div style="margin-top:12px"><button class="mcp-btn pri" id="mcp-cfg-save">保存</button></div>
    `;

    secSettings.querySelector('#mcp-cfg-save').onclick = () => {
      const url = secSettings.querySelector('#mcp-cfg-url').value.trim();
      if (!url) { toast('地址不能为空', 'error'); return; }
      GM_setValue('mcp_url', url);
      ['mcp', 'tts', 'ttsAutoPlay'].forEach(mod => {
        const toggle = secSettings.querySelector('#mod-toggle-' + mod);
        if (toggle) setModuleEnabled(mod, toggle.checked);
      });
      const autoSendToggle = secSettings.querySelector('#mcp-cfg-autosend');
      if (autoSendToggle) GM_setValue(AUTO_SEND_KEY, autoSendToggle.checked);
      const providerSel = secSettings.querySelector('#mcp-tts-provider');
      if (providerSel) GM_setValue('tts_provider', providerSel.value);
      const voiceInput = secSettings.querySelector('#mcp-tts-voice');
      if (voiceInput) GM_setValue('tts_voice', voiceInput.value.trim());
      const apiKeyInput = secSettings.querySelector('#mcp-tts-apikey');
      if (apiKeyInput) GM_setValue('tts_api_key', apiKeyInput.value.trim());
      const baseUrlInput = secSettings.querySelector('#mcp-tts-baseurl');
      if (baseUrlInput) GM_setValue('tts_base_url', baseUrlInput.value.trim());
      const modelInput = secSettings.querySelector('#mcp-tts-model');
      if (modelInput) GM_setValue('tts_model', modelInput.value.trim());
      toast('已保存', 'success');
      refreshStatus();
    };

    secSettings.querySelector('#mcp-tts-provider')?.addEventListener('change', (e) => {
      const adv = secSettings.querySelector('#mcp-tts-adv');
      if (adv) adv.style.display = e.target.value !== 'edge' ? 'block' : 'none';
    });

    // Load Edge TTS voices — with built-in fallback list
    (function loadVoices() {
      const voiceSel = secSettings.querySelector('#mcp-tts-voice');
      const localeFilter = secSettings.querySelector('#mcp-tts-voice-filter-locale');
      const genderFilter = secSettings.querySelector('#mcp-tts-voice-filter-gender');
      const status = secSettings.querySelector('#mcp-tts-voice-status');
      if (!voiceSel) return;

      // Built-in Chinese voices (works without server)
      const BUILTIN_VOICES = [
        { id: 'zh-CN-XiaoxiaoNeural', gender: 'Female', locale: 'zh-CN' },
        { id: 'zh-CN-XiaoyiNeural', gender: 'Female', locale: 'zh-CN' },
        { id: 'zh-CN-YunjianNeural', gender: 'Male', locale: 'zh-CN' },
        { id: 'zh-CN-YunxiNeural', gender: 'Male', locale: 'zh-CN' },
        { id: 'zh-CN-YunxiaNeural', gender: 'Male', locale: 'zh-CN' },
        { id: 'zh-CN-YunyangNeural', gender: 'Male', locale: 'zh-CN' },
        { id: 'zh-CN-liaoning-XiaobeiNeural', gender: 'Female', locale: 'zh-CN-liaoning' },
        { id: 'zh-CN-shaanxi-XiaoniNeural', gender: 'Female', locale: 'zh-CN-shaanxi' },
        { id: 'zh-HK-HiuGaaiNeural', gender: 'Female', locale: 'zh-HK' },
        { id: 'zh-HK-HiuMaanNeural', gender: 'Female', locale: 'zh-HK' },
        { id: 'zh-HK-WanLungNeural', gender: 'Male', locale: 'zh-HK' },
        { id: 'zh-TW-HsiaoChenNeural', gender: 'Female', locale: 'zh-TW' },
        { id: 'zh-TW-YunJheNeural', gender: 'Male', locale: 'zh-TW' },
        { id: 'zh-TW-HsiaoYuNeural', gender: 'Female', locale: 'zh-TW' },
        { id: 'en-US-JennyNeural', gender: 'Female', locale: 'en-US' },
        { id: 'en-US-GuyNeural', gender: 'Male', locale: 'en-US' },
        { id: 'en-US-AriaNeural', gender: 'Female', locale: 'en-US' },
        { id: 'ja-JP-NanamiNeural', gender: 'Female', locale: 'ja-JP' },
        { id: 'ja-JP-KeitaNeural', gender: 'Male', locale: 'ja-JP' },
        { id: 'ko-KR-SunHiNeural', gender: 'Female', locale: 'ko-KR' },
        { id: 'ko-KR-InJoonNeural', gender: 'Male', locale: 'ko-KR' },
      ];

      let allVoices = BUILTIN_VOICES;
      const currentVoice = GM_getValue('tts_voice', 'zh-CN-XiaoxiaoNeural');

      function renderVoices() {
        const locale = localeFilter?.value || '';
        const gender = genderFilter?.value || '';
        const filtered = allVoices.filter(v =>
          (!locale || v.id.includes(locale) || v.id.startsWith(locale)) &&
          (!gender || v.gender === gender)
        );
        voiceSel.innerHTML = '';
        if (!filtered.length) {
          voiceSel.innerHTML = '<option value="">无匹配语音</option>';
          return;
        }
        for (const v of filtered) {
          const opt = document.createElement('option');
          opt.value = v.id;
          const g = v.gender === 'Female' ? '♀' : '♂';
          opt.textContent = g + ' ' + v.id;
          if (v.id === currentVoice) opt.selected = true;
          voiceSel.appendChild(opt);
        }
        status.textContent = filtered.length + ' / ' + allVoices.length + ' 个语音' + (allVoices.length > BUILTIN_VOICES.length ? '' : ' (内置列表)');
      }

      // Render builtin list immediately
      renderVoices();

      // Try loading full list from server in background
      const url = getExtBaseUrl() + '/api/tts/voices';
      GM_xmlhttpRequest({
        method: 'GET', url, timeout: 10000,
        onload: (resp) => {
          try {
            const data = JSON.parse(resp.responseText);
            if (data.voices?.length) {
              allVoices = data.voices;
              renderVoices();
            }
          } catch { }
        },
        onerror: () => { }, ontimeout: () => { },
      });

      localeFilter?.addEventListener('change', renderVoices);
      genderFilter?.addEventListener('change', renderVoices);
    })();


    // ═══════════════════════════════════════════════════════════════
    //  MCP Code Block Actions + System Instruction Folding
    // ═══════════════════════════════════════════════════════════════
    function parseToolArgs(rawArgs) {
      const text = (rawArgs || '').trim();
      if (!text) return {};
      try { return JSON.parse(text); }
      catch { return { input: text }; }
    }

    function getMCPCodeInfo(block) {
      const banner = block.querySelector?.('.md-code-block-banner, [class*="code-block-banner"], [class*="code-header"]');
      const blockText = block.textContent || '';
      const langText = banner?.textContent || '';
      let match = langText.match(/(?:^|\s)mcp:([\w.-]+)(?:\s|$)/);
      if (!match) match = blockText.match(/```mcp:([\w.-]+)\s*([\s\S]*?)```/);
      if (!match) match = blockText.match(/^\s*mcp:([\w.-]+)(?:\s|$)/);
      if (!match) return null;

      const toolName = match[1];
      let rawArgs = '';
      if (match[2]) rawArgs = match[2].trim();
      else {
        const pre = block.matches?.('pre') ? block : block.querySelector?.('pre') || block.querySelector?.('code');
        rawArgs = (pre?.innerText || pre?.textContent || '').trim();
      }
      rawArgs = rawArgs.replace(new RegExp(`^mcp:${toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i'), '').trim();
      return { toolName, rawArgs };
    }

    function getCodeActionContainer(block) {
      const banner = block.querySelector?.('.md-code-block-banner, [class*="code-block-banner"], [class*="code-header"]');
      if (banner) {
        return banner.querySelector('[class*="action"], [class*="copy"], [class*="toolbar"], .efa13877') || banner;
      }
      const pre = block.matches?.('pre') ? block : block.querySelector?.('pre');
      if (!pre) return null;
      const bar = document.createElement('div');
      bar.style.cssText = 'display:flex;justify-content:flex-end;gap:4px;margin:4px 0;';
      pre.parentNode.insertBefore(bar, pre);
      return bar;
    }

    function enhanceMCPCodeBlocks() {
      const candidates = new Set();
      document.querySelectorAll('.md-code-block, [class*="code-block"], pre').forEach(el => {
        if (el.closest('#mcp-panel')) return;
        candidates.add(el.closest('.md-code-block, [class*="code-block"]') || el);
      });

      candidates.forEach(block => {
        if (!block || block.dataset?.mcpEnhanced === '1') return;
        const info = getMCPCodeInfo(block);
        if (!info) return;
        const actionContainer = getCodeActionContainer(block);
        if (!actionContainer) return;

        block.dataset.mcpEnhanced = '1';
        block.classList.add('mcp-code-hidden');

        const collapseBtn = document.createElement('button');
        collapseBtn.type = 'button';
        collapseBtn.className = 'mcp-code-action collapse';
        collapseBtn.textContent = '展开';
        collapseBtn.title = '展开或折叠 MCP 指令';
        collapseBtn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const hidden = block.classList.toggle('mcp-code-hidden');
          collapseBtn.textContent = hidden ? '展开' : '折叠';
        };

        const resendBtn = document.createElement('button');
        resendBtn.type = 'button';
        resendBtn.className = 'mcp-code-action resend';
        resendBtn.textContent = '重发';
        resendBtn.title = `重新执行 ${info.toolName}`;
        resendBtn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const latest = getMCPCodeInfo(block) || info;
          executeToolCall(latest.toolName, parseToolArgs(latest.rawArgs));
          toast(`已重发: ${latest.toolName}`, 'info');
        };

        actionContainer.appendChild(collapseBtn);
        actionContainer.appendChild(resendBtn);
      });
    }

    function findTightSystemInstructionElement(root) {
      let node = root;
      while (node?.children?.length) {
        const children = Array.from(node.children).filter(child => {
          if (child.closest?.('.mcp-sys-fold')) return false;
          const text = child.textContent || '';
          return text.includes(SYSTEM_HINT_START) && text.includes(SYSTEM_HINT_END);
        });
        if (children.length !== 1) break;
        node = children[0];
      }
      return node;
    }

    function foldSystemInstructionElement(target) {
      if (!target || target.dataset?.mcpSystemFolded === '1') return;
      if (target.querySelector?.('.mcp-sys-fold')) return;
      const text = target.textContent || '';
      const start = text.indexOf(SYSTEM_HINT_START);
      const endStart = text.indexOf(SYSTEM_HINT_END, start);
      if (start < 0 || endStart < 0) return;

      const end = endStart + SYSTEM_HINT_END.length;
      const before = text.slice(0, start).trim();
      const hidden = text.slice(start, end).trim();
      const after = text.slice(end).trim();
      if (hidden.length < 80) return;

      const frag = document.createDocumentFragment();
      const addTextBlock = (content) => {
        if (!content) return;
        const el = document.createElement('div');
        el.style.whiteSpace = 'pre-wrap';
        el.textContent = content;
        frag.appendChild(el);
      };

      addTextBlock(before);

      const fold = document.createElement('div');
      fold.className = 'mcp-sys-fold';
      fold.innerHTML = `
        <div class="mcp-sys-fold-hd"><span class="mcp-sys-fold-title">${SYSTEM_HINT_START}</span><span class="mcp-sys-fold-toggle">展开</span></div>
        <div class="mcp-sys-fold-body"></div>
      `;
      fold.querySelector('.mcp-sys-fold-body').textContent = hidden;
      fold.querySelector('.mcp-sys-fold-hd').onclick = () => {
        const open = fold.classList.toggle('open');
        fold.querySelector('.mcp-sys-fold-toggle').textContent = open ? '折叠' : '展开';
      };
      frag.appendChild(fold);

      addTextBlock(after);
      target.dataset.mcpSystemFolded = '1';
      target.replaceChildren(frag);
    }

    function collapseSystemInstructions() {
      const roots = document.querySelectorAll('.ds-markdown, .ds-markdown--block, [class*="markdown"], [data-message-author-role="user"]');
      roots.forEach(root => {
        if (root.closest('#mcp-panel, .mcp-sys-fold')) return;
        if (root.dataset?.mcpSystemFolded === '1' || root.querySelector?.('.mcp-sys-fold')) return;
        const text = root.textContent || '';
        if (!text.includes(SYSTEM_HINT_START) || !text.includes(SYSTEM_HINT_END)) return;
        const target = findTightSystemInstructionElement(root);
        if (!target || target === document.body || target === document.documentElement) return;
        foldSystemInstructionElement(target);
      });
    }

    function enhanceChatUI() {
      enhanceMCPCodeBlocks();
      collapseSystemInstructions();
      injectTTSButtons();
    }


    // ═══════════════════════════════════════════════════════════════
    //  TTS Button Injection — Add 🔊 to assistant messages
    // ═══════════════════════════════════════════════════════════════
    const _ttsSeenMessages = new WeakSet();
    const _ttsAutoPlayContainers = new Set();
    const _ttsAutoPlayTimers = new Map();

    /** Find the action bar (copy/regenerate buttons area) within a message container */
    function _findActionBar(container) {
      // Try common class patterns first
      const byClass = container.querySelector('[class*="action"], [class*="toolbar"], [class*="buttons"], [class*="footer"]');
      if (byClass) return byClass;
      // Fallback: find any element with direct button children (likely the action bar)
      const allEls = Array.from(container.querySelectorAll('*'));
      for (let i = allEls.length - 1; i >= 0; i--) {
        const el = allEls[i];
        if (el.querySelectorAll(':scope > button').length >= 1) return el;
      }
      return null;
    }

    function injectTTSButtons() {
      if (!getModuleEnabled('tts')) return;
      const selectors = currentAdapter?.selectors?.assistantMessages || '.ds-markdown--block, [class*="markdown"]';
      const messages = document.querySelectorAll(selectors);
      messages.forEach(msg => {
        const text = msg.textContent?.trim();
        if (!text || text.length < 10) return;
        const isNew = !_ttsSeenMessages.has(msg);
        _ttsSeenMessages.add(msg);
        const container = msg.closest('[class*="message"]') || msg.parentElement || msg;

        // Check for existing button on the container (not just msg, since we insert into action bar)
        if (container.querySelector('.mcp-tts-btn')) return;

        const btn = document.createElement('button');
        btn.className = 'mcp-tts-btn';
        btn.innerHTML = '🔊 朗读';
        btn.title = '朗读';
        btn.onclick = (e) => {
          e.stopPropagation();
          const freshText = msg.textContent?.trim() || text;
          if (ttsClient.playing && ttsClient.currentText === freshText) {
            ttsClient.stop();
            btn.innerHTML = '🔊 朗读';
            btn.classList.remove('playing', 'paused');
            return;
          }
          btn.innerHTML = '⏳ 合成中...';
          btn.style.minWidth = (btn.offsetWidth || 56) + 'px';
          ttsClient.play(freshText).then(() => {
            btn.innerHTML = '⏸ 暂停';
            btn.classList.add('playing');
            const check = setInterval(() => {
              if (!ttsClient.playing) {
                btn.innerHTML = '🔊 朗读';
                btn.classList.remove('playing', 'paused');
                btn.style.minWidth = '';
                clearInterval(check);
              }
            }, 500);
          }).catch(err => {
            btn.innerHTML = '🔊 朗读';
            btn.style.minWidth = '';
            toast('TTS 失败: ' + err.message, 'error');
          });
        };

        // Insert into action bar at the bottom of the message
        const actionBar = _findActionBar(container);
        if (actionBar) {
          actionBar.appendChild(btn);
        } else {
          container.appendChild(btn);
        }

        // Auto-play: track by container, wait for text to stabilize
        if (isNew && getModuleEnabled('ttsAutoPlay') && !_ttsAutoPlayContainers.has(container)) {
          _ttsAutoPlayContainers.add(container);
          _watchTextStable(container, selectors);
        }
      });
    }

    // Watch a container until its text stops changing, then play TTS
    function _watchTextStable(container, selectors) {
      const selectorStr = selectors.split(',').map(s => s.trim()).join(',');
      let lastLen = 0;
      let stableCount = 0;
      const check = setInterval(() => {
        const md = container.querySelector(selectorStr);
        if (!md) return;
        const len = md.textContent.length;
        if (len > 0 && len === lastLen) {
          stableCount++;
        } else {
          stableCount = 0;
          lastLen = len;
        }
        if (stableCount >= 2 && lastLen > 10) {
          clearInterval(check);
          _ttsAutoPlayTimers.delete(container);
          ttsClient.play(md.textContent.trim()).catch(err => console.warn('Auto TTS:', err.message));
        }
      }, 1000);
      setTimeout(() => clearInterval(check), 60000);
      _ttsAutoPlayTimers.set(container, check);
    }

    // ═══════════════════════════════════════════════════════════════
    //  MutationObserver — TTS button injection
    // ═══════════════════════════════════════════════════════════════
    let _uiDebounce = null;
    let _isPageVisible = true;

    const uiObserver = new MutationObserver((mutations) => {
      let hasNewNodes = false;
      for (const m of mutations) {
        if (m.addedNodes.length > 0) { hasNewNodes = true; break; }
      }
      if (!hasNewNodes) return;
      if (_uiDebounce) clearTimeout(_uiDebounce);
      _uiDebounce = setTimeout(() => {
        if (!_isPageVisible) return;
        const _run = () => enhanceChatUI();
        if ('requestIdleCallback' in window) {
          requestIdleCallback(_run, { timeout: 2000 });
        } else {
          setTimeout(_run, 200);
        }
      }, 1000);
    });

    function _reconnectObserver() {
      const chatContainer = document.querySelector('[class*="chat-message-list"]')
        || document.querySelector('[class*="message-list"]')
        || document.querySelector('main')
        || document.body;
      uiObserver.observe(chatContainer, { childList: true, subtree: true });
    }

    setTimeout(() => {
      _reconnectObserver();
      enhanceChatUI();
    }, 2000);

    // ── Visibility change: pause/resume to prevent deferred-callback pile-up ──
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        _isPageVisible = false;
        uiObserver.disconnect();
        if (_uiDebounce) { clearTimeout(_uiDebounce); _uiDebounce = null; }
        // Clear all auto-play timers so they don't pile up while hidden
        for (const [container, timer] of _ttsAutoPlayTimers) {
          clearInterval(timer);
        }
        _ttsAutoPlayTimers.clear();
        // Stop any active TTS playback
        if (ttsClient.playing) ttsClient.stop();
      } else {
        _isPageVisible = true;
        _reconnectObserver();
        enhanceChatUI();
      }
    });

    // ── Auto-connect on load ──
    refreshStatus();

    function esc(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
  });
})();
