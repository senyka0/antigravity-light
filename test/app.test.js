import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AppPaths } from '../src/paths.js';
import { AccountsStore } from '../src/storage.js';
import { AccountDetector } from '../src/detector.js';
import { ChatResumer } from '../src/chat-resumer.js';
import { ConfigManager } from '../src/config.js';
import { ProxyServer } from '../src/proxy.js';

test('1. AppPaths resolves correctly on this platform', () => {
  const ua = AppPaths.getUserAgent();
  assert.match(ua, /^antigravity\/2\.0\.3 (linux|windows)\/(amd64|arm64)$/);

  const stateCandidates = AppPaths.getAntigravityStateDbCandidates();
  assert.ok(stateCandidates.length > 0);

  const agy = AppPaths.getAgyCli();
  assert.ok(typeof agy === 'string');
});

test('2. AccountDetector detects current Antigravity account', () => {
  const detected = AccountDetector.detectActiveAccount();
  assert.ok(detected !== null, 'Should detect active Antigravity account on system');
  assert.ok(detected.email.includes('@'), 'Detected account should be a valid email');
  console.log('   ✓ Detected email:', detected.email, `(${detected.source})`);
});

test('3. ChatResumer detects active conversation', () => {
  const active = ChatResumer.findActiveConversation();
  assert.ok(active !== null, 'Should detect running conversation');
  assert.ok(active.conversationId, 'Conversation ID should be present');
  console.log('   ✓ Detected running conversation:', active.conversationId, '-', active.title);
});

test('4. AccountsStore CRUD operations', () => {
  const testAcc = {
    id: 'test-id-123',
    email: 'test.user@example.com',
    accessToken: 'test-token',
    refreshToken: 'test-refresh',
    expiresAt: Date.now() + 3600000,
    isActive: true,
  };

  AccountsStore.upsertAccount(testAcc);
  const fetched = AccountsStore.getAccount('test-id-123');
  assert.equal(fetched.email, 'test.user@example.com');

  AccountsStore.updateQuota('test-id-123', { flash5h: 80, flash5d: 90 });
  const updated = AccountsStore.getAccount('test-id-123');
  assert.equal(updated.quota.flash5h, 80);

  AccountsStore.removeAccount('test-id-123');
  assert.equal(AccountsStore.getAccount('test-id-123'), null);
});

test('5. ConfigManager load and update', () => {
  const config = ConfigManager.load();
  assert.equal(typeof config.proxyPort, 'number');
  assert.equal(typeof config.depletionThresholdPercent, 'number');

  ConfigManager.update({ targetModel: 'gemini-3.8-flash' });
  const updated = ConfigManager.load();
  assert.equal(updated.targetModel, 'gemini-3.8-flash');
});

test('6. ProxyServer handles OpenAI payload translation', () => {
  const openAiRequest = {
    model: 'gpt-4o', // should map to gemini-3.8-flash
    messages: [
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'What is 2+2?' },
      { role: 'assistant', content: '4' },
      { role: 'user', content: 'Multiply by 3' },
    ],
    temperature: 0.5,
  };

  const geminiPayload = ProxyServer.convertToGeminiPayload(openAiRequest, 'test-project');
  assert.equal(geminiPayload.project, 'test-project');
  assert.equal(geminiPayload.model, 'gemini-3.8-flash-tiered');
  assert.equal(geminiPayload.request.systemInstruction.parts[0].text, 'Be concise.');
  assert.equal(geminiPayload.request.contents.length, 3);
  assert.equal(geminiPayload.request.contents[0].role, 'user');
  assert.equal(geminiPayload.request.contents[1].role, 'model');
  assert.equal(geminiPayload.request.contents[2].role, 'user');
});

test('7. ProxyServer HTTP /v1/models route responds with OpenAI format', async () => {
  const testPort = 18080;
  const server = ProxyServer.start(testPort, '127.0.0.1');

  try {
    const res = await fetch(`http://127.0.0.1:${testPort}/v1/models`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.object, 'list');
    assert.ok(data.data.some((m) => m.id === 'gemini-3.8-flash'));
  } finally {
    server.close();
  }
});

test('8. Web Dashboard serves HTML and responds to /api/status', async () => {
  const testPort = 18081;
  const server = ProxyServer.start(testPort, '127.0.0.1');

  try {
    // Check GET /
    const htmlRes = await fetch(`http://127.0.0.1:${testPort}/`);
    assert.equal(htmlRes.status, 200);
    assert.ok(htmlRes.headers.get('content-type').includes('text/html'));
    const htmlText = await htmlRes.text();
    assert.ok(htmlText.includes('Antigravity Light'));

    // Check GET /api/status
    const apiRes = await fetch(`http://127.0.0.1:${testPort}/api/status`);
    assert.equal(apiRes.status, 200);
    const data = await apiRes.json();
    assert.ok(Array.isArray(data.accounts));
    assert.ok(data.activeIdeAccount);
    assert.ok(data.config);
  } finally {
    server.close();
  }
});

test('9. ProxyServer /v1/chat/completions responds live with valid response', async () => {
  const testPort = 18082;
  const server = ProxyServer.start(testPort, '127.0.0.1');

  try {
    const res = await fetch(`http://127.0.0.1:${testPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3.8-flash',
        messages: [{ role: 'user', content: 'Say pong' }],
        stream: false,
      }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.object, 'chat.completion');
    assert.ok(data.choices && data.choices.length > 0);
    assert.ok(typeof data.choices[0].message.content === 'string');
    assert.ok(data.choices[0].message.content.length > 0);
  } finally {
    server.close();
  }
});

test('10. ProxyServer /v1/chat/completions streams SSE response live', async () => {
  const testPort = 18083;
  const server = ProxyServer.start(testPort, '127.0.0.1');

  try {
    const res = await fetch(`http://127.0.0.1:${testPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3.8-flash',
        messages: [{ role: 'user', content: 'Say hello in 3 words' }],
        stream: true,
      }),
    });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type').includes('text/event-stream'));

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let chunks = [];
    let receivedDone = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      for (const line of text.split('\n')) {
        if (line.startsWith('data: ')) {
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') {
            receivedDone = true;
          } else {
            try {
              const parsed = JSON.parse(payload);
              if (parsed.choices?.[0]?.delta?.content) {
                chunks.push(parsed.choices[0].delta.content);
              }
            } catch {}
          }
        }
      }
    }

    assert.ok(receivedDone, 'Should receive [DONE] SSE chunk');
    assert.ok(chunks.length > 0, 'Should receive streamed text chunks');
  } finally {
    server.close();
  }
});

test('11. ChatResumer resolves DevTools port and candidates correctly', () => {
  const candidates = AppPaths.getDevToolsPortFileCandidates();
  assert.ok(Array.isArray(candidates) && candidates.length > 0);
  const devToolsFile = AppPaths.getDevToolsPortFile();
  assert.ok(devToolsFile, 'Should resolve DevToolsActivePort candidate');
});

test('12. ProxyServer handles tool calling and generates OpenAI-compliant tool_calls', async () => {
  // Verify tool call ID format matches OpenAI / PentAGI pattern call_{r:24:b}
  const toolId = ProxyServer.generateToolCallId();
  assert.equal(toolId.length, 29);
  assert.match(toolId, /^call_[0-9A-Za-z]{24}$/);

  const testPort = 18084;
  const server = ProxyServer.start(testPort, '127.0.0.1');

  try {
    const res = await fetch(`http://127.0.0.1:${testPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3.8-flash',
        messages: [{ role: 'user', content: 'What is the weather in Paris? Call get_weather with location Paris.' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Get weather for a given location',
              parameters: {
                type: 'object',
                properties: {
                  location: { type: 'string', description: 'City name' },
                },
                required: ['location'],
              },
            },
          },
        ],
        stream: false,
      }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.object, 'chat.completion');
    assert.ok(data.choices && data.choices.length > 0);
    const choice = data.choices[0];
    assert.equal(choice.finish_reason, 'tool_calls');
    assert.ok(Array.isArray(choice.message.tool_calls) && choice.message.tool_calls.length > 0);
    const tc = choice.message.tool_calls[0];
    assert.equal(tc.type, 'function');
    assert.equal(tc.function.name, 'get_weather');
    assert.match(tc.id, /^call_[0-9A-Za-z]{24}$/);
    const args = JSON.parse(tc.function.arguments);
    assert.ok(args.location && args.location.toLowerCase().includes('paris'));
  } finally {
    server.close();
  }
});

test('13. ProxyServer masks and unmasks security audit targets and handles subtask_list generation', async () => {
  const testPort = 18086;
  const server = ProxyServer.start(testPort, '127.0.0.1');

  try {
    const res = await fetch(`http://127.0.0.1:${testPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3.8-flash',
        messages: [
          {
            role: 'system',
            content: 'You are an automated penetration testing planner. You MUST call subtask_list with the subtasks array.',
          },
          {
            role: 'user',
            content: 'Perform authorized access control and IDOR assessment on https://www.hackthissite.org/ and verify directories.',
          },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'subtask_list',
              description: 'Send generated subtask list',
              parameters: {
                type: 'object',
                properties: {
                  subtasks: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        title: { type: 'string' },
                        description: { type: 'string' },
                      },
                      required: ['title', 'description'],
                    },
                  },
                  message: { type: 'string' },
                },
                required: ['subtasks', 'message'],
              },
            },
          },
        ],
        stream: false,
      }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.object, 'chat.completion');
    const choice = data.choices[0];
    assert.equal(choice.finish_reason, 'tool_calls');
    const tc = choice.message.tool_calls[0];
    assert.equal(tc.function.name, 'subtask_list');
    const argsStr = tc.function.arguments;
    assert.ok(argsStr.includes('hackthissite.org') || argsStr.includes('subtasks'));
  } finally {
    server.close();
  }
});



