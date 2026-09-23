const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts, plain } = require('./helpers');
const { createGasEnvironment } = require('./gas-fakes');

const KEY = 'abcd1234.s3cret-part';
const LABELS = { test: 'Test', project: 'Project' };

function setUp(settings = {}) {
  const fake = createGasEnvironment();
  const gas = loadScripts(fake.globals);
  gas.SETTINGS = { feedUrl: 'https://x.myschoolapp.com/podium/feed/iCal.aspx?z=T', ...settings };
  return { gas, env: fake.env, settings: () => gas.loadSettings_() };
}

function chatReply(content) {
  return { code: 200, body: JSON.stringify({ model: 'gpt-oss:20b', message: { role: 'assistant', content }, done: true }) };
}

function assessment(id, overrides = {}) {
  return { id, title: 'Unit 3 Test', course: 'AP Biology', category: 'test', date: '2026-10-12', details: 'Cells', ...overrides };
}

test('parseStudyReply_ reads JSON, even wrapped in text or code fences', () => {
  const gas = loadScripts();
  const expected = { a1: { effort: 'heavy', steps: ['Cells', 'Practice test'] } };
  const json = '{"assessments":[{"id":"a1","effort":"heavy","steps":["Cells","Practice test"]}]}';
  assert.deepEqual(plain(gas.parseStudyReply_(json)), expected);
  assert.deepEqual(plain(gas.parseStudyReply_('Here you go:\n```json\n' + json + '\n```\nGood luck!')), expected);
  assert.deepEqual(plain(gas.parseStudyReply_('[{"id":"a1","effort":"heavy","steps":["Cells","Practice test"]}]')), expected);
});

test('parseStudyReply_ cleans up odd answers', () => {
  const gas = loadScripts();
  const long = 'x'.repeat(200);
  const reply = plain(
    gas.parseStudyReply_(
      JSON.stringify({
        assessments: [
          { id: 'a1', effort: 'HUGE', steps: ['  many\n spaces ', '', long, 1, 2, 3, 4, 5, 6, 7] },
          { id: 'a2', effort: 'Light' },
          { effort: 'heavy', steps: ['no id'] },
        ],
      })
    )
  );
  assert.equal(reply.a1.effort, 'normal');
  assert.equal(reply.a1.steps.length, 8);
  assert.equal(reply.a1.steps[0], 'many spaces');
  assert.equal(reply.a1.steps[1].length, 80);
  assert.deepEqual(reply.a2, { effort: 'light', steps: [] });
  assert.deepEqual(Object.keys(reply), ['a1', 'a2']);
  assert.throws(() => gas.parseStudyReply_('I cannot help with that.'), /wasn't JSON/);
  assert.throws(() => gas.parseStudyReply_('{"assessments": [oops]}'), /wasn't valid JSON/);
});

test('the prompt holds only what the AI needs', () => {
  const gas = loadScripts();
  const input = plain(gas.aiInput_(assessment('bb:1', { details: 'Cells\n\n and   membranes' }), LABELS));
  assert.deepEqual(input, { kind: 'Test', class: 'AP Biology', title: 'Unit 3 Test', due: '2026-10-12', details: 'Cells and membranes' });
  const messages = plain(gas.buildStudyPrompt_([{ id: 'a1', ...input }]));
  assert.equal(messages[0].role, 'system');
  assert.match(messages[1].content, /"effort": "light", "normal" or "heavy"/);
  assert.match(messages[1].content, /"title": "Unit 3 Test"/);
});

test('ollamaFetch_ sends the key and JSON to Ollama Cloud', () => {
  const { gas, env, settings } = setUp();
  env.handleRequest = () => chatReply('{"assessments":[{"id":"a1","effort":"normal","steps":["Read"]}]}');
  const answer = plain(gas.askOllamaForAdvice_([{ input: { title: 'Quiz' } }], settings().ai, KEY));
  assert.deepEqual(answer, { a1: { effort: 'normal', steps: ['Read'] } });
  const [request] = env.requests;
  assert.equal(request.url, 'https://ollama.com/api/chat');
  assert.equal(request.options.method, 'post');
  assert.equal(request.options.headers.Authorization, `Bearer ${KEY}`);
  const body = JSON.parse(request.options.payload);
  assert.equal(body.model, 'gpt-oss:20b');
  assert.equal(body.stream, false);
  assert.equal(body.format.required[0], 'assessments');
  assert.match(body.messages[1].content, /"id": "a1"/);
});

test('ollamaFetch_ explains errors without revealing the key', () => {
  const { gas, env, settings } = setUp();
  const ai = settings().ai;
  const cases = [
    [{ code: 401, body: '{"error":"unauthorized"}' }, /rejected the API key \(HTTP 401: unauthorized\)\. Check that OLLAMA_API_KEY holds the whole key/],
    [{ code: 403, body: '{"error":"this model requires a subscription"}' }, /refused the request \(HTTP 403: this model requires a subscription\)\. If it mentions a plan/],
    [{ code: 403, body: '<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>' }, /ollama\.com refused the request from Google's servers \(HTTP 403, a web page titled "Just a moment\.\.\." instead of an API answer\)\. That's a block on Google Apps Script, not a problem with your key\./],
    [{ code: 404, body: '{"error":"model not found"}' }, /doesn't have the model "gpt-oss:20b" \(model not found\)\. Run checkAi\(\)/],
    [{ code: 429, body: '{"error":"too many requests"}' }, /usage limit was reached/],
    [{ code: 502, body: '{"error":"upstream timeout"}' }, /Ollama answered HTTP 502: upstream timeout\./],
    [{ code: 200, body: 'not json' }, /answer wasn't readable/],
  ];
  for (const [response, expected] of cases) {
    env.handleRequest = () => response;
    assert.throws(() => gas.ollamaFetch_(ai, KEY, '/api/chat', { x: 1 }), (e) => expected.test(e.message) && !e.message.includes(KEY));
  }
  env.handleRequest = () => {
    throw new Error(`Timeout calling https://ollama.com with Bearer ${KEY}`);
  };
  assert.throws(() => gas.ollamaFetch_(ai, KEY, '/api/chat', {}), (e) => /couldn't reach Ollama/.test(e.message) && !e.message.includes(KEY));
});

test('a key without a dot is flagged as only the ID part from the keys page', () => {
  const { gas, env, settings } = setUp();
  env.handleRequest = () => ({ code: 401, body: '{"error":"unauthorized"}' });
  assert.throws(
    () => gas.ollamaFetch_(settings().ai, '9f2c41d07be35a86c1e04d2b7a6f1c3e', '/api/chat', {}),
    /HTTP 401: unauthorized\)\. OLLAMA_API_KEY has no "\." in it, so it is probably only the first part of the key/
  );
});

test('pasted keys are cleaned up, and a slightly misnamed property still works', () => {
  const { gas, env } = setUp();
  env.properties.OLLAMA_API_KEY = '  "Bearer abcd1234.s3cret-part"\n';
  assert.equal(gas.readApiKey_(), KEY);
  delete env.properties.OLLAMA_API_KEY;
  env.properties['ollama api key '] = KEY;
  assert.equal(gas.readApiKey_(), KEY);
  delete env.properties['ollama api key '];
  assert.equal(gas.readApiKey_(), '');
});

test('getStudyAdvice_ asks once per assessment and remembers the answers', () => {
  const { gas, env, settings } = setUp();
  env.properties.OLLAMA_API_KEY = KEY;
  let asked = [];
  env.handleRequest = (url, options) => {
    const items = JSON.parse(JSON.parse(options.payload).messages[1].content.split('Assessments:\n')[1]);
    asked.push(items.map((i) => i.title));
    return chatReply(JSON.stringify({ assessments: items.map((i) => ({ id: i.id, effort: 'heavy', steps: ['Step for ' + i.title] })) }));
  };
  const list = [assessment('bb:late', { title: 'Late', date: '2026-11-01' }), assessment('bb:soon', { title: 'Soon', date: '2026-10-06' })];

  const first = plain(gas.getStudyAdvice_(list, settings(), LABELS));
  assert.deepEqual(asked, [['Soon', 'Late']]); // soonest first
  assert.deepEqual(first.advice['bb:soon'], { effort: 'heavy', steps: ['Step for Soon'] });
  assert.deepEqual([first.asked, first.waiting, first.note], [2, 0, '']);

  asked = [];
  const again = plain(gas.getStudyAdvice_(list, settings(), LABELS));
  assert.deepEqual(asked, []);
  assert.deepEqual(again.advice, first.advice);

  // A changed description is asked about again; a gone assessment is forgotten.
  const changed = [assessment('bb:soon', { title: 'Soon', date: '2026-10-06', details: 'Now covers chapter 4 too' })];
  gas.getStudyAdvice_(changed, settings(), LABELS);
  assert.deepEqual(asked, [['Soon']]);
  assert.deepEqual(
    Object.keys(env.properties).filter((k) => k.startsWith('B2C_AI_')),
    ['B2C_AI_' + gas.hash_('bb:soon')]
  );
});

test('getStudyAdvice_ asks about at most ai.maxPerRun at a time', () => {
  const { gas, env, settings } = setUp({ ai: { maxPerRun: 2 } });
  env.properties.OLLAMA_API_KEY = KEY;
  env.handleRequest = () => chatReply('{"assessments":[{"id":"a1","effort":"light","steps":[]},{"id":"a2","effort":"light","steps":[]}]}');
  const list = ['a', 'b', 'c', 'd', 'e'].map((x, i) => assessment('bb:' + x, { date: '2026-10-1' + i }));
  const result = plain(gas.getStudyAdvice_(list, settings(), LABELS));
  assert.deepEqual([result.asked, result.waiting], [2, 3]);
  assert.deepEqual(Object.keys(result.advice), ['bb:a', 'bb:b']);
});

test('getStudyAdvice_ goes on without AI when there is no key, AI is off, or Ollama fails', () => {
  const { gas, env, settings } = setUp();
  env.handleRequest = () => chatReply('{}');
  const list = [assessment('bb:1')];

  const noKey = plain(gas.getStudyAdvice_(list, settings(), LABELS));
  assert.match(noKey.note, /add OLLAMA_API_KEY/);
  assert.equal(env.requests.length, 0);

  env.properties.OLLAMA_API_KEY = KEY;
  gas.SETTINGS.ai = { enabled: false };
  assert.deepEqual(plain(gas.getStudyAdvice_(list, settings(), LABELS)).advice, {});
  assert.equal(env.requests.length, 0);

  gas.SETTINGS.ai = {};
  env.handleRequest = () => ({ code: 429, body: '{"error":"limit"}' });
  const failed = plain(gas.getStudyAdvice_(list, settings(), LABELS));
  assert.match(failed.note, /^AI advice skipped this time: Ollama's usage limit was reached/);
  assert.deepEqual(failed.advice, {});
  assert.ok(!Object.keys(env.properties).some((k) => k.startsWith('B2C_AI_')), 'failures are not cached');
});

test('checkAi() lists models and shows a sample answer', () => {
  const { gas, env } = setUp();
  gas.checkAi();
  assert.match(env.logs.join('\n'), /No OLLAMA_API_KEY yet/);

  env.properties.OLLAMA_API_KEY = ` ${KEY} `;
  env.handleRequest = (url) =>
    url.endsWith('/api/tags')
      ? { code: 200, body: JSON.stringify({ models: [{ name: 'gpt-oss:120b' }, { name: 'qwen3:8b' }] }) }
      : chatReply('{"assessments":[{"id":"a1","effort":"normal","steps":["Membranes"]}]}');
  gas.checkAi();
  const log = env.logs.join('\n');
  assert.match(log, /Found OLLAMA_API_KEY: starts with "abcd", 20 characters \(ignoring spaces, quotes or "Bearer" around it\)\./);
  assert.match(log, /Sample answer from gpt-oss:20b: \{"effort":"normal","steps":\["Membranes"\]\}/);
  assert.match(log, /Models you can use \(2\): gpt-oss:120b, qwen3:8b/);
  assert.match(log, /Your ai.model "gpt-oss:20b" is not in that list/);
  assert.match(log, /The AI is working\./);
  assert.deepEqual(env.requests.map((r) => r.options.method), ['post', 'get']);
  assert.equal(env.requests[0].options.headers.Authorization, `Bearer ${KEY}`);
  assert.ok(!log.includes(KEY));
});

test('checkAi() says why the AI is not working', () => {
  const { gas, env } = setUp();
  env.properties.OLLAMA_API_KEY = '9f2c41d07be35a86c1e04d2b7a6f1c3e';
  env.handleRequest = () => ({ code: 401, body: '{"error":"unauthorized"}' });
  assert.throws(() => gas.checkAi(), /The AI is not working yet: Ollama rejected the API key \(HTTP 401: unauthorized\)/);
  const log = env.logs.join('\n');
  assert.match(log, /starts with "9f2c", 32 characters\./);
  assert.match(log, /OLLAMA_API_KEY has no "\." in it/);
  assert.match(log, /Couldn't list the models: Ollama rejected the API key/);
});

test('every conversation with the AI is saved, and showAiTranscript() prints it', () => {
  const { gas, env, settings } = setUp();
  gas.showAiTranscript();
  assert.match(env.logs.join('\n'), /No conversations with the AI yet/);

  env.handleRequest = () => ({
    code: 200,
    body: JSON.stringify({
      message: { content: '{"assessments":[{"id":"a1","effort":"heavy","steps":["Membranes"]}]}', thinking: 'Unit tests cover a lot, so heavy.' },
    }),
  });
  gas.askOllamaForAdvice_([{ input: { kind: 'Test', class: 'AP Biology', title: 'Unit 3 Test', due: '2026-10-12', details: 'Cells' } }], settings().ai, KEY);
  env.handleRequest = () => ({ code: 429, body: '{"error":"limit"}' });
  assert.throws(() => gas.askOllamaForAdvice_([{ input: { title: 'Quiz 2.1' } }], settings().ai, KEY));

  env.logs.length = 0;
  gas.showAiTranscript();
  const [newest, older] = env.logs;
  assert.match(newest, /^===== Conversation 1 of 2 \(newest\) =====\nWhen: \w{3}, \w{3} \d+, \d{4} at \d+:\d{2} [AP]M {4}Model: gpt-oss:20b/);
  assert.match(newest, /--- What the script asked ---\n[\s\S]*"title": "Quiz 2\.1"/);
  assert.match(newest, /--- It went wrong ---\nOllama's usage limit was reached/);
  assert.match(older, /^===== Conversation 2 of 2 =====/);
  assert.match(older, /--- Instructions the AI always gets ---\nYou help a high school student plan study time/);
  assert.match(older, /"class": "AP Biology"/);
  assert.match(older, /--- The AI's thinking ---\nUnit tests cover a lot, so heavy\./);
  assert.match(older, /--- The AI's answer ---\n\{"assessments":\[\{"id":"a1","effort":"heavy","steps":\["Membranes"\]\}\]\}/);
  assert.ok(!env.logs.join('\n').includes(KEY));
});

test('only the last 5 conversations are kept, each small enough for a script property', () => {
  const { gas, env, settings } = setUp();
  env.handleRequest = () => chatReply('{"assessments":[]}');
  for (let i = 1; i <= 7; i++) {
    gas.askOllamaForAdvice_([{ input: { title: `Test ${i}`, details: 'x'.repeat(1200) } }, { input: { title: 'Big', details: 'y'.repeat(1200) } }, { input: { title: 'Bigger', details: 'z'.repeat(1200) } }], settings().ai, KEY);
  }
  const saved = Object.keys(env.properties).filter((k) => k.startsWith('B2C_TRANSCRIPT_')).sort();
  assert.deepEqual(saved, ['B2C_TRANSCRIPT_0', 'B2C_TRANSCRIPT_1', 'B2C_TRANSCRIPT_2', 'B2C_TRANSCRIPT_3', 'B2C_TRANSCRIPT_4']);
  assert.ok(saved.every((k) => env.properties[k].length <= 8500));
  const titles = plain(gas.loadTranscripts_()).map((t) => /"title": "(Test \d)"/.exec(t.request)[1]);
  assert.deepEqual(titles, ['Test 7', 'Test 6', 'Test 5', 'Test 4', 'Test 3']);
});

test('clearing old AI answers leaves the transcripts alone', () => {
  const { gas, env, settings } = setUp();
  env.properties.OLLAMA_API_KEY = KEY;
  env.handleRequest = () => chatReply('{"assessments":[{"id":"a1","effort":"normal","steps":["Read"]}]}');
  gas.getStudyAdvice_([assessment('bb:1')], settings(), LABELS);
  gas.getStudyAdvice_([assessment('bb:2', { title: 'Other' })], settings(), LABELS);
  assert.equal(gas.loadTranscripts_().length, 2);
  gas.clearAiCache_();
  assert.equal(gas.loadTranscripts_().length, 2);
});
