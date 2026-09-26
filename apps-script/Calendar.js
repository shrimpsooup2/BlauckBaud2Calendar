/**
 * Everything that talks to Google Calendar (CalendarApp), plus the small bit
 * of sync state kept in Script Properties.
 *
 * Events created by this tool carry two private tags: b2c_id (which
 * Blackbaud item it is) and b2c_hash (what we last wrote). Events without
 * b2c_id are never touched.
 */

var TAG_ID_ = 'b2c_id';
var TAG_HASH_ = 'b2c_hash';
var PROP_CALENDAR_ID_ = 'B2C_CALENDAR_ID';
var PROP_SYNCED_ = 'B2C_SYNCED';
var MAX_STATE_CHARS_ = 8500;

/** Your calendar called `name` (preferring the one whose id is saved in `idProperty`), or null. */
function findOwnedCalendar_(name, idProperty) {
  var calendars = CalendarApp.getOwnedCalendarsByName(name);
  if (!calendars.length) return null;
  var savedId = PropertiesService.getScriptProperties().getProperty(idProperty);
  for (var i = 0; i < calendars.length; i++) {
    if (calendars[i].getId() === savedId) return calendars[i];
  }
  return calendars[0];
}

function getOrCreateOwnedCalendar_(name, idProperty, summary) {
  var calendar = findOwnedCalendar_(name, idProperty);
  if (!calendar) {
    calendar = CalendarApp.createCalendar(name, { summary: summary });
    console.log('Created the Google Calendar "' + name + '".');
  }
  return calendar;
}

/** The assessments calendar, or null. */
function findCalendar_(settings) {
  return findOwnedCalendar_(settings.calendarName, PROP_CALENDAR_ID_);
}

function getOrCreateCalendar_(settings) {
  return getOrCreateOwnedCalendar_(
    settings.calendarName,
    PROP_CALENDAR_ID_,
    'Tests, quizzes and major projects synced from Blackbaud.'
  );
}

/** {stateKey: date} of items synced to `calendar` before ({} if it's a new calendar). */
function loadSyncedState_(calendar) {
  var props = PropertiesService.getScriptProperties();
  if (!calendar || props.getProperty(PROP_CALENDAR_ID_) !== calendar.getId()) return {};
  try {
    return JSON.parse(props.getProperty(PROP_SYNCED_) || '{}');
  } catch (e) {
    return {};
  }
}

function saveSyncedState_(calendar, synced) {
  // Script properties hold at most 9 KB each; drop the oldest entries if needed.
  var keys = Object.keys(synced).sort(function (a, b) {
    return synced[a] < synced[b] ? -1 : synced[a] > synced[b] ? 1 : 0;
  });
  var json = JSON.stringify(synced);
  while (json.length > MAX_STATE_CHARS_ && keys.length) {
    delete synced[keys.shift()];
    json = JSON.stringify(synced);
  }
  var values = {};
  values[PROP_CALENDAR_ID_] = calendar.getId();
  values[PROP_SYNCED_] = json;
  PropertiesService.getScriptProperties().setProperties(values);
}

function clearSyncedState_() {
  PropertiesService.getScriptProperties().deleteProperty(PROP_SYNCED_);
}

/** Events on `calendar` from `fromDate` to `toDate` (inclusive, 'YYYY-MM-DD'). */
function eventsBetween_(calendar, fromDate, toDate, tz) {
  var from = zonedWallTimeToInstant_(fromDate, '00:00', tz);
  var to = zonedWallTimeToInstant_(addDays_(toDate, 1), '00:00', tz);
  return calendar.getEvents(from, to);
}

/**
 * This tool's assessment events on `calendar` from `fromDate` to `toDate`
 * (inclusive, 'YYYY-MM-DD'): [{id, hash, date, title, ref}]. Their ids start
 * with "bb:"; study sessions ("study:...") are handled in Study.js.
 */
function listToolEvents_(calendar, fromDate, toDate, tz) {
  var events = [];
  eventsBetween_(calendar, fromDate, toDate, tz).forEach(function (ev) {
    var id = ev.getTag(TAG_ID_);
    if (!id || id.indexOf('bb:') !== 0) return;
    var start = ev.isAllDayEvent() ? ev.getAllDayStartDate() : ev.getStartTime();
    events.push({
      id: id,
      hash: ev.getTag(TAG_HASH_) || '',
      date: wallClockInZone_(start, tz).date,
      title: ev.getTitle(),
      ref: ev,
    });
  });
  return events;
}

/** Looks a little beyond the sync window so items whose date moved are still found. */
function listManagedEvents_(calendar, win, tz) {
  return listToolEvents_(calendar, addDays_(win.start, -60), addDays_(win.end, 60), tz);
}

function eventTimes_(d, tz) {
  var start = zonedWallTimeToInstant_(d.date, d.time, tz);
  return { start: start, end: new Date(start.getTime() + d.durationMinutes * 60000) };
}

function createCalendarEvent_(calendar, d, tz) {
  var ev;
  if (d.time) {
    var times = eventTimes_(d, tz);
    ev = calendar.createEvent(d.title, times.start, times.end, { description: d.description });
  } else {
    ev = calendar.createAllDayEvent(d.title, zonedWallTimeToInstant_(d.date, '00:00', tz), {
      description: d.description,
    });
  }
  ev.setTag(TAG_ID_, d.id);
  styleEvent_(ev, d);
  // Written last: if anything above failed, the next sync updates the event.
  ev.setTag(TAG_HASH_, d.hash);
}

function updateCalendarEvent_(ev, d, tz) {
  ev.setTitle(d.title);
  ev.setDescription(d.description);
  if (d.time) {
    var times = eventTimes_(d, tz);
    ev.setTime(times.start, times.end);
  } else {
    ev.setAllDayDate(zonedWallTimeToInstant_(d.date, '00:00', tz));
  }
  styleEvent_(ev, d);
  ev.setTag(TAG_HASH_, d.hash);
}

function styleEvent_(ev, d) {
  if (d.color) ev.setColor(d.color);
  ev.removeAllReminders();
  d.reminders.forEach(function (minutes) {
    ev.addPopupReminder(minutes);
  });
}

/** Short pause between writes so Google doesn't rate-limit a big first sync. */
function pause_() {
  Utilities.sleep(150);
}

/**
 * Applies a plan from planSync_. Stops starting new work once `deadline`
 * (epoch ms) passes; whatever is left is picked up by the next sync.
 * Returns {created, updated, removed, errors: [message], retryIds: [id]}.
 */
function applyPlan_(calendar, plan, tz, deadline) {
  var result = { created: 0, updated: 0, removed: 0, errors: [], retryIds: [], postponed: 0 };
  function outOfTime() {
    return Date.now() > deadline;
  }
  plan.create.forEach(function (d) {
    if (outOfTime()) {
      result.retryIds.push(d.id);
      result.postponed++;
      return;
    }
    try {
      createCalendarEvent_(calendar, d, tz);
      result.created++;
    } catch (e) {
      result.retryIds.push(d.id);
      result.errors.push('Could not add "' + d.title + '" (' + d.date + '): ' + e.message);
    }
    pause_();
  });
  plan.update.forEach(function (u) {
    if (outOfTime()) {
      result.postponed++;
      return;
    }
    try {
      updateCalendarEvent_(u.existing.ref, u.desired, tz);
      result.updated++;
    } catch (e) {
      result.errors.push('Could not update "' + u.desired.title + '" (' + u.desired.date + '): ' + e.message);
    }
    pause_();
  });
  plan.remove.forEach(function (r) {
    if (outOfTime()) {
      result.postponed++;
      return;
    }
    try {
      r.existing.ref.deleteEvent();
      result.removed++;
    } catch (e) {
      result.errors.push('Could not remove "' + r.existing.title + '" (' + r.existing.date + '): ' + e.message);
    }
    pause_();
  });
  return result;
}

/** Turns on the automatic sync: every syncEveryDays days (around 6 AM) or every syncEveryHours hours. */
function installTrigger_(settings) {
  deleteSyncTriggers_();
  var days = Number(settings.syncEveryDays) || 0;
  var builder = ScriptApp.newTrigger('syncNow').timeBased();
  if (days > 0) builder.everyDays(days).atHour(6).create();
  else builder.everyHours(Number(settings.syncEveryHours)).create();
}

function syncIntervalText_(settings) {
  var days = Number(settings.syncEveryDays) || 0;
  if (days > 0) return days === 1 ? 'every day' : 'every ' + days + ' days';
  var hours = Number(settings.syncEveryHours);
  return hours === 1 ? 'every hour' : 'every ' + hours + ' hours';
}

/** Removes the automatic-sync trigger(s); returns how many there were. */
function deleteSyncTriggers_() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'syncNow') {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  });
  return removed;
}
