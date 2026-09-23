const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { loadScripts, plain } = require('./helpers');
const { createGasEnvironment } = require('./gas-fakes');

const FEED_URL = 'webcal://myschool.myschoolapp.com/podium/feed/iCal.aspx?z=T';
const WEB_APP = 'https://script.google.com/macros/s/AKfyc-test/exec';

function setUp(settings = {}) {
  const fake = createGasEnvironment();
  const gas = loadScripts(fake.globals);
  gas.SETTINGS = { feedUrl: FEED_URL, ...settings };
  return { gas, env: fake.env };
}

test('class names are compared without section numbers and block labels', () => {
  const gas = loadScripts();
  assert.equal(gas.displayClassName_('AP Biology - 2 (B)'), 'AP Biology');
  assert.equal(gas.displayClassName_('English 10 - 03A'), 'English 10');
  assert.equal(gas.displayClassName_('Algebra II - Honors'), 'Algebra II - Honors');
  assert.equal(gas.simplifyText_('AP Biology - 2: Unit 3 Test'), 'ap biology 2 unit 3 test');
});

test('grades are matched to assessments by class name', () => {
  const gas = loadScripts();
  const gradeOf = gas.buildGradeLookup_([
    { name: 'AP Biology - 2 (B)', grade: 84 },
    { name: 'Biology Lab - 1', grade: 70 },
    { name: 'Art - 4', grade: 99 },
    { name: 'English 10 - 1', grade: 91 },
    { name: 'English 10', grade: 88 }, // typed later: wins
  ]);
  assert.deepEqual(plain(gradeOf({ course: 'AP Biology', title: 'Unit 3 Test' })), { className: 'AP Biology', grade: 84 });
  assert.deepEqual(plain(gradeOf({ summary: 'AP Biology - 2: Unit 3 Test', title: 'AP Biology - 2: Unit 3 Test' })), {
    className: 'AP Biology',
    grade: 84,
  });
  assert.deepEqual(plain(gradeOf({ summary: 'Biology Lab - 1: Lab Practical' })), { className: 'Biology Lab', grade: 70 });
  assert.deepEqual(plain(gradeOf({ summary: 'English 10 - 1: Essay' })), { className: 'English 10', grade: 88 });
  assert.equal(gradeOf({ summary: 'Artificial Intelligence: Project' }), null);
  assert.equal(gradeOf({ title: 'Unit 3 Test' }), null);
});

test('typed-in grades win over the bookmark', () => {
  const { gas, env } = setUp({ study: { grades: { 'AP Biology': 90 } } });
  env.properties.B2C_GRADES = JSON.stringify({ receivedAt: 'x', classes: [{ name: 'AP Biology - 2 (B)', grade: 84 }, { name: 'Geometry - 3', grade: 95 }] });
  const gradeOf = gas.buildGradeLookup_(gas.gradeRecords_(gas.loadSettings_()));
  assert.equal(gradeOf({ course: 'AP Biology' }).grade, 90);
  assert.equal(gradeOf({ course: 'Geometry' }).grade, 95);
});

test('validateGradesPayload_ only accepts sensible grades with the right secret', () => {
  const gas = loadScripts();
  const ok = (classes) => JSON.stringify({ token: 'secret', classes });
  assert.throws(() => gas.validateGradesPayload_(ok([{ name: 'A', grade: 90 }]), null), /run makeGradesBookmarklet\(\) first/);
  assert.throws(() => gas.validateGradesPayload_('', 'secret'), /Nothing was sent/);
  assert.throws(() => gas.validateGradesPayload_('x'.repeat(20001), 'secret'), /too much data/);
  assert.throws(() => gas.validateGradesPayload_('{nope', 'secret'), /wasn't readable/);
  assert.throws(() => gas.validateGradesPayload_(JSON.stringify({ token: 'old', classes: [] }), 'secret'), /bookmark is out of date/);
  assert.throws(() => gas.validateGradesPayload_(ok([]), 'secret'), /No grades were sent/);
  assert.throws(() => gas.validateGradesPayload_(ok([{ name: '', grade: 'x' }]), 'secret'), /None of the grades/);
  const result = plain(
    gas.validateGradesPayload_(
      ok([
        { name: '  AP  Biology - 2 ', grade: '84.46' },
        { name: 'ap biology - 2', grade: 50 },
        { name: 'Geometry', grade: 200 },
        { name: 'Chemistry', grade: 77 },
      ]),
      'secret'
    )
  );
  assert.deepEqual(result, { classes: [{ name: 'AP Biology - 2', grade: 84.5 }, { name: 'Chemistry', grade: 77 }] });
});

test('doPost (used by bookmarks from older versions) saves grades sent with the right secret', () => {
  const { gas, env } = setUp();
  const token = gas.gradesToken_();
  assert.equal(gas.gradesToken_(), token);
  assert.match(token, /^[0-9a-f]{64}$/);

  const page = gas.doPost({ parameter: { payload: JSON.stringify({ token, classes: [{ name: 'AP Bio <b>', grade: 84 }] }) } });
  assert.match(page.getContent(), /Saved your grades/);
  assert.match(page.getContent(), /AP Bio &lt;b&gt;: 84%/);
  const saved = JSON.parse(env.properties.B2C_GRADES);
  assert.deepEqual(saved.classes, [{ name: 'AP Bio <b>', grade: 84 }]);
  assert.ok(!Number.isNaN(Date.parse(saved.receivedAt)));

  const rejected = gas.doPost({ parameter: { payload: JSON.stringify({ token: 'guess', classes: [{ name: 'X', grade: 1 }] }) } });
  assert.match(rejected.getContent(), /Grades not saved/);
  assert.deepEqual(JSON.parse(env.properties.B2C_GRADES).classes, [{ name: 'AP Bio <b>', grade: 84 }]);
});

test('doGet saves grades that arrive in the address, the way the bookmark sends them', () => {
  const { gas, env } = setUp();
  const token = gas.gradesToken_();
  const page = gas.doGet({ parameter: { payload: JSON.stringify({ token, classes: [{ name: 'Geometry - 3', grade: 95 }] }) } });
  assert.match(page.getContent(), /Saved your grades/);
  assert.deepEqual(JSON.parse(env.properties.B2C_GRADES).classes, [{ name: 'Geometry - 3', grade: 95 }]);
  assert.equal(page.title, 'Blackbaud → Calendar');
});

test('a visit without grades explains how to fix the bookmark', () => {
  const { gas, env } = setUp();
  for (const page of [gas.doGet(), gas.doGet({ parameter: {} }), gas.doPost({ parameter: {} })]) {
    const html = page.getContent();
    assert.match(html, /No grades received/);
    assert.match(html, /no grades came with this visit/);
    assert.match(html, /run <b>makeGradesBookmarklet<\/b>, copy the whole line that starts with <b>javascript:<\/b>/);
  }
  assert.equal(env.properties.B2C_GRADES, undefined);
});

test('a pasted test (/dev) address is caught with an explanation', () => {
  const { gas } = setUp({ study: { webAppUrl: 'https://script.google.com/macros/s/abc/dev' } });
  assert.throws(() => gas.loadSettings_(), /ending in \/exec \(that one ends in \/dev: it's the test address/);
});

test('the web app URL comes from Settings or the deployment', () => {
  const { gas, env } = setUp();
  const missing = /doesn't know its web app address yet\. In Apps Script, click Deploy → Manage deployments .*copy the Web app URL that ends in \/exec, and add it to the study section of Settings\.gs like this: webAppUrl:/;
  assert.throws(() => gas.webAppUrl_(gas.loadSettings_()), missing);
  env.webAppUrl = 'https://script.google.com/macros/s/abc/dev';
  assert.throws(() => gas.webAppUrl_(gas.loadSettings_()), missing);
  env.webAppUrl = WEB_APP;
  assert.equal(gas.webAppUrl_(gas.loadSettings_()), WEB_APP);
  gas.SETTINGS.study = { webAppUrl: 'https://script.google.com/a/macros/school.org/s/xyz/exec' };
  assert.equal(gas.webAppUrl_(gas.loadSettings_()), 'https://script.google.com/a/macros/school.org/s/xyz/exec');
});

// --- The bookmark, run in a pretend browser -----------------------------------

function schoolYear() {
  const now = new Date();
  const y = now.getFullYear();
  return now.getMonth() >= 6 ? `${y} - ${y + 1}` : `${y - 1} - ${y}`;
}

const BLACKBAUD_API = {
  '/api/webapp/context': { UserInfo: { UserId: 4242 } },
  '/api/DataDirect/StudentGroupTermList/': [
    { DurationId: 111, CurrentInd: 0 },
    { DurationId: 222, CurrentInd: 1 },
  ],
  '/api/datadirect/ParentStudentUserAcademicGroupsGet': [
    { sectionidentifier: 'AP Biology - 2 (B)', cumgrade: '84.46' },
    { sectionidentifier: 'Geometry - 3', cumgrade: '95' },
    { sectionidentifier: 'Study Hall', cumgrade: null },
  ],
};

function runBookmarklet(code, { api = BLACKBAUD_API, status = {}, answers = [] } = {}) {
  assert.ok(code.startsWith('javascript:'));
  const source = decodeURIComponent(code.slice('javascript:'.length));
  const calls = { fetched: [], alerts: [], confirms: [], submitted: [] };
  function element(tag) {
    return {
      tag,
      children: [],
      appendChild(child) { this.children.push(child); },
      submit() { calls.submitted.push({ method: this.method, action: this.action, target: this.target, fields: this.children.map((c) => [c.name, c.value]) }); },
      remove() {},
    };
  }
  const browser = {
    location: { origin: 'https://myschool.myschoolapp.com', hostname: 'myschool.myschoolapp.com' },
    fetch: async (url, options) => {
      calls.fetched.push({ url, options });
      const path = url.replace('https://myschool.myschoolapp.com', '').split('?')[0];
      const code = status[path] || (path in api ? 200 : 404);
      return { ok: code === 200, status: code, text: async () => (code === 200 ? JSON.stringify(api[path]) : '<html>no</html>') };
    },
    confirm: (message) => {
      calls.confirms.push(message);
      return answers.length ? answers.shift() : true;
    },
    alert: (message) => calls.alerts.push(message),
    document: { body: element('body'), createElement: element },
  };
  const result = vm.runInNewContext(source, browser);
  assert.equal(result, undefined, 'a bookmark must not return a value (the browser would show it as a page)');
  return new Promise((resolve) => setTimeout(() => resolve(calls), 20));
}

test('makeGradesBookmarklet() prints a bookmark with the web app URL and secret', () => {
  const { gas, env } = setUp({ study: { webAppUrl: ` ${WEB_APP} ` } });
  gas.makeGradesBookmarklet();
  const code = env.logs.join('\n').split('\n').find((l) => l.startsWith('javascript:'));
  assert.ok(code);
  const source = decodeURIComponent(code.slice(11));
  assert.match(source, /^void \(async function gradesGrabber_/);
  assert.ok(source.includes(WEB_APP));
  assert.ok(source.includes(env.properties.B2C_GRADES_TOKEN));
});

test('the bookmark reads grades from Blackbaud and sends them to the web app', async () => {
  const { gas } = setUp();
  const calls = await runBookmarklet(gas.gradesBookmarkletCode_(WEB_APP, 'secret'));
  assert.deepEqual(calls.alerts, []);
  const year = encodeURIComponent(schoolYear());
  assert.deepEqual(
    calls.fetched.map((f) => f.url),
    [
      'https://myschool.myschoolapp.com/api/webapp/context',
      `https://myschool.myschoolapp.com/api/DataDirect/StudentGroupTermList/?studentUserId=4242&schoolYearLabel=${year}&personaId=2`,
      `https://myschool.myschoolapp.com/api/datadirect/ParentStudentUserAcademicGroupsGet?userId=4242&schoolYearLabel=${year}&memberLevel=3&persona=2&durationList=222&markingPeriodId=`,
    ]
  );
  assert.ok(calls.fetched.every((f) => f.options.credentials === 'include'));
  assert.match(calls.confirms[0], /AP Biology - 2 \(B\): 84\.5%\n- Geometry - 3: 95%$/);
  assert.equal(calls.submitted.length, 1);
  const form = calls.submitted[0];
  assert.deepEqual([form.method, form.action, form.target], ['GET', WEB_APP, '_blank']);
  assert.equal(form.fields[0][0], 'payload');
  assert.deepEqual(JSON.parse(form.fields[0][1]), {
    token: 'secret',
    classes: [{ name: 'AP Biology - 2 (B)', grade: 84.5 }, { name: 'Geometry - 3', grade: 95 }],
  });
});

test('what the bookmark sends is accepted by the web app', async () => {
  const { gas, env } = setUp();
  const token = gas.gradesToken_();
  const calls = await runBookmarklet(gas.gradesBookmarkletCode_(WEB_APP, token));
  const payload = calls.submitted[0].fields[0][1];
  assert.match(gas.doGet({ parameter: { payload } }).getContent(), /Saved your grades/);
  assert.equal(JSON.parse(env.properties.B2C_GRADES).classes.length, 2);
});

test('the bookmark sends nothing if you cancel', async () => {
  const { gas } = setUp();
  const calls = await runBookmarklet(gas.gradesBookmarkletCode_(WEB_APP, 'secret'), { answers: [false] });
  assert.equal(calls.submitted.length, 0);
});

test('the bookmark explains which step failed', async () => {
  const { gas } = setUp();
  const signedOut = await runBookmarklet(gas.gradesBookmarkletCode_(WEB_APP, 'secret'), { status: { '/api/webapp/context': 401 } });
  assert.equal(signedOut.submitted.length, 0);
  assert.match(signedOut.alerts[0], /couldn't read your grades\.\n\n\/api\/webapp\/context answered HTTP 401/);

  const noGrades = await runBookmarklet(gas.gradesBookmarkletCode_(WEB_APP, 'secret'), {
    api: { ...BLACKBAUD_API, '/api/datadirect/ParentStudentUserAcademicGroupsGet': [{ sectionidentifier: 'Art', cumgrade: '' }] },
  });
  assert.match(noGrades.alerts[0], /found 1 classes, but none has a grade yet/);

  const noUser = await runBookmarklet(gas.gradesBookmarkletCode_(WEB_APP, 'secret'), { api: { ...BLACKBAUD_API, '/api/webapp/context': {} } });
  assert.match(noUser.alerts[0], /could not find your student ID/);
});
