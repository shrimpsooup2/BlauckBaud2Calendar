const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts, plain } = require('./helpers');

const gas = loadScripts();

function settingsWith(overrides = {}) {
  return gas.mergeDeep_(gas.DEFAULTS_, overrides);
}

function classify(title, extra = {}, overrides = {}) {
  const fn = gas.buildClassifier_(settingsWith(overrides));
  return plain(fn({ title, categories: [], description: '', ...extra }));
}

test('recognizes each kind of assessment or project from the title', () => {
  const cases = {
    'Unit 3 Test': 'test',
    'Chapter 5 & 6 tests': 'test',
    'Spanish Midterm': 'test',
    'FINAL EXAM - Semester 1': 'test',
    'Summative Assessment: Cells': 'test',
    'Pop Quiz': 'quiz',
    'Vocab quizzes 1-3': 'quiz',
    'Science Fair Project': 'project',
    'Senior Capstone': 'project',
    'Persuasive Essay': 'essay',
    'Research Paper final draft': 'essay',
    'DBQ: Causes of WWI': 'essay',
    'Group Presentation': 'presentation',
    'Socratic Seminar': 'presentation',
    'Lab Report: Titration': 'lab',
    'lab-report 4': 'lab',
  };
  for (const [title, category] of Object.entries(cases)) {
    const result = classify(title);
    assert.equal(result.include, true, title);
    assert.equal(result.category, category, title);
  }
});

test('earlier kinds win when a title matches several', () => {
  assert.equal(classify('Lab Quiz').category, 'quiz');
  assert.equal(classify('Final Project Presentation').category, 'project');
});

test('matches whole words only', () => {
  for (const title of ['Contest entry', 'Testing strategies', 'Latest news', 'Quizlet practice set', 'Projector sign-out']) {
    assert.equal(classify(title).include, false, title);
  }
});

test('ordinary homework is skipped', () => {
  const result = classify('Read chapters 4-5');
  assert.equal(result.include, false);
  assert.equal(result.reason, 'no assessment/project keywords');
});

test('excluded words win over assessment keywords', () => {
  for (const title of ['Unit 2 Test Review', 'Study guide for quiz', 'Test corrections', 'Practice test', 'Study for the exam']) {
    const result = classify(title);
    assert.equal(result.include, false, title);
    assert.match(result.reason, /excluded word/, title);
  }
});

test('extra exclude keywords add to the built-in list', () => {
  const overrides = { extraExcludeKeywords: ['bell ringer'] };
  assert.equal(classify('Bell ringer quiz', {}, overrides).include, false);
  assert.equal(classify('Unit test review', {}, overrides).include, false);
});

test('a turned-off kind is skipped with a clear reason', () => {
  const result = classify('Pop Quiz', {}, { categories: { quiz: { enabled: false } } });
  assert.equal(result.include, false);
  assert.equal(result.reason, 'looks like a quiz, but quiz is turned off');
});

test('extraKeywords teach it your school\'s words', () => {
  assert.equal(classify('Unit 4 Checkpoint').include, false);
  const result = classify('Unit 4 Checkpoint', {}, { categories: { test: { extraKeywords: ['checkpoint'] } } });
  assert.equal(result.category, 'test');
});

test('custom kinds can be added', () => {
  const overrides = { categories: { recital: { label: 'Recital', keywords: ['recital', 'jury'] } } };
  assert.equal(classify('Piano jury', {}, overrides).category, 'recital');
});

test('uses the Blackbaud type when the title has no keywords', () => {
  const result = classify('Chapter 7', { categories: ['Major Assessment'] });
  assert.equal(result.include, true);
  assert.equal(result.category, 'test');
  assert.equal(result.reason, '"assessment" in Blackbaud type');
});

test('excluded Blackbaud types are skipped', () => {
  const result = classify('Chapter 7 test', { categories: ['Homework'] });
  assert.equal(result.include, false);
  assert.match(result.reason, /Blackbaud type/);
});

test('descriptions are only searched when turned on', () => {
  const extra = { description: 'This is the unit test.' };
  assert.equal(classify('Chapter 7', extra).include, false);
  assert.equal(classify('Chapter 7', extra, { searchDescription: true }).category, 'test');
});

test('splitTitle_ separates class and assignment when a pattern is set', () => {
  const pattern = new RegExp(gas.mergeDeep_({}, { p: '^(?<course>.+?) - \\d+: (?<title>.+)$' }).p);
  assert.deepEqual(plain(gas.splitTitle_('AP Biology - 2: Unit 3 Test', pattern)), {
    course: 'AP Biology',
    title: 'Unit 3 Test',
  });
  assert.deepEqual(plain(gas.splitTitle_('Homecoming Dance', pattern)), { course: '', title: 'Homecoming Dance' });
  assert.deepEqual(plain(gas.splitTitle_('Unit 3 Test', null)), { course: '', title: 'Unit 3 Test' });
});
