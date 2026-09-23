const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { OUTPUTS, DIST } = require('../scripts/build');

test('dist/ is up to date (run `npm run build` after changing apps-script/)', () => {
  for (const [name, build] of Object.entries(OUTPUTS)) {
    const built = fs.readFileSync(path.join(DIST, name), 'utf8');
    assert.ok(built === build(), `dist/${name} is out of date`);
  }
});

test('the combined script defines each function once', () => {
  const combined = OUTPUTS['BlackbaudToCalendar.gs']();
  const names = [...combined.matchAll(/^function (\w+)\(/gm)].map((m) => m[1]);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepEqual(dupes, []);
  for (const fn of ['setup', 'syncNow', 'preview', 'showFeedSample', 'stopAutoSync', 'restoreDeletedEvents', 'removeSyncedEvents']) {
    assert.ok(names.includes(fn), fn);
  }
});

test('the pasted files work on their own, the way Apps Script loads them', () => {
  const vm = require('vm');
  const { createGasEnvironment } = require('./gas-fakes');
  const { dayFromToday } = require('./helpers');
  const day = (n) => dayFromToday(n, 'America/New_York').replace(/-/g, '');
  const feed = [
    'BEGIN:VCALENDAR',
    `BEGIN:VEVENT\nUID:1\nSUMMARY:Unit 3 Test\nDTSTART;VALUE=DATE:${day(2)}\nEND:VEVENT`,
    `BEGIN:VEVENT\nUID:2\nSUMMARY:Read chapter 4\nDTSTART;VALUE=DATE:${day(3)}\nEND:VEVENT`,
    `BEGIN:VEVENT\nUID:3\nSUMMARY:History Project\nDTSTART;VALUE=DATE:${day(9)}\nEND:VEVENT`,
    'END:VCALENDAR',
  ].join('\n');
  const { env, globals } = createGasEnvironment({ feed });
  const context = vm.createContext(globals);
  for (const name of ['Settings.gs', 'BlackbaudToCalendar.gs']) {
    vm.runInContext(fs.readFileSync(path.join(DIST, name), 'utf8'), context, { filename: name });
  }
  // The untouched settings template asks for the feed link first.
  assert.throws(() => context.setup(), /feedUrl: paste your Blackbaud calendar feed link/);
  env.properties.BLACKBAUD_FEED_URL = 'webcal://school.myschoolapp.com/podium/feed/iCal.aspx?z=abc';
  context.setup();
  assert.deepEqual(env.calendars[0].events.map((e) => e.getTitle()), ['📝 Unit 3 Test', '🛠️ History Project']);
  assert.equal(env.triggers.length, 1);
});
