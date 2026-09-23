# Blackbaud → Google Calendar

Puts your **tests, quizzes, essays, presentations, labs and major projects** from Blackbaud
(myschoolapp.com) onto Google Calendar, and keeps them up to date.

- Each item becomes an all-day event on its due date, color-coded by kind:
  📝 test, ✏️ quiz, 🛠️ project, 📄 essay/paper, 🎤 presentation, 🧪 lab.
- Reminders go off ahead of time, for example 3 days and 1 day before a test and 7, 3 and 1 days
  before a project.
- Homework, readings, study guides and review sheets are left out.
- Everything goes into its own calendar ("Blackbaud Assessments"). You can hide it, recolor it or
  delete it without touching your other events.
- When a teacher moves, renames or deletes an assignment, your calendar follows. If you delete an
  event yourself, it stays deleted.
- Optional **[study planner](#study-planner-optional)**: schedules study sessions before each
  assessment, with more time for classes where your grades are lower. An AI (Ollama) reads each
  assignment and names what to focus on in every session.

It runs as a **Google Apps Script** in your own Google account. You don't install anything, it's
free, and it keeps syncing every few hours even when your computer is off.

> **Before you rely on it:** Blackbaud doesn't publish the format of its calendar feed, and it
> differs a little between schools. This tool reads the standard iCalendar format that Blackbaud
> exports, and the tests use feeds shaped like Blackbaud's, but it hasn't been run against your
> school's real feed yet. Run `preview()` first (step 3) to check what it would add.

---

## Setup (about 10 minutes)

### Step 1: Copy your Blackbaud calendar feed link

1. Sign in to your school's Blackbaud site (usually `https://YOURSCHOOL.myschoolapp.com`).
2. Open your **Calendar**. Make sure assignments are turned on in the calendar's filters.
3. Click the **feed icon** (it looks like an RSS symbol) in the upper right. This opens the
   external feed options. Choose the iCal/subscribe option and **copy the link**. It starts with
   `webcal://` or `https://`, and usually contains `/podium/feed/iCal.aspx?z=`.

Blackbaud's menus vary between schools and versions. If you can't find a feed icon, your school may
have turned feeds off; ask your school's tech office whether calendar (iCal) feeds are enabled for
students.

**Keep this link private.** Anyone who has it can read your Blackbaud calendar.

### Step 2: Create the script

1. Go to [script.google.com](https://script.google.com), signed in with the Google account whose
   calendar you want to use, and click **New project**. Click "Untitled project" and name it
   `Blackbaud to Calendar`.
2. Delete everything in `Code.gs`. Open
   [`dist/BlackbaudToCalendar.gs`](dist/BlackbaudToCalendar.gs), copy the entire file (the copy
   button above the code on GitHub works), and paste it into `Code.gs`.
3. Click the **+** next to "Files", choose **Script**, and name it `Settings`. Delete what's in it,
   then paste in all of [`dist/Settings.gs`](dist/Settings.gs).
4. In `Settings.gs`, replace `PASTE_YOUR_BLACKBAUD_FEED_LINK_HERE` with your feed link. Keep the
   quotes around it. Press **Ctrl+S** (or **⌘S**) to save.
5. Click the gear icon (**Project Settings**) and check that the **Time zone** is your school's.

### Step 3: Preview what it will add

1. In the toolbar, choose **`preview`** from the function dropdown and click **Run**.
2. The first time, Google asks for permission: **Review permissions**, pick your account, then
   *"Google hasn't verified this app"* → **Advanced** → **Go to Blackbaud to Calendar (unsafe)** →
   **Allow**. That warning appears because this is your own script, not a published app. It asks
   for three permissions:
   - *See and edit your calendars*: to create the calendar and its events.
   - *Connect to an external service*: to read your Blackbaud feed.
   - *Run when you are not present*: for the automatic sync.
3. Read the **Execution log**. It lists every item it would add, and every item it skipped with the
   reason. Nothing on your calendar changes yet.

If the list looks wrong, see [Customizing](#customizing) and [Troubleshooting](#troubleshooting).

### Step 4: Turn it on

Choose **`setup`** and click **Run**. It creates the **Blackbaud Assessments** calendar, adds
everything, and turns on the automatic sync (every 4 hours). Open
[Google Calendar](https://calendar.google.com) and you'll find it under "My calendars". It also
appears in the Google Calendar app on your phone. If it doesn't, turn it on in the app's settings.

That's it. If a sync ever fails (for example, the feed link expired), Google emails you.

---

## Study planner (optional)

Once your assessments are syncing, the tool can also plan **study sessions** on a separate
**Study Plan** calendar:

- Each upcoming assessment gets study time based on its kind: about 3 hours for a test, 45 minutes
  for a quiz, 5 hours for a project, 4 for an essay, 2 for a presentation and 1½ for a lab.
- **Your grades adjust it.** At your target grade (93% by default) an assessment gets the usual
  time. Every 5 points below adds 25%, up to double. Every 5 points above takes 25% off, down to
  60%. With 83% in AP Biology, a test there gets 4½ hours instead of 3.
- **The AI reads the assignment.** Ollama estimates how big it is (a cumulative final gets more time
  than a one-chapter quiz). It also breaks the work into steps, which become session titles like
  "📚 Unit 3 Test (AP Biology): Membranes".
- Sessions go into your study hours, around the events in your main calendar, and never add up to
  more than 2 hours of study a day. Test sessions bunch up near the test (1, 2, 4 and 7 days
  before). Project sessions spread out over the weeks before the due date.
- The plan stays put between syncs. If you move a session, it stays where you put it. If you delete
  one, it isn't added back.

### Turn it on

In `Settings.gs`, set `enabled: true` under `study`, and set `hours` to when you're free to study.
Save, then run `preview` to see the plan, and `syncNow` to create it. From then on it updates with
every automatic sync.

### Add your Ollama API key

1. Create a key at [ollama.com/settings/keys](https://ollama.com/settings/keys). The free plan
   works; it has usage limits.
2. In Apps Script, click the gear (**Project Settings**), scroll to **Script properties** and click
   **Add script property**. Enter `OLLAMA_API_KEY` as the property and your key as the value, then
   click **Save script properties**.
3. Run `checkAi`. It lists the models your account can use and asks for a sample plan. If your
   `ai.model` isn't in that list, pick one from it and set `ai.model` in `Settings.gs`.

The key never goes in `Settings.gs`, so it can't end up anywhere you share by accident. Without a key
the planner still works; sessions just get plain titles, like "📚 Study for Unit 3 Test". The AI is
asked about each assessment once and the answer is remembered. It only asks again if the assignment
changes.

### Set up the "Send grades" bookmark

Blackbaud only shows grades while you're signed in, so a bookmark reads them in your own browser:

1. In Apps Script, click **Deploy → New deployment**. Click the gear next to "Select type" and
   choose **Web app**. Set *Execute as* to **Me** and *Who has access* to **Anyone**, click
   **Deploy**, and allow the permissions.
2. Run `makeGradesBookmarklet`. The log shows a long line starting with `javascript:`. Copy the
   whole line.
3. Right-click your bookmarks bar and choose **Add page…** (Chrome, Edge) or **Add Bookmark…**
   (Firefox). Name it "Send grades" and paste the line as the URL.
4. Sign in to Blackbaud and click the bookmark. It shows your class grades and asks before sending
   them. A new tab confirms "Saved your grades".

Click it again whenever your grades change. Run `showGrades` to see what the planner is using.

*Who has access* must be "Anyone" because the bookmark sends grades from your Blackbaud tab, which
isn't signed in to Google. The web app can only do one thing, save grades, and it only accepts them
along with the secret built into your bookmark. Keep the bookmark private. If it leaks, delete the
`B2C_GRADES_TOKEN` script property and run `makeGradesBookmarklet` again for a new one.

> **Heads-up:** Blackbaud doesn't document where its website gets grades from, so the bookmark
> uses the same addresses the website does. It hasn't been tried on a real school yet. If it shows
> an error, the message says which step failed; keep it, because it's what's needed to fix the
> bookmark. Until then you can type grades into `study.grades` in `Settings.gs`.

### Study settings

| Setting | Default | What it does |
| --- | --- | --- |
| `study.enabled` | `false` | Turns the planner on. |
| `study.hours` | weekdays `'16:00-21:00'`, weekends `'10:00-18:00'` | When you can study. `mon` to `sun` set single days, and `''` means no studying that day. |
| `study.sessionMinutes` | `45` | Length of one session. |
| `study.maxMinutesPerDay` | `120` | Most study time in one day. |
| `study.breakMinutes` | `15` | Free time kept between a session and anything else. |
| `study.busyCalendars` | `[]` | Other calendars to plan around, by name. Your main calendar always counts. |
| `study.targetGrade` | `93` | The grade at which an assessment gets its usual study time. |
| `study.grades` | `{}` | Typed-in grades, like `{ 'AP Biology': 84 }`. These win over the bookmark's. |
| `study.kinds` | see `Defaults.js` | For each kind: usual `minutes`, how many `daysAhead` to start, and `spacing` (`'spaced'` or `'even'`). |
| `study.calendarName` | `'Study Plan'` | The calendar the sessions go in. |
| `study.reminderMinutes` | `10` | Popup reminder before each session (`0` for none). |
| `ai.model` | `'gpt-oss:20b'` | The Ollama model to use. `checkAi` lists the ones you can use. |
| `ai.enabled` | `true` | `false` turns the AI off. |

## Customizing

Every change goes in `Settings.gs`. Save, then run `syncNow` (or wait for the next automatic sync);
existing events are updated to match. Some examples:

```js
var SETTINGS = {
  feedUrl: 'webcal://...',

  categories: {
    quiz: { enabled: false },                              // don't sync quizzes
    project: { remindDaysBefore: [14, 7, 2] },             // earlier project reminders
    test: { extraKeywords: ['checkpoint', 'unit check'] }, // your school's words for tests
    essay: { color: 'pink' },
  },

  extraExcludeKeywords: ['bell ringer'],  // never sync titles containing these
  syncEveryHours: 2,                      // 1, 2, 4, 6, 8 or 12
  reminderTime: '07:30',                  // reminders go off at 7:30 AM
};
```

| Setting | Default | What it does |
| --- | --- | --- |
| `calendarName` | `'Blackbaud Assessments'` | The Google Calendar to fill. It's created if it doesn't exist. |
| `lookbackDays` / `lookaheadDays` | `7` / `120` | Sync items due from 7 days ago up to 120 days ahead. |
| `syncEveryHours` | `4` | How often to check Blackbaud. Run `setup` again after changing it. |
| `reminderTime` | `'16:00'` | Time of day reminders go off. |
| `categories` | see below | Turn kinds on or off, and change their keywords, colors, icons and reminders. |
| `extraExcludeKeywords` | `[]` | More words that mean "don't sync this". |
| `titlePattern` | none | Splits titles like `AP Biology - 2: Unit 3 Test` into class and assignment. The event is then titled `📝 Unit 3 Test (AP Biology)`. An example is in `Settings.gs`. |
| `useDueTime` | `false` | `true` makes short timed events at the due time instead of all-day events. |
| `dueDateFrom` | `'start'` | Use `'end'` if your feed's events run from the assigned date to the due date. |
| `searchDescription` | `false` | Also look for keywords in the assignment description. |
| `deleteRemoved` | `true` | Remove events whose assignment disappeared from Blackbaud. |

The built-in kinds, checked in this order (the first match wins):

| Kind | Keywords (whole words, any case) | Color | Reminders (days before) |
| --- | --- | --- | --- |
| 📝 test | test, exam, midterm, final exam, finals, assessment, summative | red | 3, 1 |
| ✏️ quiz | quiz, quizzes | orange | 1 |
| 🛠️ project | project, capstone, portfolio | blue | 7, 3, 1 |
| 📄 essay | essay, paper, research paper, term paper, thesis, final draft, DBQ | purple | 5, 1 |
| 🎤 presentation | presentation, speech, oral report, debate, socratic seminar | yellow | 3, 1 |
| 🧪 lab | lab report, lab practical, practical | green | 2 |

Titles containing *review, study guide, study for, prepare for, practice test/quiz/exam,
corrections, sign up, permission slip, no school* or *no class* are skipped. So are items whose
Blackbaud type is *Homework* or *Classwork*. [`apps-script/Defaults.js`](apps-script/Defaults.js)
lists every setting and default.

Changes you make to a synced event in Google Calendar, such as its color or a note, are kept until
the assignment changes in Blackbaud.

## Functions you can run

Pick one in the Apps Script toolbar and click **Run**:

| Function | What it does |
| --- | --- |
| `setup` | First-time setup: syncs, then turns on automatic sync. Safe to run again. |
| `preview` | Shows what would be added, updated or removed, and why items were skipped. Changes nothing. |
| `syncNow` | Syncs right now. |
| `showFeedSample` | Prints the fields, Blackbaud types and next few events in your feed. Useful for tuning. |
| `restoreDeletedEvents` | Brings back synced events you deleted. |
| `stopAutoSync` | Turns off the automatic sync. |
| `removeSyncedEvents` | Deletes every event this tool created. Your own events are never touched. |
| `makeGradesBookmarklet` | Prints your "Send grades" bookmark. |
| `showGrades` | Shows the grades the study planner is using. |
| `checkAi` | Checks your Ollama key and model, and shows a sample answer. |
| `replanStudySessions` | Deletes upcoming study sessions (including ones you moved) and plans them again. |
| `removeStudySessions` | Deletes every study session this tool made. |

To uninstall: run `stopAutoSync` and `removeSyncedEvents`, delete the calendar in Google Calendar's
settings, and delete the Apps Script project.

## Troubleshooting

**"Please fix Settings.gs: …"**: the message says which setting is wrong and how to fix it.

**`preview` finds nothing, or misses things.** Run `showFeedSample` and look at the titles and
types.
- If there are no assignments at all, the feed probably only includes events or your class schedule.
  In Blackbaud, turn assignments on in the calendar's filters, then copy the feed link again.
- If your teachers use other words, such as "Checkpoint" or "Unit Assessment", add them with
  `extraKeywords`.
- If the feed shows types like "Major Assessment" under *Blackbaud types*, those are used
  automatically.

**It adds things it shouldn't**, such as a class called "Test Prep". Add words to
`extraExcludeKeywords`, or turn a kind off.

**Dates are off by a day.** Check the time zone in Project Settings. If your feed's events start on
the assigned date, set `dueDateFrom: 'end'`.

**"HTTP 404" or "didn't return a calendar".** The feed link was reset or expired. Copy a new one
from Blackbaud and update `feedUrl`.

**Using a school Google account?** Some schools block Apps Script or outside connections. If
authorizing fails, use a personal Google account instead.

**The log says "couldn't fit N session(s)".** There isn't enough free study time before that due
date. Add study hours, raise `study.maxMinutesPerDay`, or lower that kind's `minutes`.

**AI messages in the log.** "Rejected the API key": check that the script property is named exactly
`OLLAMA_API_KEY`. "Doesn't have the model": run `checkAi` and choose a model from its list. "Usage
limit was reached": the free plan's limit. In every case the planner carries on without the AI and
catches up on a later sync.

**Updating to a new version:** replace everything in `Code.gs` with the new
[`dist/BlackbaudToCalendar.gs`](dist/BlackbaudToCalendar.gs). Keep your `Settings.gs`. If you use the
grades bookmark, also click **Deploy → Manage deployments**, edit (pencil icon), choose
**Version: New version** and click **Deploy**. The web app keeps its address, so your bookmark
keeps working.

## Privacy

Everything runs inside your own Google account. The script talks to your Blackbaud feed, your Google
Calendar and, if you turn on the study planner's AI, Ollama. Ollama gets each assessment's kind,
class, title, due date and description, and nothing else: not your grades, your feed link or your
calendar. Grades from the bookmark are stored in the script's properties, in your Google account.
The feed link and the API key are never written to logs or error messages. The tool only edits or
deletes events it created itself (they carry a hidden tag), so your other events are safe.

---

## Development

The source is in [`apps-script/`](apps-script). Every file shares one global scope, like in Apps
Script:

| File | Purpose |
| --- | --- |
| `Main.js` | Functions you run, settings loading and validation, and logging |
| `Defaults.js` | Default settings |
| `Settings.js` | Settings template for users |
| `Calendar.js` | Google Calendar access (CalendarApp), triggers and sync state |
| `Plan.js` | Builds the wanted events and works out create/update/remove (pure) |
| `Classify.js` | Keyword classification (pure) |
| `Ics.js` | iCalendar feed parser (pure) |
| `Study.js` | Study planner: reads calendars, applies the plan, study functions you run |
| `Planner.js` | Decides how much to study and when (pure) |
| `Grades.js` | Grades: the bookmark, the web app (`doPost`) and matching grades to classes |
| `Ollama.js` | Ollama Cloud client, prompt and answer parsing |
| `Util.js` | Dates, time zones, hashing and HTML-to-text (pure) |

```sh
npm test        # Node's built-in test runner; no dependencies to install
npm run build   # regenerate dist/ after changing apps-script/ (a test checks dist/ is current)
```

The tests load the sources into a sandbox with in-memory fakes of the Apps Script services
([`tests/gas-fakes.js`](tests/gas-fakes.js)), so full syncs run under Node.

If you use [clasp](https://github.com/google/clasp), you can push straight from the repository:
`clasp create --type standalone --rootDir apps-script`, then `clasp push`. Set `timeZone` in
`apps-script/appsscript.json` to your own time zone first.
