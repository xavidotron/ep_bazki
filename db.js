var fs = require('fs');
var regexpEscape = require('escape-regexp');
var startsWith = require("underscore.string/startsWith");
var endsWith = require("underscore.string/endsWith");
var queue = require("queue-async");
const assert = require('assert').strict;
var yaml = require('js-yaml');
var deepEqual = require('deep-equal');

var AuthorManager = require("ep_etherpad-lite/node/db/AuthorManager");
var GroupManager = require("ep_etherpad-lite/node/db/GroupManager");
var PadManager = require("ep_etherpad-lite/node/db/PadManager");
var PadMessageHandler = require("ep_etherpad-lite/node/handler/PadMessageHandler");

var util = require('./util');

exports.pad_to_path = function (pad) {
  return pad.path;
};

exports.groupid_to_project = function (groupid) {
  if (groupid in groupid_to_project) {
    return groupid_to_project[groupid];
  } else {
    return null;
  }
}

var groupid_to_project = {}

exports.get_groupid = async function (project, callback) {
  assert(!callback);
  let data = await GroupManager.createGroupIfNotExistsFor(project);
  groupid_to_project[data.groupID] = project;
  return data.groupID;
}

exports.get_project_pad = async function(project, path, subid, callback) {
  assert(!callback);
  // subid is optional.
  if (subid) {
    assert.equal(typeof subid, 'string');
    subid = '~' + subid;
  } else {
    subid = '';
  }
  let groupid = await exports.get_groupid(project);
  var partial_padid = util.path_to_padid(path) + subid;
  var full_padid = groupid + '$' + partial_padid;
  let exists = await PadManager.doesPadExist(full_padid);
    
  if (!exists) {
    // Create via GroupManager so that we get it associated with the group
    // in the DB.
    await GroupManager.createGroupPad(groupid, partial_padid, '')
  }

  let pad = await PadManager.getPad(full_padid, '');
  pad.path = path;
  return pad;
}

exports.macroForPad = function (project, pad) {
  var match = /\\name\{([^{}]+)\{\}\}/.exec(pad.atext.text);
  if (match) {
    return match[1];
  } else {
    return null;
  }
}

var FIELD_FLAVORS = {
  owner: 'comment',
  status: 'comment',
  note: 'comment',
};

// entry starts after the starting {
function parseFields(entry, subs, onsub) {
  var parsed = [];
  var depth = 1;
  var ci = 0;
  var in_key = false;
  while (depth > 0 && ci < entry.length) {
    if (entry[ci] == '}') {
      depth -= 1;
      if (depth == 1 && subs && parsed[parsed.length - 1][0] in subs) {
        var len = parsed[parsed.length - 1][1].length;
        var start = ci - len;
        var newv = subs[parsed[parsed.length - 1][0]];
        delete subs[parsed[parsed.length - 1][0]];
        onsub(start, len, newv);
        parsed[parsed.length - 1][1] = newv;
      }
      if (subs && Object.keys(subs).length > 0 && depth == 0) {
        // Add field case.
        var newls = '';
        for (var k in subs) {
          parsed.push([k, subs[k]]);
          if (FIELD_FLAVORS[k] == 'comment') {
            var bits = subs[k].split('\n');
            newls += '  % ' + k + ': ' + bits[0] + '\n';
            for (var i = 1; i < bits.length; ++i) {
              newls += '  %   ' + bits[i] + '\n';
            }
          } else {
            var spaces = '';
            for (var i = 0; i < 8 - k.length; ++i) {
              spaces += ' ';
            }
            newls += '  \\s\\MY' + k + spaces + '{' + subs[k] + '}\n';
          }
        }
        onsub(ci, 0, newls);
      }
    }
    if (depth > 1 || (depth == 1 && entry[ci] == '}'
                      && parsed[parsed.length - 1][0] == '!')) {
      parsed[parsed.length - 1][1] += entry[ci];
    } else if (entry[ci] != '\n' && entry[ci] != '}') {
      var m3 = /^\\(?:r?s\\MY([a-zA-Z]+)|([a-z]+)name(?:\[[^\]]+\])?)[ \n\t]*\{/.exec(entry.slice(ci));
      if (m3) {
        parsed.push([m3[1] || m3[2], '']);
        ci += m3[0].length - 1;
      } else {
        var m4 = /^% ([^:]+): (.*\n(?: *%  .*\n| *% *\n)*)/
          .exec(entry.slice(ci));
        if (m4) {
          // comment-flavor fields
          var key = m4[1];
          if (subs && key in subs) {
            onsub(ci + m4[0].length - m4[2].length, m4[2].length - 1,
                  subs[key].replace(/\n/g, '\n  %   '));
            parsed.push([key, subs[key]]);
            delete subs[key];
          } else {
            var val = m4[2].slice(0, -1).replace(/^ *% {0,3}/mg, '');
            parsed.push([key, val]);
          }
          ci += m4[0].length;
          continue;
        } else {
          if (parsed.length > 0 && parsed[parsed.length - 1][0] == '!') {
            parsed[parsed.length - 1][1] += entry[ci];
          } else if (entry[ci] != ' ') {
            parsed.push(['!', entry[ci]]);
          }
        }
      }
    }
    if (entry[ci] == '{') {
      depth += 1;
    }
    ++ci;
  }
  return parsed;
}

async function parseFieldsForMacro(project, list, macro, subs, authorid, callback) {
  assert(!callback);
  const list_pad = await exports.get_project_pad(project, list);

  var data = list_pad.atext.text;      
  var re = new RegExp('^( *\\\\NEW\\{)([^}]+)(\\}\\{' + regexpEscape(macro)
                      + '\\}\\{)', 'gm');
  var m2 = re.exec(data);
  
  if (m2) {
    if (subs && 'type' in subs) {
      var changeset = util.makeReplaceChangeset(
        data, m2.index, m2[0].length, m2[1] + subs.type + m2[3]);
      list_pad.appendRevision(changeset, authorid);
      PadMessageHandler.updatePadClients(list_pad, function () {});
      // This works but is a confusing contract.
      return true;
    }
    
    var parsed = parseFields(
      data.slice(re.lastIndex), subs,
      function (start, len, newv) {
        var changeset = util.makeReplaceChangeset(
          data, re.lastIndex + start, len, newv);
        list_pad.appendRevision(changeset, authorid);
        PadMessageHandler.updatePadClients(list_pad, function () {});
      });
    if (parsed) {
      parsed = [['type', m2[2]]].concat(parsed);
    }
    return parsed;
  } else {
    return null;
  }
}

exports.mapEntriesFromList = async function (project, list, callback) {
  assert(!callback);
  var field_set = {};
  const list_pad = exports.get_project_pad(project, list);

  var data = list_pad.atext.text;
  var re = new RegExp('^ *\\\\(?:NEW\\{([^}]+)\\}|updatemacro)\\{(\\\\[a-zA-Z]+)\\}\\{',
                      'gm');
  var m;
  var maps = [];
  while ((m = re.exec(data))) {
    console.log(m[0], m[2]);
    var parsed = parseFields(data.slice(re.lastIndex));
    var map = {};
    for (var i = 0; i < parsed.length; ++i) {
      map[parsed[i][0]] = parsed[i][1];
      field_set[parsed[i][0]] = true;
    }
    map.macro = m[2];
    map.type = m[1];
    map.list = list;
    if (map.file) {
      map.path = util.directoryForClass(project,
                                        util.classForList(list)) + map.file;
      if (!/\.[^/]+$/.exec(map.file)) {
        map.path += '.tex';
      }
    }
    maps.push(map);
  };

  var dir = util.directoryForClass(project, util.classForList(list));
  // Not all lists correspond to a directory of files, so this may be null.
  if (dir) {
    fs.readdir(
      util.get_checkout(project) + dir,
      function (error, contents) {
        if (error) { callback(error); return; }
        
        var dirset = {};
        for (var i = 0; i < contents.length; ++i) {
          dirset[contents[i]] = true;
        }
        for (var i = 0; i < maps.length; ++i) {
          if (maps[i].file && (maps[i].file in dirset
                               || maps[i].file + '.tex' in dirset)) {
            maps[i].file_exists = true;
          } else {
            maps[i].file_exists = false;
          }
        }
        
        return [maps, Object.keys(field_set)];
      });
  } else {
    return [maps, Object.keys(field_set)];
  }
};

async function getMapYaml(project, path, callback) {
  assert(!callback);
  const pad =exports.get_project_pad(
    project, path);

  var data = yaml.safeLoad(pad.atext.text);
  data.path = path.replace(/\.yaml$/, '.tex');
  data.file = /[^\/]*$/.exec(data.path)[0];
  return data;
}

exports.mapYamlFromDirectory = function (project, dir, callback) {
  assert(endsWith(dir, '/'));
  fs.readdir(util.get_checkout(project) + dir, function (error, contents) {
    contents.sort();
    var q = queue();
    var mapmap = {};
    var texes = [];
    for (var i = 0; i < contents.length; ++i) {
      if (endsWith(contents[i], '.yaml')) {
        q.defer(function (path, cb) {
          getMapYaml(project, path, function (error, data) {
            if (error) { cb(error); return; }
            mapmap[data.file] = data;
            cb();
          });
        }, dir + contents[i]);
      } else if (endsWith(contents[i], '.tex')) {
        texes.push(contents[i]);
      }
    }
    q.await(function (error) {
      if (error) { callback(error); return; }
      
      var maps = [];
      for (var k in mapmap) {
        maps.push(mapmap[k]);
      }
      for (var i = 0; i < texes.length; ++i) {
        if (texes[i] in mapmap) {
          mapmap[texes[i]].file_exists = true;
        } else {
          maps.push({file: texes[i], path: dir + texes[i], file_exists: true});
        }
      }

      for (var i = 0; i < maps.length; ++i) {
        maps[i].name = maps[i].file
          .replace(/\.tex$/, '')
          .replace(/\b[a-z]/g, function (c) {return c.toUpperCase(); })
          .replace('-', ' and ');
        maps[i].name_readonly = true;
      }

      callback(null, maps);
    });
  });
}

METADATA_LISTENERS = {};

exports.getMetadataFromPad = function (project, pad, callback) {
  if (!(project in METADATA_LISTENERS)) {
    METADATA_LISTENERS[project] = {};
  }
  METADATA_LISTENERS[project][pad.id] = true;
  
  var macro = exports.macroForPad(project, pad);
  if (macro) {
    var list = util.listForPath(project, exports.pad_to_path(pad));
    parseFieldsForMacro(
      project, list, macro, null, null, 
      function (error, parsed) {
        if (error) { callback(error); return; }
        if (parsed != null) {
          callback(null, macro, parsed);
        } else {
          callback(null,
                   "No list entry found for " + macro + " in " + list + ".");
        }
      });
  } else {
    callback(null, "No \\name{} found.");
  }
};

exports.updateMetadataForPad = function (project, pad) {
  exports.getMetadataFromPad(project, pad, function (error, macro, metadata) {
    if (error) { console.log("metadata", error); return; }
    
    var msg = {
      type: "COLLABROOM",
      data: {
        type: "CUSTOM",
        payload: {
          padId: pad.id + '~body',
          macro: macro,
          metadata: metadata,
        },
      }
    };
    PadMessageHandler.handleCustomObjectMessage(msg, null, function(){});
  });
};

exports.refreshMetadataForProject = function (project) {
  for (var padid in METADATA_LISTENERS[project]) {
    PadManager.getPad(padid, '').then((pad) => {
      exports.updateMetadataForPad(project, pad);
    });
  }
}

exports.refreshMapEntriesForList = async function (project, list, callback) {
  assert(!callback);
  const [maps, group_id] = await Promise.all([
    exports.mapEntriesFromList(project, list),
    exports.get_groupid(project),
  ]);
      
  var msg = {
    type: "COLLABROOM",
    data: {
      type: "CUSTOM",
      payload: {
        padId: group_id + '$!status',
        list: list,
        maps: maps,
      },
    }
  };
  PadMessageHandler.handleCustomObjectMessage(msg, null, function(){});
}

exports.refreshMapYaml = async function (project, path, callback) {
  assert(!callback);
  const [map, group_id] = await Promise.all([
    getMapYaml(project, path),
    exports.get_groupid(project),
  ]);
      
  var msg = {
    type: "COLLABROOM",
    data: {
      type: "CUSTOM",
      payload: {
        padId: group_id + '$!status',
        maps: [map],
      },
    }
  };
  PadMessageHandler.handleCustomObjectMessage(msg, null, function(){});
}

exports.setMacroMetadata = function (project, list, macro, key, value, authorid) {
  var subs = {};
  subs[key] = util.sanitizeTex(value);
  parseFieldsForMacro(
    project, list, macro, subs, authorid,
    function (error, parsed) {
      if (error) { console.log('failed set', error); return; }
      if (parsed == null) {
        console.log('missing set', macro);
      }
    });
}

exports.setFileMetadata = async function (project, path, key, value, authorid, callback) {
  assert(!callback);
  const pad = await exports.get_project_pad(
    project, path.replace(/\.tex$/, '.yaml'));

  var md = yaml.safeLoad(pad.atext.text);
  if (md == null) {
    md = {};
  }
  md[key] = value;
  var new_yaml = yaml.safeDump(md);console.log('d', new_yaml);
  exports.setPadTxt(pad, new_yaml, authorid);console.log('e');
}

var under_setPad = false;

exports.isInternalEdit = function () {
  return under_setPad;
}

function setPad(pad, from, to, authorid) {
  if (deepEqual(from, to)) {
    return false;
  }
  under_setPad = true;
  var changeset = util.makeChangeset(from, to, pad.apool());
  // console.log("PU", pad.atext.text.length, changeset);
  pad.appendRevision(changeset, authorid);
  PadMessageHandler.updatePadClients(pad, function () {});
  under_setPad = false;
  return true;
}

exports.setPadTex = function (pad, data, authorid, appendp) {
  var from = util.atextToTaggedChars(pad);
  var to = util.texToTaggedChars(data);

  if (appendp) {
    to = from.concat(to);
  }
  return setPad(pad, from, to, authorid);
}

exports.setPadTxt = function (pad, data, authorid, appendp) {
  var from = util.atextToTaggedChars(pad);
  var to = util.plainTaggedChars(data);
  if (appendp) {
    to = from.concat(to);
  }
  setPad(pad, from, to, authorid);
}

exports.copyPad = function (from, to, authorid) {
  setPad(to, util.atextToTaggedChars(to), util.atextToTaggedChars(from),
         authorid);
}
