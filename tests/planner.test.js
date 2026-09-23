const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts, plain } = require('./helpers');

const gas = loadScripts();
const TZ = 'America/New_York';
const TODAY = '2026-10-05'; // a Monday

function at(date, time) {
  return gas.zonedWallTimeToInstant_(date, time, TZ).getTime();
}

function local(ms) {
  const w = gas.wallClockInZone_(new Date(ms), TZ);
  return `${w.date} ${w.time}`;
}

function assessment(overrides = {}) {
  return {
    id: 'bb:t1',
    title: 'Unit 3 Test',
    course: 'AP Biology',
    summary: 'AP Biology - 2: Unit 3 Test',
    details: '',
    category: 'test',
    date: '2026-10-12',
    ...overrides,
  };
}

function plan(overrides = {}) {
  const input = {
    assessments: [assessment()],
    sessions: [],
    busy: [],
    tombstones: {},
    gradeOf: () => null,
    advice: {},
    study: gas.mergeDeep_(gas.DEFAULTS_.study, overrides.study || {}),
    kindLabels: { test: 'Test', quiz: 'Quiz', project: 'Project', essay: 'Essay / paper' },
    now: at(TODAY, '08:00'),
    today: TODAY,
    tz: TZ,
    ...overrides,
  };
  input.study = gas.mergeDeep_(gas.DEFAULTS_.study, overrides.study || {});
  return gas.planStudy_(input);
}

// Turns planned sessions into "existing" ones, as the calendar would return them.
function asExisting(sessions) {
  return sessions.map((s) => ({ ...s, plannedStart: s.start }));
}

test('parseHourRanges_ reads study hours', () => {
  assert.deepEqual(plain(gas.parseHourRanges_('16:00-21:00')), [[960, 1260]]);
  assert.deepEqual(plain(gas.parseHourRanges_('16:00-21:00, 7:00-7:45')), [[420, 465], [960, 1260]]);
  assert.deepEqual(plain(gas.parseHourRanges_('')), []);
  assert.deepEqual(plain(gas.parseHourRanges_('none')), []);
  assert.deepEqual(plain(gas.parseHourRanges_('20:00-24:00')), [[1200, 1440]]);
  assert.equal(gas.parseHourRanges_('4pm-9pm'), null);
  assert.equal(gas.parseHourRanges_('21:00-16:00'), null);
  assert.equal(gas.parseHourRanges_('16:00-21:75'), null);
});

test('studyWindowsFor_ uses weekday, weekend and single-day hours', () => {
  const hours = { weekdays: '16:00-21:00', weekends: '10:00-18:00', fri: '', sun: '13:00-15:00' };
  assert.deepEqual(plain(gas.studyWindowsFor_('2026-10-05', hours)), [[960, 1260]]); // Monday
  assert.deepEqual(plain(gas.studyWindowsFor_('2026-10-09', hours)), []); // Friday off
  assert.deepEqual(plain(gas.studyWindowsFor_('2026-10-10', hours)), [[600, 1080]]); // Saturday
  assert.deepEqual(plain(gas.studyWindowsFor_('2026-10-11', hours)), [[780, 900]]); // Sunday
});

test('gradeFactor_ gives more time for lower grades, within limits', () => {
  assert.equal(gas.gradeFactor_(93, 93), 1);
  assert.equal(gas.gradeFactor_(83, 93), 1.5);
  assert.equal(gas.gradeFactor_(73, 93), 2);
  assert.equal(gas.gradeFactor_(50, 93), 2);
  assert.equal(gas.gradeFactor_(100, 93), 0.65);
  assert.equal(gas.gradeFactor_(120, 93), 0.6);
  assert.equal(gas.gradeFactor_(undefined, 93), 1);
  assert.equal(gas.formatMinutes_(270), '4h 30m');
  assert.equal(gas.formatMinutes_(45), '45m');
  assert.equal(gas.formatMinutes_(120), '2h');
});

test('a test gets spaced sessions in study hours before the due date', () => {
  const p = plain(plan());
  assert.equal(p.create.length, 4); // 180 minutes / 45
  assert.deepEqual(
    p.create.map((s) => local(s.start)).sort(),
    ['2026-10-05 16:00', '2026-10-08 16:00', '2026-10-10 10:00', '2026-10-11 10:00'] // 7, 4, 2 and 1 days before
  );
  for (const s of p.create) {
    assert.equal(s.end - s.start, 45 * 60000);
    assert.equal(s.forId, 'bb:t1');
    assert.equal(s.id, `study:bb:t1:${s.start}`);
  }
  const first = p.create.find((s) => local(s.start) === '2026-10-05 16:00');
  assert.equal(first.title, '📚 Study for Unit 3 Test (AP Biology)');
  assert.match(first.description, /^Session 1 of 4 for Unit 3 Test \(AP Biology\), due Mon, Oct 12, 2026\.\n\n/);
  assert.match(first.description, /No grade found for this class, so it gets the usual time\./);
  const summary = p.summaries[0];
  assert.equal(summary.sessionsWanted, 4);
  assert.equal(summary.created, 4);
  assert.equal(summary.unplaced, 0);
});

test('a lower grade in the class means more sessions', () => {
  const p = plain(plan({ gradeOf: () => ({ className: 'AP Biology', grade: 83 }) }));
  assert.equal(p.create.length, 6); // 180 × 1.5 = 270 minutes
  assert.match(p.create[0].description, /Your grade in AP Biology is 83%, so it gets 1\.5× that\./);
  const strong = plain(plan({ gradeOf: () => ({ className: 'AP Biology', grade: 99 }) }));
  assert.equal(strong.create.length, 3); // 180 × 0.7 = 126 minutes
});

test('sessions avoid busy times, with a break around them', () => {
  const busy = [[at('2026-10-11', '09:30'), at('2026-10-11', '12:00')]];
  const p = plain(plan({ busy }));
  const sunday = p.create.filter((s) => local(s.start).startsWith('2026-10-11'));
  assert.deepEqual(sunday.map((s) => local(s.start)), ['2026-10-11 12:15']);
});

test('no day goes over maxMinutesPerDay', () => {
  const assessments = [
    assessment({ id: 'bb:a' }),
    assessment({ id: 'bb:b', title: 'Chapter 4 Test', course: 'Chemistry' }),
    assessment({ id: 'bb:c', title: 'Midterm', course: 'History' }),
  ];
  const p = plain(plan({ assessments, study: { maxMinutesPerDay: 90 } }));
  const perDay = {};
  for (const s of p.create) {
    const day = local(s.start).slice(0, 10);
    perDay[day] = (perDay[day] || 0) + (s.end - s.start) / 60000;
  }
  assert.ok(Object.values(perDay).every((m) => m <= 90), JSON.stringify(perDay));
  // Two sessions on the same day never overlap and keep their break.
  const starts = p.create.map((s) => s.start).sort((a, b) => a - b);
  for (let i = 1; i < starts.length; i++) {
    if (local(starts[i]).slice(0, 10) === local(starts[i - 1]).slice(0, 10)) {
      assert.ok(starts[i] - starts[i - 1] >= 60 * 60000);
    }
  }
});

test('re-planning with the same inputs changes nothing', () => {
  const first = plain(plan({ gradeOf: () => ({ className: 'AP Biology', grade: 85 }) }));
  const second = plain(
    plan({ gradeOf: () => ({ className: 'AP Biology', grade: 85 }), sessions: asExisting(first.create) })
  );
  assert.deepEqual([second.create.length, second.update.length, second.remove.length], [0, 0, 0]);
  assert.equal(second.keep.length, first.create.length);
});

test('sessions that now clash with something are moved, unless you moved them there', () => {
  const [s] = plain(plan()).create.filter((x) => local(x.start) === '2026-10-08 16:00');
  const busy = [[at('2026-10-08', '15:30'), at('2026-10-08', '17:00')]];
  const clash = plain(plan({ busy, sessions: [{ ...s, plannedStart: s.start }] }));
  assert.deepEqual(clash.remove.map((r) => r.reason), ['something else is scheduled then']);
  assert.equal(clash.create.length, 4);

  const movedByYou = { ...s, plannedStart: s.start - 3600000 };
  const kept = plain(plan({ busy, sessions: [movedByYou] }));
  assert.deepEqual(kept.remove, []);
  assert.equal(kept.create.length, 3);
});

test('sessions after the due date are removed and re-planned', () => {
  const late = { id: 'study:bb:t1:1', forId: 'bb:t1', start: at('2026-10-13', '16:00'), end: at('2026-10-13', '16:45'), plannedStart: 5, hash: 'x' };
  const p = plain(plan({ sessions: [late] }));
  assert.deepEqual(p.remove.map((r) => r.reason), ['it is after the due date']);
  assert.equal(p.create.length, 4);
});

test('sessions you deleted are not added back', () => {
  const p = plain(plan({ tombstones: { 'bb:t1': 3 } }));
  assert.equal(p.create.length, 1);
  assert.equal(p.summaries[0].deleted, 3);
});

test("a gone assessment's upcoming sessions are removed; past ones stay", () => {
  const past = { id: 'study:bb:old:1', forId: 'bb:old', start: at('2026-10-04', '10:00'), end: at('2026-10-04', '10:45'), hash: 'x' };
  const future = { id: 'study:bb:old:2', forId: 'bb:old', start: at('2026-10-06', '16:00'), end: at('2026-10-06', '16:45'), hash: 'x' };
  const p = plain(plan({ sessions: [past, future] }));
  assert.deepEqual(p.remove.map((r) => [r.existing.id, r.reason]), [['study:bb:old:2', 'its assessment is no longer coming up']]);
});

test('when fewer sessions are needed, the earliest upcoming ones go', () => {
  const lots = plain(plan({ gradeOf: () => ({ className: 'AP Biology', grade: 80 }) })).create;
  const p = plain(plan({ sessions: asExisting(lots), gradeOf: () => ({ className: 'AP Biology', grade: 97 }) }));
  const needed = Math.round((180 * 0.8) / 45);
  assert.equal(p.remove.length, lots.length - needed);
  const removedStarts = p.remove.map((r) => r.existing.start);
  const keptStarts = p.keep.concat(p.update.map((u) => u.existing)).map((s) => s.start);
  assert.ok(Math.max(...removedStarts) < Math.min(...keptStarts));
  assert.ok(p.remove.every((r) => r.reason === 'fewer sessions are needed now'));
});

test('past sessions count as done', () => {
  const done = { id: 'study:bb:t1:1', forId: 'bb:t1', start: at('2026-10-04', '10:00'), end: at('2026-10-04', '10:45'), plannedStart: at('2026-10-04', '10:00'), hash: 'x' };
  const p = plain(plan({ sessions: [done] }));
  assert.equal(p.create.length, 3);
  assert.equal(p.summaries[0].done, 1);
  assert.match(p.create[0].description, /^Session 2 of 4/);
});

test('AI advice sets each session\'s focus and scales the time', () => {
  const advice = { 'bb:t1': { effort: 'heavy', steps: ['Cell membranes', 'Transport', 'Osmosis', 'Practice test'] } };
  const p = plain(plan({ advice }));
  assert.equal(p.create.length, 5); // 180 × 1.3 = 234 minutes
  const titles = p.create.sort((a, b) => a.start - b.start).map((s) => s.title);
  assert.deepEqual(titles, [
    '📚 Unit 3 Test (AP Biology): Cell membranes',
    '📚 Unit 3 Test (AP Biology): Cell membranes',
    '📚 Unit 3 Test (AP Biology): Transport',
    '📚 Unit 3 Test (AP Biology): Osmosis',
    '📚 Unit 3 Test (AP Biology): Practice test',
  ]);
  assert.match(p.create[0].description, /Focus: Cell membranes/);
  assert.match(p.create[0].description, /The AI rated it heavy \(1\.3×\)\./);
});

test('new AI advice updates the titles of planned sessions', () => {
  const first = plain(plan()).create;
  const p = plain(plan({ sessions: asExisting(first), advice: { 'bb:t1': { effort: 'normal', steps: ['Read notes', 'Practice'] } } }));
  assert.equal(p.create.length, 0);
  assert.equal(p.update.length, 4);
  assert.ok(p.update.every((u) => /: (Read notes|Practice)$/.test(u.desired.title)));
});

test("it reports sessions it couldn't fit", () => {
  const p = plain(plan({ study: { hours: { weekdays: '', weekends: '' } } }));
  assert.equal(p.create.length, 0);
  assert.equal(p.summaries[0].unplaced, 4);
});

test('nothing is added for something due today; due tomorrow means today', () => {
  const today = plain(plan({ assessments: [assessment({ date: TODAY })] }));
  assert.deepEqual([today.create.length, today.summaries[0].unplaced], [0, 0]);
  const tomorrow = plain(plan({ assessments: [assessment({ date: '2026-10-06', category: 'quiz' })] }));
  assert.deepEqual(tomorrow.create.map((s) => local(s.start)), ['2026-10-05 16:00']);
});

test('sessions start at least 30 minutes from now', () => {
  const p = plain(plan({ now: at(TODAY, '16:10'), assessments: [assessment({ date: '2026-10-06', category: 'quiz' })] }));
  assert.deepEqual(p.create.map((s) => local(s.start)), ['2026-10-05 16:45']);
});

test('projects are spread evenly over the weeks before they are due', () => {
  const p = plain(plan({ assessments: [assessment({ id: 'bb:p', category: 'project', title: 'Science Fair Project', date: '2026-10-26' })] }));
  const days = p.create.map((s) => local(s.start).slice(0, 10)).sort();
  assert.equal(days.length, 7); // 300 / 45 ≈ 6.7
  assert.equal(new Set(days).size, 7);
  assert.ok(days[0] <= '2026-10-07', days.join());
  assert.ok(days[6] >= '2026-10-22', days.join());
});
