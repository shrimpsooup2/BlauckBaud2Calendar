// End-to-end: syncs with study.enabled and checks the "Study Plan" calendar
// (fake Apps Script services; dates are relative to today).
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts, dayFromToday } = require('./helpers');
const { createGasEnvironment } = require('./gas-fakes');

const TZ = 'America/New_York';
const KEY = 'ollama-test-key';

function feed(events) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0'];
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${e.uid}`, `SUMMARY:${e.summary}`, `DTSTART;VALUE=DATE:${dayFromToday(e.day, TZ).replace(/-/g, '')}`);
    if (e.description) lines.push(`DESCRIPTION:${e.description}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

const EVENTS = [
  { uid: 'bio', summary: 'AP Biology - 2: Unit 3 Test', day: 6, description: 'Cells and membranes' },
  { uid: 'hist', summary: 'US History - 4: Industrial Revolution Project', day: 18 },
  { uid: 'hw', summary: 'English 10 - 1: Read chapter 4', day: 2 },
];

// Every hour of every day is study time, so results don't depend on when the tests run.
const ALL_DAY = { weekdays: '00:00-24:00', weekends: '00:00-24:00' };

function setUp({ events = EVENTS, study = {}, ai = {} } = {}) {
  const fake = createGasEnvironment({ tz: TZ, feed: feed(events) });
  const gas = loadScripts(fake.globals);
  gas.SETTINGS = {
    feedUrl: 'webcal://myschool.myschoolapp.com/podium/feed/iCal.aspx?z=T',
    titlePattern: '^(?<course>.+?) - \\d+: (?<title>.+)$',
    study: { enabled: true, hours: ALL_DAY, ...study },
    ai,
  };
  return { gas, env: fake.env };
}

function calendarNamed(env, name) {
  return env.calendars.find((c) => c.getName() === name);
}

function sessions(env) {
  return env.calendars.flatMap((cal) => cal.events.filter((e) => String(e.getTag('b2c_id')).startsWith('study:')));
}

function sessionsFor(env, id) {
  return sessions(env).filter((e) => e.getTag('b2c_for') === id);
}

function localDate(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(date);
}

test('syncNow() plans study sessions for upcoming assessments', () => {
  const { gas, env } = setUp();
  const summary = gas.syncNow();
  assert.ok(calendarNamed(env, 'Blackbaud Assessments'));
  const bio = sessionsFor(env, 'bb:bio');
  const hist = sessionsFor(env, 'bb:hist');
  assert.equal(bio.length, 4); // test: 180 minutes / 45
  assert.equal(hist.length, 7); // project: 300 minutes / 45
  assert.equal(summary.study.created, 11);
  for (const s of bio) {
    assert.ok(localDate(s.getStartTime()) < dayFromToday(6, TZ), 'before the due date');
    assert.equal(s.getEndTime() - s.getStartTime(), 45 * 60000);
    assert.equal(s.getTitle(), '📚 Study for Unit 3 Test (AP Biology)');
    assert.equal(s.getColor(), '2');
    assert.deepEqual(s.getPopupReminders(), [10]);
    assert.equal(Number(s.getTag('b2c_planned')), s.getStartTime().getTime());
  }
  assert.ok(env.logs.some((l) => /Study plan for 2 upcoming assessment\(s\):/.test(l)));
});

test('a second sync leaves the study plan alone', () => {
  const { gas, env } = setUp();
  gas.syncNow();
  const writes = env.writes;
  const summary = gas.syncNow();
  assert.deepEqual([summary.study.created, summary.study.updated, summary.study.removed], [0, 0, 0]);
  assert.equal(env.writes, writes);
});

test('sessions go around events in your main calendar, but not all-day ones', () => {
  const { gas, env } = setUp({ study: { maxMinutesPerDay: 720 } });
  const busyDay = dayFromToday(3, TZ);
  env.defaultCalendar.addTimedEvent('Soccer tournament', busyDay, '00:00', 24 * 60 - 1);
  env.defaultCalendar.createAllDayEvent('Spirit week', new Date(`${dayFromToday(5, TZ)}T12:00:00Z`), {});
  gas.syncNow();
  const days = sessions(env).map((s) => localDate(s.getStartTime()));
  assert.ok(!days.includes(busyDay), days.join());
  assert.ok(days.includes(dayFromToday(5, TZ)), 'all-day events do not block study time');
});

test('grades sent by the bookmark change how much time each class gets', () => {
  const { gas, env } = setUp();
  const token = gas.gradesToken_();
  gas.doPost({
    parameter: {
      payload: JSON.stringify({ token, classes: [{ name: 'AP Biology - 2 (B)', grade: 78 }, { name: 'US History - 4', grade: 99 }] }),
    },
  });
  gas.syncNow();
  assert.equal(sessionsFor(env, 'bb:bio').length, 7); // 180 × 1.75 = 315 minutes
  assert.equal(sessionsFor(env, 'bb:hist').length, 5); // 300 × 0.7 = 210 minutes
  assert.match(sessionsFor(env, 'bb:bio')[0].getDescription(), /Your grade in AP Biology is 78%, so it gets 1\.75× that\./);

  // Better grades later: extra sessions are taken off again.
  gas.doPost({ parameter: { payload: JSON.stringify({ token, classes: [{ name: 'AP Biology - 2 (B)', grade: 93 }] }) } });
  gas.syncNow();
  assert.equal(sessionsFor(env, 'bb:bio').length, 4);
});

test('the AI names what to study, and never sees your grades', () => {
  const { gas, env } = setUp({ study: { grades: { 'AP Biology': 81 } } });
  env.properties.OLLAMA_API_KEY = KEY;
  env.handleRequest = (url, options) => {
    const items = JSON.parse(JSON.parse(options.payload).messages[1].content.split('Assessments:\n')[1]);
    return {
      code: 200,
      body: JSON.stringify({
        message: {
          content: JSON.stringify({
            assessments: items.map((i) => ({ id: i.id, effort: 'normal', steps: i.title === 'Unit 3 Test' ? ['Cell structure', 'Membranes', 'Practice test'] : ['Plan', 'Research', 'Build'] })),
          }),
        },
      }),
    };
  };
  gas.syncNow();
  assert.equal(env.requests.length, 1);
  const payload = env.requests[0].options.payload;
  assert.equal(env.requests[0].options.headers.Authorization, `Bearer ${KEY}`);
  const items = JSON.parse(JSON.parse(payload).messages[1].content.split('Assessments:\n')[1]);
  assert.deepEqual(items.map((i) => Object.keys(i).sort()), [
    ['class', 'details', 'due', 'id', 'kind', 'title'],
    ['class', 'details', 'due', 'id', 'kind', 'title'],
  ]);
  assert.ok(!/81/.test(payload), 'grades are not sent to the AI');
  assert.equal(items[0].details, 'Cells and membranes');

  const titles = sessionsFor(env, 'bb:bio')
    .sort((a, b) => a.getStartTime() - b.getStartTime())
    .map((s) => s.getTitle());
  assert.equal(titles[0], '📚 Unit 3 Test (AP Biology): Cell structure');
  assert.equal(titles[titles.length - 1], '📚 Unit 3 Test (AP Biology): Practice test');
  assert.ok(!env.logs.some((l) => l.includes(KEY)));

  // Answers are remembered: the next sync doesn't ask again.
  gas.syncNow();
  assert.equal(env.requests.length, 1);
});

test('if Ollama fails, the sync still works and sessions get plain titles', () => {
  const { gas, env } = setUp();
  env.properties.OLLAMA_API_KEY = KEY;
  env.handleRequest = () => ({ code: 500, body: '{"error":"boom"}' });
  const summary = gas.syncNow();
  assert.equal(summary.study.created, 11);
  assert.equal(sessionsFor(env, 'bb:bio')[0].getTitle(), '📚 Study for Unit 3 Test (AP Biology)');
  assert.ok(env.logs.some((l) => /AI advice skipped this time: Ollama answered HTTP 500: boom\./.test(l)));
});

test('study sessions you delete stay deleted; replanStudySessions() starts over', () => {
  const { gas, env } = setUp();
  gas.syncNow();
  sessionsFor(env, 'bb:bio')[0].deleteEvent();
  gas.syncNow();
  assert.equal(sessionsFor(env, 'bb:bio').length, 3);

  gas.replanStudySessions();
  assert.equal(sessionsFor(env, 'bb:bio').length, 4);
});

test('no study sessions for assessments you deleted from the calendar', () => {
  const { gas, env } = setUp();
  gas.syncNow();
  calendarNamed(env, 'Blackbaud Assessments').events.find((e) => e.getTag('b2c_id') === 'bb:hist').deleteEvent();
  gas.syncNow();
  assert.equal(sessionsFor(env, 'bb:hist').length, 0);
  assert.equal(sessionsFor(env, 'bb:bio').length, 4);
});

test('sessions for an assessment that disappears from Blackbaud are removed', () => {
  const { gas, env } = setUp();
  gas.syncNow();
  env.feed = feed(EVENTS.filter((e) => e.uid !== 'bio'));
  gas.syncNow();
  assert.equal(sessionsFor(env, 'bb:bio').length, 0);
  assert.equal(sessionsFor(env, 'bb:hist').length, 7);
});

test('assessments and study sessions can share one calendar', () => {
  const { gas, env } = setUp({ study: { calendarName: 'Blackbaud Assessments' } });
  gas.syncNow();
  const summary = gas.syncNow();
  assert.equal(env.calendars.length, 1);
  assert.deepEqual([summary.removed, summary.study.removed, summary.study.created], [0, 0, 0]);
  assert.equal(sessions(env).length, 11);
});

test('preview() shows the study plan without creating anything', () => {
  const { gas, env } = setUp();
  gas.preview();
  assert.equal(env.calendars.length, 0);
  assert.equal(env.writes, 0);
  const log = env.logs.join('\n');
  assert.match(log, /Study plan for 2 upcoming assessment\(s\):/);
  assert.match(log, /Unit 3 Test \(AP Biology\): 3h, 4 session\(s\) \[no grade\]/);
  assert.match(log, /\+ \w{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}–\d{2}:\d{2} {2}📚 Study for Unit 3 Test \(AP Biology\)/);
});

test('study settings are checked', () => {
  const { gas } = setUp({
    study: {
      hours: { weekdays: '4pm-9pm', holidays: '10:00-12:00' },
      sessionMinutes: 5,
      grades: { 'AP Biology': 'B+' },
      webAppUrl: 'https://example.com/hook',
      kinds: { test: { daysAhead: 90, spacing: 'random' } },
    },
    ai: { model: '', maxPerRun: 0 },
  });
  let message = '';
  try {
    gas.loadSettings_();
  } catch (e) {
    message = e.message;
  }
  for (const expected of [
    /study\.hours\.weekdays must look like '16:00-21:00'/,
    /study\.hours\.holidays is not a day I know/,
    /study\.sessionMinutes must be a number from 15 to 240/,
    /study\.grades\["AP Biology"\] must be a number like 84/,
    /study\.webAppUrl should be the Web app URL from Deploy → Manage deployments, ending in \/exec\./,
    /study\.kinds\.test\.daysAhead must be from 0 to 30/,
    /study\.kinds\.test\.spacing must be 'spaced' or 'even'/,
    /ai\.model must name a model/,
    /ai\.maxPerRun must be a number from 1 to 20/,
  ]) {
    assert.match(message, expected);
  }
});

test('removeStudySessions() deletes only study sessions', () => {
  const { gas, env } = setUp({ study: { calendarName: 'Blackbaud Assessments' } });
  gas.syncNow();
  gas.removeStudySessions();
  assert.equal(sessions(env).length, 0);
  assert.equal(calendarNamed(env, 'Blackbaud Assessments').events.length, 2);
  assert.ok(env.logs.some((l) => /Set study.enabled to false/.test(l)));
});
