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
};
