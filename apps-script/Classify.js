/**
 * Decides which feed items are assessments or major projects, and what kind
 * (test, quiz, project, ...), using the keyword lists in the settings.
 */

/** Case-insensitive whole-word matcher; spaces/hyphens in a phrase match either. */
function keywordRegex_(keyword) {
  var words = String(keyword).trim().split(/[\s\-_]+/).filter(Boolean).map(escapeRegex_);
  return new RegExp('(?:^|[^A-Za-z0-9])' + words.join('[\\s\\-_]+') + '(?=$|[^A-Za-z0-9])', 'i');
}

function keywordMatchers_(keywords) {
  return (keywords || [])
    .map(function (k) {
      return String(k).trim();
    })
    .filter(Boolean)
    .map(function (k) {
      return { keyword: k, re: keywordRegex_(k) };
    });
}

function firstKeywordMatch_(matchers, text) {
  for (var i = 0; i < matchers.length; i++) {
    if (matchers[i].re.test(text)) return matchers[i].keyword;
  }
  return null;
}

/**
 * Splits a feed title into {course, title} using the optional titlePattern
 * (a RegExp with named groups "course" and "title").
 */
function splitTitle_(summary, pattern) {
  if (pattern) {
    var m = pattern.exec(summary);
    if (m && m.groups && m.groups.title) {
      return { course: (m.groups.course || '').trim(), title: m.groups.title.trim() };
    }
  }
  return { course: '', title: summary };
}

/**
 * Returns classify(item) -> {include, category, reason}, where item has
 * title, categories (Blackbaud types from the feed) and description.
 *
 * Order of checks: excluded words in the title, excluded Blackbaud types,
 * then category keywords in the title, the Blackbaud type, and (optionally)
 * the description. The first category with a matching keyword wins.
 */
function buildClassifier_(settings) {
  var excludes = keywordMatchers_((settings.excludeKeywords || []).concat(settings.extraExcludeKeywords || []));
  var excludeTypes = keywordMatchers_(settings.excludeTypes);
  var categories = Object.keys(settings.categories || {}).map(function (key) {
    var c = settings.categories[key] || {};
    return {
      key: key,
      enabled: c.enabled !== false,
      matchers: keywordMatchers_((c.keywords || []).concat(c.extraKeywords || [])),
    };
  });

  function categorize(text, where) {
    if (!text) return null;
    for (var i = 0; i < categories.length; i++) {
      var cat = categories[i];
      var keyword = firstKeywordMatch_(cat.matchers, text);
      if (!keyword) continue;
      if (!cat.enabled) {
        return { include: false, category: cat.key, reason: 'looks like a ' + cat.key + ', but ' + cat.key + ' is turned off' };
      }
      return { include: true, category: cat.key, reason: '"' + keyword + '" in ' + where };
    }
    return null;
  }

  return function classify(item) {
    var title = item.title || item.summary || '';
    var types = (item.categories || []).join(', ');
    var excluded = firstKeywordMatch_(excludes, title);
    if (excluded) {
      return { include: false, category: null, reason: 'title contains excluded word "' + excluded + '"' };
    }
    if (types && firstKeywordMatch_(excludeTypes, types)) {
      return { include: false, category: null, reason: 'Blackbaud type "' + types + '" is excluded' };
    }
    return (
      categorize(title, 'title') ||
      categorize(types, 'Blackbaud type') ||
      (settings.searchDescription ? categorize(item.description, 'description') : null) || {
        include: false,
        category: null,
        reason: 'no assessment/project keywords',
      }
    );
  };
}
