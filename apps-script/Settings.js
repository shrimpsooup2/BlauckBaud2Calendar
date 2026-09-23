/**
 * Blackbaud → Google Calendar: YOUR SETTINGS
 *
 * This is the only file you need to edit. When a new version of the tool
 * comes out, replace the other file (BlackbaudToCalendar.gs) and keep this one.
 * Every setting and its default is explained in Defaults.js in the repository.
 */
var SETTINGS = {
  // STEP 1: Your Blackbaud calendar feed link (starts with webcal:// or https://).
  // Keep it private: anyone with this link can read your Blackbaud calendar.
  feedUrl: 'PASTE_YOUR_BLACKBAUD_FEED_LINK_HERE',

  // The Google Calendar to fill (it's created for you if it doesn't exist).
  calendarName: 'Blackbaud Assessments',

  // Sync items due from this many days ago up to this many days ahead.
  lookbackDays: 7,
  lookaheadDays: 120,

  // How often to check Blackbaud: 1, 2, 4, 6, 8 or 12 hours.
  syncEveryHours: 4,

  // Popup reminders go off at this time of day (24-hour clock).
  reminderTime: '16:00',

  // Change what gets synced. Some examples (remove the // to use one):
  categories: {
    // quiz: { enabled: false },                                  // skip quizzes
    // project: { remindDaysBefore: [14, 7, 2] },                 // earlier project reminders
    // test: { extraKeywords: ['checkpoint', 'unit check'] },     // your school's words for tests
    // essay: { color: 'pink' },
  },

  // Never sync items whose title contains one of these (added to the built-in list).
  extraExcludeKeywords: [
    // 'bell ringer',
  ],

  // If your feed titles look like "AP Biology - 2: Unit 3 Test", this splits
  // them into class and assignment (run showFeedSample() to see your titles):
  // titlePattern: '^(?<course>.+?) - \\d+: (?<title>.+)$',

  // STEP 2 (optional): the study planner. It puts study sessions on a
  // "Study Plan" calendar, with more time for classes where your grade is lower.
  // See "Study planner" in the README.
  study: {
    enabled: false,

    // When you can study (24-hour clock). Add mon, tue, ... sun for single days,
    // e.g. fri: '' for no studying on Fridays, or several ranges: '07:00-07:45, 16:00-21:00'.
    hours: { weekdays: '16:00-21:00', weekends: '10:00-18:00' },
    sessionMinutes: 45,
    maxMinutesPerDay: 120,

    // Other calendars to plan around (your main calendar always counts).
    busyCalendars: [
      // 'Soccer',
    ],

    // Grades you type here win over the ones the "Send grades" bookmark sends.
    grades: {
      // 'AP Biology': 84,
    },
  },

  // AI for the study planner. Your Ollama API key does NOT go here: add it in
  // Project Settings → Script properties as OLLAMA_API_KEY.
  ai: {
    model: 'gpt-oss:20b',
  },
};
