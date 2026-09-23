/**
 * Study plan: gathers the synced assessments, your grades, AI advice and
 * your busy times, runs the planner (Planner.js) and keeps the "Study Plan"
 * calendar in step. Runs after every sync when study.enabled is true.
 *
 * Study sessions carry the tags b2c_id ("study:..."), b2c_for (the
 * assessment), b2c_planned (the start time the planner chose, to notice when
 * you move a session) and b2c_hash.
 */

var TAG_STUDY_FOR_ = 'b2c_for';
var TAG_PLANNED_ = 'b2c_planned';
var PROP_STUDY_CALENDAR_ID_ = 'B2C_STUDY_CALENDAR_ID';
var PROP_STUDY_ = 'B2C_STUDY';
// Sessions are read this far back; deleted ones are remembered a bit less
// (daysAhead is capped at 30, so every current assessment's sessions fit).
var STUDY_HISTORY_DAYS_ = 45;
var STUDY_MEMORY_DAYS_ = 40;

function findStudyCalendar_(settings) {
  return findOwnedCalendar_(settings.study.calendarName, PROP_STUDY_CALENDAR_ID_);
}

function getOrCreateStudyCalendar_(settings) {
  return getOrCreateOwnedCalendar_(
    settings.study.calendarName,
    PROP_STUDY_CALENDAR_ID_,
    'Study sessions planned for your Blackbaud assessments.'
  );
}

function kindLabels_(settings) {
  var labels = {};
  Object.keys(settings.categories).forEach(function (key) {
    labels[key] = settings.categories[key].label || key;
  });
  return labels;
}

/** Planner assessments from a sync plan (leaves out ones you deleted from the calendar). */
function studyAssessments_(syncPlan) {
  var desired = syncPlan.create.concat(
    syncPlan.unchanged,
    syncPlan.update.map(function (u) {
      return u.desired;
    })
  );
  return desired.map(function (d) {
    return {
      id: d.id,
      title: d.source.title,
      course: d.source.course,
      summary: d.source.summary,
      details: d.source.description,
      category: d.category,
      date: d.date,
    };
  });
}

/** This tool's study sessions on `calendar` between two dates. */
function listStudySessions_(calendar, fromDate, toDate, tz) {
  var sessions = [];
  eventsBetween_(calendar, fromDate, toDate, tz).forEach(function (ev) {
    var id = ev.getTag(TAG_ID_);
    if (!id || id.indexOf('study:') !== 0) return;
    var start = ev.getStartTime().getTime();
    var planned = Number(ev.getTag(TAG_PLANNED_));
    sessions.push({
      id: id,
      forId: ev.getTag(TAG_STUDY_FOR_) || '',
      start: start,
      end: ev.getEndTime().getTime(),
      plannedStart: planned ? planned : null,
      hash: ev.getTag(TAG_HASH_) || '',
      title: ev.getTitle(),
      date: wallClockInZone_(new Date(start), tz).date,
      ref: ev,
    });
  });
  return sessions;
}

function isDeclined_(ev) {
  try {
    return CalendarApp.GuestStatus && ev.getMyStatus() === CalendarApp.GuestStatus.NO;
  } catch (e) {
    return false;
  }
}

/** Timed events in your main calendar (and study.busyCalendars): [[startMs, endMs]]. */
function busyIntervals_(settings, fromMs, toMs) {
  var calendars = [CalendarApp.getDefaultCalendar()];
  settings.study.busyCalendars.forEach(function (name) {
    CalendarApp.getCalendarsByName(name).forEach(function (c) {
      calendars.push(c);
    });
  });
  var seen = {};
  var busy = [];
  calendars.forEach(function (calendar) {
    if (!calendar || seen[calendar.getId()]) return;
    seen[calendar.getId()] = true;
    calendar.getEvents(new Date(fromMs), new Date(toMs)).forEach(function (ev) {
      // All-day events (deadlines, holidays) don't block time; our own events are handled separately.
      if (ev.isAllDayEvent() || ev.getTag(TAG_ID_) || isDeclined_(ev)) return;
      busy.push([ev.getStartTime().getTime(), ev.getEndTime().getTime()]);
    });
  });
  return busy;
}

/** {sessionKey: 'date|assessmentKey'} remembered for `calendar` ({} for a new calendar). */
function loadStudyState_(calendar) {
  if (!calendar) return {};
  try {
    var state = JSON.parse(PropertiesService.getScriptProperties().getProperty(PROP_STUDY_) || '{}');
    return state.calendarId === calendar.getId() ? state.s || {} : {};
  } catch (e) {
    return {};
  }
}

function saveStudyState_(calendar, entries) {
  var keys = Object.keys(entries).sort(function (a, b) {
    return entries[a] < entries[b] ? -1 : entries[a] > entries[b] ? 1 : 0;
  });
  var json = JSON.stringify({ calendarId: calendar.getId(), s: entries });
  while (json.length > MAX_STATE_CHARS_ && keys.length) {
    delete entries[keys.shift()];
    json = JSON.stringify({ calendarId: calendar.getId(), s: entries });
  }
  var values = {};
  values[PROP_STUDY_] = json;
  values[PROP_STUDY_CALENDAR_ID_] = calendar.getId();
  PropertiesService.getScriptProperties().setProperties(values);
}

function studyStateEntry_(session, tz) {
  return wallClockInZone_(new Date(session.start), tz).date + '|' + hash_(session.forId);
}

/**
 * Sessions the planner made before that are gone now were deleted by you.
 * Returns {counts: {assessmentId: n}, entries: {sessionKey: entry}} for the
 * ones still worth remembering.
 */
function studyTombstones_(state, sessions, assessments, today) {
  var present = {};
  sessions.forEach(function (s) {
    present[hash_(s.id)] = true;
  });
  var byKey = {};
  assessments.forEach(function (a) {
    byKey[hash_(a.id)] = a.id;
  });
  var oldest = addDays_(today, -STUDY_MEMORY_DAYS_);
  var counts = {};
  var entries = {};
  Object.keys(state).forEach(function (key) {
    if (present[key]) return;
    var parts = String(state[key]).split('|');
    var forId = byKey[parts[1]];
    if (!forId || parts[0] < oldest) return;
    counts[forId] = (counts[forId] || 0) + 1;
    entries[key] = state[key];
  });
  return { counts: counts, entries: entries };
}

function applyStudyPlan_(calendar, plan, settings, deadline) {
  var study = settings.study;
  var color = colorId_(study.color);
  var reminder = Number(study.reminderMinutes);
  var result = { created: [], updated: 0, removed: [], errors: [], postponed: 0 };
  plan.create.forEach(function (s) {
    if (Date.now() > deadline) {
      result.postponed++;
      return;
    }
    try {
      var ev = calendar.createEvent(s.title, new Date(s.start), new Date(s.end), { description: s.description });
      ev.setTag(TAG_ID_, s.id);
      ev.setTag(TAG_STUDY_FOR_, s.forId);
      ev.setTag(TAG_PLANNED_, String(s.start));
      if (color) ev.setColor(color);
      ev.removeAllReminders();
      if (reminder > 0) ev.addPopupReminder(reminder);
      ev.setTag(TAG_HASH_, s.hash);
      result.created.push(s);
    } catch (e) {
      result.errors.push('Could not add study session "' + s.title + '": ' + e.message);
    }
    pause_();
  });
  plan.update.forEach(function (u) {
    if (Date.now() > deadline) {
      result.postponed++;
      return;
    }
    try {
      u.existing.ref.setTitle(u.desired.title);
      u.existing.ref.setDescription(u.desired.description);
      u.existing.ref.setTag(TAG_HASH_, u.desired.hash);
      result.updated++;
    } catch (e) {
      result.errors.push('Could not update study session "' + u.desired.title + '": ' + e.message);
    }
    pause_();
  });
  plan.remove.forEach(function (r) {
    if (Date.now() > deadline) {
      result.postponed++;
      return;
    }
    try {
      r.existing.ref.deleteEvent();
      result.removed.push(r.existing);
    } catch (e) {
      result.errors.push('Could not remove study session "' + r.existing.title + '": ' + e.message);
    }
    pause_();
  });
  return result;
}

/** What to remember after applying: every session still on the calendar, plus deleted ones. */
function nextStudyState_(plan, applied, tombstoneEntries, tz, today) {
  var oldest = addDays_(today, -STUDY_MEMORY_DAYS_);
  var entries = Object.assign({}, tombstoneEntries);
  var removed = applied.removed;
  var onCalendar = plan.keep.concat(
    plan.update.map(function (u) {
      return u.existing;
    }),
    plan.remove
      .map(function (r) {
        return r.existing;
      })
      .filter(function (s) {
        return removed.indexOf(s) === -1;
      }),
    applied.created
  );
  onCalendar.forEach(function (s) {
    if (!s.forId) return;
    var entry = studyStateEntry_(s, tz);
    if (entry.slice(0, 10) >= oldest) entries[hash_(s.id)] = entry;
  });
  return entries;
}

function formatSessionTime_(s, tz) {
  var start = wallClockInZone_(new Date(s.start), tz);
  var end = wallClockInZone_(new Date(s.end), tz);
  return formatHumanDate_(start.date).slice(0, 3) + ' ' + start.date + ' ' + start.time + '–' + end.time;
}

function logStudyPlan_(plan, aiResult, settings, tz, verbose) {
  var lines = ['Study plan for ' + plan.summaries.length + ' upcoming assessment(s):'];
  plan.summaries.forEach(function (s) {
    var why = s.grade ? s.grade.className + ' ' + s.grade.grade + '% → ×' + s.gradeFactor.toFixed(2) : 'no grade';
    if (s.effort !== 'normal') why += ', AI says ' + s.effort;
    var counts = [];
    if (s.done) counts.push(s.done + ' done');
    if (s.kept) counts.push(s.kept + ' planned');
    if (s.created) counts.push(s.created + ' new');
    if (s.deleted) counts.push(s.deleted + ' you deleted');
    lines.push(
      '  ' + s.assessment.date + '  ' + assessmentName_(s.assessment) + ': ' + formatMinutes_(s.minutes) + ', ' +
        s.sessionsWanted + ' session(s) [' + why + ']' + (counts.length ? ' (' + counts.join(', ') + ')' : '')
    );
    if (s.unplaced) {
      lines.push(
        "    ! couldn't fit " + s.unplaced + ' session(s) before the due date. Add study hours or raise maxMinutesPerDay.'
      );
    }
  });
  if (settings.ai.enabled) {
    if (aiResult.asked) lines.push('AI (' + settings.ai.model + ') planned ' + aiResult.asked + ' assessment(s).');
    if (aiResult.waiting && !aiResult.note) lines.push('AI will look at ' + aiResult.waiting + ' more on the next sync.');
    if (aiResult.note) lines.push(aiResult.note);
  }
  lines.push(
    'Study calendar: ' + plan.create.length + ' to add, ' + plan.update.length + ' to update, ' + plan.remove.length +
      ' to remove.'
  );
  if (verbose) {
    var byStart = function (a, b) {
      return a.start - b.start;
    };
    plan.create.slice().sort(byStart).forEach(function (s) {
      lines.push('  + ' + formatSessionTime_(s, tz) + '  ' + s.title);
    });
    plan.update.forEach(function (u) {
      lines.push('  ~ ' + formatSessionTime_(u.existing, tz) + '  ' + u.desired.title);
    });
    plan.remove.forEach(function (r) {
      lines.push('  - ' + formatSessionTime_(r.existing, tz) + '  ' + r.existing.title + '   [' + r.reason + ']');
    });
  }
  console.log(lines.join('\n'));
}

/**
 * Plans (or with opts.dryRun, previews) study sessions for the assessments
 * in `syncPlan`. Returns {created, updated, removed, errors}.
 */
function runStudy_(settings, syncPlan, tz, opts) {
  var now = Date.now();
  var today = wallClockInZone_(new Date(now), tz).date;
  var assessments = studyAssessments_(syncPlan).filter(function (a) {
    return a.date >= today;
  });
  var labels = kindLabels_(settings);
  var aiResult = getStudyAdvice_(assessments, settings, labels);
  var calendar = opts.dryRun ? findStudyCalendar_(settings) : getOrCreateStudyCalendar_(settings);
  var lastDay = addDays_(today, Number(settings.lookaheadDays) + 1);
  var sessions = calendar ? listStudySessions_(calendar, addDays_(today, -STUDY_HISTORY_DAYS_), lastDay, tz) : [];
  var tombstones = studyTombstones_(loadStudyState_(calendar), sessions, assessments, today);
  var plan = planStudy_({
    assessments: assessments,
    sessions: sessions,
    busy: busyIntervals_(settings, now, zonedWallTimeToInstant_(lastDay, '00:00', tz).getTime()),
    tombstones: tombstones.counts,
    gradeOf: buildGradeLookup_(gradeRecords_(settings)),
    advice: aiResult.advice,
    study: settings.study,
    kindLabels: labels,
    now: now,
    today: today,
    tz: tz,
  });
  logStudyPlan_(plan, aiResult, settings, tz, opts.dryRun);
  if (opts.dryRun) return { created: 0, updated: 0, removed: 0, errors: [] };

  var applied = applyStudyPlan_(calendar, plan, settings, opts.deadline);
  saveStudyState_(calendar, nextStudyState_(plan, applied, tombstones.entries, tz, today));
  console.log(
    'Study sessions: ' + applied.created.length + ' added, ' + applied.updated + ' updated, ' + applied.removed.length +
      ' removed.' + (applied.postponed ? ' ' + applied.postponed + ' left for the next sync (ran out of time).' : '')
  );
  return {
    created: applied.created.length,
    updated: applied.updated,
    removed: applied.removed.length,
    errors: applied.errors,
  };
}

// --- Functions you can run --------------------------------------------------

/** Prints the grades the planner knows about. */
function showGrades() {
  var settings = loadSettings_();
  var stored = storedGrades_();
  var lines = [];
  if (stored && stored.classes && stored.classes.length) {
    lines.push('From the bookmark (' + stored.receivedAt + '):');
    stored.classes.forEach(function (c) {
      lines.push('  ' + c.name + ': ' + c.grade + '%');
    });
  } else {
    lines.push('Nothing from the grades bookmark yet. Run makeGradesBookmarklet() to set it up.');
  }
  var typed = Object.keys(settings.study.grades || {});
  if (typed.length) {
    lines.push('Typed into Settings.gs (these win):');
    typed.forEach(function (name) {
      lines.push('  ' + name + ': ' + settings.study.grades[name] + '%');
    });
  }
  lines.push('', 'Run preview() to see which grade each assessment uses.');
  console.log(lines.join('\n'));
}

/** Prints the "Send grades" bookmark to add to your browser. */
function makeGradesBookmarklet() {
  var settings = loadSettings_();
  var code = gradesBookmarkletCode_(webAppUrl_(settings), gradesToken_());
  console.log(
    [
      'Your "Send grades" bookmark is ready. To add it:',
      '1. Show your bookmarks bar (Ctrl+Shift+B, or Cmd+Shift+B on a Mac).',
      '2. Right-click the bar and choose "Add page..." (Chrome/Edge) or "Add Bookmark..." (Firefox).',
      '3. Name it "Send grades". For the URL, copy the whole next line (it starts with javascript:).',
      '',
      code,
      '',
      'Then open Blackbaud, sign in, and click the bookmark. Keep it private: it can update your grades.',
    ].join('\n')
  );
}

/** Checks the Ollama key and model, and shows a sample answer. */
function checkAi() {
  var settings = loadSettings_();
  var ai = settings.ai;
  var apiKey = PropertiesService.getScriptProperties().getProperty(OLLAMA_KEY_PROPERTY_);
  if (!apiKey && isOllamaCloud_(ai.baseUrl)) {
    console.log('No OLLAMA_API_KEY yet. Add it in Project Settings → Script properties (see the README).');
    return;
  }
  var tags = ollamaFetch_(ai, apiKey, '/api/tags');
  var names = ((tags && tags.models) || []).map(function (m) {
    return m.name || m.model;
  });
  console.log('Models you can use (' + names.length + '): ' + names.join(', '));
  if (names.length && names.indexOf(ai.model) === -1) {
    console.warn('Your ai.model "' + ai.model + '" is not in that list. Pick one of them for ai.model in Settings.gs.');
  }
  var sample = askOllamaForAdvice_(
    [{ input: { kind: 'Test', class: 'Biology', title: 'Unit 3 Test', due: '2026-10-01', details: 'Cell membranes, transport, osmosis.' } }],
    ai,
    apiKey
  );
  console.log('Sample answer from ' + ai.model + ': ' + JSON.stringify(sample.a1 || sample));
  console.log('The AI is working.');
}

/** Deletes upcoming study sessions and plans them again from scratch. */
function replanStudySessions() {
  var settings = loadSettings_();
  var tz = timeZoneOf_(settings);
  var calendar = findStudyCalendar_(settings);
  var removed = 0;
  if (calendar) {
    var now = Date.now();
    var today = wallClockInZone_(new Date(now), tz).date;
    listStudySessions_(calendar, today, addDays_(today, Number(settings.lookaheadDays) + 1), tz).forEach(function (s) {
      if (s.start > now) {
        s.ref.deleteEvent();
        removed++;
        pause_();
      }
    });
  }
  PropertiesService.getScriptProperties().deleteProperty(PROP_STUDY_);
  console.log('Removed ' + removed + ' upcoming study session(s). Planning again now.');
  return syncNow();
}

/** Deletes every study session this tool made. */
function removeStudySessions() {
  var settings = loadSettings_();
  var tz = timeZoneOf_(settings);
  var calendar = findStudyCalendar_(settings);
  var removed = 0;
  if (calendar) {
    var today = wallClockInZone_(new Date(), tz).date;
    listStudySessions_(calendar, addDays_(today, -730), addDays_(today, 730), tz).forEach(function (s) {
      s.ref.deleteEvent();
      removed++;
      pause_();
    });
  }
  PropertiesService.getScriptProperties().deleteProperty(PROP_STUDY_);
  console.log('Removed ' + removed + ' study session(s).');
  if (settings.study.enabled) console.log('The planner is still on. Set study.enabled to false in Settings.gs to stop it.');
}
