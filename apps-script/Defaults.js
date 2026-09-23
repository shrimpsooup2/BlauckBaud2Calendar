/**
 * Built-in defaults. Don't edit this file: put your changes in Settings.gs,
 * which is merged on top of these values every time the tool runs.
 */
var DEFAULTS_ = {
  // Blackbaud calendar feed link. Set it in Settings.gs (or in the script
  // property BLACKBAUD_FEED_URL, which wins if both are set).
  feedUrl: '',

  // Google Calendar the tool creates and keeps in sync.
  calendarName: 'Blackbaud Assessments',

  // IANA time zone such as 'America/New_York'. Empty = the Apps Script
  // project's time zone (Project Settings > Time zone).
  timeZone: '',

  // Only items due inside [today - lookbackDays, today + lookaheadDays] are
  // synced. Older events already on the calendar are left alone.
  lookbackDays: 7,
  lookaheadDays: 120,

  // How often the automatic sync runs: 1, 2, 4, 6, 8 or 12 hours.
  syncEveryHours: 4,

  // Remove calendar events whose Blackbaud item disappeared (or stopped
  // matching your filters). Only events this tool created are ever touched.
  deleteRemoved: true,

  // false: every item becomes an all-day event on its due date.
  // true: items with a due time become short timed events at that time.
  useDueTime: false,
  timedEventMinutes: 30,

  // Popup reminders fire this many days before the due date (per category,
  // see remindDaysBefore) at this time of day. Used for all-day events.
  reminderTime: '16:00',

  // Which feed date is the due date: 'start' (DTSTART) or 'end' (DTEND).
  dueDateFrom: 'start',

  // Optional regular expression with named groups (?<course>...) and
  // (?<title>...) that splits a feed title into class and assignment name.
  titlePattern: '',

  // Event titles. Placeholders: {icon} {label} {title} {course}
  titleFormat: '{icon} {title}',
  titleFormatWithCourse: '{icon} {title} ({course})',

  // Also look for keywords in the assignment description, not just the title.
  searchDescription: false,

  // Items whose title contains any of these are never synced.
  excludeKeywords: [
    'review',
    'study guide',
    'study for',
    'prepare for',
    'prep for',
    'practice test',
    'practice quiz',
    'practice exam',
    'correction',
    'corrections',
    'sign up',
    'permission slip',
    'no school',
    'no class',
  ],
  // Added to excludeKeywords (so you don't have to repeat the defaults).
  extraExcludeKeywords: [],

  // Items whose Blackbaud type (the feed's CATEGORIES) contains one of these
  // are never synced.
  excludeTypes: ['homework', 'classwork'],

  // Kinds of work that get synced, checked in this order; the first kind with
  // a matching keyword wins. Per kind:
  //   enabled          false to skip this kind entirely
  //   keywords         words/phrases that identify it (whole words, any case)
  //   extraKeywords    added to keywords
  //   label, icon      used in the event title and description
  //   color            red, orange, yellow, green, blue, purple, pink, cyan,
  //                    gray, lavender, sage (or a Google color number 1-11)
  //   remindDaysBefore popup reminders, in days before the due date (max 5)
  categories: {
    test: {
      enabled: true,
      label: 'Test',
      icon: '📝',
      color: 'red',
      remindDaysBefore: [3, 1],
      keywords: [
        'test', 'tests', 'exam', 'exams', 'midterm', 'midterms', 'final exam',
        'finals', 'assessment', 'assessments', 'summative',
      ],
      extraKeywords: [],
    },
    quiz: {
      enabled: true,
      label: 'Quiz',
      icon: '✏️',
      color: 'orange',
      remindDaysBefore: [1],
      keywords: ['quiz', 'quizzes'],
      extraKeywords: [],
    },
    project: {
      enabled: true,
      label: 'Project',
      icon: '🛠️',
      color: 'blue',
      remindDaysBefore: [7, 3, 1],
      keywords: ['project', 'projects', 'capstone', 'portfolio'],
      extraKeywords: [],
    },
    essay: {
      enabled: true,
      label: 'Essay / paper',
      icon: '📄',
      color: 'purple',
      remindDaysBefore: [5, 1],
      keywords: [
        'essay', 'essays', 'paper', 'research paper', 'term paper', 'thesis',
        'final draft', 'dbq',
      ],
      extraKeywords: [],
    },
    presentation: {
      enabled: true,
      label: 'Presentation',
      icon: '🎤',
      color: 'yellow',
      remindDaysBefore: [3, 1],
      keywords: [
        'presentation', 'presentations', 'speech', 'oral report', 'debate',
        'socratic seminar',
      ],
      extraKeywords: [],
    },
    lab: {
      enabled: true,
      label: 'Lab',
      icon: '🧪',
      color: 'green',
      remindDaysBefore: [2],
      keywords: ['lab report', 'lab practical', 'practical'],
      extraKeywords: [],
    },
  },

  // How many skipped feed items preview() lists (they are always counted).
  previewSkippedLimit: 40,

  // Study planner: puts study sessions for upcoming assessments on a separate
  // calendar. More time goes to classes where your grade is lower.
  study: {
    enabled: false,
    calendarName: 'Study Plan',
    icon: '📚',
    color: 'sage',
    // Popup reminder before each session (0 = none).
    reminderMinutes: 10,
    sessionMinutes: 45,
    maxMinutesPerDay: 120,
    // Free time kept between a session and anything else.
    breakMinutes: 15,
    maxSessionsPerAssessment: 10,
    // When you can study, 24-hour clock. Several ranges: '07:00-07:45, 16:00-21:00'.
    // mon, tue, wed, thu, fri, sat, sun override weekdays/weekends; '' = no study that day.
    hours: { weekdays: '16:00-21:00', weekends: '10:00-18:00' },
    // Other calendars to plan around (by name). Your main calendar always counts.
    busyCalendars: [],
    // At this grade an assessment gets its kind's usual time; each 5 points
    // below adds 25% (up to 2×), each 5 points above takes 25% off (down to 0.6×).
    targetGrade: 93,
    // Typed-in grades, e.g. { 'AP Biology': 84 }. They win over the bookmark's.
    grades: {},
    // The web app's URL for the grades bookmark: Deploy → Manage deployments →
    // Web app URL (ends in /exec). See the README.
    webAppUrl: '',
    // Usual study time per kind at your target grade; sessions start at most
    // daysAhead days before the due date. spacing: 'spaced' bunches sessions
    // near the due date (tests); 'even' spreads them out (projects).
    kinds: {
      test: { minutes: 180, daysAhead: 10, spacing: 'spaced' },
      quiz: { minutes: 45, daysAhead: 3, spacing: 'spaced' },
      project: { minutes: 300, daysAhead: 21, spacing: 'even' },
      essay: { minutes: 240, daysAhead: 14, spacing: 'even' },
      presentation: { minutes: 120, daysAhead: 7, spacing: 'even' },
      lab: { minutes: 90, daysAhead: 5, spacing: 'even' },
    },
    // For kinds you add yourself.
    defaultKind: { minutes: 90, daysAhead: 7, spacing: 'even' },
  },

  // AI study advice (what to study in each session, and how big each
  // assessment is). Uses the script property OLLAMA_API_KEY.
  ai: {
    enabled: true,
    baseUrl: 'https://ollama.com',
    model: 'gpt-oss:20b',
    // Assessments to ask about per sync (answers are remembered).
    maxPerRun: 5,
  },
};
