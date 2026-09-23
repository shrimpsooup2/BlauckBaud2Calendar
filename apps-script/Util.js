/**
 * Small helpers shared by the rest of the tool. Nothing here needs a Google
 * service (Utilities is used when available), so it also runs under Node for
 * the tests.
 *
 * Dates are passed around as 'YYYY-MM-DD' strings and times as 'HH:MM'
 * strings in the user's time zone, which keeps all-day events free of
 * time-zone surprises.
 */

/** Merges plain objects recursively; anything else in `override` replaces `base`. */
function mergeDeep_(base, override) {
  if (override === undefined) return clone_(base);
  if (!isPlainObject_(base) || !isPlainObject_(override)) return clone_(override);
  var out = {};
  Object.keys(base).forEach(function (key) {
    out[key] = clone_(base[key]);
  });
  Object.keys(override).forEach(function (key) {
    out[key] = key in base ? mergeDeep_(base[key], override[key]) : clone_(override[key]);
  });
  return out;
}

function isPlainObject_(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone_(value) {
  if (Array.isArray(value)) return value.map(clone_);
  if (isPlainObject_(value)) return mergeDeep_({}, value);
  return value;
}

function pad2_(n) {
  return (n < 10 ? '0' : '') + n;
}

/** Adds (or subtracts) whole days to a 'YYYY-MM-DD' date. */
function addDays_(isoDate, days) {
  var p = isoDate.split('-').map(Number);
  var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + days));
  return d.getUTCFullYear() + '-' + pad2_(d.getUTCMonth() + 1) + '-' + pad2_(d.getUTCDate());
}

/** Wall-clock date and time of `instant` in IANA zone `tz`: {date, time}. */
function wallClockInZone_(instant, tz) {
  if (typeof Utilities !== 'undefined' && Utilities.formatDate) {
    var s = Utilities.formatDate(instant, tz, 'yyyy-MM-dd HH:mm');
    return { date: s.slice(0, 10), time: s.slice(11, 16) };
  }
  var parts = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
    .formatToParts(instant)
    .forEach(function (part) {
      parts[part.type] = part.value;
    });
  return {
    date: parts.year + '-' + parts.month + '-' + parts.day,
    time: parts.hour + ':' + parts.minute,
  };
}

/** The instant at which the wall clock in zone `tz` shows `date` `time`. */
function zonedWallTimeToInstant_(date, time, tz) {
  var target = wallAsUtcMillis_(date, time);
  var guess = target;
  // Two correction passes settle the offset, including across DST changes.
  for (var i = 0; i < 2; i++) {
    var wall = wallClockInZone_(new Date(guess), tz);
    guess += target - wallAsUtcMillis_(wall.date, wall.time);
  }
  return new Date(guess);
}

function wallAsUtcMillis_(date, time) {
  var d = date.split('-').map(Number);
  var t = time.split(':').map(Number);
  return Date.UTC(d[0], d[1] - 1, d[2], t[0], t[1]);
}

/** Windows time-zone names (used by some .NET calendar feeds) to IANA names. */
var WINDOWS_TIME_ZONES_ = {
  'eastern standard time': 'America/New_York',
  'central standard time': 'America/Chicago',
  'mountain standard time': 'America/Denver',
  'us mountain standard time': 'America/Phoenix',
  'pacific standard time': 'America/Los_Angeles',
  'alaskan standard time': 'America/Anchorage',
  'hawaiian standard time': 'Pacific/Honolulu',
  'atlantic standard time': 'America/Halifax',
  'newfoundland standard time': 'America/St_Johns',
  'gmt standard time': 'Europe/London',
  'greenwich standard time': 'Atlantic/Reykjavik',
  'w. europe standard time': 'Europe/Berlin',
  'romance standard time': 'Europe/Paris',
  'central europe standard time': 'Europe/Budapest',
  'aus eastern standard time': 'Australia/Sydney',
  'e. australia standard time': 'Australia/Brisbane',
  'new zealand standard time': 'Pacific/Auckland',
  'china standard time': 'Asia/Shanghai',
  'tokyo standard time': 'Asia/Tokyo',
  'singapore standard time': 'Asia/Singapore',
  'india standard time': 'Asia/Kolkata',
  'arabian standard time': 'Asia/Dubai',
  utc: 'UTC',
  gmt: 'UTC',
};

/** Resolves an iCalendar TZID to an IANA zone name, or null if unknown. */
function resolveTimeZone_(tzid) {
  var name = String(tzid || '').replace(/^"|"$/g, '').trim();
  var windows = WINDOWS_TIME_ZONES_[name.toLowerCase()];
  if (windows) return windows;
  // Some feeds prefix zones, e.g. "/mozilla.org/20070129_1/America/New_York".
  var iana = /([A-Za-z]+\/[A-Za-z0-9_+\-]+(?:\/[A-Za-z0-9_+\-]+)?)$/.exec(name);
  return iana ? iana[1] : null;
}

/** Short, stable hex hash (32-bit FNV-1a) of a string. */
function hash_(str) {
  var h = 0x811c9dc5;
  for (var i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}

/** Turns an HTML fragment into readable plain text. Plain text passes through. */
function htmlToText_(s) {
  var text = String(s || '');
  if (/<[a-z\/!][^>]*>/i.test(text)) {
    text = text
      .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
      .replace(/<\s*br\s*\/?\s*>/gi, '\n')
      .replace(/<\s*li[^>]*>/gi, '\n• ')
      .replace(/<\s*\/\s*(p|div|ul|ol|h[1-6]|tr|table)\s*>/gi, '\n')
      .replace(/<[^>]+>/g, '');
  }
  return decodeEntities_(text)
    .replace(/[ \t\u00a0]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeEntities_(s) {
  var named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (whole, code) {
    if (code[0] === '#') {
      var n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    var key = code.toLowerCase();
    return key in named ? named[key] : whole;
  });
}

function truncate_(s, max) {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…';
}

function escapeRegex_(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

var WEEKDAYS_ = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var MONTHS_ = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' -> 'Wed, Sep 30, 2026' */
function formatHumanDate_(isoDate) {
  var p = isoDate.split('-').map(Number);
  var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return WEEKDAYS_[d.getUTCDay()] + ', ' + MONTHS_[p[1] - 1] + ' ' + p[2] + ', ' + p[0];
}

/** 'HH:MM' -> '3:05 PM' */
function formatHumanTime_(time) {
  var t = time.split(':').map(Number);
  return ((t[0] + 11) % 12) + 1 + ':' + pad2_(t[1]) + (t[0] < 12 ? ' AM' : ' PM');
}
