const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadScripts, plain } = require('./helpers');

const gas = loadScripts();
const TZ = 'America/New_York';
const sample = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-feed.ics'), 'utf8');

function itemsByUid(text, tz = TZ) {
  const out = {};
  gas.readFeed_(text, tz).forEach((item) => (out[item.uid] = plain(item)));
  return out;
}

test('reads every VEVENT and ignores VTIMEZONE and VALARM contents', () => {
  const items = itemsByUid(sample);
  assert.deepEqual(Object.keys(items).sort(), [
    'assignment-2001',
    'assignment-2002',
    'assignment-2003',
    'assignment-2004',
    'assignment-2005',
    'event-3001',
    'schedule-1001',
  ]);
  // The VALARM's DESCRIPTION ("Reminder") must not replace the event's.
  assert.equal(items['assignment-2001'].description, 'Covers cell structure, membranes and transport.\nBring a pencil.');
});

test('date-only values have no time', () => {
  const items = itemsByUid(sample);
  assert.deepEqual(items['assignment-2001'].start, { date: '2026-09-30', time: null });
  assert.deepEqual(items['assignment-2001'].end, { date: '2026-10-01', time: null });
});

test('UTC times are converted to the local time zone', () => {
  const items = itemsByUid(sample);
  // 03:59 UTC on Oct 2 is 11:59 PM on Oct 1 in New York (EDT, UTC-4).
  assert.deepEqual(items['assignment-2003'].start, { date: '2026-10-01', time: '23:59' });
  const chicago = itemsByUid(sample, 'America/Chicago');
  assert.deepEqual(chicago['assignment-2003'].start, { date: '2026-10-01', time: '22:59' });
});

test('Windows and quoted TZIDs are understood', () => {
  const ny = itemsByUid(sample);
  assert.deepEqual(ny['schedule-1001'].start, { date: '2026-09-30', time: '08:00' });
  assert.deepEqual(ny['event-3001'].start, { date: '2026-10-03', time: '19:00' });
  // Same wall time seen from Los Angeles is three hours earlier.
  const la = itemsByUid(sample, 'America/Los_Angeles');
  assert.deepEqual(la['schedule-1001'].start, { date: '2026-09-30', time: '05:00' });
  assert.deepEqual(la['event-3001'].start, { date: '2026-10-03', time: '16:00' });
});

test('unknown TZIDs and floating times are taken as local wall time', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:a',
    'SUMMARY:Floating',
    'DTSTART:20261105T093000',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:b',
    'SUMMARY:Unknown zone',
    'DTSTART;TZID=Some Custom Zone:20261105T101500',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const items = itemsByUid(ics, 'America/Denver');
  assert.deepEqual(items.a.start, { date: '2026-11-05', time: '09:30' });
  assert.deepEqual(items.b.start, { date: '2026-11-05', time: '10:15' });
});

test('CATEGORIES are split on unescaped commas', () => {
  const items = itemsByUid(sample);
  assert.deepEqual(items['assignment-2003'].categories, ['Assessment, Minor']);
  const ics = 'BEGIN:VEVENT\nUID:x\nDTSTART;VALUE=DATE:20261001\nCATEGORIES:Test,Major\nCATEGORIES:Test,Unit\nEND:VEVENT';
  assert.deepEqual(itemsByUid(ics).x.categories, ['Test', 'Major', 'Unit']);
});

test('HTML descriptions (X-ALT-DESC) become plain text', () => {
  const items = itemsByUid(sample);
  assert.equal(items['assignment-2005'].description, 'Build a museum exhibit & present it.\n\n• Poster\n• Sources');
});

test('handles CRLF, a byte-order mark and quoted parameters containing colons', () => {
  const ics =
    '\uFEFFBEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:q\r\nSUMMARY;LANGUAGE="en:US":Lab Report\\; final\r\n' +
    'DTSTART;VALUE=DATE:20261201\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const items = itemsByUid(ics);
  assert.equal(items.q.summary, 'Lab Report; final');
});

test('events without a UID get a stable made-up one', () => {
  const ics = 'BEGIN:VEVENT\nSUMMARY:Essay\nDTSTART;VALUE=DATE:20261201\nEND:VEVENT';
  const first = itemsByUid(ics);
  const again = itemsByUid(ics);
  const [uid] = Object.keys(first);
  assert.match(uid, /^nouid-[0-9a-f]{8}$/);
  assert.deepEqual(Object.keys(again), [uid]);
});

test('events without a start date are dropped', () => {
  const ics = 'BEGIN:VEVENT\nUID:n\nSUMMARY:No date\nEND:VEVENT';
  assert.deepEqual(itemsByUid(ics), {});
});
