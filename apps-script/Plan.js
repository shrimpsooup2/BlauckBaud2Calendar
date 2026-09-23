/**
 * Turns classified feed items into the calendar events we want, then compares
 * those with the events already on the calendar to work out what to create,
 * update and remove. Pure logic: no Google services.
 */

/** Google Calendar event colors (CalendarApp.EventColor values). */
var EVENT_COLORS_ = {
  lavender: '1', 'pale blue': '1',
  sage: '2', 'pale green': '2',
  grape: '3', purple: '3', mauve: '3',
  flamingo: '4', pink: '4', 'pale red': '4',
  banana: '5', yellow: '5',
  tangerine: '6', orange: '6',
  peacock: '7', cyan: '7', teal: '7',
  graphite: '8', gray: '8', grey: '8',
  blueberry: '9', blue: '9',
  basil: '10', green: '10',
  tomato: '11', red: '11',
};

/** Color name or number -> '1'..'11'; '' for "calendar default"; null if unknown. */
function colorId_(color) {
  if (color === undefined || color === null || color === '') return '';
  var s = String(color).trim().toLowerCase();
  if (/^(?:[1-9]|1[01])$/.test(s)) return s;
  return EVENT_COLORS_[s] || null;
}

/** Google allows popup reminders up to four weeks before an event. */
var MAX_REMINDER_MINUTES_ = 40320;

/**
 * Minutes before the event start for a reminder `daysBefore` days ahead.
 * All-day events start at midnight, so the reminder is placed at
 * `reminderTime` on that earlier day. Returns null if out of range.
 */
function reminderMinutes_(daysBefore, allDay, reminderTime) {
  var days = Number(daysBefore);
  if (!(days >= 0)) return null;
  var minutes = days * 1440;
  if (allDay) {
    var t = String(reminderTime || '16:00').split(':').map(Number);
    minutes = Math.max(0, minutes - (t[0] * 60 + (t[1] || 0)));
  }
  minutes = Math.round(minutes);
  return minutes <= MAX_REMINDER_MINUTES_ ? minutes : null;
}

/** The sync window {start, end} ('YYYY-MM-DD', inclusive) around `today`. */
function syncWindow_(today, settings) {
  return {
    start: addDays_(today, -Number(settings.lookbackDays)),
    end: addDays_(today, Number(settings.lookaheadDays)),
  };
}

/** The item's due {date, time}, per settings.dueDateFrom. */
function dueOf_(item, settings) {
  if (settings.dueDateFrom === 'end' && item.end) {
    if (item.end.time !== null) return item.end;
    // A date-only DTEND is exclusive: the event ends the day before.
    var last = addDays_(item.end.date, -1);
    return { date: last < item.start.date ? item.start.date : last, time: null };
  }
  return item.start;
}

/**
 * Classifies every feed item due inside the window. Returns decisions sorted
 * by due date: [{item, result}], where item gains course, title and due, and
 * result is {include, category, reason}.
 */
function classifyItems_(items, settings, win) {
  var classify = buildClassifier_(settings);
  var pattern = settings.titlePattern ? new RegExp(settings.titlePattern) : null;
  var decisions = [];
  items.forEach(function (raw) {
    var due = dueOf_(raw, settings);
    if (!due || due.date < win.start || due.date > win.end) return;
    var item = Object.assign({}, raw, splitTitle_(raw.summary, pattern), { due: due });
    decisions.push({ item: item, result: classify(item) });
  });
  decisions.sort(function (a, b) {
    var ka = a.item.due.date + ' ' + (a.item.due.time || '');
    var kb = b.item.due.date + ' ' + (b.item.due.time || '');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return decisions;
}

function fillTemplate_(template, values) {
  return String(template)
    .replace(/\{(\w+)\}/g, function (whole, key) {
      return key in values ? values[key] : whole;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/** A link is only shown if it can't be the secret feed link itself. */
function isSafeLink_(url) {
  return /^https?:\/\//i.test(url) && !/podium\/feed|ical\.aspx|[?&]z=/i.test(url);
}

function buildDescription_(item, label) {
  var lines = [];
  if (item.course) lines.push('Class: ' + item.course);
  var kind = 'Kind: ' + label;
  if (item.categories && item.categories.length) kind += ' (Blackbaud: ' + item.categories.join(', ') + ')';
  lines.push(kind);
  lines.push('Due: ' + formatHumanDate_(item.due.date) + (item.due.time ? ' at ' + formatHumanTime_(item.due.time) : ''));
  if (item.description) lines.push('', truncate_(item.description, 3000));
  if (item.url && isSafeLink_(item.url)) lines.push('', 'Open in Blackbaud: ' + item.url);
  lines.push('', '(Synced from Blackbaud. Delete this event to hide it for good.)');
  return lines.join('\n');
}

/**
 * The calendar event we want for an included item:
 * {id, title, description, date, time, durationMinutes, color, reminders,
 *  category, hash}. `time` is null for all-day events. `hash` changes
 * whenever anything we write to the calendar changes.
 */
function buildEvent_(item, categoryKey, settings) {
  var cat = settings.categories[categoryKey];
  var allDay = !settings.useDueTime || !item.due.time;
  var label = cat.label || categoryKey;
  var values = { icon: cat.icon || '', label: label, title: item.title, course: item.course };
  var reminders = [];
  (cat.remindDaysBefore || []).forEach(function (days) {
    var minutes = reminderMinutes_(days, allDay, settings.reminderTime);
    if (minutes !== null && reminders.indexOf(minutes) === -1 && reminders.length < 5) reminders.push(minutes);
  });
  var event = {
    id: 'bb:' + item.uid,
    title: fillTemplate_(item.course ? settings.titleFormatWithCourse : settings.titleFormat, values),
    description: buildDescription_(item, label),
    date: item.due.date,
    time: allDay ? null : item.due.time,
    durationMinutes: allDay ? 0 : Number(settings.timedEventMinutes) || 30,
    color: colorId_(cat.color) || '',
    reminders: reminders.sort(function (a, b) {
      return b - a;
    }),
    category: categoryKey,
  };
  event.hash = hash_(
    JSON.stringify([event.title, event.description, event.date, event.time, event.durationMinutes, event.color, event.reminders])
  );
  return event;
}

/** Events for all included decisions (one per id). */
function desiredEvents_(decisions, settings) {
  var seen = {};
  var events = [];
  decisions.forEach(function (d) {
    if (!d.result.include) return;
    var event = buildEvent_(d.item, d.result.category, settings);
    if (seen[event.id]) return;
    seen[event.id] = true;
    events.push(event);
  });
  return events;
}

/** Key under which an event id is remembered in the sync state. */
function stateKey_(id) {
  return hash_(id);
}

/**
 * Compares desired events with the tool's events already on the calendar.
 *
 * existing: [{id, hash, date, ...}] (only events this tool created)
 * opts.deleteRemoved: remove events whose item is gone (inside the window)
 * opts.synced: {stateKey: date} of items synced before; a desired item that
 *   was synced before but is missing now was deleted by the user, so it is
 *   left deleted instead of being re-created.
 *
 * Returns {create: [desired], update: [{existing, desired}],
 *          remove: [{existing, reason}], unchanged: [desired],
 *          keptDeleted: [desired]}.
 */
function planSync_(desired, existing, win, opts) {
  var synced = opts.synced || {};
  var plan = { create: [], update: [], remove: [], unchanged: [], keptDeleted: [] };
  var onCalendar = {};
  existing.forEach(function (ev) {
    if (onCalendar[ev.id]) plan.remove.push({ existing: ev, reason: 'duplicate' });
    else onCalendar[ev.id] = ev;
  });
  var wanted = {};
  desired.forEach(function (d) {
    wanted[d.id] = true;
    var ev = onCalendar[d.id];
    if (!ev) {
      if (synced[stateKey_(d.id)]) plan.keptDeleted.push(d);
      else plan.create.push(d);
    } else if (ev.hash !== d.hash) {
      plan.update.push({ existing: ev, desired: d });
    } else {
      plan.unchanged.push(d);
    }
  });
  if (opts.deleteRemoved) {
    Object.keys(onCalendar).forEach(function (id) {
      var ev = onCalendar[id];
      if (!wanted[id] && ev.date >= win.start && ev.date <= win.end) {
        plan.remove.push({ existing: ev, reason: 'no longer in Blackbaud or no longer matches your settings' });
      }
    });
  }
  return plan;
}

/**
 * The sync state to save after a plan was applied: every desired item that
 * is now on the calendar (or was deleted by the user) is remembered.
 * `failedIds` are items whose creation failed, so they are retried.
 */
function nextSyncedState_(plan, failedIds) {
  var failed = {};
  (failedIds || []).forEach(function (id) {
    failed[id] = true;
  });
  var synced = {};
  [plan.create, plan.unchanged, plan.keptDeleted].forEach(function (list) {
    list.forEach(function (d) {
      if (!failed[d.id]) synced[stateKey_(d.id)] = d.date;
    });
  });
  plan.update.forEach(function (u) {
    synced[stateKey_(u.desired.id)] = u.desired.date;
  });
  return synced;
}
