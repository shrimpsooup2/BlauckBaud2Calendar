const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts, plain } = require('./helpers');

const gas = loadScripts();
const WIN = { start: '2026-09-16', end: '2027-01-21' };

function settingsWith(overrides = {}) {
  return gas.mergeDeep_(gas.DEFAULTS_, { feedUrl: 'https://example.myschoolapp.com/podium/feed/iCal.aspx?z=abc', ...overrides });
}

function item(overrides = {}) {
  return {
    uid: 'a-1',
    summary: 'Unit 3 Test',
    description: '',
    categories: [],
    location: '',
    url: '',
    start: { date: '2026-09-30', time: null },
    end: null,
    ...overrides,
  };
}

function eventFor(it, settings = settingsWith()) {
  const decisions = gas.classifyItems_([it], settings, WIN);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].result.include, true);
  return plain(gas.buildEvent_(decisions[0].item, decisions[0].result.category, settings));
}

test('mergeDeep_ merges objects, replaces lists and leaves the defaults alone', () => {
  const merged = gas.mergeDeep_(gas.DEFAULTS_, { categories: { quiz: { enabled: false, keywords: ['check'] } } });
  assert.equal(merged.categories.quiz.enabled, false);
  assert.deepEqual(plain(merged.categories.quiz.keywords), ['check']);
  assert.equal(merged.categories.quiz.icon, gas.DEFAULTS_.categories.quiz.icon);
  assert.equal(gas.DEFAULTS_.categories.quiz.enabled, true);
  assert.deepEqual(plain(gas.DEFAULTS_.categories.quiz.keywords), ['quiz', 'quizzes']);
});

test('reminderMinutes_ places all-day reminders at reminderTime on earlier days', () => {
  assert.equal(gas.reminderMinutes_(1, true, '16:00'), 480); // 4 PM the day before
  assert.equal(gas.reminderMinutes_(3, true, '07:30'), 3 * 1440 - 450);
  assert.equal(gas.reminderMinutes_(0, true, '16:00'), 0); // can't remind after midnight on the day itself
  assert.equal(gas.reminderMinutes_(1, false, '16:00'), 1440);
  assert.equal(gas.reminderMinutes_(28, false), 40320);
  assert.equal(gas.reminderMinutes_(29, false), null); // Google's limit is four weeks
  assert.equal(gas.reminderMinutes_('x', true), null);
});

test('colorId_ understands names and numbers', () => {
  assert.equal(gas.colorId_('red'), '11');
  assert.equal(gas.colorId_('Tomato'), '11');
  assert.equal(gas.colorId_(' blue '), '9');
  assert.equal(gas.colorId_(7), '7');
  assert.equal(gas.colorId_(''), '');
  assert.equal(gas.colorId_(undefined), '');
  assert.equal(gas.colorId_('chartreuse'), null);
  assert.equal(gas.colorId_(12), null);
});

test('dueOf_ can use the end date; date-only ends are exclusive', () => {
  const s = settingsWith({ dueDateFrom: 'end' });
  const multiDay = item({ start: { date: '2026-10-01', time: null }, end: { date: '2026-10-08', time: null } });
  assert.deepEqual(plain(gas.dueOf_(multiDay, s)), { date: '2026-10-07', time: null });
  const oneDay = item({ start: { date: '2026-10-01', time: null }, end: { date: '2026-10-01', time: null } });
  assert.deepEqual(plain(gas.dueOf_(oneDay, s)), { date: '2026-10-01', time: null });
  const timed = item({ start: { date: '2026-10-01', time: '08:00' }, end: { date: '2026-10-01', time: '23:59' } });
  assert.deepEqual(plain(gas.dueOf_(timed, s)), { date: '2026-10-01', time: '23:59' });
  assert.deepEqual(plain(gas.dueOf_(timed, settingsWith())), { date: '2026-10-01', time: '08:00' });
});

test('classifyItems_ keeps only items inside the window, sorted by due date', () => {
  const items = [
    item({ uid: 'late', start: { date: '2026-12-01', time: null } }),
    item({ uid: 'too-old', start: { date: '2026-09-15', time: null } }),
    item({ uid: 'first', start: { date: '2026-09-16', time: '09:00' } }),
    item({ uid: 'too-far', start: { date: '2027-01-22', time: null } }),
    item({ uid: 'last', start: { date: '2027-01-21', time: null } }),
  ];
  const uids = gas.classifyItems_(items, settingsWith(), WIN).map((d) => d.item.uid);
  assert.deepEqual(plain(uids), ['first', 'late', 'last']);
});

test('buildEvent_ makes an all-day event with icon, reminders and color', () => {
  const ev = eventFor(item({ description: 'Covers cells.', categories: ['Test'] }));
  assert.equal(ev.id, 'bb:a-1');
  assert.equal(ev.title, '📝 Unit 3 Test');
  assert.equal(ev.date, '2026-09-30');
  assert.equal(ev.time, null);
  assert.equal(ev.color, '11');
  assert.deepEqual(ev.reminders, [3 * 1440 - 960, 1440 - 960]);
  assert.equal(ev.category, 'test');
  assert.match(ev.hash, /^[0-9a-f]{8}$/);
  assert.equal(
    ev.description,
    'Kind: Test (Blackbaud: Test)\nDue: Wed, Sep 30, 2026\n\nCovers cells.\n\n' +
      '(Synced from Blackbaud. Delete this event to hide it for good.)'
  );
});

test('buildEvent_ uses the course title format when a titlePattern splits the title', () => {
  const s = settingsWith({ titlePattern: '^(?<course>.+?) - \\d+: (?<title>.+)$' });
  const ev = eventFor(item({ summary: 'AP Biology - 2: Unit 3 Test' }), s);
  assert.equal(ev.title, '📝 Unit 3 Test (AP Biology)');
  assert.match(ev.description, /^Class: AP Biology\n/);
});

test('buildEvent_ makes timed events only when useDueTime is on', () => {
  const due = item({ summary: 'Essay', start: { date: '2026-10-01', time: '23:59' } });
  const allDay = eventFor(due);
  assert.equal(allDay.time, null);
  assert.match(allDay.description, /Due: Thu, Oct 1, 2026 at 11:59 PM/);
  const timed = eventFor(due, settingsWith({ useDueTime: true, timedEventMinutes: 45 }));
  assert.equal(timed.time, '23:59');
  assert.equal(timed.durationMinutes, 45);
  assert.deepEqual(timed.reminders, [5 * 1440, 1440]);
});

test('buildEvent_ keeps at most five distinct reminders, latest-first order', () => {
  const s = settingsWith({ categories: { test: { remindDaysBefore: [1, 3, 3, 7, 2, 5, 10, 60] } } });
  const ev = eventFor(item(), s);
  assert.deepEqual(ev.reminders, [7, 5, 3, 2, 1].map((d) => d * 1440 - 960));
});

test('the event hash changes when the content changes, and only then', () => {
  const a = eventFor(item());
  assert.equal(eventFor(item()).hash, a.hash);
  assert.notEqual(eventFor(item({ description: 'new details' })).hash, a.hash);
  assert.notEqual(eventFor(item({ start: { date: '2026-10-02', time: null } })).hash, a.hash);
  assert.notEqual(eventFor(item(), settingsWith({ categories: { test: { color: 'blue' } } })).hash, a.hash);
});

test('links are shown unless they could be the private feed link', () => {
  assert.equal(gas.isSafeLink_('https://school.myschoolapp.com/app/student#assignmentdetail/1/2'), true);
  assert.equal(gas.isSafeLink_('https://school.myschoolapp.com/podium/feed/iCal.aspx?z=secret'), false);
  assert.equal(gas.isSafeLink_('https://example.com/page?z=secret'), false);
  assert.equal(gas.isSafeLink_('javascript:alert(1)'), false);
  const ev = eventFor(item({ url: 'https://school.myschoolapp.com/podium/feed/iCal.aspx?z=secret' }));
  assert.doesNotMatch(ev.description, /secret/);
});

function existing(id, hash, date, extra = {}) {
  return { id, hash, date, title: id, ...extra };
}

function desired(id, hash, date) {
  return { id, hash, date, title: id };
}

test('planSync_ creates, updates, keeps and removes the right events', () => {
  const plan = plain(
    gas.planSync_(
      [desired('new', 'h1', '2026-10-01'), desired('changed', 'h2', '2026-10-02'), desired('same', 'h3', '2026-10-03')],
      [
        existing('changed', 'old', '2026-10-02'),
        existing('same', 'h3', '2026-10-03'),
        existing('gone', 'h4', '2026-10-04'),
        existing('gone-but-old', 'h5', '2026-09-01'),
        existing('gone-far-ahead', 'h6', '2027-03-01'),
      ],
      WIN,
      { deleteRemoved: true, synced: {} }
    )
  );
  assert.deepEqual(plan.create.map((d) => d.id), ['new']);
  assert.deepEqual(plan.update.map((u) => [u.existing.id, u.desired.hash]), [['changed', 'h2']]);
  assert.deepEqual(plan.unchanged.map((d) => d.id), ['same']);
  // Events outside the window are history (or not yet visible): leave them.
  assert.deepEqual(plan.remove.map((r) => r.existing.id), ['gone']);
  assert.deepEqual(plan.keptDeleted, []);
});

test('planSync_ removes duplicates and can be told never to remove', () => {
  const dupes = [existing('x', 'h', '2026-10-01', { ref: 1 }), existing('x', 'h', '2026-10-01', { ref: 2 })];
  const plan = plain(gas.planSync_([desired('x', 'h', '2026-10-01')], dupes, WIN, { deleteRemoved: false }));
  assert.deepEqual(plan.remove.map((r) => [r.existing.ref, r.reason]), [[2, 'duplicate']]);
  assert.equal(plan.unchanged.length, 1);

  const keep = plain(gas.planSync_([], [existing('gone', 'h', '2026-10-01')], WIN, { deleteRemoved: false }));
  assert.deepEqual(keep.remove, []);
});

test('planSync_ does not re-create events the user deleted', () => {
  const synced = {};
  synced[gas.stateKey_('deleted-by-me')] = '2026-10-05';
  const plan = plain(
    gas.planSync_([desired('deleted-by-me', 'h', '2026-10-05'), desired('brand-new', 'h', '2026-10-06')], [], WIN, {
      deleteRemoved: true,
      synced,
    })
  );
  assert.deepEqual(plan.keptDeleted.map((d) => d.id), ['deleted-by-me']);
  assert.deepEqual(plan.create.map((d) => d.id), ['brand-new']);
});

test('nextSyncedState_ remembers what is on the calendar, except items to retry', () => {
  const plan = {
    create: [desired('made', 'h', '2026-10-01'), desired('failed', 'h', '2026-10-02')],
    update: [{ existing: existing('upd', 'o', '2026-10-03'), desired: desired('upd', 'n', '2026-10-04') }],
    unchanged: [desired('same', 'h', '2026-10-05')],
    keptDeleted: [desired('hidden', 'h', '2026-10-06')],
    remove: [{ existing: existing('gone', 'h', '2026-10-07') }],
  };
  const state = plain(gas.nextSyncedState_(plan, ['failed']));
  const expected = {};
  [['made', '2026-10-01'], ['upd', '2026-10-04'], ['same', '2026-10-05'], ['hidden', '2026-10-06']].forEach(
    ([id, date]) => (expected[gas.stateKey_(id)] = date)
  );
  assert.deepEqual(state, expected);
});

test('settingsProblems_ accepts the defaults plus a feed link', () => {
  assert.deepEqual(plain(gas.settingsProblems_(settingsWith())), []);
  assert.deepEqual(plain(gas.settingsProblems_(settingsWith({ feedUrl: 'webcal://school.myschoolapp.com/x' }))), []);
});

test('settingsProblems_ explains common mistakes', () => {
  const problems = gas.settingsProblems_(
    gas.mergeDeep_(gas.DEFAULTS_, {
      feedUrl: 'PASTE_YOUR_BLACKBAUD_FEED_LINK_HERE',
      syncEveryHours: 3,
      lookaheadDays: -1,
      reminderTime: '4pm',
      dueDateFrom: 'middle',
      titlePattern: '(unclosed',
      extraExcludeKeywords: 'bell ringer',
      categories: { quiz: { color: 'chartreuse', extraKeywords: 'check' }, broken: true },
    })
  ).join('\n');
  for (const expected of [
    /feedUrl: paste your Blackbaud calendar feed link/,
    /syncEveryHours must be one of 1, 2, 4, 6, 8, 12/,
    /lookaheadDays must be a number of days/,
    /reminderTime must be a 24-hour time/,
    /dueDateFrom must be 'start' or 'end'/,
    /titlePattern is not a valid regular expression/,
    /extraExcludeKeywords must be a list/,
    /categories.quiz.color "chartreuse" is not a color I know/,
    /categories.quiz.extraKeywords must be a list/,
    /categories.broken must be written like/,
  ]) {
    assert.match(problems, expected);
  }
  assert.match(gas.settingsProblems_(settingsWith({ feedUrl: 'ftp://x' })).join(), /should start with webcal:\/\/ or https:\/\//);
});

test('helpers: dates, times and HTML', () => {
  assert.equal(gas.addDays_('2026-12-31', 1), '2027-01-01');
  assert.equal(gas.addDays_('2028-03-01', -1), '2028-02-29');
  assert.equal(gas.formatHumanDate_('2026-09-30'), 'Wed, Sep 30, 2026');
  assert.equal(gas.formatHumanTime_('00:05'), '12:05 AM');
  assert.equal(gas.formatHumanTime_('12:00'), '12:00 PM');
  assert.equal(gas.formatHumanTime_('23:59'), '11:59 PM');
  assert.equal(gas.htmlToText_('Line one<br>Line&nbsp;two &#x263A; &lt;ok&gt;'), 'Line one\nLine two ☺ <ok>');
  assert.equal(gas.htmlToText_('Plain text & more'), 'Plain text & more');
  assert.equal(gas.resolveTimeZone_('Eastern Standard Time'), 'America/New_York');
  assert.equal(gas.resolveTimeZone_('"America/Chicago"'), 'America/Chicago');
  assert.equal(gas.resolveTimeZone_('/mozilla.org/20070129_1/Europe/London'), 'Europe/London');
  assert.equal(gas.resolveTimeZone_('Etc/GMT+5'), 'Etc/GMT+5');
  assert.equal(gas.resolveTimeZone_('Local'), null);
});

test('zonedWallTimeToInstant_ handles daylight-saving changes', () => {
  // 2026-11-01 is the day US clocks fall back.
  assert.equal(gas.zonedWallTimeToInstant_('2026-11-01', '00:00', 'America/New_York').toISOString(), '2026-11-01T04:00:00.000Z');
  assert.equal(gas.zonedWallTimeToInstant_('2026-11-02', '00:00', 'America/New_York').toISOString(), '2026-11-02T05:00:00.000Z');
  assert.equal(gas.zonedWallTimeToInstant_('2026-03-09', '23:59', 'America/Los_Angeles').toISOString(), '2026-03-10T06:59:00.000Z');
});
