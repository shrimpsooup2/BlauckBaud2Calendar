// The AI deciding which Blackbaud items go on the calendar (ai.chooseItems).
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts, plain, dayFromToday } = require('./helpers');
const { createGasEnvironment } = require('./gas-fakes');

const TZ = 'America/New_York';
const KEY = 'abcd1234.s3cret-part';
const WIN = { start: '2026-09-01', end: '2026-12-31' };

function setUp(settings = {}) {
  const fake = createGasEnvironment({ tz: TZ });
  const gas = loadScripts(fake.globals);
  gas.SETTINGS = { feedUrl: 'https://x.myschoolapp.com/podium/feed/iCal.aspx?z=T', ...settings };
  return { gas, env: fake.env, settings: () => gas.loadSettings_() };
}

function item(uid, summary, overrides = {}) {
  return { uid, summary, description: '', categories: [], location: '', url: '', start: { date: '2026-10-05', time: null }, end: null, ...overrides };
}

// An AI that decides by title and answers in the requested format.
function fakeAi(env, decide, { thinking = '' } = {}) {
  env.asked = [];
  env.handleRequest = (url, options) => {
    const body = JSON.parse(options.payload);
    const items = JSON.parse(body.messages[1].content.split('Items:\n')[1]);
    env.asked.push(items.map((i) => i.title));
    const answer = { items: items.map((i) => ({ id: i.id, ...decide(i) })) };
    return { code: 200, body: JSON.stringify({ message: { content: JSON.stringify(answer), thinking } }) };
  };
}

test('parseChoiceReply_ reads the answer and drops kinds it does not know', () => {
  const gas = loadScripts();
  const kinds = ['test', 'quiz', 'project'];
  const reply = plain(
    gas.parseChoiceReply_(
      'Sure!\n```json\n' +
        JSON.stringify({
          items: [
            { id: 'i1', kind: 'Quiz', why: ' weekly   vocab quiz ' },
            { id: 'i2', kind: 'none', why: 'x'.repeat(200) },
            { id: 'i3', kind: 'homework' },
            { kind: 'test' },
          ],
        }) +
        '\n```',
      kinds
    )
  );
  assert.deepEqual(Object.keys(reply), ['i1', 'i2']);
  assert.deepEqual(reply.i1, { kind: 'quiz', why: 'weekly vocab quiz' });
  assert.equal(reply.i2.kind, 'none');
  assert.equal(reply.i2.why.length, 80);
  assert.deepEqual(plain(gas.parseChoiceReply_('[{"id":"i1","kind":"test"}]', kinds)), { i1: { kind: 'test', why: '' } });
  assert.throws(() => gas.parseChoiceReply_('no idea', kinds), /wasn't JSON/);
});

test('the choosing prompt lists the kinds and the items', () => {
  const gas = loadScripts();
  const input = plain(gas.choiceInput_({ summary: 'Bio: Unit 3 Test', categories: ['Test'], due: { date: '2026-10-05' }, description: 'Cells\n\n' + 'y'.repeat(400) }));
  assert.deepEqual(Object.keys(input), ['title', 'type', 'due', 'details']);
  assert.equal(input.details.length, 300);
  const messages = plain(gas.buildChoicePrompt_([{ id: 'i1', ...input }], { test: 'Test', quiz: 'Quiz' }));
  assert.match(messages[0].content, /picking out the assessments and major assignments/);
  assert.match(messages[1].content, /one of "test" \(Test\), "quiz" \(Quiz\), or "none"/);
  assert.match(messages[1].content, /A review sheet or study guide for a test is "none"/);
  assert.match(messages[1].content, /"title": "Bio: Unit 3 Test"/);
  const schema = plain(gas.choiceSchema_(['test', 'quiz']));
  assert.deepEqual(schema.properties.items.items.properties.kind.enum, ['test', 'quiz', 'none']);
});

test('the AI decides, but your own keywords and turned-off kinds win', () => {
  const { gas, settings } = setUp({
    extraExcludeKeywords: ['bell ringer'],
    categories: { quiz: { enabled: false }, test: { extraKeywords: ['unit check'] } },
  });
  const s = settings();
  const decisions = gas.classifyItems_(
    [
      item('checkpoint', 'Chapter 5 Checkpoint'),
      item('test', 'Unit 3 Test'),
      item('bell', 'Bell ringer project'),
      item('check', 'Unit check 2'),
      item('quiz', 'Vocab 4'),
      item('untouched', 'Read chapter 4'),
      item('odd', 'Science Olympiad'),
    ],
    s,
    WIN
  );
  const choices = {
    checkpoint: { kind: 'test', why: 'graded checkpoint' },
    test: { kind: 'none', why: 'test already listed elsewhere' },
    bell: { kind: 'project', why: 'project' },
    check: { kind: 'none', why: 'short check' },
    quiz: { kind: 'quiz', why: 'vocab quiz' },
    odd: { kind: 'recital', why: 'not a kind we have' },
  };
  const results = {};
  plain(gas.applyAiChoices_(decisions, choices, s)).forEach((d) => (results[d.item.uid] = d.result));
  assert.deepEqual(results.checkpoint, { include: true, category: 'test', reason: 'AI says test: graded checkpoint', byAi: true });
  assert.deepEqual(results.test, { include: false, category: null, reason: 'AI says skip: test already listed elsewhere', byAi: true });
  assert.equal(results.bell.include, false);
  assert.equal(results.bell.reason, 'your extraExcludeKeywords has "bell ringer"');
  assert.deepEqual([results.check.include, results.check.category, results.check.reason], [true, 'test', 'your extraKeywords for test has "unit check"']);
  assert.deepEqual([results.quiz.include, results.quiz.reason], [false, 'AI says quiz, but quiz is turned off']);
  // Without an AI answer (or with a kind we don't have), the keyword decision stands.
  assert.equal(results.untouched.reason, 'no assessment/project keywords');
  assert.equal(results.untouched.byAi, undefined);
  assert.equal(results.odd.byAi, undefined);
});

test('getAiChoices_ asks in batches, remembers answers, and skips repeating items', () => {
  const { gas, env, settings } = setUp();
  env.properties.OLLAMA_API_KEY = KEY;
  fakeAi(env, (i) => ({ kind: /Quiz/.test(i.title) ? 'quiz' : 'none', why: 'by title' }));
  const items = [];
  for (let n = 1; n <= 30; n++) items.push(item('hw' + n, `Homework ${n}`, { start: { date: `2026-10-${String(n).padStart(2, '0')}`, time: null } }));
  items.push(item('quiz', 'Quiz 2.1', { start: { date: '2026-09-15', time: null } }));
  for (let n = 1; n <= 5; n++) items.push(item('class' + n, 'AP Biology - 2 (B)', { start: { date: `2026-09-0${n + 1}`, time: '08:00' } }));
  const decisions = gas.classifyItems_(items, settings(), WIN);

  const first = plain(gas.getAiChoices_(decisions, settings(), gas.kindLabels_(settings())));
  assert.equal(env.asked.length, 2); // 31 items in batches of 25
  assert.equal(env.asked[0][0], 'Quiz 2.1'); // soonest first
  assert.ok(!env.asked.flat().includes('AP Biology - 2 (B)'));
  assert.deepEqual([first.asked, first.waiting, first.repeats, first.note], [31, 0, 5, '']);
  assert.deepEqual(first.choices.quiz, { kind: 'quiz', why: 'by title' });

  env.asked = [];
  const again = plain(gas.getAiChoices_(decisions, settings(), gas.kindLabels_(settings())));
  assert.deepEqual(env.asked, []);
  assert.equal(Object.keys(again.choices).length, 31);

  // A changed description is asked about again; a new date alone isn't; gone items are forgotten.
  const changed = gas.classifyItems_(
    [item('quiz', 'Quiz 2.1', { description: 'Now open-book', start: { date: '2026-09-15', time: null } }), item('hw1', 'Homework 1', { start: { date: '2026-11-20', time: null } })],
    settings(),
    WIN
  );
  gas.getAiChoices_(changed, settings(), gas.kindLabels_(settings()));
  assert.deepEqual(env.asked, [['Quiz 2.1']]);
  assert.equal(Object.keys(env.properties).filter((k) => k.startsWith('B2C_CHOICE_')).length, 2);
});

test('getAiChoices_ respects ai.maxItemsPerRun, the time limit, and failures', () => {
  const { gas, env, settings } = setUp({ ai: { maxItemsPerRun: 30 } });
  env.properties.OLLAMA_API_KEY = KEY;
  const items = [];
  for (let n = 1; n <= 40; n++) items.push(item('i' + n, `Item ${n}`, { start: { date: `2026-10-${String((n % 28) + 1).padStart(2, '0')}`, time: null } }));
  const decisions = gas.classifyItems_(items, settings(), WIN);
  const labels = gas.kindLabels_(settings());

  let calls = 0;
  env.handleRequest = (url, options) => {
    calls++;
    if (calls === 2) return { code: 429, body: '{"error":"limit"}' };
    const batch = JSON.parse(JSON.parse(options.payload).messages[1].content.split('Items:\n')[1]);
    return { code: 200, body: JSON.stringify({ message: { content: JSON.stringify({ items: batch.map((i) => ({ id: i.id, kind: 'none' })) }) } }) };
  };
  const r = plain(gas.getAiChoices_(decisions, settings(), labels));
  assert.equal(calls, 2);
  assert.equal(r.asked, 25);
  assert.equal(r.waiting, 15);
  assert.match(r.note, /The AI stopped choosing items this time \(Ollama's usage limit was reached/);

  calls = 10;
  const late = plain(gas.getAiChoices_(decisions, settings(), labels, Date.now() - 1));
  assert.equal(calls, 10, 'no new requests after the time limit');
  assert.equal(late.waiting, 15);
});

test('without a key, the keyword rules decide and the log says why', () => {
  const { gas, env, settings } = setUp();
  const decisions = gas.classifyItems_([item('a', 'Unit 3 Test')], settings(), WIN);
  const r = plain(gas.getAiChoices_(decisions, settings(), gas.kindLabels_(settings())));
  assert.match(r.note, /The AI is not choosing items yet: add OLLAMA_API_KEY/);
  assert.equal(env.requests.length, 0);
});

// --- Whole syncs -------------------------------------------------------------

function feed(events) {
  const lines = ['BEGIN:VCALENDAR'];
  for (const e of events) {
    const date = dayFromToday(e.day, TZ).replace(/-/g, '');
    lines.push('BEGIN:VEVENT', `UID:${e.uid}`, `SUMMARY:${e.summary}`, e.time ? `DTSTART;TZID=America/New_York:${date}T080000` : `DTSTART;VALUE=DATE:${date}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

const EVENTS = [
  { uid: 'checkpoint', summary: 'Chemistry - 1: Chapter 5 Checkpoint', day: 4 },
  { uid: 'test', summary: 'AP Biology - 2: Unit 3 Test', day: 6 },
  { uid: 'review', summary: 'AP Biology - 2: Unit 3 Test Review', day: 5 },
  { uid: 'reading', summary: 'English 10 - 1: Read chapter 4', day: 2 },
  ...[1, 2, 3, 4, 5].map((n) => ({ uid: 'class' + n, summary: 'AP Biology - 2 (B)', day: n, time: true })),
];

function syncSetUp(settings = {}) {
  const fake = createGasEnvironment({ tz: TZ, feed: feed(EVENTS) });
  const gas = loadScripts(fake.globals);
  gas.SETTINGS = { feedUrl: 'webcal://x.myschoolapp.com/podium/feed/iCal.aspx?z=T', titlePattern: '^(?<course>.+?) - \\d+: (?<title>.+)$', ...settings };
  return { gas, env: fake.env };
}

function titles(env) {
  return env.calendars[0].events.map((e) => e.getTitle()).sort();
}

test('a sync puts what the AI picks on the calendar', () => {
  const { gas, env } = syncSetUp();
  env.properties.OLLAMA_API_KEY = KEY;
  fakeAi(env, (i) => (/Checkpoint|Unit 3 Test$/.test(i.title) ? { kind: 'test', why: 'graded assessment' } : { kind: 'none', why: 'not graded' }), { thinking: 'Checkpoints are graded.' });
  gas.syncNow();
  assert.deepEqual(titles(env), ['📝 Chapter 5 Checkpoint (Chemistry)', '📝 Unit 3 Test (AP Biology)']);
  assert.deepEqual(env.asked, [['English 10 - 1: Read chapter 4', 'Chemistry - 1: Chapter 5 Checkpoint', 'AP Biology - 2: Unit 3 Test Review', 'AP Biology - 2: Unit 3 Test']]);
  const log = env.logs.join('\n');
  assert.match(log, /The AI chose for 4 item\(s\) \(4 new this time\)\. Run showAiTranscript\(\) to read its reasons\./);
  assert.match(log, /5 repeating item\(s\), like class meetings, were left to the keyword rules\./);
  assert.match(log, /Chemistry - 1: Chapter 5 Checkpoint {3}\[AI says test: graded assessment\]/);

  env.logs.length = 0;
  gas.preview();
  assert.match(env.logs.join('\n'), /Unit 3 Test Review {3}\[AI says skip: not graded\]/);

  env.logs.length = 0;
  gas.showAiTranscript();
  assert.match(env.logs[0], /About: Choosing what goes on your calendar/);
  assert.match(env.logs[0], /--- The AI's thinking ---\nCheckpoints are graded\./);
});

test('without a key, a sync falls back to the keyword rules', () => {
  const { gas, env } = syncSetUp();
  gas.syncNow();
  assert.deepEqual(titles(env), ['📝 Unit 3 Test (AP Biology)']);
  assert.match(env.logs.join('\n'), /The AI is not choosing items yet/);
});

test('ai.chooseItems: false keeps the AI out of choosing', () => {
  const { gas, env } = syncSetUp({ ai: { chooseItems: false } });
  env.properties.OLLAMA_API_KEY = KEY;
  fakeAi(env, () => ({ kind: 'test' }));
  gas.syncNow();
  assert.equal(env.requests.length, 0);
  assert.deepEqual(titles(env), ['📝 Unit 3 Test (AP Biology)']);
});

test('syncEveryDays runs the automatic sync every few days, early in the morning', () => {
  const { gas, env } = syncSetUp({ syncEveryDays: 3, ai: { chooseItems: false } });
  gas.setup();
  assert.equal(env.triggers.length, 1);
  assert.deepEqual(env.triggers[0].spec, { handler: 'syncNow', everyDays: 3, atHour: 6 });
  assert.match(env.logs.join('\n'), /will update automatically every 3 days\./);

  gas.SETTINGS.syncEveryDays = 0;
  gas.setup();
  assert.deepEqual(env.triggers.map((t) => t.spec), [{ handler: 'syncNow', everyHours: 4 }]);
});

test('syncEveryDays is checked', () => {
  for (const bad of [0.5, 31, 'soon', -1]) {
    const { gas } = syncSetUp({ syncEveryDays: bad });
    assert.throws(() => gas.loadSettings_(), /syncEveryDays must be a whole number of days from 1 to 30/, String(bad));
  }
  const { gas } = syncSetUp({ syncEveryDays: 3, syncEveryHours: 5 });
  assert.doesNotThrow(() => gas.loadSettings_(), 'syncEveryHours is ignored when syncEveryDays is set');
});
