/**
 * Class grades for the study planner.
 *
 * Grades arrive from the "Send grades" bookmark: you click it while signed in
 * to Blackbaud, it reads your class averages there and opens this script's
 * web app with them in the address (doGet), which stores them in Script
 * Properties. The address is used rather than a form post because Google
 * sometimes redirects web app requests (for example when you're signed in
 * to several accounts), and a redirected post loses its data. Grades typed
 * into Settings.gs (study.grades) take priority over sent ones.
 *
 * Grades stay in your Google account; they are never sent to the AI.
 */

var GRADES_PROPERTY_ = 'B2C_GRADES';
var GRADES_TOKEN_PROPERTY_ = 'B2C_GRADES_TOKEN';
var MAX_GRADES_PAYLOAD_CHARS_ = 20000;

/** Lower-case words only, for comparing names. */
function simplifyText_(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** 'AP Biology - 2 (B)' -> 'AP Biology' (drops block labels and section numbers). */
function displayClassName_(name) {
  return String(name || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+-\s*[A-Za-z]?\d+[A-Za-z]?\s*$/, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Returns gradeOf(assessment) -> {className, grade} | null. A class matches
 * when its name (without section/block) appears in the assessment's class,
 * title or feed title; the longest matching name wins. Later records win
 * over earlier ones with the same name.
 */
function buildGradeLookup_(records) {
  var byKey = {};
  records.forEach(function (r) {
    var className = displayClassName_(r.name);
    var key = simplifyText_(className);
    if (key && typeof r.grade === 'number' && isFinite(r.grade)) {
      byKey[key] = { className: className, grade: r.grade, key: key };
    }
  });
  var entries = Object.keys(byKey)
    .map(function (k) {
      return byKey[k];
    })
    .sort(function (a, b) {
      return b.key.length - a.key.length;
    });
  return function gradeOf(a) {
    var texts = [a.course, a.summary, a.title]
      .filter(Boolean)
      .map(function (t) {
        return ' ' + simplifyText_(t) + ' ';
      });
    for (var i = 0; i < entries.length; i++) {
      for (var j = 0; j < texts.length; j++) {
        if (texts[j].indexOf(' ' + entries[i].key + ' ') !== -1) {
          return { className: entries[i].className, grade: entries[i].grade };
        }
      }
    }
    return null;
  };
}

/** Grades sent by the bookmark: {receivedAt, classes: [{name, grade}]} or null. */
function storedGrades_() {
  var raw = PropertiesService.getScriptProperties().getProperty(GRADES_PROPERTY_);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

/** All grade records: sent ones first, then typed ones (which win). */
function gradeRecords_(settings) {
  var records = [];
  var stored = storedGrades_();
  if (stored && Array.isArray(stored.classes)) records = records.concat(stored.classes);
  var typed = settings.study.grades || {};
  Object.keys(typed).forEach(function (name) {
    records.push({ name: name, grade: Number(typed[name]) });
  });
  return records;
}

/** Checks what the bookmark sent. Returns {classes} or throws a readable Error. */
function validateGradesPayload_(raw, expectedToken) {
  if (!expectedToken) throw new Error("Grades aren't set up yet. In the script, run makeGradesBookmarklet() first.");
  var text = String(raw || '');
  if (!text) throw new Error('Nothing was sent.');
  if (text.length > MAX_GRADES_PAYLOAD_CHARS_) throw new Error('That was too much data to be grades.');
  var data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error("That wasn't readable grade data.");
  }
  if (!data || data.token !== expectedToken) {
    throw new Error('This bookmark is out of date. Run makeGradesBookmarklet() again and replace the bookmark.');
  }
  if (!Array.isArray(data.classes) || !data.classes.length) throw new Error('No grades were sent.');
  if (data.classes.length > 40) throw new Error('Too many classes were sent.');
  var seen = {};
  var classes = [];
  data.classes.forEach(function (c) {
    var name = String((c && c.name) || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 150);
    var grade = Number(c && c.grade);
    if (!name || !isFinite(grade) || grade < 0 || grade > 150 || seen[name.toLowerCase()]) return;
    seen[name.toLowerCase()] = true;
    classes.push({ name: name, grade: Math.round(grade * 10) / 10 });
  });
  if (!classes.length) throw new Error('None of the grades sent were usable.');
  return { classes: classes };
}

function escapeHtml_(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function gradesPage_(heading, bodyHtml) {
  return (
    '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:2rem auto;padding:0 1rem;line-height:1.5}</style>' +
    '</head><body><h2>' + escapeHtml_(heading) + '</h2>' + bodyHtml + '</body></html>'
  );
}

function gradesResultPage_(result) {
  if (!result.ok) return gradesPage_('Grades not saved', '<p>' + escapeHtml_(result.message) + '</p>');
  var items = result.classes
    .map(function (c) {
      return '<li>' + escapeHtml_(c.name) + ': ' + c.grade + '%</li>';
    })
    .join('');
  return gradesPage_(
    'Saved your grades',
    '<ul>' + items + '</ul><p>Your study plan uses them from the next sync. You can close this tab.</p>'
  );
}

var GRADES_INBOX_HELP_ =
  '<p>This is the grades inbox for your study planner, but no grades came with this visit.</p>' +
  '<p>If you got here by clicking your "Send grades" bookmark, the bookmark is set to this page\'s address ' +
  'instead of the bookmark code. In the script, run <b>makeGradesBookmarklet</b>, copy the whole line that ' +
  'starts with <b>javascript:</b>, and paste it as the bookmark\'s URL (edit the bookmark to replace it).</p>' +
  '<p>When the bookmark works, clicking it on Blackbaud first shows a box listing your grades and asking ' +
  'whether to send them.</p>';

/** Stores grades sent by the bookmark, or explains what went wrong. */
function receiveGrades_(e) {
  var raw = (e && e.parameter && e.parameter.payload) || (e && e.postData && e.postData.contents) || '';
  if (!raw) return gradesPage_('No grades received', GRADES_INBOX_HELP_);
  var result;
  try {
    var data = validateGradesPayload_(raw, PropertiesService.getScriptProperties().getProperty(GRADES_TOKEN_PROPERTY_));
    PropertiesService.getScriptProperties().setProperty(
      GRADES_PROPERTY_,
      JSON.stringify({ receivedAt: new Date().toISOString(), classes: data.classes })
    );
    result = { ok: true, classes: data.classes };
  } catch (err) {
    result = { ok: false, message: err.message };
  }
  return gradesResultPage_(result);
}

/** Web app: the bookmark opens it with ?payload=... */
function doGet(e) {
  return HtmlService.createHtmlOutput(receiveGrades_(e)).setTitle('Blackbaud → Calendar');
}

/** Web app: bookmarks made by older versions post their grades. */
function doPost(e) {
  return HtmlService.createHtmlOutput(receiveGrades_(e)).setTitle('Blackbaud → Calendar');
}

/** The secret the bookmark includes so only it can update your grades. */
function gradesToken_() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty(GRADES_TOKEN_PROPERTY_);
  if (!token) {
    token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    props.setProperty(GRADES_TOKEN_PROPERTY_, token);
  }
  return token;
}

function webAppUrl_(settings) {
  var fromSettings = String(settings.study.webAppUrl || '').trim();
  if (fromSettings) return fromSettings;
  var service = ScriptApp.getService();
  var url = service && service.getUrl();
  if (url && /\/exec$/.test(url)) return url;
  throw new Error(
    'Deploy the script as a web app first (README: "Grades bookmark"), then paste its Web app URL ' +
      'into study.webAppUrl in Settings.gs.'
  );
}

/**
 * Runs in your browser as a bookmark on your Blackbaud site, not in Apps
 * Script. While you're signed in it can read the same data the Blackbaud
 * pages show you: it looks up your current classes and their averages, asks
 * you to confirm, and sends them to this script's web app in a new tab.
 *
 * Blackbaud's data addresses aren't documented, so each step reports clearly
 * where it failed. No // comments in here: it gets squeezed into a bookmark.
 */
async function gradesGrabber_(config) {
  var title = 'Blackbaud to Calendar';
  async function getJson(path) {
    var where = path.split('?')[0];
    var res = await fetch(location.origin + path, { credentials: 'include', headers: { Accept: 'application/json' } });
    var text = await res.text();
    if (!res.ok) throw new Error(where + ' answered HTTP ' + res.status);
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(where + " didn't send data (are you signed in?)");
    }
  }
  function pick(obj, paths) {
    for (var i = 0; i < paths.length; i++) {
      var value = obj;
      var parts = paths[i].split('.');
      for (var j = 0; j < parts.length && value !== undefined && value !== null; j++) value = value[parts[j]];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return undefined;
  }
  try {
    if (!/myschoolapp\.com$|blackbaud/i.test(location.hostname)) {
      if (!confirm(title + ": this doesn't look like your Blackbaud site. Try anyway?")) return;
    }
    var context = await getJson('/api/webapp/context');
    var userId = pick(context, ['UserInfo.UserId', 'MasterUserInfo.UserId', 'UserId', 'userId']);
    if (!userId) throw new Error('could not find your student ID');
    var now = new Date();
    var y = now.getFullYear();
    var year = encodeURIComponent(now.getMonth() >= 6 ? y + ' - ' + (y + 1) : y - 1 + ' - ' + y);
    var terms = await getJson('/api/DataDirect/StudentGroupTermList/?studentUserId=' + userId + '&schoolYearLabel=' + year + '&personaId=2');
    terms = Array.isArray(terms) ? terms : [];
    var current = terms.filter(function (t) {
      return t.CurrentInd === 1 || t.CurrentInd === true || t.CurrentInd === '1';
    });
    var durations = [];
    (current.length ? current : terms).forEach(function (t) {
      if (t.DurationId !== undefined && durations.indexOf(t.DurationId) === -1) durations.push(t.DurationId);
    });
    var groups = await getJson(
      '/api/datadirect/ParentStudentUserAcademicGroupsGet?userId=' + userId + '&schoolYearLabel=' + year +
        '&memberLevel=3&persona=2&durationList=' + durations.join(',') + '&markingPeriodId='
    );
    groups = Array.isArray(groups) ? groups : [];
    var classes = [];
    groups.forEach(function (g) {
      var name = pick(g, ['sectionidentifier', 'SectionIdentifier', 'groupname', 'GroupName', 'coursename']);
      var grade = parseFloat(pick(g, ['cumgrade', 'CumGrade', 'grade']));
      if (!name || !isFinite(grade)) return;
      name = String(name).trim();
      if (classes.some(function (c) { return c.name === name; })) return;
      classes.push({ name: name, grade: Math.round(grade * 10) / 10 });
    });
    if (!classes.length) throw new Error('found ' + groups.length + ' classes, but none has a grade yet');
    var list = classes.map(function (c) { return '- ' + c.name + ': ' + c.grade + '%'; }).join('\n');
    if (!confirm(title + ': send these grades to your study planner?\n\n' + list)) return;
    var form = document.createElement('form');
    form.method = 'GET';
    form.action = config.url;
    form.target = '_blank';
    var input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'payload';
    input.value = JSON.stringify({ token: config.token, classes: classes });
    form.appendChild(input);
    document.body.appendChild(form);
    form.submit();
    form.remove();
  } catch (e) {
    alert(
      title + ": couldn't read your grades.\n\n" + e.message +
        '\n\nMake sure you are signed in to Blackbaud in this tab. If it keeps happening, send this message to whoever set up the tool.'
    );
  }
}

/**
 * The bookmark's address: javascript: plus the grabber with your web app URL
 * and secret. `void` matters: a javascript: link that returns a value
 * replaces the page with it.
 */
function gradesBookmarkletCode_(url, token) {
  var source = 'void (' + gradesGrabber_.toString() + ')(' + JSON.stringify({ url: url, token: token }) + ');';
  return 'javascript:' + encodeURIComponent(source.replace(/\n\s+/g, '\n'));
}
