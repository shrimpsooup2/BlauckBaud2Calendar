/**
 * Minimal iCalendar (RFC 5545) reader: enough to pull the events out of a
 * Blackbaud calendar feed and turn them into plain "feed items".
 */

/**
 * Parses iCalendar text into raw VEVENTs. Each VEVENT is a map from property
 * name to a list of {params, value}. Properties of nested components such as
 * VALARM are ignored so they can't overwrite the event's own SUMMARY etc.
 */
function parseIcs_(text) {
  var events = [];
  var stack = [];
  var current = null;
  unfoldIcsLines_(text).forEach(function (line) {
    var prop = parseIcsLine_(line);
    if (!prop) return;
    if (prop.name === 'BEGIN') {
      var begin = prop.value.trim().toUpperCase();
      stack.push(begin);
      if (begin === 'VEVENT') current = {};
      return;
    }
    if (prop.name === 'END') {
      var end = prop.value.trim().toUpperCase();
      var at = stack.lastIndexOf(end);
      if (at !== -1) stack.length = at;
      if (end === 'VEVENT' && current) {
        events.push(current);
        current = null;
      }
      return;
    }
    if (current && stack[stack.length - 1] === 'VEVENT') {
      (current[prop.name] = current[prop.name] || []).push({ params: prop.params, value: prop.value });
    }
  });
  return events;
}

/** Splits text into logical lines, joining folded continuation lines. */
function unfoldIcsLines_(text) {
  var lines = [];
  String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r\n|\n|\r/)
    .forEach(function (line) {
      if ((line[0] === ' ' || line[0] === '\t') && lines.length) {
        lines[lines.length - 1] += line.slice(1);
      } else if (line) {
        lines.push(line);
      }
    });
  return lines;
}

/** 'DTSTART;TZID="A:B";VALUE=DATE-TIME:2026...' -> {name, params, value}. */
function parseIcsLine_(line) {
  var inQuotes = false;
  var colon = -1;
  for (var i = 0; i < line.length; i++) {
    var c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ':' && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon <= 0) return null;
  var head = splitOutsideQuotes_(line.slice(0, colon), ';');
  var params = {};
  head.slice(1).forEach(function (param) {
    var eq = param.indexOf('=');
    if (eq > 0) {
      params[param.slice(0, eq).trim().toUpperCase()] = param.slice(eq + 1).replace(/^"|"$/g, '');
    }
  });
  return { name: head[0].trim().toUpperCase(), params: params, value: line.slice(colon + 1) };
}

function splitOutsideQuotes_(s, sep) {
  var parts = [];
  var buf = '';
  var inQuotes = false;
  for (var i = 0; i < s.length; i++) {
    var c = s[i];
    if (c === '"') inQuotes = !inQuotes;
    if (c === sep && !inQuotes) {
      parts.push(buf);
      buf = '';
    } else {
      buf += c;
    }
  }
  parts.push(buf);
  return parts;
}

/** Splits a comma-separated TEXT list (e.g. CATEGORIES), honoring escaped commas. */
function splitIcsList_(value) {
  var parts = [];
  var buf = '';
  for (var i = 0; i < value.length; i++) {
    var c = value[i];
    if (c === '\\' && i + 1 < value.length) {
      buf += c + value[++i];
    } else if (c === ',') {
      parts.push(unescapeIcsText_(buf));
      buf = '';
    } else {
      buf += c;
    }
  }
  parts.push(unescapeIcsText_(buf));
  return parts;
}

/** Undoes iCalendar TEXT escaping (\n, \, \; \\). */
function unescapeIcsText_(value) {
  return String(value || '').replace(/\\([\\;,nN])/g, function (_, c) {
    return c === 'n' || c === 'N' ? '\n' : c;
  });
}

/**
 * Parses a DTSTART/DTEND property into {date, time} in zone `tz`, where time
 * is null for date-only values. UTC times and times in another TZID are
 * converted; floating times and unknown zones are taken as local wall time.
 */
function parseIcsDate_(prop, tz) {
  if (!prop) return null;
  var m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/i.exec(prop.value.trim());
  if (!m) return null;
  var date = m[1] + '-' + m[2] + '-' + m[3];
  if (!m[4] || String(prop.params.VALUE || '').toUpperCase() === 'DATE') {
    return { date: date, time: null };
  }
  var time = m[4] + ':' + m[5];
  if (m[7]) {
    var instant = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
    return wallClockInZone_(instant, tz);
  }
  var zone = prop.params.TZID ? resolveTimeZone_(prop.params.TZID) : null;
  if (zone && zone !== tz) {
    try {
      return wallClockInZone_(zonedWallTimeToInstant_(date, time, zone), tz);
    } catch (e) {
      // Unknown zone name: fall back to wall time.
    }
  }
  return { date: date, time: time };
}

/**
 * Converts a raw VEVENT into a feed item:
 * {uid, summary, description, categories[], location, url, start, end}
 * where start/end are {date, time} in zone `tz` (or null).
 */
function icsEventToItem_(ev, tz) {
  function first(name) {
    return ev[name] && ev[name].length ? ev[name][0] : null;
  }
  function text(name) {
    var prop = first(name);
    return prop ? unescapeIcsText_(prop.value).trim() : '';
  }
  var categories = [];
  (ev.CATEGORIES || []).forEach(function (prop) {
    splitIcsList_(prop.value).forEach(function (c) {
      c = c.trim();
      if (c && categories.indexOf(c) === -1) categories.push(c);
    });
  });
  var description = text('DESCRIPTION');
  if (!description && first('X-ALT-DESC')) description = unescapeIcsText_(first('X-ALT-DESC').value);
  var start = parseIcsDate_(first('DTSTART'), tz);
  var end = parseIcsDate_(first('DTEND'), tz);
  var summary = text('SUMMARY');
  var uid = text('UID') || 'nouid-' + hash_(summary + '|' + (start ? start.date + ' ' + start.time : ''));
  var recurrence = first('RECURRENCE-ID');
  if (recurrence) uid += '@' + recurrence.value.trim();
  return {
    uid: uid,
    summary: summary,
    description: htmlToText_(description),
    categories: categories,
    location: text('LOCATION'),
    url: text('URL'),
    start: start,
    end: end,
  };
}

/** Parses a whole feed into feed items (events without a start are dropped). */
function readFeed_(icsText, tz) {
  return parseIcs_(icsText)
    .map(function (ev) {
      return icsEventToItem_(ev, tz);
    })
    .filter(function (item) {
      return item.start;
    });
}
