// In-memory stand-ins for the Apps Script services the tool uses
// (CalendarApp, UrlFetchApp, PropertiesService, ScriptApp, ...), so the whole
// sync can run under Node.

function wallParts(instant, tz) {
  const parts = {};
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
    .forEach((p) => (parts[p.type] = p.value));
  return parts;
}

function wallDate(instant, tz) {
  const p = wallParts(instant, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

// Midnight at the start of `date` ('YYYY-MM-DD') in tz.
function midnight(date, tz) {
  const [y, m, d] = date.split('-').map(Number);
  let guess = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 3; i++) {
    const p = wallParts(new Date(guess), tz);
    const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    guess += Date.UTC(y, m - 1, d) - shown;
  }
  return new Date(guess);
}

function nextDay(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

class FakeEvent {
  constructor(calendar, title, options) {
    this.calendar = calendar;
    this.id = `event-${++calendar.env.nextId}`;
    this.title = title;
    this.description = (options && options.description) || '';
    this.tags = {};
    this.color = '';
    this.reminders = [];
    this.deleted = false;
  }
  getId() { return this.id; }
  getTitle() { return this.title; }
  setTitle(t) { this.calendar.env.writes++; this.title = t; return this; }
  getDescription() { return this.description; }
  setDescription(d) { this.calendar.env.writes++; this.description = d; return this; }
  getTag(key) { return key in this.tags ? this.tags[key] : null; }
  setTag(key, value) { this.calendar.env.writes++; this.tags[key] = String(value); return this; }
  getColor() { return this.color; }
  setColor(c) { this.calendar.env.writes++; this.color = c; return this; }
  removeAllReminders() { this.calendar.env.writes++; this.reminders = []; return this; }
  addPopupReminder(m) { this.calendar.env.writes++; this.reminders.push(m); return this; }
  getPopupReminders() { return this.reminders.slice(); }
  isAllDayEvent() { return this.allDayDate !== undefined; }
  getAllDayStartDate() {
    if (!this.isAllDayEvent()) throw new Error('not an all-day event');
    return midnight(this.allDayDate, this.calendar.env.tz);
  }
  setAllDayDate(date) {
    this.calendar.env.writes++;
    this.allDayDate = wallDate(date, this.calendar.env.tz);
    delete this.start;
    delete this.end;
    return this;
  }
  setTime(start, end) {
    this.calendar.env.writes++;
    delete this.allDayDate;
    this.start = new Date(start.getTime());
    this.end = new Date(end.getTime());
    return this;
  }
  getStartTime() {
    return this.isAllDayEvent() ? this.getAllDayStartDate() : new Date(this.start.getTime());
  }
  getEndTime() {
    return this.isAllDayEvent() ? midnight(nextDay(this.allDayDate), this.calendar.env.tz) : new Date(this.end.getTime());
  }
  deleteEvent() {
    this.calendar.env.writes++;
    this.deleted = true;
    this.calendar.events = this.calendar.events.filter((e) => e !== this);
  }
}

class FakeCalendar {
  constructor(env, name, options) {
    this.env = env;
    this.id = `calendar-${++env.nextId}@group.calendar.google.com`;
    this.name = name;
    this.options = options || {};
    this.events = [];
  }
  getId() { return this.id; }
  getName() { return this.name; }
  createAllDayEvent(title, date, options) {
    this.env.writes++;
    const ev = new FakeEvent(this, title, options);
    ev.allDayDate = wallDate(date, this.env.tz);
    this.events.push(ev);
    return ev;
  }
  createEvent(title, start, end, options) {
    this.env.writes++;
    const ev = new FakeEvent(this, title, options);
    ev.start = new Date(start.getTime());
    ev.end = new Date(end.getTime());
    this.events.push(ev);
    return ev;
  }
  getEvents(start, end) {
    return this.events.filter((ev) => ev.getStartTime() < end && ev.getEndTime() > start);
  }
}

function createGasEnvironment({ tz = 'America/New_York', feed = '', feedStatus = 200 } = {}) {
  const env = {
    tz,
    nextId: 0,
    writes: 0,
    feed,
    feedStatus,
    fetchedUrls: [],
    calendars: [],
    properties: {},
    triggers: [],
    logs: [],
  };

  const globals = {
    console: {
      log: (...a) => env.logs.push(a.join(' ')),
      warn: (...a) => env.logs.push(a.join(' ')),
      error: (...a) => env.logs.push(a.join(' ')),
    },
    Utilities: {
      formatDate(date, zone, pattern) {
        const p = wallParts(date, zone);
        if (pattern !== 'yyyy-MM-dd HH:mm') throw new Error('fake formatDate: unsupported pattern ' + pattern);
        return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
      },
      sleep() {},
    },
    Session: { getScriptTimeZone: () => env.tz },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in env.properties ? env.properties[k] : null),
        setProperty: (k, v) => { env.properties[k] = String(v); },
        setProperties: (o) => { Object.keys(o).forEach((k) => (env.properties[k] = String(o[k]))); },
        deleteProperty: (k) => { delete env.properties[k]; },
      }),
    },
    UrlFetchApp: {
      fetch(url) {
        env.fetchedUrls.push(url);
        if (env.fetchError) throw new Error(env.fetchError(url));
        return {
          getResponseCode: () => env.feedStatus,
          getContentText: () => env.feed,
        };
      },
    },
    ScriptApp: {
      newTrigger(handler) {
        const trigger = { handler };
        const builder = {
          timeBased() { return builder; },
          everyHours(h) { trigger.everyHours = h; return builder; },
          create() {
            const t = { getHandlerFunction: () => handler, spec: trigger };
            env.triggers.push(t);
            return t;
          },
        };
        return builder;
      },
      getProjectTriggers: () => env.triggers.slice(),
      deleteTrigger: (t) => { env.triggers = env.triggers.filter((x) => x !== t); },
    },
    CalendarApp: {
      getOwnedCalendarsByName: (name) => env.calendars.filter((c) => c.getName() === name),
      getCalendarById: (id) => env.calendars.find((c) => c.getId() === id) || null,
      createCalendar(name, options) {
        const cal = new FakeCalendar(env, name, options);
        env.calendars.push(cal);
        return cal;
      },
    },
  };

  return { env, globals, FakeCalendar, midnight, wallDate };
}

module.exports = { createGasEnvironment, midnight, wallDate };
