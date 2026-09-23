/**
 * AI study advice from Ollama Cloud (https://ollama.com), used by the study
 * planner. For each assessment the AI estimates how much work it is (light,
 * normal or heavy) and lists what to study, in order. The planner uses that
 * for session titles and to adjust study time.
 *
 * Only an assessment's kind, class, title, due date and description are
 * sent. Grades are not. Answers are cached per assessment, so the AI is only
 * asked again when the assessment changes.
 *
 * The API key is read from the script property OLLAMA_API_KEY, never from
 * code, and is never logged.
 */

var OLLAMA_KEY_PROPERTY_ = 'OLLAMA_API_KEY';
var AI_CACHE_PREFIX_ = 'B2C_AI_';
var AI_EFFORTS_ = ['light', 'normal', 'heavy'];

var STUDY_ADVICE_SCHEMA_ = {
  type: 'object',
  properties: {
    assessments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          effort: { type: 'string', enum: AI_EFFORTS_ },
          steps: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'effort', 'steps'],
      },
    },
  },
  required: ['assessments'],
};

/** What the AI is told about an assessment (also what its cached answer depends on). */
function aiInput_(a, kindLabels) {
  return {
    kind: (kindLabels && kindLabels[a.category]) || a.category,
    class: a.course || '',
    title: a.title,
    due: a.date,
    details: truncate_(String(a.details || '').replace(/\s+/g, ' ').trim(), 1200),
  };
}

/** Chat messages asking for advice on `items` ([{id, kind, class, title, due, details}]). */
function buildStudyPrompt_(items) {
  var instructions = [
    'For each assessment below, return an object with:',
    '- "id": the id given.',
    '- "effort": "light", "normal" or "heavy": how much work it is compared with a typical one of its kind. ' +
      'Use "heavy" for cumulative, final, long or multi-unit work, "light" for short or single-topic work, ' +
      'and "normal" when unsure.',
    '- "steps": 2 to 6 short study steps (under 60 characters each), in the order to do them, from the first ' +
      'study session to the last. Name concrete topics from the details when there are any. For tests and ' +
      'quizzes, finish with practice or self-testing. For projects, essays and presentations, use milestones ' +
      '(plan, research, draft, revise, rehearse).',
    '',
    'Reply with JSON only, shaped like {"assessments": [{"id": "a1", "effort": "normal", "steps": ["..."]}]}.',
    '',
    'Assessments:',
    JSON.stringify(items, null, 1),
  ].join('\n');
  return [
    {
      role: 'system',
      content:
        'You help a high school student plan study time. You judge how much work each assessment is and ' +
        'break its preparation into steps. You answer with JSON only.',
    },
    { role: 'user', content: instructions },
  ];
}

/** Reads the model's answer into {id: {effort, steps}}; tolerant of extra text and code fences. */
function parseStudyReply_(content) {
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
  var list = Array.isArray(data) ? data : data && Array.isArray(data.assessments) ? data.assessments : [];
  var out = {};
  list.forEach(function (item) {
    if (!item || item.id === undefined || item.id === null) return;
    var effort = String(item.effort || '').toLowerCase();
    var steps = (Array.isArray(item.steps) ? item.steps : [])
      .map(function (s) {
        return String(s).replace(/\s+/g, ' ').trim();
      })
      .filter(Boolean)
      .slice(0, 8)
      .map(function (s) {
        return truncate_(s, 80);
      });
    out[String(item.id)] = { effort: AI_EFFORTS_.indexOf(effort) !== -1 ? effort : 'normal', steps: steps };
  });
  return out;
}

function isOllamaCloud_(baseUrl) {
  return /^https:\/\/(www\.)?ollama\.com\/?$/i.test(String(baseUrl).trim());
}

/**
 * Calls the Ollama API (GET without payload, POST with). Throws an Error with
 * a readable message; the API key never appears in it.
 */
function ollamaFetch_(ai, apiKey, path, payload) {
  var options = { method: payload ? 'post' : 'get', muteHttpExceptions: true, headers: {} };
  if (apiKey) options.headers.Authorization = 'Bearer ' + apiKey;
  if (payload) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }
  var response;
  try {
    response = UrlFetchApp.fetch(String(ai.baseUrl).trim().replace(/\/+$/, '') + path, options);
  } catch (e) {
    var message = String(e.message);
    if (apiKey) message = message.split(apiKey).join('…');
    throw new Error("couldn't reach Ollama (" + message + ')');
  }
  var code = response.getResponseCode();
  var text = response.getContentText();
  if (code === 200) {
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error("Ollama's answer wasn't readable");
    }
  }
  var detail = '';
  try {
    detail = JSON.parse(text).error || '';
  } catch (e) {
    detail = text;
  }
  detail = truncate_(String(detail).replace(/\s+/g, ' ').trim(), 200);
  if (code === 401 || code === 403) {
    throw new Error('Ollama rejected the API key (HTTP ' + code + '). Check OLLAMA_API_KEY in Project Settings → Script properties.');
  }
  if (code === 404 && path === '/api/chat') {
    throw new Error('Ollama doesn\'t have the model "' + ai.model + '". Run checkAi() to see the models you can use, then set ai.model in Settings.gs.');
  }
  if (code === 429) {
    throw new Error("Ollama's usage limit was reached (HTTP 429). Study sessions get plain titles until it resets.");
  }
  throw new Error('Ollama answered HTTP ' + code + (detail ? ': ' + detail : '') + '.');
}

/** Asks the AI about a batch: [{input}] -> {index: {effort, steps}} keyed like 'a1', 'a2', ... */
function askOllamaForAdvice_(batch, ai, apiKey) {
  var items = batch.map(function (t, i) {
    return Object.assign({ id: 'a' + (i + 1) }, t.input);
  });
  var body = ollamaFetch_(ai, apiKey, '/api/chat', {
    model: ai.model,
    messages: buildStudyPrompt_(items),
    stream: false,
    format: STUDY_ADVICE_SCHEMA_,
    options: { temperature: 0.2 },
  });
  return parseStudyReply_(body && body.message && body.message.content);
}

/**
 * AI advice for `assessments`: cached answers plus fresh ones for up to
 * ai.maxPerRun assessments that are new or changed (soonest first).
 * Returns {advice: {assessmentId: {effort, steps}}, asked, waiting, note}.
 * Never throws: problems end up in `note` and the plan goes on without AI.
 */
function getStudyAdvice_(assessments, settings, kindLabels) {
  var ai = settings.ai;
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var advice = {};
  var todo = [];
  var current = {};
  assessments.forEach(function (a) {
    var key = AI_CACHE_PREFIX_ + hash_(a.id);
    current[key] = true;
    var input = aiInput_(a, kindLabels);
    var inputHash = hash_(JSON.stringify(input));
    var cached = null;
    try {
      cached = all[key] ? JSON.parse(all[key]) : null;
    } catch (e) {
      cached = null;
    }
    if (cached && cached.h === inputHash) advice[a.id] = { effort: cached.effort, steps: cached.steps || [] };
    else todo.push({ a: a, input: input, inputHash: inputHash, key: key });
  });
  // Forget answers about assessments that are gone.
  Object.keys(all).forEach(function (key) {
    if (key.indexOf(AI_CACHE_PREFIX_) === 0 && !current[key]) props.deleteProperty(key);
  });

  var result = { advice: advice, asked: 0, waiting: todo.length, note: '' };
  if (!ai.enabled || !todo.length) return result;
  var apiKey = props.getProperty(OLLAMA_KEY_PROPERTY_);
  if (!apiKey && isOllamaCloud_(ai.baseUrl)) {
    result.note = 'AI is off until you add OLLAMA_API_KEY in Project Settings → Script properties.';
    return result;
  }
  todo.sort(function (x, y) {
    return x.a.date < y.a.date ? -1 : x.a.date > y.a.date ? 1 : 0;
  });
  var batch = todo.slice(0, Number(ai.maxPerRun));
  try {
    var answers = askOllamaForAdvice_(batch, ai, apiKey);
    batch.forEach(function (t, i) {
      var answer = answers['a' + (i + 1)];
      if (!answer) return;
      advice[t.a.id] = answer;
      props.setProperty(t.key, JSON.stringify({ h: t.inputHash, effort: answer.effort, steps: answer.steps }));
      result.asked++;
    });
    result.waiting = todo.length - result.asked;
  } catch (e) {
    result.note = 'AI advice skipped this time: ' + e.message;
  }
  return result;
}

function clearAiCache_() {
  var props = PropertiesService.getScriptProperties();
  Object.keys(props.getProperties()).forEach(function (key) {
    if (key.indexOf(AI_CACHE_PREFIX_) === 0) props.deleteProperty(key);
  });
}
