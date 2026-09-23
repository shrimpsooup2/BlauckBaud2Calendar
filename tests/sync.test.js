// End-to-end: runs setup(), syncNow(), preview() and friends against fake
// Apps Script services and checks what ends up on the (fake) calendar.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts, dayFromToday } = require('./helpers');
const { createGasEnvironment, midnight } = require('./gas-fakes');

const TZ = 'America/New_York';
const FEED_URL = 'webcal://myschool.myschoolapp.com/podium/feed/iCal.aspx?z=SECRET-TOKEN';

function vevent({ uid, summary, day, time, categories, description }) {
  const date = dayFromToday(day, TZ).replace(/-/g, '');
  return [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `SUMMARY:${summary}`,
    time ? `DTSTART;TZID=America/New_York:${date}T${time.replace(':', '')}00` : `DTSTART;VALUE=DATE:${date}`,
    categories ? `CATEGORIES:${categories}` : null,
    description ? `DESCRIPTION:${description}` : null,
    'END:VEVENT',
  ]
    .filter(Boolean)
    .join('\r\n');
}

function feed(events) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events.map(vevent), 'END:VCALENDAR'].join('\r\n');
}

const BASE_EVENTS = [
  { uid: 'sched-1', summary: 'AP Biology - 2 (B)', day: 1, time: '08:00' },
  { uid: 'bio-test', summary: 'AP Biology - 2: Unit 3 Test', day: 3, categories: 'Test', description: 'Cells' },
  { uid: 'eng-hw', summary: 'English 10 - 1: Read chapters 4-5', day: 2, categories: 'Homework' },
  { uid: 'geo-quiz', summary: 'Geometry - 3: Quiz 2.1', day: 5, time: '23:59' },
  { uid: 'geo-review', summary: 'Geometry - 3: Unit 2 Test Review', day: 6 },
  { uid: 'hist-proj', summary: 'US History - 4: Industrial Revolution Project', day: 20 },
  { uid: 'old-test', summary: 'Chemistry - 1: Old Test', day: -30 },
  { uid: 'far-essay', summary: 'English 10 - 1: Essay', day: 200 },
];

function setUp({ events = BASE_EVENTS, settings = {} } = {}) {
  const fake = createGasEnvironment({ tz: TZ, feed: feed(events) });
  const gas = loadScripts(fake.globals);
  gas.SETTINGS = { feedUrl: FEED_URL, titlePattern: '^(?<course>.+?) - \\d+: (?<title>.+)$', ...settings };
  return { gas, env: fake.env };
}

function calendarOf(env) {
  assert.equal(env.calendars.length, 1);
  return env.calendars[0];
}

function byTag(env) {
  const out = {};
  calendarOf(env).events.forEach((ev) => (out[ev.getTag('b2c_id')] = ev));
  return out;
}

test('setup() creates the calendar, adds the assessments and turns on auto-sync', () => {
  const { gas, env } = setUp();
  gas.setup();

  assert.deepEqual(env.fetchedUrls, ['https://myschool.myschoolapp.com/podium/feed/iCal.aspx?z=SECRET-TOKEN']);
  const cal = calendarOf(env);
  assert.equal(cal.getName(), 'Blackbaud Assessments');
  const events = byTag(env);
  assert.deepEqual(Object.keys(events).sort(), ['bb:bio-test', 'bb:geo-quiz', 'bb:hist-proj']);

  const test = events['bb:bio-test'];
  assert.equal(test.getTitle(), '📝 Unit 3 Test (AP Biology)');
  assert.equal(test.isAllDayEvent(), true);
  assert.equal(test.allDayDate, dayFromToday(3, TZ));
  assert.equal(test.getColor(), '11');
  assert.deepEqual(test.getPopupReminders(), [3360, 480]);
  assert.match(test.getDescription(), /^Class: AP Biology\nKind: Test \(Blackbaud: Test\)\nDue: .+\n\nCells\n/);

  // Due time is ignored by default: quizzes are all-day on their due date.
  assert.equal(events['bb:geo-quiz'].allDayDate, dayFromToday(5, TZ));
  assert.equal(events['bb:hist-proj'].getColor(), '9');

  assert.equal(env.triggers.length, 1);
  assert.equal(env.triggers[0].getHandlerFunction(), 'syncNow');
  assert.equal(env.triggers[0].spec.everyHours, 4);
  assert.equal(env.properties.B2C_CALENDAR_ID, cal.getId());
  assert.ok(env.logs.some((l) => /All set!/.test(l)));
  assert.ok(!env.logs.some((l) => l.includes('SECRET-TOKEN')), 'the feed link must never be logged');
});

test('running setup() again keeps a single trigger and changes nothing', () => {
  const { gas, env } = setUp();
  gas.setup();
  const writes = env.writes;
  gas.setup();
  assert.equal(env.triggers.length, 1);
  assert.equal(env.writes, writes);
});

test('syncNow() follows changes in Blackbaud', () => {
  const { gas, env } = setUp();
  gas.syncNow();
  const originalTest = byTag(env)['bb:bio-test'];

  env.feed = feed([
    // Moved two days later and renamed.
    { uid: 'bio-test', summary: 'AP Biology - 2: Unit 3 Test (Cells)', day: 5, categories: 'Test', description: 'Cells' },
    // geo-quiz disappeared; hist-proj unchanged; a new essay appeared.
    { uid: 'hist-proj', summary: 'US History - 4: Industrial Revolution Project', day: 20 },
    { uid: 'eng-essay', summary: 'English 10 - 1: Persuasive Essay', day: 9 },
  ]);
  const summary = gas.syncNow();
  assert.equal(summary.created, 1);
  assert.equal(summary.updated, 1);
  assert.equal(summary.removed, 1);
  assert.equal(summary.unchanged, 1);

  const events = byTag(env);
  assert.deepEqual(Object.keys(events).sort(), ['bb:bio-test', 'bb:eng-essay', 'bb:hist-proj']);
  assert.equal(events['bb:bio-test'], originalTest, 'updated in place, not re-created');
  assert.equal(originalTest.getTitle(), '📝 Unit 3 Test (Cells) (AP Biology)');
  assert.equal(originalTest.allDayDate, dayFromToday(5, TZ));
  assert.equal(events['bb:eng-essay'].getColor(), '3');
});

test('events the user deleted stay deleted until restoreDeletedEvents()', () => {
  const { gas, env } = setUp();
  gas.syncNow();
  byTag(env)['bb:geo-quiz'].deleteEvent();

  const summary = gas.syncNow();
  assert.equal(summary.created, 0);
  assert.equal(summary.keptDeleted, 1);
  assert.equal(byTag(env)['bb:geo-quiz'], undefined);

  gas.restoreDeletedEvents();
  assert.ok(byTag(env)['bb:geo-quiz']);
});

test("the user's own events and edits are left alone", () => {
  const { gas, env } = setUp();
  gas.syncNow();
  const cal = calendarOf(env);
  const mine = cal.createAllDayEvent('My study session', midnight(dayFromToday(3, TZ), TZ), {});
  // Recoloring a synced event survives syncs until Blackbaud changes the item.
  byTag(env)['bb:bio-test'].setColor('5');

  const summary = gas.syncNow();
  assert.equal(summary.updated, 0);
  assert.equal(summary.removed, 0);
  assert.ok(cal.events.includes(mine));
  assert.equal(byTag(env)['bb:bio-test'].getColor(), '5');
});

test('preview() reports the plan without touching Google Calendar', () => {
  const { gas, env } = setUp();
  const summary = gas.preview();
  assert.equal(env.calendars.length, 0);
  assert.equal(env.writes, 0);
  assert.equal(summary.toCreate, 3);
  const log = env.logs.join('\n');
  assert.match(log, /3 look like assessments or major projects/);
  assert.match(log, /Unit 2 Test Review .*title contains excluded word "review"/);
  assert.match(log, /\+ \d{4}-\d{2}-\d{2} {2}📝 Unit 3 Test \(AP Biology\)/);
  assert.match(log, /This was a preview/);
});

test('useDueTime creates timed events at the due time', () => {
  const { gas, env } = setUp({ settings: { useDueTime: true } });
  gas.syncNow();
  const quiz = byTag(env)['bb:geo-quiz'];
  assert.equal(quiz.isAllDayEvent(), false);
  const start = quiz.getStartTime();
  const local = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' }).format(start);
  assert.equal(local, `${dayFromToday(5, TZ)}, 23:59`);
  assert.equal(quiz.getEndTime() - start, 30 * 60000);
  assert.deepEqual(quiz.getPopupReminders(), [1440]);
});

test('a broken feed link fails loudly without leaking the link or touching the calendar', () => {
  const { gas, env } = setUp();
  gas.syncNow();
  const writes = env.writes;

  env.feed = '<html><body>Please sign in</body></html>';
  assert.throws(() => gas.syncNow(), (e) => /didn't return a calendar/.test(e.message) && !e.message.includes('SECRET'));
  env.feedStatus = 404;
  assert.throws(() => gas.syncNow(), (e) => /HTTP 404/.test(e.message) && !e.message.includes('SECRET'));
  assert.equal(env.writes, writes);
});

test('network errors from Google are reported without the feed link', () => {
  const { gas, env } = setUp();
  env.fetchError = (url) => `Address unavailable: ${url}`;
  assert.throws(
    () => gas.syncNow(),
    (e) => e.message === "Couldn't reach the Blackbaud feed: Address unavailable: <your feed link>"
  );
  // A token that shows up in some other URL (say, after a redirect) is hidden too.
  env.fetchError = () => 'Timeout: https://cdn.myschoolapp.com/podium/feed/iCal.aspx?z=SECRET-TOKEN&x=1';
  assert.throws(() => gas.syncNow(), (e) => !e.message.includes('SECRET') && /iCal\.aspx\?z=…&x=1/.test(e.message));
});

test('an empty feed never wipes the calendar', () => {
  const { gas, env } = setUp();
  gas.syncNow();
  env.feed = 'BEGIN:VCALENDAR\r\nEND:VCALENDAR';
  assert.equal(gas.syncNow(), null);
  assert.equal(calendarOf(env).events.length, 3);
});

test('setup() refuses to run until the feed link is filled in', () => {
  const { gas, env } = setUp();
  gas.SETTINGS = { feedUrl: 'PASTE_YOUR_BLACKBAUD_FEED_LINK_HERE' };
  assert.throws(() => gas.setup(), /Please fix Settings\.gs:\n- feedUrl: paste your Blackbaud calendar feed link/);
  assert.equal(env.fetchedUrls.length, 0);
  assert.equal(env.triggers.length, 0);
});

test('the BLACKBAUD_FEED_URL script property overrides Settings.gs', () => {
  const { gas, env } = setUp();
  gas.SETTINGS = {};
  env.properties.BLACKBAUD_FEED_URL = 'https://other.myschoolapp.com/podium/feed/iCal.aspx?z=PROP';
  gas.syncNow();
  assert.deepEqual(env.fetchedUrls, ['https://other.myschoolapp.com/podium/feed/iCal.aspx?z=PROP']);
});

test('changing settings updates existing events', () => {
  const { gas, env } = setUp();
  gas.syncNow();
  gas.SETTINGS.categories = { test: { color: 'purple', remindDaysBefore: [2] } };
  const summary = gas.syncNow();
  assert.equal(summary.updated, 1);
  const test = byTag(env)['bb:bio-test'];
  assert.equal(test.getColor(), '3');
  assert.deepEqual(test.getPopupReminders(), [2 * 1440 - 960]);
});

test('turning a kind off removes its events', () => {
  const { gas, env } = setUp();
  gas.syncNow();
  gas.SETTINGS.categories = { quiz: { enabled: false } };
  const summary = gas.syncNow();
  assert.equal(summary.removed, 1);
  assert.equal(byTag(env)['bb:geo-quiz'], undefined);
});

test('stopAutoSync() and removeSyncedEvents() clean up', () => {
  const { gas, env } = setUp();
  gas.setup();
  const cal = calendarOf(env);
  cal.createAllDayEvent('My own event', midnight(dayFromToday(1, TZ), TZ), {});

  gas.stopAutoSync();
  assert.equal(env.triggers.length, 0);
  gas.removeSyncedEvents();
  assert.deepEqual(cal.events.map((e) => e.getTitle()), ['My own event']);
  assert.equal(env.properties.B2C_SYNCED, undefined);
});

test('a new calendar starts with a clean slate', () => {
  const { gas, env } = setUp();
  gas.syncNow();
  byTag(env)['bb:geo-quiz'].deleteEvent();
  gas.syncNow();
  // The user deletes the whole calendar; the next sync makes a new one with everything.
  env.calendars = [];
  gas.syncNow();
  assert.deepEqual(Object.keys(byTag(env)).sort(), ['bb:bio-test', 'bb:geo-quiz', 'bb:hist-proj']);
});
