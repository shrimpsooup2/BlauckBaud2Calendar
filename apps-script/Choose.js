/**
 * Lets the AI decide which Blackbaud items go on the calendar (ai.chooseItems).
 *
 * The keyword rules in Classify.js still run first; the AI's answer then
 * replaces their decision for every item it has judged. Each item is judged
 * once and the answer remembered (script properties B2C_CHOICE_*), so later
 * syncs only ask about new or changed items. Items the AI hasn't judged yet,
 * because there is no key, it failed, or there were too many for one sync,
 * keep the keyword decision.
 *
 * Your own additions always win over the AI: extraExcludeKeywords, a kind's
 * extraKeywords, and kinds you turned off.
 */

var CHOICE_PREFIX_ = 'B2C_CHOICE_';
var CHOICE_BATCH_SIZE_ = 25;
// A title that appears this often in the sync window is a class meeting or a
// routine item: the keyword rules handle those without asking the AI.
var CHOICE_REPEAT_LIMIT_ = 4;

/** What the AI is told about an item (its answer is remembered per this). */
function choiceInput_(item) {
  return {
    title: item.summary,
    type: (item.categories || []).join(', '),
    due: item.due.date,
    details: truncate_(String(item.description || '').replace(/\s+/g, ' ').trim(), 300),
  };
}

function choiceInputHash_(input) {
  // The due date isn't part of it: a moved test is still a test.
  return hash_(JSON.stringify([input.title, input.type, input.details]));
}

function choiceSchema_(kinds) {
  return {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            kind: { type: 'string', enum: kinds.concat(['none']) },
            why: { type: 'string' },
          },
          required: ['id', 'kind'],
        },
      },
    },
    required: ['items'],
  };
}

/** Chat messages asking which of `items` ([{id, title, type, due, details}]) belong on the calendar. */
function buildChoicePrompt_(items, kindLabels) {
  var kinds = Object.keys(kindLabels)
    .map(function (key) {
      return '"' + key + '" (' + kindLabels[key] + ')';
    })
    .join(', ');
  var instructions = [
    "Each item below comes from a high school student's Blackbaud school calendar. Decide which ones " +
      'belong on their calendar as something to prepare for: tests, exams, quizzes and other graded ' +
      'assessments, and major work like projects, essays, papers, presentations and lab reports.',
    '',
    'For each item, answer with "kind": one of ' + kinds + ', or "none" for everything else: regular ' +
      'homework, readings, worksheets, notes, study guides, review sheets, practice work, corrections, ' +
      'class meetings, school events and reminders.',
    'A review sheet or study guide for a test is "none": the test itself is what counts. Use the title, ' +
      'the Blackbaud type and the details. If an item could be ordinary homework, answer "none" unless it ' +
      'looks graded and significant.',
    'Also give "why": a few words explaining the choice.',
    '',
    'Reply with JSON only, shaped like {"items": [{"id": "i1", "kind": "none", "why": "reading homework"}]}, ' +
      'with one entry for every item.',
    '',
    'Items:',
    JSON.stringify(items, null, 1),
  ].join('\n');
  return [
    {
      role: 'system',
      content:
        "You sort a high school student's school calendar, picking out the assessments and major assignments " +
        'worth putting on their calendar. You answer with JSON only.',
    },
    { role: 'user', content: instructions },
  ];
}

/** Reads the model's answer into {id: {kind, why}}, keeping only known kinds. */
function parseChoiceReply_(content, kinds) {
  var text = String(content || '')
    .replace(/```(?:json)?/gi, '')
    .trim();
  var start = text.search(/[\[{]/);
  var end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (start === -1 || end <= start) throw new Error("the AI's answer wasn't JSON");
  var data;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error("the AI's answer wasn't valid JSON");
  }
  var list = Array.isArray(data) ? data : data && Array.isArray(data.items) ? data.items : [];
  var out = {};
  list.forEach(function (entry) {
    if (!entry || entry.id === undefined || entry.id === null) return;
    var kind = String(entry.kind || '').trim().toLowerCase();
    if (kind !== 'none' && kinds.indexOf(kind) === -1) return;
    out[String(entry.id)] = {
      kind: kind,
      why: truncate_(String(entry.why || '').replace(/\s+/g, ' ').trim(), 80),
    };
  });
  return out;
}

/**
 * The AI's choices for the items in `decisions` (from classifyItems_):
 * remembered answers, plus new ones for up to ai.maxItemsPerRun items
 * (soonest first), starting no new request after `deadline` (epoch ms).
 * Returns {choices: {uid: {kind, why}}, asked, waiting, repeats, note}.
 * Never throws; problems end up in `note`.
 */
function getAiChoices_(decisions, settings, kindLabels, deadline) {
  var ai = settings.ai;
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var titleCounts = {};
  decisions.forEach(function (d) {
    titleCounts[d.item.summary] = (titleCounts[d.item.summary] || 0) + 1;
  });

  var choices = {};
  var todo = [];
  var current = {};
  var repeats = 0;
  decisions.forEach(function (d) {
    if (titleCounts[d.item.summary] >= CHOICE_REPEAT_LIMIT_) {
      repeats++;
      return;
    }
    var key = CHOICE_PREFIX_ + hash_(d.item.uid);
    current[key] = true;
    var input = choiceInput_(d.item);
    var inputHash = choiceInputHash_(input);
    var cached = null;
    try {
      cached = all[key] ? JSON.parse(all[key]) : null;
    } catch (e) {
      cached = null;
    }
    if (cached && cached.h === inputHash) choices[d.item.uid] = { kind: cached.k, why: cached.w || '' };
    else todo.push({ uid: d.item.uid, input: input, inputHash: inputHash, key: key });
  });
  // Forget answers about items that left the sync window.
  Object.keys(all).forEach(function (key) {
    if (key.indexOf(CHOICE_PREFIX_) === 0 && !current[key]) props.deleteProperty(key);
  });

  var result = { choices: choices, asked: 0, waiting: todo.length, repeats: repeats, note: '' };
  if (!todo.length) return result;
  var apiKey = readApiKey_();
  if (!apiKey && isOllamaCloud_(ai.baseUrl)) {
    result.note = 'The AI is not choosing items yet: add OLLAMA_API_KEY in Project Settings → Script properties.';
    return result;
  }
  var kinds = Object.keys(kindLabels);
  var left = todo.slice(0, Number(ai.maxItemsPerRun));
  try {
    while (left.length && !(deadline && Date.now() > deadline)) {
      var batch = left.splice(0, CHOICE_BATCH_SIZE_);
      var items = batch.map(function (t, i) {
        return Object.assign({ id: 'i' + (i + 1) }, t.input);
      });
      var reply = ollamaChat_(ai, apiKey, buildChoicePrompt_(items, kindLabels), choiceSchema_(kinds), 'Choosing what goes on your calendar');
      var answers = parseChoiceReply_(reply, kinds);
      var values = {};
      batch.forEach(function (t, i) {
        var answer = answers['i' + (i + 1)];
        if (!answer) return;
        choices[t.uid] = answer;
        values[t.key] = JSON.stringify({ h: t.inputHash, k: answer.kind, w: answer.why });
        result.asked++;
      });
      props.setProperties(values);
    }
  } catch (e) {
    result.note = 'The AI stopped choosing items this time (' + e.message + '). The keyword rules decided the rest.';
  }
  result.waiting = todo.length - result.asked;
  return result;
}

/**
 * Replaces keyword decisions with the AI's choices where it made one, while
 * your own extraExcludeKeywords, extraKeywords and turned-off kinds win.
 */
function applyAiChoices_(decisions, choices, settings) {
  var userExcludes = keywordMatchers_(settings.extraExcludeKeywords);
  var userKinds = Object.keys(settings.categories || {}).map(function (key) {
    var c = settings.categories[key] || {};
    return { key: key, enabled: c.enabled !== false, matchers: keywordMatchers_(c.extraKeywords) };
  });
  return decisions.map(function (d) {
    var choice = choices[d.item.uid];
    if (!choice) return d;
    var title = d.item.title || d.item.summary || '';
    function decide(include, category, reason) {
      return { item: d.item, result: { include: include, category: category, reason: reason, byAi: true } };
    }
    var excluded = firstKeywordMatch_(userExcludes, title);
    if (excluded) return decide(false, null, 'your extraExcludeKeywords has "' + excluded + '"');
    for (var i = 0; i < userKinds.length; i++) {
      var keyword = firstKeywordMatch_(userKinds[i].matchers, title);
      if (!keyword) continue;
      var key = userKinds[i].key;
      return userKinds[i].enabled
        ? decide(true, key, 'your extraKeywords for ' + key + ' has "' + keyword + '"')
        : decide(false, key, 'looks like a ' + key + ', but ' + key + ' is turned off');
    }
    var why = choice.why ? ': ' + choice.why : '';
    if (choice.kind === 'none') return decide(false, null, 'AI says skip' + why);
    var category = settings.categories[choice.kind];
    if (!category) return d;
    if (category.enabled === false) {
      return decide(false, choice.kind, 'AI says ' + choice.kind + ', but ' + choice.kind + ' is turned off');
    }
    return decide(true, choice.kind, 'AI says ' + choice.kind + why);
  });
}
