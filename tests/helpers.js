// Loads the Apps Script sources into a sandbox, the way Apps Script does:
// every file shares one global scope.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const FILES = require('../scripts/files');

const SRC = path.join(__dirname, '..', 'apps-script');

function loadScripts(globals = {}) {
  const context = vm.createContext({ console, ...globals });
  for (const file of FILES) {
    vm.runInContext(fs.readFileSync(path.join(SRC, file), 'utf8'), context, { filename: file });
  }
  return context;
}

// Objects made inside the sandbox have the sandbox's prototypes, which
// assert.deepStrictEqual treats as different. Compare plain copies instead.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// 'YYYY-MM-DD' of today + n days in time zone tz.
function dayFromToday(n, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date())
    .split('-')
    .map(Number);
  const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + n));
  return d.toISOString().slice(0, 10);
}

module.exports = { loadScripts, plain, dayFromToday, SRC };
