/**
 * Blackbaud → Google Calendar
 * Puts your Blackbaud tests, quizzes, essays and major projects on Google Calendar.
 *
 * Run these from the Apps Script editor (pick one in the toolbar, then Run):
 *   setup()                 First-time setup: syncs once, then turns on automatic sync.
 *   preview()               Shows what would be synced. Doesn't change your calendar.
 *   syncNow()               Syncs right now. (The automatic sync runs this.)
 *   showFeedSample()        Prints raw details from your feed, for tuning Settings.gs.
 *   restoreDeletedEvents()  Brings back synced events you deleted from the calendar.
 *   stopAutoSync()          Turns the automatic sync off.
 *   removeSyncedEvents()    Deletes every event this tool created.
 *
 * Study planner (turn on with study.enabled in Settings.gs):
 *   makeGradesBookmarklet() Prints the "Send grades" bookmark for your browser.
 *   showGrades()            Shows the grades the planner is using.
 *   checkAi()               Checks your Ollama key and model.
 *   replanStudySessions()   Throws away upcoming study sessions and plans them again.
 *   removeStudySessions()   Deletes every study session this tool made.
 */

var VALID_SYNC_HOURS_ = [1, 2, 4, 6, 8, 12];
var FEED_URL_PROPERTY_ = 'BLACKBAUD_FEED_URL';
// Apps Script stops a run after 6 minutes; stop starting new work well before.
var MAX_RUN_MILLIS_ = 4.5 * 60 * 1000;

function setup() {
  var settings = loadSettings_();
  var summary = runSync_({ dryRun: false });
  if (!summary) {
    console.warn("Setup didn't finish (see the message above), so automatic sync is not on yet.");
    return;
  }
  installTrigger_(settings.syncEveryHours);
  console.log(
    'All set! Your calendar "' + settings.calendarName + '" will update automatically every ' +
      settings.syncEveryHours + ' hour(s).'
  );
}

function syncNow() {
  return runSync_({ dryRun: false });
}

function preview() {
  return runSync_({ dryRun: true });
}

function stopAutoSync() {
  var removed = deleteSyncTriggers_();
  console.log(removed ? 'Automatic sync is off.' : 'Automatic sync was already off.');
}

function restoreDeletedEvents() {
  clearSyncedState_();
  console.log('Forgot which events you deleted; syncing now to bring them back.');
  return syncNow();
}

function removeSyncedEvents() {
  var settings = loadSettings_();
  var tz = timeZoneOf_(settings);
  var calendar = findCalendar_(settings);
  if (!calendar) {
    console.log('No calendar named "' + settings.calendarName + '", so there is nothing to remove.');
    return;
  }
  var deadline = Date.now() + MAX_RUN_MILLIS_;
  var today = wallClockInZone_(new Date(), tz).date;
  var events = listToolEvents_(calendar, addDays_(today, -730), addDays_(today, 730), tz);
  var removed = 0;
  events.forEach(function (ev) {
    if (Date.now() > deadline) return;
    ev.ref.deleteEvent();
    removed++;
    pause_();
  });
  clearSyncedState_();
  console.log('Removed ' + removed + ' synced event(s).');
  if (removed < events.length) console.log('Ran out of time; run removeSyncedEvents() again to finish.');
  if (ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'syncNow'; })) {
    console.log('Automatic sync is still on and will add them again. Run stopAutoSync() to turn it off.');
  }
}

function showFeedSample() {
  var settings = loadSettings_();
  var tz = timeZoneOf_(settings);
  var raw = parseIcs_(fetchFeedText_(settings));
  var items = raw.map(function (ev) {
    return icsEventToItem_(ev, tz);
  });
  var propertyCounts = {};
  raw.forEach(function (ev) {
    Object.keys(ev).forEach(function (name) {
      propertyCounts[name] = (propertyCounts[name] || 0) + 1;
    });
  });
  var typeCounts = {};
  items.forEach(function (item) {
    item.categories.forEach(function (c) {
      typeCounts[c] = (typeCounts[c] || 0) + 1;
    });
  });
  var today = wallClockInZone_(new Date(), tz).date;
  var upcoming = items
    .filter(function (item) {
      return item.start && item.start.date >= today;
    })
    .sort(function (a, b) {
      return a.start.date < b.start.date ? -1 : a.start.date > b.start.date ? 1 : 0;
    })
    .slice(0, 10);
  var lines = [
    'The feed has ' + raw.length + ' events.',
    'Fields seen (and how many events have them): ' + formatCounts_(propertyCounts),
    'Blackbaud types (CATEGORIES) seen: ' + (Object.keys(typeCounts).length ? formatCounts_(typeCounts) : 'none'),
    '',
    'Next ' + upcoming.length + ' events:',
  ];
  upcoming.forEach(function (item) {
    lines.push(
      '- SUMMARY: ' + item.summary,
      '  starts: ' + formatWhen_(item.start) + '   ends: ' + (item.end ? formatWhen_(item.end) : '(none)'),
      '  types: ' + (item.categories.join(', ') || '(none)'),
      '  description: ' + (truncate_(item.description.replace(/\s+/g, ' '), 160) || '(none)')
    );
  });
  console.log(lines.join('\n'));
}

// ---------------------------------------------------------------------------

/** Settings.gs merged over the defaults, checked for mistakes. */
function loadSettings_() {
  var settings = mergeDeep_(DEFAULTS_, typeof SETTINGS === 'undefined' ? {} : SETTINGS);
  var fromProperty = PropertiesService.getScriptProperties().getProperty(FEED_URL_PROPERTY_);
  if (fromProperty) settings.feedUrl = fromProperty;
  var problems = settingsProblems_(settings);
  if (problems.length) throw new Error('Please fix Settings.gs:\n- ' + problems.join('\n- '));
  return settings;
}

/** Human-readable problems with the settings (empty if all good). */
function settingsProblems_(s) {
  var problems = [];
  var url = String(s.feedUrl || '').trim();
  if (!url || /PASTE/i.test(url)) {
    problems.push('feedUrl: paste your Blackbaud calendar feed link (see the README, step 1).');
  } else if (!/^(webcals?|https?):\/\//i.test(url)) {
    problems.push('feedUrl should start with webcal:// or https://');
  }
  if (!String(s.calendarName || '').trim()) problems.push('calendarName must not be empty.');
  if (VALID_SYNC_HOURS_.indexOf(Number(s.syncEveryHours)) === -1) {
    problems.push('syncEveryHours must be one of ' + VALID_SYNC_HOURS_.join(', ') + '.');
  }
  ['lookbackDays', 'lookaheadDays'].forEach(function (key) {
    var n = Number(s[key]);
    if (!(n >= 0 && n <= 400)) problems.push(key + ' must be a number of days from 0 to 400.');
  });
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(s.reminderTime))) {
    problems.push("reminderTime must be a 24-hour time like '16:00'.");
  }
  if (s.dueDateFrom !== 'start' && s.dueDateFrom !== 'end') problems.push("dueDateFrom must be 'start' or 'end'.");
  if (s.titlePattern) {
    try {
      new RegExp(s.titlePattern);
    } catch (e) {
      problems.push('titlePattern is not a valid regular expression: ' + e.message);
    }
  }
  ['excludeKeywords', 'extraExcludeKeywords', 'excludeTypes'].forEach(function (key) {
    if (!Array.isArray(s[key])) problems.push(key + " must be a list like ['word', 'another phrase'].");
  });
  studySettingsProblems_(s, problems);
  Object.keys(s.categories || {}).forEach(function (key) {
    var c = s.categories[key];
    var where = 'categories.' + key;
    if (!isPlainObject_(c)) {
      problems.push(where + ' must be written like { enabled: false }.');
      return;
    }
    if (colorId_(c.color) === null) {
      problems.push(where + '.color "' + c.color + '" is not a color I know (try red, orange, yellow, green, blue, purple, pink, cyan or gray).');
    }
    ['keywords', 'extraKeywords', 'remindDaysBefore'].forEach(function (list) {
      if (c[list] !== undefined && !Array.isArray(c[list])) problems.push(where + '.' + list + ' must be a list in [square brackets].');
    });
  });
  return problems;
}

function numberBetween_(value, min, max) {
  var n = Number(value);
  return typeof value !== 'boolean' && value !== '' && value !== null && n >= min && n <= max;
}

/** Adds problems with the study and ai settings to `problems`. */
function studySettingsProblems_(s, problems) {
  var study = s.study;
  var ai = s.ai;
  if (!isPlainObject_(study) || !isPlainObject_(ai)) {
    problems.push('study and ai must be written like { enabled: true }.');
    return;
  }
  if (!String(study.calendarName || '').trim()) problems.push('study.calendarName must not be empty.');
  if (!isPlainObject_(study.hours)) {
    problems.push("study.hours must look like { weekdays: '16:00-21:00', weekends: '10:00-18:00' }.");
  } else {
    Object.keys(study.hours).forEach(function (day) {
      if (['weekdays', 'weekends'].concat(WEEKDAY_KEYS_).indexOf(day) === -1) {
        problems.push('study.hours.' + day + ' is not a day I know (use weekdays, weekends, or mon to sun).');
      } else if (parseHourRanges_(study.hours[day]) === null) {
        problems.push("study.hours." + day + " must look like '16:00-21:00' (or '' for none).");
      }
    });
  }
  [
    ['sessionMinutes', 15, 240],
    ['maxMinutesPerDay', 15, 720],
    ['breakMinutes', 0, 120],
    ['maxSessionsPerAssessment', 1, 30],
    ['reminderMinutes', 0, 1440],
    ['targetGrade', 0, 150],
  ].forEach(function (rule) {
    if (!numberBetween_(study[rule[0]], rule[1], rule[2])) {
      problems.push('study.' + rule[0] + ' must be a number from ' + rule[1] + ' to ' + rule[2] + '.');
    }
  });
  if (numberBetween_(study.maxMinutesPerDay, 0, 720) && Number(study.maxMinutesPerDay) < Number(study.sessionMinutes)) {
    problems.push('study.maxMinutesPerDay must be at least study.sessionMinutes.');
  }
  if (colorId_(study.color) === null) problems.push('study.color "' + study.color + '" is not a color I know.');
  if (!Array.isArray(study.busyCalendars)) problems.push("study.busyCalendars must be a list like ['Soccer'].");
  if (!isPlainObject_(study.grades)) {
    problems.push("study.grades must look like { 'AP Biology': 84 }.");
  } else {
    Object.keys(study.grades).forEach(function (name) {
      if (!numberBetween_(study.grades[name], 0, 150)) problems.push('study.grades["' + name + '"] must be a number like 84.');
    });
  }
  if (study.webAppUrl && !/^https:\/\/script\.google\.com\/.+\/exec$/.test(String(study.webAppUrl).trim())) {
    problems.push('study.webAppUrl should be the Web app URL from Deploy, ending in /exec.');
  }
  var kinds = isPlainObject_(study.kinds) ? study.kinds : {};
  if (!isPlainObject_(study.kinds)) problems.push('study.kinds must look like { test: { minutes: 180 } }.');
  var kindEntries = Object.keys(kinds).map(function (name) {
    return ['study.kinds.' + name, kinds[name]];
  });
  kindEntries.push(['study.defaultKind', study.defaultKind]);
  kindEntries.forEach(function (entry) {
    var where = entry[0];
    var kind = entry[1];
    if (!isPlainObject_(kind)) {
      problems.push(where + ' must look like { minutes: 180, daysAhead: 10 }.');
      return;
    }
    if (kind.minutes !== undefined && !numberBetween_(kind.minutes, 0, 3000)) problems.push(where + '.minutes must be a number of minutes.');
    if (kind.daysAhead !== undefined && !numberBetween_(kind.daysAhead, 0, 30)) problems.push(where + '.daysAhead must be from 0 to 30.');
    if (kind.spacing !== undefined && kind.spacing !== 'spaced' && kind.spacing !== 'even') {
      problems.push(where + ".spacing must be 'spaced' or 'even'.");
    }
  });
  if (!/^https?:\/\/\S+$/.test(String(ai.baseUrl || ''))) problems.push('ai.baseUrl must be a web address like https://ollama.com.');
  if (!String(ai.model || '').trim()) problems.push("ai.model must name a model, like 'gpt-oss:20b'.");
  if (!numberBetween_(ai.maxPerRun, 1, 20)) problems.push('ai.maxPerRun must be a number from 1 to 20.');
}

function timeZoneOf_(settings) {
  return settings.timeZone || Session.getScriptTimeZone();
}

/** Blackbaud hands out webcal:// links; Apps Script needs https://. */
function normalizeFeedUrl_(url) {
  return String(url).trim().replace(/^webcals?:\/\//i, 'https://');
}

/** Removes the feed link (which works like a password) from a message. */
function redactFeedUrl_(message, feedUrl) {
  var text = String(message);
  [String(feedUrl).trim(), normalizeFeedUrl_(feedUrl)].forEach(function (url) {
    if (url) text = text.split(url).join('<your feed link>');
  });
  return text.replace(/([?&]z=)[^&\s"')]+/gi, '$1…');
}

function fetchFeedText_(settings) {
  // Errors never include the link itself: it works like a password.
  var response;
  try {
    response = UrlFetchApp.fetch(normalizeFeedUrl_(settings.feedUrl), {
      muteHttpExceptions: true,
      followRedirects: true,
    });
  } catch (e) {
    throw new Error("Couldn't reach the Blackbaud feed: " + redactFeedUrl_(e.message, settings.feedUrl));
  }
  var code = response.getResponseCode();
  if (code !== 200) {
    throw new Error(
      'Blackbaud answered the feed link with HTTP ' + code + '. Copy the feed link from Blackbaud again and update feedUrl.'
    );
  }
  var text = response.getContentText('UTF-8');
  if (text.indexOf('BEGIN:VCALENDAR') === -1) {
    throw new Error(
      "The feed link didn't return a calendar (it may have expired or lead to a sign-in page). " +
        'Copy the feed link from Blackbaud again and update feedUrl.'
    );
  }
  return text;
}

/** One full sync (or a dry run). Returns a summary, or null if it didn't run. */
function runSync_(opts) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    console.warn('Another sync is already running. Try again in a minute.');
    return null;
  }
  try {
    var started = Date.now();
    var settings = loadSettings_();
    var tz = timeZoneOf_(settings);
    var today = wallClockInZone_(new Date(), tz).date;
    var win = syncWindow_(today, settings);

    var items = readFeed_(fetchFeedText_(settings), tz);
    if (!items.length) {
      // Better safe than sorry: a broken feed must not wipe the calendar.
      console.warn('The Blackbaud feed has no events right now, so nothing was changed.');
      return null;
    }
    var decisions = classifyItems_(items, settings, win);
    var desired = desiredEvents_(decisions, settings);
    logDecisions_(decisions, items.length, win, settings, opts.dryRun);

    var calendar = opts.dryRun ? findCalendar_(settings) : getOrCreateCalendar_(settings);
    var existing = calendar ? listManagedEvents_(calendar, win, tz) : [];
    var plan = planSync_(desired, existing, win, {
      deleteRemoved: settings.deleteRemoved,
      synced: loadSyncedState_(calendar),
    });
    logPlan_(plan, opts.dryRun);
    var summary = {
      toCreate: plan.create.length,
      toUpdate: plan.update.length,
      toRemove: plan.remove.length,
      unchanged: plan.unchanged.length,
      keptDeleted: plan.keptDeleted.length,
    };
    if (opts.dryRun) {
      if (settings.study.enabled) runStudySafely_(settings, plan, tz, { dryRun: true }, []);
      console.log('This was a preview: your calendars were not changed. Run syncNow() or setup() to apply it.');
      return summary;
    }

    var result = applyPlan_(calendar, plan, tz, started + MAX_RUN_MILLIS_);
    saveSyncedState_(calendar, nextSyncedState_(plan, result.retryIds));
    console.log(
      'Done: ' + result.created + ' added, ' + result.updated + ' updated, ' + result.removed + ' removed.' +
        (result.postponed ? ' ' + result.postponed + ' change(s) left for the next sync (ran out of time).' : '')
    );
    var errors = result.errors.slice();
    if (settings.study.enabled) {
      summary.study = runStudySafely_(settings, plan, tz, { dryRun: false, deadline: started + MAX_RUN_MILLIS_ }, errors);
    }
    if (errors.length) {
      console.error(errors.join('\n'));
      throw new Error(errors.length + ' calendar change(s) failed (details above). They will be retried on the next sync.');
    }
    summary.created = result.created;
    summary.updated = result.updated;
    summary.removed = result.removed;
    return summary;
  } finally {
    lock.releaseLock();
  }
}

/** Runs the study planner; its problems are added to `errors` instead of stopping the sync. */
function runStudySafely_(settings, syncPlan, tz, opts, errors) {
  try {
    var result = runStudy_(settings, syncPlan, tz, opts);
    Array.prototype.push.apply(errors, result.errors);
    return result;
  } catch (e) {
    console.error('Study plan: ' + e.message);
    errors.push('Study plan: ' + e.message);
    return null;
  }
}

function logDecisions_(decisions, feedCount, win, settings, verbose) {
  var included = decisions.filter(function (d) {
    return d.result.include;
  });
  var skipped = decisions.filter(function (d) {
    return !d.result.include;
  });
  var lines = [
    'Blackbaud feed: ' + feedCount + ' events, ' + decisions.length + ' due between ' + win.start + ' and ' + win.end + '.',
    included.length + ' look like assessments or major projects' + (included.length ? ':' : '.'),
  ];
  included.forEach(function (d) {
    lines.push('  ' + formatWhen_(d.item.due) + '  ' + padRight_(d.result.category, 12) + d.item.summary + '   [' + d.result.reason + ']');
  });
  if (verbose && skipped.length) {
    var limit = Number(settings.previewSkippedLimit) || 0;
    lines.push('', skipped.length + ' skipped' + (skipped.length > limit ? ' (showing the first ' + limit + ')' : '') + ':');
    skipped.slice(0, limit).forEach(function (d) {
      lines.push('  ' + formatWhen_(d.item.due) + '  ' + d.item.summary + '   [' + d.result.reason + ']');
    });
  } else if (skipped.length) {
    lines.push(skipped.length + ' other events skipped (run preview() to see them).');
  }
  console.log(lines.join('\n'));
}

function logPlan_(plan, verbose) {
  var lines = [
    'Calendar: ' + plan.create.length + ' to add, ' + plan.update.length + ' to update, ' + plan.remove.length +
      ' to remove, ' + plan.unchanged.length + ' already up to date' +
      (plan.keptDeleted.length ? ', ' + plan.keptDeleted.length + ' you deleted (left deleted)' : '') + '.',
  ];
  if (verbose) {
    plan.create.forEach(function (d) {
      lines.push('  + ' + d.date + '  ' + d.title);
    });
    plan.update.forEach(function (u) {
      lines.push('  ~ ' + u.desired.date + '  ' + u.desired.title);
    });
    plan.remove.forEach(function (r) {
      lines.push('  - ' + r.existing.date + '  ' + r.existing.title + '   [' + r.reason + ']');
    });
  }
  console.log(lines.join('\n'));
}

function formatWhen_(when) {
  return when.date + (when.time ? ' ' + when.time : '      ');
}

function formatCounts_(counts) {
  return Object.keys(counts)
    .sort(function (a, b) {
      return counts[b] - counts[a];
    })
    .map(function (k) {
      return k + ' (' + counts[k] + ')';
    })
    .join(', ');
}

function padRight_(s, width) {
  s = String(s);
  return s.length >= width ? s + ' ' : s + new Array(width - s.length + 1).join(' ');
}
