/**
 * Study planner: decides how much to study for each upcoming assessment and
 * when. Pure logic, no Google services.
 *
 * How much: the kind's usual study time (study.kinds) × a grade factor (more
 * time when your grade in that class is below study.targetGrade) × the AI's
 * effort estimate, split into sessions of study.sessionMinutes.
 *
 * When: on the days before the due date (up to daysAhead days), inside your
 * study hours, around busy events, and never more than maxMinutesPerDay a
 * day. Tests and quizzes are "spaced" (sessions bunch up closer to the test);
 * projects and essays are spread "even"ly.
 *
 * Sessions already on the calendar are kept where they are, so the plan
 * doesn't reshuffle every sync. Sessions you moved stay where you put them;
 * sessions you deleted aren't added back.
 */

var EFFORT_FACTORS_ = { light: 0.75, normal: 1, heavy: 1.3 };
var WEEKDAY_KEYS_ = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
// Days before the due date to aim for with "spaced" study, in order.
var SPACED_OFFSETS_ = [1, 2, 4, 7, 11, 16, 22, 29, 37, 46];
// Don't start a new session less than this long from now.
var SESSION_LEAD_MINUTES_ = 30;
var SLOT_STEP_MINUTES_ = 15;

/** '16:00-21:00, 7:00-7:45' -> [[960, 1260], [420, 465]]; '' -> []; null if invalid. */
function parseHourRanges_(text) {
  var spec = String(text === undefined || text === null ? '' : text).trim();
  if (!spec || /^(none|off|-)$/i.test(spec)) return [];
  var ranges = [];
  var parts = spec.split(',');
  for (var i = 0; i < parts.length; i++) {
    var m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(parts[i]);
    if (!m) return null;
    var start = +m[1] * 60 + +m[2];
    var end = +m[3] * 60 + +m[4];
    if (+m[2] > 59 || +m[4] > 59 || start >= end || end > 24 * 60) return null;
    ranges.push([start, end]);
  }
  return ranges.sort(function (a, b) {
    return a[0] - b[0];
  });
}

function dayOfWeek_(date) {
  var p = date.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
}

/** Study windows for a date: [[startMinute, endMinute]]. Day keys (mon..sun) beat weekdays/weekends. */
function studyWindowsFor_(date, hours) {
  var weekday = dayOfWeek_(date);
  var key = WEEKDAY_KEYS_[weekday];
  var spec = hours[key] !== undefined ? hours[key] : weekday === 0 || weekday === 6 ? hours.weekends : hours.weekdays;
  return parseHourRanges_(spec) || [];
}

function minutesToTime_(minutes) {
  return pad2_(Math.floor(minutes / 60)) + ':' + pad2_(minutes % 60);
}

/** 1× at the target grade; 5 points below it adds 25%. Limited to 0.6×–2×. */
function gradeFactor_(grade, targetGrade) {
  if (typeof grade !== 'number' || !isFinite(grade)) return 1;
  return Math.min(2, Math.max(0.6, 1 + (Number(targetGrade) - grade) / 20));
}

/** 'h m' text for minutes: 270 -> '4h 30m', 45 -> '45m', 120 -> '2h'. */
function formatMinutes_(minutes) {
  var m = Math.round(minutes);
  var h = Math.floor(m / 60);
  var rest = m % 60;
  if (!h) return rest + 'm';
  return rest ? h + 'h ' + rest + 'm' : h + 'h';
}

/** The study settings for an assessment kind (falls back to study.defaultKind). */
function studyKind_(study, category) {
  return mergeDeep_(study.defaultKind, (study.kinds || {})[category] || {});
}

function listDays_(from, to) {
  var days = [];
  for (var d = from; d <= to; d = addDays_(d, 1)) days.push(d);
  return days;
}

/**
 * The order in which to try days for new sessions. "spaced" aims for 1, 2,
 * 4, 7, ... days before the due date; "even" spreads `need` sessions evenly
 * over the free days. Every day in `days` appears once.
 */
function preferredDays_(spacing, days, need, dueDate, usedDays) {
  var inRange = {};
  days.forEach(function (d) {
    inRange[d] = true;
  });
  var order = [];
  function add(d) {
    if (inRange[d] && order.indexOf(d) === -1) order.push(d);
  }
  if (spacing === 'even') {
    var free = days.filter(function (d) {
      return !usedDays[d];
    });
    for (var i = 0; i < need && free.length; i++) {
      add(free[Math.min(free.length - 1, Math.floor(((i + 0.5) * free.length) / need))]);
    }
  } else {
    SPACED_OFFSETS_.forEach(function (offset) {
      add(addDays_(dueDate, -offset));
    });
  }
  // Then everything else, latest first.
  days.slice().reverse().forEach(add);
  return order;
}

function overlapsAny_(intervals, start, end) {
  for (var i = 0; i < intervals.length; i++) {
    if (intervals[i][0] < end && intervals[i][1] > start) return true;
  }
  return false;
}

/**
 * The first free slot of `minutes` on `date` inside `windows`, starting no
 * earlier than `earliest` (ms) and at least `breakMinutes` away from anything
 * in `occupied` ([[startMs, endMs]]). Returns {start, end} in ms, or null.
 */
function findSlot_(date, windows, occupied, minutes, breakMinutes, earliest, tz, instantCache) {
  var length = minutes * 60000;
  var gap = breakMinutes * 60000;
  for (var w = 0; w < windows.length; w++) {
    var from = windows[w][0];
    var to = windows[w][1];
    var cacheKey = date + ' ' + from;
    var base = instantCache[cacheKey];
    if (base === undefined) {
      base = instantCache[cacheKey] = zonedWallTimeToInstant_(date, minutesToTime_(from), tz).getTime();
    }
    for (var t = from; t + minutes <= to; t += SLOT_STEP_MINUTES_) {
      var start = base + (t - from) * 60000;
      if (start < earliest) continue;
      if (!overlapsAny_(occupied, start - gap, start + length + gap)) return { start: start, end: start + length };
    }
  }
  return null;
}

function assessmentName_(a) {
  return a.title + (a.course ? ' (' + a.course + ')' : '');
}

/** Title and description for session `k` (0-based) of `total` for assessment `a`. */
function sessionContent_(a, info, k, total, study) {
  var steps = (info.advice && info.advice.steps) || [];
  var focus = steps.length ? steps[Math.min(steps.length - 1, Math.floor((k * steps.length) / total))] : '';
  var name = assessmentName_(a);
  var title = (study.icon ? study.icon + ' ' : '') + (focus ? name + ': ' + focus : 'Study for ' + name);
  var why = ['Usual study time (' + info.kindLabel.toLowerCase() + '): ' + formatMinutes_(info.baseMinutes) + '.'];
  if (info.grade) {
    why.push(
      'Your grade in ' + info.grade.className + ' is ' + info.grade.grade + '%, so it gets ' +
        info.gradeFactor.toFixed(2).replace(/\.?0+$/, '') + '× that.'
    );
  } else {
    why.push('No grade found for this class, so it gets the usual time.');
  }
  if (info.effort !== 'normal') why.push('The AI rated it ' + info.effort + ' (' + EFFORT_FACTORS_[info.effort] + '×).');
  why.push('Plan: about ' + formatMinutes_(info.minutes) + ' in ' + info.sessionsWanted + ' session(s).');
  var lines = ['Session ' + (k + 1) + ' of ' + total + ' for ' + name + ', due ' + formatHumanDate_(a.date) + '.'];
  if (focus) lines.push('Focus: ' + focus);
  lines.push('', why.join(' '), '', '(Planned by Blackbaud → Google Calendar. Move this session and it stays put; delete it to skip it.)');
  var description = lines.join('\n');
  return { title: title, description: description, hash: hash_(JSON.stringify([title, description])) };
}

/**
 * Plans study sessions.
 *
 * input = {
 *   assessments: [{id, title, course, category, date, ...}]  (synced assessments)
 *   sessions: [{id, forId, start, end, plannedStart, hash, ...}]  (existing, ms)
 *   busy: [[startMs, endMs]]            (other calendars' timed events)
 *   tombstones: {assessmentId: count}   (sessions the user deleted)
 *   gradeOf: function (assessment) -> {className, grade} | null
 *   advice: {assessmentId: {effort, steps}}   (from the AI, optional)
 *   study, kindLabels, now (ms), today ('YYYY-MM-DD'), tz
 * }
 *
 * Returns {create: [session], update: [{existing, desired}],
 *          remove: [{existing, reason}], keep: [session],
 *          summaries: [{assessment, ...info, done, kept, created, deleted, unplaced}]}.
 * New sessions look like {id, forId, date, start, end, title, description, hash}.
 */
function planStudy_(input) {
  var study = input.study;
  var now = input.now;
  var tz = input.tz;
  var plan = { create: [], update: [], remove: [], keep: [], summaries: [] };
  var instantCache = {};
  var earliest = now + SESSION_LEAD_MINUTES_ * 60000;

  var assessments = input.assessments
    .filter(function (a) {
      return a.date >= input.today;
    })
    .sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  var byId = {};
  assessments.forEach(function (a) {
    byId[a.id] = a;
  });

  // Sessions whose assessment is gone: drop the future ones, keep the history.
  var sessionsFor = {};
  var occupied = input.busy.slice();
  var dayMinutes = {};
  function book(session) {
    occupied.push([session.start, session.end]);
    var date = wallClockInZone_(new Date(session.start), tz).date;
    dayMinutes[date] = (dayMinutes[date] || 0) + (session.end - session.start) / 60000;
  }
  input.sessions.forEach(function (s) {
    if (byId[s.forId]) {
      (sessionsFor[s.forId] = sessionsFor[s.forId] || []).push(s);
    } else if (s.end > now) {
      plan.remove.push({ existing: s, reason: 'its assessment is no longer coming up' });
    }
  });

  // First pass: decide which existing sessions stay, so every kept session
  // blocks its time before anything new is placed.
  var decided = assessments.map(function (a) {
    var kind = studyKind_(study, a.category);
    var grade = input.gradeOf(a);
    var advice = (input.advice || {})[a.id] || null;
    var effort = advice && EFFORT_FACTORS_[advice.effort] ? advice.effort : 'normal';
    var gradeFactor = gradeFactor_(grade && grade.grade, study.targetGrade);
    var minutes = Number(kind.minutes) * gradeFactor * EFFORT_FACTORS_[effort];
    var wanted = Math.max(1, Math.min(Number(study.maxSessionsPerAssessment), Math.round(minutes / Number(study.sessionMinutes))));
    var info = {
      kind: kind,
      kindLabel: (input.kindLabels || {})[a.category] || a.category,
      baseMinutes: Number(kind.minutes),
      grade: grade,
      gradeFactor: gradeFactor,
      advice: advice,
      effort: effort,
      minutes: minutes,
      sessionsWanted: wanted,
    };

    var existing = (sessionsFor[a.id] || []).slice().sort(function (x, y) {
      return x.start - y.start;
    });
    var done = [];
    var kept = [];
    existing.forEach(function (s) {
      var date = wallClockInZone_(new Date(s.start), tz).date;
      var movedByUser = s.plannedStart !== undefined && s.plannedStart !== null && s.plannedStart !== s.start;
      if (s.end <= now) {
        done.push(s);
      } else if (date > a.date) {
        plan.remove.push({ existing: s, reason: 'it is after the due date' });
      } else if (!movedByUser && (date === a.date || overlapsAny_(input.busy, s.start, s.end))) {
        plan.remove.push({ existing: s, reason: date === a.date ? 'the due date moved' : 'something else is scheduled then' });
      } else {
        kept.push(s);
      }
    });
    var deleted = (input.tombstones || {})[a.id] || 0;
    var extra = done.length + kept.length + deleted - wanted;
    while (extra > 0 && kept.length) {
      plan.remove.push({ existing: kept.shift(), reason: 'fewer sessions are needed now' });
      extra--;
    }
    kept.forEach(book);
    done.forEach(book);
    return { a: a, info: info, done: done, kept: kept, deleted: deleted, created: [], unplaced: 0 };
  });

  // Second pass: place new sessions, earliest due date first.
  decided.forEach(function (d) {
    var a = d.a;
    var kind = d.info.kind;
    var need = d.info.sessionsWanted - d.done.length - d.kept.length - d.deleted;
    // Nothing can be added for something due today.
    if (need <= 0 || a.date === input.today) return;
    var from = addDays_(a.date, -Number(kind.daysAhead));
    if (from < input.today) from = input.today;
    var to = addDays_(a.date, -1);
    var days = from <= to ? listDays_(from, to) : [];
    var used = {};
    d.done.concat(d.kept).forEach(function (s) {
      used[wallClockInZone_(new Date(s.start), tz).date] = true;
    });
    var order = preferredDays_(kind.spacing, days, need, a.date, used);
    var length = Number(study.sessionMinutes);
    for (var n = 0; n < need; n++) {
      var slot = null;
      for (var pass = 0; pass < 2 && !slot; pass++) {
        for (var i = 0; i < order.length && !slot; i++) {
          var day = order[i];
          if (pass === 0 && used[day]) continue;
          if ((dayMinutes[day] || 0) + length > Number(study.maxMinutesPerDay)) continue;
          slot = findSlot_(day, studyWindowsFor_(day, study.hours), occupied, length, Number(study.breakMinutes), earliest, tz, instantCache);
          if (slot) slot.date = day;
        }
      }
      if (!slot) {
        d.unplaced++;
        continue;
      }
      var session = { id: 'study:' + a.id + ':' + slot.start, forId: a.id, date: slot.date, start: slot.start, end: slot.end };
      used[slot.date] = true;
      book(session);
      d.created.push(session);
    }
  });

  // Titles and descriptions depend on each session's place in the sequence.
  decided.forEach(function (d) {
    var all = d.done.concat(d.kept, d.created).sort(function (x, y) {
      return x.start - y.start;
    });
    all.forEach(function (s, k) {
      var content = sessionContent_(d.a, d.info, k, all.length, study);
      if (d.created.indexOf(s) !== -1) {
        s.title = content.title;
        s.description = content.description;
        s.hash = content.hash;
        plan.create.push(s);
      } else if (d.kept.indexOf(s) !== -1 && s.hash !== content.hash) {
        plan.update.push({ existing: s, desired: content });
      } else {
        plan.keep.push(s);
      }
    });
    plan.summaries.push(
      Object.assign({ assessment: d.a }, d.info, {
        done: d.done.length,
        kept: d.kept.length,
        created: d.created.length,
        deleted: d.deleted,
        unplaced: d.unplaced,
      })
    );
  });
  return plan;
}
