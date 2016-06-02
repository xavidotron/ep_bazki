var jsdifflib = require('jsdifflib');
var fs = require('fs');
var deepEqual = require('deep-equal');
var startsWith = require("underscore.string/startsWith");
var endsWith = require("underscore.string/endsWith");
var assert = require('assert');
var crypto = require('crypto');
var unorm = require('unorm');

var Changeset = require("ep_etherpad-lite/static/js/Changeset");

exports.nlFormat = function (bit, op) {
  var nlcnt = 0;
  var afterLastNl = -1;
  for (var i = 0; i < bit.length; ++i) {
    if (bit[i][0] == '\n') {
      nlcnt += 1;
      afterLastNl = i + 1;
    }
  }
  var opstr = '';
  if (nlcnt > 0) {
    opstr += '|' + nlcnt.toString(36) + op + afterLastNl.toString(36);
    bit = bit.slice(afterLastNl);
  }
  if (bit.length > 0) {
    opstr += op + bit.length.toString(36);
  }
  return opstr;
}

function putAttrib(apool, key, value) {
  return apool.putAttrib([key, value]).toString(36);
}

exports.makeChangeset = function (from, to, apool) {
  // console.log('from', from);
  // console.log('to', to);
  var sm = new jsdifflib.SequenceMatcher(from, to,
                                         function (c) { return false; });
  var opcodes = sm.get_opcodes();
  /*console.log('opcodes');
  for (var i = 0; i < opcodes.length; ++i) {
    if (opcodes[i][0] == 'equal') {
      console.log(opcodes[i]);
    } else {
      console.log(opcodes[i], from.slice(opcodes[i][1], opcodes[i][2]),
                  to.slice(opcodes[i][3], opcodes[i][4]));
    }
  }*/
  var opstr = 'Z:';
  var bank = '';
  var list_stack = [];
  var last_list = 0;
  opstr += from.length.toString(36);
  if (to.length >= from.length) {
    opstr += '>' + (to.length - from.length).toString(36);
  } else {
    opstr += '<' + (from.length - to.length).toString(36);
  }
  for (var i = 0; i < opcodes.length; ++i) {
    if (opcodes[i][0] == 'equal' && (opcodes[i][2] != from.length ||
                                     opcodes[i][4] != to.length)) {
      opstr += exports.nlFormat(from.slice(opcodes[i][1], opcodes[i][2]), '=');
    }
    if (opcodes[i][0] == 'replace' || opcodes[i][0] == 'delete') {
      opstr += exports.nlFormat(from.slice(opcodes[i][1], opcodes[i][2]), '-')
    }
    if (opcodes[i][0] == 'replace' || opcodes[i][0] == 'insert') {
      // Find areas with same attrs.
      var subi = opcodes[i][3];
      while (subi < opcodes[i][4]) {
        skip_bank = false;
        var start = subi;
        var fchars = to[subi].slice(1);
        ++subi;
        while (subi < opcodes[i][4] && fchars == to[subi].slice(1)) {
          ++subi;
        }
        if (fchars) {
          for (var j = 0; j < fchars.length; ++j) {
            if (/\d/.exec(fchars[j])) {
              // It's a list item or heading start char.
              var level = parseInt(fchars[j]);
              if (to[start][0] == 'h') {
                opstr += '*' + putAttrib(apool, 'heading', 'h' + fchars[j])
                  + '*' + putAttrib(apool, 'insertorder', 'first')
                  + '*' + putAttrib(apool, 'lmkr', '1');
              } else {
                // First, reset the list_stack if we've had a line break since
                // the last list, unless it was the most recent character.
                for (var k = last_list; k < start - 1; ++k) {
                  if (to[k][0] == '\n') {
                    list_stack = [];
                  }
                }
                last_list = start;
                opstr += '*' + putAttrib(
                    apool, 'list',
                    ltchar_to_list_type[to[start][0]] + fchars[j])
                  + '*' + putAttrib(apool, 'lmkr', '1');
                while (level > list_stack.length) {
                  list_stack.push(0);
                }
                while (level < list_stack.length) {
                  list_stack.pop();
                }
                list_stack[list_stack.length - 1] += 1;
                opstr += '*' + putAttrib(apool, 'start', 
                                         list_stack[list_stack.length - 1]);
              }
              bank += '*';
              skip_bank = true;
            } else {
              var attr = fchar_to_attr(fchars[j]);
              if (!attr) {
                console.error("Unknown fchar " + fchars[j] + '!');
              }
              if (fchars[j] in HAS_ARG) {
                opstr += '*' + putAttrib(apool, attr, fchars[j + 1]);
                ++j;
              } else {
                opstr += '*' + putAttrib(apool, attr, 'true');
              }
            }
          }
        }
        opstr += exports.nlFormat(to.slice(start, subi), '+');
        if (!skip_bank) {
          var added = to.slice(start, subi);
          for (var j = 0; j < added.length; ++j) {
            bank += added[j][0];
          }
        }
      }
    }
  }
  return opstr + "$" + bank;
};

exports.makeReplaceChangeset = function (data, start, len, newv) {
  var oldv = data.slice(start, start + len);
  var changeset = 'Z:' + data.length.toString(36);
  if (newv.length >= oldv.length) {
    changeset += '>' + (newv.length - oldv.length).toString(36);
  } else {
    changeset += '<' + (oldv.length - newv.length).toString(36);
  }
  changeset += exports.nlFormat(data.slice(0, start), '=');
  changeset += exports.nlFormat(oldv, '-');
  changeset += exports.nlFormat(newv, '+');
  changeset += '$' + newv;
  return changeset;
};

var format_map = {
  b: ['textbf', 'bold'],
  i: ['emph', 'italic'],
  u: ['underline', 'underline'],
  s: ['sout', 'strikethrough'],
  n: [null, 'newline'],
  '{': [null, 'emptyarg'],
};
var HAS_ARG = {
  n: true,
}

var tex_to_fchar = {};
var attr_to_fchar = {};
for (var k in format_map) {
  tex_to_fchar[format_map[k][0]] = k;
  attr_to_fchar[format_map[k][1]] = k;
}

var list_type_to_ltchar = {
  'number': '#',
  'bullet': '*',
  'indent': '_',
};
var ltchar_to_list_type = {};
for (var k in list_type_to_ltchar) {
  ltchar_to_list_type[list_type_to_ltchar[k]] = k;
}

var tex_to_ltchar = {
  'enum': '#',
  'itemz': '*',
  'quotation': '_',
};
var ltchar_to_tex = {}
for (var k in tex_to_ltchar) {
  ltchar_to_tex[tex_to_ltchar[k]] = k;
}
var tex_to_heading = {
  'section*': 2,
  'subsection*': 3,
  'subsubsection*': 4,
  'paragraph': 5,
};
var heading_to_tex = {};
for (var k in tex_to_heading) {
  heading_to_tex[tex_to_heading[k]] = k;
}

var tex_cmd_to_uchar = {
  'ldots': '…',
  'ae': 'æ',
  '_': '_',
}
// These are all the combining characters for the accent.
var tex_cmd_to_accent = {
  "`": '\u0300',
  "'": '\u0301',
  '^': '\u0302',
  '~': '\u0303',
  '=': '\u0304',
  '"': '\u0308',
  'v': '\u030C',
  'c': '\u0327',
}
var tex_char_to_uchar = {
  "``": '“',
  "''": '”',
  "`": '‘',
  "'": '’',
  "---": '—',
  "--": '–',
}
var uchar_to_tex = {};
for (var k in tex_cmd_to_uchar) {
  var cmd;
  if (/^[^a-zA-Z*]$/.exec(k)) {
    cmd = '\\' + k;
  } else {
    cmd = '\\' + k + '{}';
  }
  uchar_to_tex[tex_cmd_to_uchar[k]] = cmd;
}
for (var k in tex_cmd_to_accent) {
  var letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (var i = 0; i < letters.length; ++i) {
    var norm = unorm.nfc(letters[i] + tex_cmd_to_accent[k]);
    if (norm.length == 1) {
      uchar_to_tex[norm] = '\\' + k + '{' + letters[i] + '}';
    }
  }
}
for (var k in tex_char_to_uchar) {
  uchar_to_tex[tex_char_to_uchar[k]] = k;
}

function fchar_to_tex(fchar) {
  if (fchar in format_map) {
    return format_map[fchar][0];
  } else {
    return null;
  }
}
function fchar_to_attr(fchar) {
  if (fchar in format_map) {
    return format_map[fchar][1];
  } else {
    return null;
  }
}

exports.plainTaggedChars = function (str) {
  var ret = [];
  for (var i = 0; i < str.length; ++i) {
    if ((i == 0 || str[i - 1] == '\n') && str[i] == '\t') {
      var n = 1;
      while (i + 1 < str.length && str[i + 1] == '\t') {
        ++n;
        ++i;
      }
      ret.push('_' + n);
    } else {
      ret.push(str[i]);
    }
  }
  return ret;
}

exports.taggedCharsToPlainText = function (tchars) {
  var ret = '';
  for (var i = 0; i < tchars.length; ++i) {
    if (tchars[i][0] == '_') {
      var target_level = parseInt(tchars[i].slice(1));
      if (!Number.isNaN(target_level)) {
        for (var j = 0; j < target_level; ++j) {
          ret += '\t';
        }
        continue;
      }
    }
    ret += tchars[i][0];
  }
  return ret;
}

exports.texToTaggedChars = function (str) {
  var ret = []

  function push_all(s) {
    for (var i = 0; i < s.length; ++i) {
      ret.push(s[i]);
    }
  }

  var re = /^\\begin\{([a-zA-Z*]+)\}[\[\n]?|^\\end\{([a-zA-Z*]+)\}\n?|\\([a-zA-Z*]+|[^a-zA-Z*])\{|\\([^a-zA-Z*])|^(\\item ?)|[{}]|\]|\n *|[`'-]+/mg;
  var m;
  var stack = [];
  var last_point = 0;
  var list_stack = [];
  while ((m = re.exec(str))) {
    push_all(str.slice(last_point, m.index));
    last_point = re.lastIndex;
    if (m[0] == '\\{' || m[0] == '\\}') {
      // Fall through.
    } else if (m[0] == '{') {
      stack.push(false);
    } else if (m[0] == '}') {
      var markup = stack.pop();
      if (markup) {
        var cmd = markup[0].slice(1, -1);
        if (cmd in tex_to_heading) {
          ret.splice(markup[1], 0, 'h' + tex_to_heading[cmd]);
        } else if (cmd in tex_cmd_to_uchar) {
          if (/^[^a-zA-Z*]$/.exec(cmd)) {
            ret.push(tex_cmd_to_uchar[cmd] + '{');
          } else {
            ret.push(tex_cmd_to_uchar[cmd]);
          }
        } else if (cmd in tex_cmd_to_accent) {
          // This doesn't handle multi-char args properly, but how often does
          // that come up?
          ret[ret.length - 1] = unorm.nfc(ret[ret.length - 1]
                                          + tex_cmd_to_accent[cmd])
        } else {
          for (var i = markup[1]; i < ret.length; ++i) {
            ret[i] = ret[i][0] + tex_to_fchar[cmd] + ret[i].slice(1);
          }
        }
        // Don't push it.
        continue;
      } else {
        // Fall through.
      }
    } else if (m[0] == ']' && stack.length 
               && stack[stack.length - 1][0] == '[') {
      var markup = stack.pop();
      for (var i = markup[1]; i < ret.length; ++i) {
        ret[i] = ret[i][0] + markup[2] + ret[i].slice(1);
      }
      // Don't push it.
      continue;
    } else if (m[5] && list_stack.length > 0) {
      // List item, possibly with space
      if (startsWith(ret[ret.length - 1], ' n')) {
        ret[ret.length - 1] = '\n';
        for (var i = 0; i < parseInt(ret[ret.length - 1].slice(2)); ++i) {
          ret.push(' ');
        } 
      }
      ret.push(tex_to_ltchar[list_stack[list_stack.length - 1][0]]
               + list_stack.length);
      continue;
    } else {
      if (m[3]) {
          if (m[3] in tex_to_fchar || m[3] in tex_to_heading
              || m[3] in tex_cmd_to_uchar || m[3] in tex_cmd_to_accent) {
            stack.push(['\\' + m[3] + '{', ret.length]);
            continue;
          } else {
            stack.push(false);
          }
      } else if (m[4]) {
        // Single character macro with no arg
        if (m[4] in tex_cmd_to_uchar) {
          ret.push(tex_cmd_to_uchar[m[4]]);
          continue;
        }
      } else if (m[1]) {
        // \begin{} case
        if (m[1] in tex_to_ltchar) {
          list_stack.push([m[1], ret.length]);
          if (m[1] == 'quotation') {
            ret.push('_' + list_stack.length);
          } else if (m[0].slice(-1) == '[') {
            // We treat the optional argument for tlist-style list environments
            // as a bold line.
            stack.push(['[', ret.length, 'b']);
          }
          continue;
        }
      } else if (m[2]) {
        // \end{} case
        if (startsWith(ret[ret.length - 1], ' n')) {
          ret[ret.length - 1] = '\n';
          for (var i = 0; i < parseInt(ret[ret.length - 1].slice(2)); ++i) {
            ret.push(' ');
          }
        }
        if (list_stack.length && list_stack[list_stack.length - 1][0] == m[2]) {
          var prev = list_stack.pop();
          if (prev[0] == 'quotation') {
            for (var i = prev[1]; i < ret.length - 1; ++i) {
              if (ret[i][0] == '\n') {
                ret.splice(i + 1, 0, '_' + (list_stack.length + 1));
                ++i;
              }
            }
          }
          continue;
        }
      } else if (m[0][0] == '\n' && list_stack.length > 0 
                 && list_stack[list_stack.length - 1][0] != 'quotation') {
        ret.push(' n' + m[0].slice(1).length);
        continue;
      } else if (m[0] in tex_char_to_uchar) {
        ret.push(tex_char_to_uchar[m[0]]);
        continue;
      }
    }
    push_all(m[0]);
  }
  push_all(str.slice(last_point));
  while (stack.length) {
    var markup = stack.pop();
    if (!markup) {
      continue;
    }
    var chars = [];
    for (var i = 0; i < markup[0].length; ++i) {
      chars.push(markup[0][i]);
    }
    ret.splice.apply(ret, [markup[1], 0].concat(chars));
  }
  return ret;
};

exports.atextToTaggedChars = function (pad, include_raw) {
  var ret = [];
  for (var i = 0; i < pad.atext.text.length; ++i) {
    ret.push(pad.atext.text[i]);
  }

  var opi = Changeset.opIterator(pad.atext.attribs);
  var index = 0;
  while (opi.hasNext()) {
    var op = opi.next();
    for (var i = 0; i < op.chars; ++i) {
      var attribs = op.attribs.split('*');
      // First entry is just empty, so start at 1.
      for (var j = 1; j < attribs.length; ++j) {
        var attridx = parseInt(attribs[j], 36);
        var attr = pad.apool().getAttrib(attridx);
        if (!attr) {
          console.log(op.attribs, attribs, j, attribs[j], attridx, attr);
          continue;
        }
        if (attr[1] && attr[0] in attr_to_fchar) {
          if (attr_to_fchar[attr[0]] in HAS_ARG) {
            ret[index] += attr_to_fchar[attr[0]] + attr[1];
          } else {
            ret[index] += attr_to_fchar[attr[0]];
          }
        } else if (attr[0] == 'list') {
          var list_type = list_type_to_ltchar[attr[1].slice(0, 6)];
          if (list_type) {
            ret[index] = list_type;
            var lev = parseInt(attr[1].slice(6));
            ret[index] += lev;
          }
        } else if (attr[0] == 'heading') {
          ret[index] = attr[1];
        }
        if (include_raw) {
          ret[index] += '{' + attr[0] + '=' + attr[1] + '}';
        }
      }
      ++index;
    }
  }
  // console.log(ret);
  return ret;
}

exports.taggedCharsToTex = function (tchars) {
  var ret = '';
  var fchars = [];
  var list_stack = [];
  var before_next_nl = '';
  var curr = null;

  for (var i = 0; i < tchars.length; ++i) {
    if (Number.isNaN(tchars[i])) { console.log('tcharsi', tchars[i]); }
    var last = curr;
    curr = tchars[i][0];
    var nextFchars = tchars[i].slice(1);
    
    if (startsWith(nextFchars, 'n')) {
      ret += '\n';
      for (var j = 0; j < parseInt(nextFchars.slice(1)); ++j) {
        ret += ' ';
      } 
      continue;
    }

    while (fchars.length > nextFchars.length 
           || (fchars.length > 0 
               && fchars != nextFchars.slice(0, fchars.length))) {
      if (fchar_to_tex(fchars[fchars.length - 1])) {
        ret += '}';
      }
      fchars = fchars.slice(0, fchars.length - 1);
    }
    var target_level = parseInt(nextFchars);
    if (target_level) {
      if (curr == 'h') {
        ret += '\\' + heading_to_tex[target_level] + '{';
        before_next_nl = '}';
      } else {
        var ltype = ltchar_to_tex[curr];
        while (target_level > list_stack.length) {
          ret += '\\begin{' + ltype + '}\n';
          if (list_stack.length + 1 < target_level && ltype != 'quotation') {
            ret += '\\item ';
          }
          list_stack.push(ltype);
        }
        while (target_level < list_stack.length) {
          ret += '\\end{' + list_stack.pop() + '}\n';
        }
        if (list_stack[list_stack.length - 1] != 'quotation') {
          ret += '\\item ';
        }
      }
      continue;
    } else {
      if (i > 0 && tchars[i - 1][0] == '\n') {
        while (list_stack.length) {
          ret += '\\end{' + list_stack.pop() + '}\n';
        }
      }
      while (nextFchars.length > fchars.length) {
        var tex = fchar_to_tex(nextFchars[fchars.length]);
        if (tex) {
          ret += '\\' + tex + '{';
        }
        fchars += nextFchars[fchars.length];
      }
    }
    
    if (curr == '\n') {
      ret += before_next_nl;
      before_next_nl = '';
    }
    
    if (curr == '"') {
      if (last == ' ' || last == '\n' || last == null) {
        curr = '“';
      } else {
        curr = '”';
      }
    }
    if (curr == "'") {
      if (last == ' ' || last == '\n' || last == null) {
        curr = '‘';
      } else {
        curr = '’';
      }
    }
    
    if (curr in uchar_to_tex) {
      ret += uchar_to_tex[curr];
      if (fchars.indexOf('{') != -1) {
        ret += '{}';
      }
    } else {
      ret += curr;
    }
  }
  for (var i = 0; i < fchars.length; ++i) {
    ret += '}';
  }
  while (list_stack.length) {
    ret += '\\end{' + list_stack.pop() + '}';
  }
  // Late regexp patches
  ret = ret.replace(/^\\textbf\{(.+)\}( *)\n\\begin\{(enum|itemz)\}$/mg,
                    '\\begin{$3}[$1]$2');
  ret = ret.replace(/\.\.\./g, '\\ldots{}');
  // console.log(ret);
  return ret;
};

exports.path_to_padid = function (path) {
  var md5 = crypto.createHash('md5');
  md5.update(path);
  var padid = md5.digest('hex');
  
  var dotparts = path.split('.');
  if (dotparts.length > 1) {
    padid += '.' + dotparts[dotparts.length - 1];
  }
  return padid;
}

var checkouts_root = "checkouts/";

exports.get_checkout = function (project) {
  return checkouts_root + project + '/';
}

exports.for_each_project = function (f) {
  fs.readdir(checkouts_root, function (error, contents) {
    if (error) { console.log('feg', error); return; }
    
    for (var i = 0; i < contents.length; ++i) {
      if (!startsWith(contents[i], '.')) {
        f(contents[i]);
      }
    }
  });
}

var CLASS_OVERRIDES = {
}
exports.classForDirectory = function (project, dir) {
  assert(endsWith(dir, '/'));
  var type = dir.slice(0, -1);
  if (CLASS_OVERRIDES[project] && CLASS_OVERRIDES[project][type]) {
    return CLASS_OVERRIDES[project][type];
  }
  if (endsWith(type, 's')) {
    type = type.slice(0, -1);
  }
  type = type.toLowerCase();
  if (endsWith(type, 'sheet')) {
    type = type.slice(0, -5);
  }
  return type;
}

var DIRECTORY_NOUNS = {
  Notebooks: "Notebooks",
}

var DIRECTORY_OVERRIDES = {};
exports.directoryForClass = function (project, cls) {
  if (DIRECTORY_OVERRIDES[project] && DIRECTORY_OVERRIDES[project][cls]) {
    return DIRECTORY_OVERRIDES[project][cls] + '/';
  }
  var plural = exports.pluralForClass(project, cls);
  if (endsWith(plural, 'sheets')) {
    return plural + '/';
  } else if (plural in DIRECTORY_NOUNS) {
    return DIRECTORY_NOUNS[plural] + '/';
  } else {
    return null;
  }
}

var COLORS = {
  white: true,
  black: true,
  red: true,
  green: true,
  yellow: true,
  blue: true,
  brown: true,
  purple: true,
  pink: true,
  orange: true,
  gray: true,
  grey: true,
  cyan: true,
  indigo: true,
  violet: true,
  magenta: true,
  tan: true,
};
function s(word) {
  return [word, word + 's'];
}
var CLASS_TO_NOUN = {
  abil: ["Ability", "Abilities"],
  'char': s("Charsheet"),
  combat: s("Combat Card"),
  gm: s("GM"),
  mem: s("Mem Packet"),
  money: ["Money", "Money"],
};
var NOUN_OVERRIDES = {};

exports.singularForClass = function (project, cls) {
  if (project in NOUN_OVERRIDES && cls in NOUN_OVERRIDES[project]) {
    return NOUN_OVERRIDES[project][cls][0];
  } else if (cls in CLASS_TO_NOUN) {
    return CLASS_TO_NOUN[cls][0];
  } else if (cls in COLORS) {
    return cls[0].toUpperCase() + cls.slice(1) + 'sheet';
  } else {
    return cls[0].toUpperCase() + cls.slice(1);
  }
}
exports.pluralForClass = function (project, cls) {
  if (project in NOUN_OVERRIDES && cls in NOUN_OVERRIDES[project]) {
    return NOUN_OVERRIDES[project][cls][1];
  } else if (cls in CLASS_TO_NOUN) {
    return CLASS_TO_NOUN[cls][1];
  } else {
    return exports.singularForClass(project, cls) + 's';
  }
}

exports.setOverridesForProject = function (project, classes) {
  CLASS_OVERRIDES[project] = {};
  DIRECTORY_OVERRIDES[project] = {};
  NOUN_OVERRIDES[project] = {};
  for (var cls in classes) {
    var plural, singular = null;
    if (typeof(classes[cls]) == "string") {
      plural = classes[cls];
    } else {
      plural = classes[cls].plural;
      singular = classes[cls].singular;
    }
    if (!singular) {
      singular = plural.slice(0, -1);
    }
    CLASS_OVERRIDES[project][plural] = cls;
    DIRECTORY_OVERRIDES[project][cls] = plural;
    NOUN_OVERRIDES[project][cls] = [singular, plural];
  }
}

exports.classForList = function (list) {
  return /^Lists\/(.+)-LIST.tex$/.exec(list)[1];
}

exports.listForClass = function (cls) {
  return 'Lists/' + cls + '-LIST.tex';
}

exports.listForPath = function (project, path) {
  var parts = path.split('/');
  assert(parts.length > 1);
  var dir = parts[0] + '/';
  var cls = exports.classForDirectory(project, dir);
  assert.notEqual(cls, null);
  return exports.listForClass(cls);
}

exports.iconClass = function(path) {
  if (endsWith(path, '.inform/')) {
    return 'moon-book';
  } else if (endsWith(path, '/')) {
    return 'moon-folder-o';
  } else if (endsWith(path, '-LIST.tex')) {
    return 'moon-list';
  } else if (endsWith(path, '.tex')) {
    if (startsWith(path, 'Charsheets/')) {
      return 'moon-user-secret';
    } else if (startsWith(path, 'Bluesheets/')) {
      return 'moon-group';
    } else if (startsWith(path, 'Greensheets/')) {
      return 'moon-bolt';
    } else if (startsWith(path, 'Whitesheets/')) {
      return 'moon-newspaper-o';
    } else if (startsWith(path, 'Book/')) {
      return 'moon-book';
    } else {
      return 'moon-file';
    }
  } else if (endsWith(path, '.txt') || /README/.exec(path)) {
    return 'moon-file-text-o';
  } else {
    return 'moon-file-o';
  }
}

exports.basename = function (s) {
  return s.match(/^(.*)\/([^\/]+)$/)[2];
}
exports.dirname = function (s) {
  return s.match(/^(.*)\/([^\/]+)$/)[1];
}

exports.exists = function (path, cb) {
  fs.access(path, function (error) {
    if (error) {
      if (error.code == 'ENOENT') {
        cb(null, false);
      } else {
        cb(error);
      }
    } else {
      cb(null, true);
    }
  });
}

exports.sanitizeTex = function (value) {
  var braces = 0;
  for (var i = 0; i < value.length; ++i) {
    if (value[i] == '{') {
      ++braces;
    } else if (value[i] == '}') {
      if (braces <= 0) {
        value = value.slice(0, i) + value.slice(i + 1);
        --i;
      } else {
        --braces;
      }
    }
  }
  if (braces > 0) {
    var trimmed = value.trimRight();
    var end = value.slice(trimmed.length);
    for (var i = 0; i < braces; ++i) {
      trimmed += '}';
    }
    return trimmed + end;
  } else {
    return value;
  }
}
