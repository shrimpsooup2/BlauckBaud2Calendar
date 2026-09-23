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
};
