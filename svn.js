var queue = require("queue-async");
var synchd = require("synchronized");
var execFile = require('child_process').execFile;
var fs = require('fs');
var endsWith = require("underscore.string/endsWith");
var startsWith = require("underscore.string/startsWith");
var find = require('findit');
var isBinaryPath = require('is-binary-path');

var Changeset = require("ep_etherpad-lite/static/js/Changeset");
var AuthorManager = require("ep_etherpad-lite/node/db/AuthorManager");
var PadManager = require("ep_etherpad-lite/node/db/PadManager");
var PadMessageHandler = require("ep_etherpad-lite/node/handler/PadMessageHandler");
var hooks = require('ep_etherpad-lite/static/js/pluginfw/hooks');

var util = require('./util');
var db = require('./db');

function usesTexFormatting(name) {
  // Do TeX formatting even for .txt, so things round-trip properly and such.
  // Don't do it for .sty/.cls and such, though.
  // Doing it for SConstruct would be bad, too.
  return endsWith(name, '.tex') || endsWith(name, '.txt');
}

// Ignore files that are binary or .git-type directories, because making pads
// for them won't do anything useful and could mangle them.
function shouldIgnoreFile(file) {
  if (isBinaryPath(file) || /(^|\/)\..+\//.exec(file)) {
    return true;
  } else {
    return false;
  }
}

function setPadDataForPath(project, path, data, author, appendp,
                           force_pad_update, callback) {
  queue().defer(db.get_project_pad, project, path)
    .defer(AuthorManager.createAuthorIfNotExistsFor, author, author)
    .await(function (error, pad, authordata) {
      if (error) {
        if (callback) {
          callback(error);
        } else {
          console.log("setPadDataForPath", error);
        }
        return;
      }
      var updated;
      // Do this for both .tex and .txt, so it roundtrips to SVN losslessly.
      if (usesTexFormatting(path)) {
        updated = db.setPadTex(pad, data, authordata['authorID'], appendp);
      } else {
        updated = db.setPadTxt(pad, data, authordata['authorID'], appendp);
      } 
      if (!updated && force_pad_update) {
        exports.padUpdate(null, {pad: pad, author: authordata['authorID']},
                          callback || function () {});
      } else {
        if (callback) { callback(); }
      }
    });
}

exports.padUpdate = function (hook_name, context, cb) {
  var changed_pad = context.pad;
  var authorid = context.author;
  var name = changed_pad.id;

  if (name.indexOf('~') != -1) {
    // This is an internal pad used by probably ep_gameki. We don't sync it
    // to SVN.
    cb();
    return;
  }

  var namebits = name.split('$');
  if (namebits.length != 2) {
    cb();
    return;
  }
  var project = db.groupid_to_project(namebits[0]);
  var filename = db.pad_to_path(changed_pad);

  var text;
  // Do TeX formatting even for .txt, so things round-trip properly and such.
  // Don't do it for .sty/.cls and such, though.
  if (usesTexFormatting(name)) {
    text = util.taggedCharsToTex(util.atextToTaggedChars(changed_pad));
    var nonascii = text.match(/[^\000-\176]/g);
    if (nonascii) {
      //console.warn("Non ascii characters in", filename, ":", nonascii);
    }
  } else {
    text = util.taggedCharsToPlainText(util.atextToTaggedChars(changed_pad));
  }
  hooks.callAll('bazkiSavingPad', {name: name, text: text, author: authorid});

  AuthorManager.getAuthorName(authorid, function (error, author) {
    if (error) { console.log('authorness', error); return; }
    writeAndAddFile(project, filename, text, author);
  });

  // Don't wait for SVN.
  cb();
}

function writeAndAddFile(project, name, text, author) {
  pending_write = true;
  synchd(project, function (done) {
      fs.writeFile(util.get_checkout(project) + name, text, function (error) {
        if (error) {
          if (error.code == 'ENOENT') {console.log('making', /(.+)\/[^\/]+/.exec(name)[1]);
            exports.mkdir(
              project, /(.+)\/[^\/]+/.exec(name)[1], author,
              function (error) {
                if (error) {
                  console.log("pre commit mkdir", error, author);
                } else {
                  writeAndAddFile(project, name, text, author);
                }
              });
          } else {
            console.log("pre commit", error, author);
          }
        } else {
          if (!(project in pending_commits)) {
            pending_commits[project] = {};
          }
          if (name in pending_commits[project]) {
            if (pending_commits[project][name]
                [pending_commits[project][name].length - 1] != author) {
              pending_commits[project][name].push(author);
            }
          } else {
            pending_commits[project][name] = ['add', author];
          }
        }
        pending_write = false;
        done();
      });
  });
}

exports.mkdir = function (project, directory, author, callback) {
  fs.mkdir(util.get_checkout(project) + directory, function (error) {
    if (!error) {
      if (!(project in pending_commits)) {
        pending_commits[project] = {};
      }
      pending_commits[project][directory] = ['add', author];
    }
    callback(error);
  });
};

exports.rm = function (project, path, author, callback) {
  var checkout = util.get_checkout(project);
  execFile(
    '/usr/bin/svn', ['rm', '--force', path], {'cwd': checkout},
    function (error, stdout, stderr) {
      if (!error) {
        if (!(project in pending_commits)) {
          pending_commits[project] = {};
        }
        pending_commits[project][path] = ['rm', author];  
      }
      callback(error);
    });
}

// Errors leave things in an inconsistent state.  "So don't hit errors."
exports.mv = function (project, path, newpath, author, callback) {
  queue().defer(db.get_project_pad, project, path)
    .defer(db.get_project_pad, project, path, 'body')
    .defer(db.get_project_pad, project, path, 'comment')
    .defer(db.get_groupid, project)
    .defer(AuthorManager.createAuthorIfNotExistsFor, author, author)
    .await(function (error, oldpad, old_body, old_comment, group_id, 
                     authordata) {
      if (error) { callback(error); return; }

      synchd(project, function (done) {
        var checkout = util.get_checkout(project);
        execFile(
          '/usr/bin/svn', ['mv', path, newpath], {'cwd': checkout},
          function (error, stdout, stderr) {
            if (error) { done(); callback(error); return; }
            if (!(project in pending_commits)) {
              pending_commits[project] = {};
            }
            pending_commits[project][path] = ['mv:' + newpath, author];  
            
            var new_id = group_id + '$' + util.path_to_padid(newpath);
            // It'd be more like API.movePad to remove the old pad afterwards,
            // but I'm all like, why bother.  This way, if something goes
            // wrong, we're more likely to be able to recover.
            queue().defer(oldpad.copy.bind(oldpad), new_id, 'true')
              .defer(old_body.copy.bind(old_body), new_id + '~body', 'true')
              .defer(old_comment.copy.bind(old_comment), new_id + '~comment', 
                     'true')
              .await(function (error) {
                done();
                callback(error);
              });
          });
      });
    });
}

exports.new_file = function (project, path, data, author, callback) {
  writeAndAddFile(project, path, '', author);
  setPadDataForPath(project, path, data, author, false, false, callback);
};

// TODO(xavid): merge with above
exports.append_file = function (project, path, data, author, callback) {
  setPadDataForPath(project, path, data, author, true, false, callback);
};

var pending_write = false;
var pending_commits = {};

function read_and_set_pad(project, path, ticker, force_pad_update, callback) {
  var checkout = util.get_checkout(project);
  fs.readFile(
    checkout + path, {encoding: 'utf-8'}, 
    function (error, data) {
      if (error) {
        if (error.code != 'EISDIR') {
          console.error("PROCESSING UPDATE", error);
        }
      } else {
        setPadDataForPath(project, path, data, 'svn', false, force_pad_update);
      }
      if (ticker) {
        ticker.tick();
      }
      callback();
    });
}

function svn_sync_locked(project, ticker, done) {
  if (pending_write) {
    done();
    return;
  }

  var checkout = util.get_checkout(project);
  
  var args = [];
  if (project in pending_commits) {
    for (var k in pending_commits[project]) {
      args.push(k);
      args.push(pending_commits[project][k][0]);
      args.push(pending_commits[project][k].slice(1).join(','));
    }
    //console.log(project, "ARGS", args);
    delete pending_commits[project];
  }
  execFile(
    __dirname + "/bin/svn-sync.sh", args,
    {'cwd': checkout},
    function (error, stdout, stderr) {
      if (error) {
        console.error("UPDATE", error, stderr, checkout);
      } else {
        var lines = stdout.split('\n');
        var q = queue(3);
        var cnt = 0;
        for (var i = 0; i < lines.length; ++i) {
          if (lines[i] == '') {
            continue;
          }
          ++cnt;
          var mod = /^(.)    (.+)$/.exec(lines[i]);
          if (!shouldIgnoreFile(mod[2])) {
            q.defer(read_and_set_pad, project, mod[2], ticker, false);
          }
        }
        if (ticker) {
          ticker.set_target(cnt);
        }
        q.await(done);
      }
    });
}

exports.svn_sync = function (project, ticker, done) {
  synchd.fn(project, svn_sync_locked)(project, ticker, done);
};

function svn_read_all_locked(project, ticker, full_reset, done) {
  var checkout = util.get_checkout(project);
  var finder = find(checkout);
  var files = [];
  finder.on('file', function (file, stat) {
    if (shouldIgnoreFile(file)) {
      // Ignore it.
    } else if (startsWith(file, checkout)) {
      files.push(file.slice(checkout.length));
    } else {
      console.log('WEIRD FILE', file);
    }
  });
  finder.on('directory', function (dir, stat, stop) {
    if (/\/[.][^\/]+$/.exec(dir)) {
      stop();
    }
  });
  finder.on('end', function () {
    var q = queue(1);
    if (ticker) {
      ticker.set_target(files.length);
    }
    for (var i = 0; i < files.length; ++i) {
      var thunk = read_and_set_pad.bind(null, project, files[i], ticker, true);
      if (full_reset) {
        q.defer(function (path, cb) {
          db.get_project_pad(project, path, function (error, pad) {
            if (error) { cb(error); return; }

            pad.remove(function (error) {
              if (error) { cb(error); return; }
              thunk(cb);
            });
          });
        }, files[i]);
      } else {
        q.defer(thunk);
      }
    }
    q.await(done);
  });
}

exports.createSpecialPads = function (project, done) {
  db.get_groupid(project, function (error, groupid) {
    if (error) { done(error); return; }
    queue().defer(PadManager.getPad, groupid + '$!chat', '')
      .defer(PadManager.getPad, groupid + '$!status', '')
      .await(done);
  });
}

exports.svn_read_all = function (project, ticker, full_reset, done) {
  queue().defer(synchd.fn(project, svn_read_all_locked), project, ticker, full_reset)
    .defer(exports.createSpecialPads, project)
    .await(done);
};

var interval = setInterval(function () {
  util.for_each_project(function (project) {
    // Serialize all filesystem/VCS operations, so we don't have to worry about
    // concurrent modification of files.
    exports.svn_sync(project, null, function () {});
  });
}, 10 * 1000);
