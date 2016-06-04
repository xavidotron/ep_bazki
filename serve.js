var async = require("async");
var queue = require("queue-async");
var execFile = require('child_process').execFile;
var fs = require('fs');
var startsWith = require("underscore.string/startsWith");
var endsWith = require("underscore.string/endsWith");

var AuthorManager = require("ep_etherpad-lite/node/db/AuthorManager");
var SessionManager = require("ep_etherpad-lite/node/db/SessionManager");

var db = require('./db');
var util = require('./util');
var svn = require('./svn');

var EXTENSION_MAP = {};
exports.registerExtension = function (extension, view) {
  EXTENSION_MAP[extension] = view;
}
exports.viewForFile = function (path) {
  var m = /\.\w+$/.exec(path);
  if (m && m[0] in EXTENSION_MAP) {
    if (typeof(EXTENSION_MAP[m[0]]) == 'function') {
      return EXTENSION_MAP[m[0]](path);
    } else {
      return EXTENSION_MAP[m[0]];
    }
  }
  return 'edit';
}

var VIEWS = {};
exports.registerView = function (view, handler) {
  VIEWS[view] = handler;
}

function validateRequest(project, req, res, handler) {
  if (!req.cookies.sessionID) {
    res.redirect('/g/' + project + '/login' + req.url);
    return;
  }

  var sessions = req.cookies.sessionID.split(',');
  queue().defer(async.map, sessions, SessionManager.getSessionInfo)
    .defer(db.get_groupid, project)
    .await(function (error, session_infos, groupid) {
      if (error) {
        if (error.message == 'sessionID does not exist') {
          res.clearCookie("sessionID");
          res.redirect('/g/' + project + '/login' + req.url);
        } else {
          console.log("validation", error);
          res.clearCookie("sessionID");
          res.status(500).send(error);
        }
        return;
      }

      var session_info = null;
      var valid_sessions = [];
      for (var i = 0; i < session_infos.length; ++i) {
        if (session_infos[i].validUntil >= new Date().getTime()/1000) {
          valid_sessions.push(session_infos[i].sessionID);
          if (session_infos[i].groupID == groupid)  {
            session_info = session_infos[i];
          }
        }
      }
      if (valid_sessions.length != session_infos.length) {
        // Clear out expired session cookies.
        if (valid_sessions.length == 0) {
          res.clearCookie("sessionID");
        } else {
          res.cookie("sessionID", valid_sessions.join(','));
        }
      }
      if (!session_info) {
        res.redirect('/g/' + project + '/login' + req.url);
        return;
      }
      
      AuthorManager.getAuthorName(
        session_info.authorID, function (error, author) {
          if (error) {
            console.log("authorness", error);
            res.status(500).send(error);
            return;
          }
          
          res.locals.author = author;
          res.locals.authorid = session_info.authorID;
          res.locals.groupid = groupid;
          res.locals.body = req.body;
          res.locals.url = req.url;
          res.locals.query = req.query;
          res.locals.params = req.params;
          
          res.locals.util = util;
          
          if (req.body && req.body.ticker_error) {
            res.status(500).send(req.body.ticker_error);
            return;
          }

          handler(res.locals, res);
        });
    });
}

exports.register_plain_url = function (app, controller, handler) {
  app.all(
    '/g/:project/' + controller,
    function (req, res) {
      var project = res.locals.project = req.params.project;
      
      validateRequest(project, req, res, handler.bind(undefined, project));
    });
}

exports.register_path_url = function (app, controller, handler) {
  app.all(
    '/g/:project/' + controller + '/:path(*)',
    function (req, res) {
      var project = res.locals.project = req.params.project;
      var path = res.locals.path = req.params.path;
      
      if (path.indexOf('..') != -1) {
        res.status(400).send('Invalid path!');
        return;
      }
      
      validateRequest(project, req, res,
                      handler.bind(undefined, project, path));
    });
}

function ERR(error, res, suppress_header) {
  console.error('ERR', error);
  if (res.is_ticking) {
    exports.finishWait(res, '', {ticker_error: error});
    return;
  }
  if (error.message) {
    res.render("error.ejs", {
      error: error,
      stdout: error.message,
      log: error.log,
      suppress_header: suppress_header,
    });
  } else {
    res.status(500).send(error);
  }
}
exports.ERR = ERR;

exports.startWait = function (res) {
  res.write('<html><head><link rel="stylesheet" href="/s/icomoon/style.css"><style type="text/css">p {text-align: center;position:absolute;height:100%;width:100%;margin:0} body {margin: 0; overflow: hidden}object{position:relative;height:30%}div{position:absolute;top:10px;left:10px;right:10px;bottom:10px}main{position:absolute;top:50%;transform:translateY(-50%);text-align:center;width:100%}@keyframes spin {\
  0% {\
    transform: rotate(0deg);\
  }\
  100% {\
    transform: rotate(359deg);\
  }\
}</style></head><body onload="document.body.innerHTML = \'An error occurred.\';"><div><main><span class="moon-settings" style="display:inline-block;font-size:10em;animation:spin 2s infinite linear"></span></main>');
  res.is_ticking = true;
}

exports.WaitTicker = function (res) {
  this.res = res;
  this.ticks = 0;
  this.set_target = function (target) {
    this.target = target;
    this.next = 1;
  }
  this.tick = function () {
    ++this.ticks;
    if (this.ticks >= this.next * this.target / 10) {
      this.res.write('<p style="transform: rotate('+(this.next * 36)+'deg)"><object type="image/svg+xml" data="/s/wavy-dagger.svg"></object></p>');
      ++this.next;
    }
  }
}

exports.finishWait = function (res, dest, post_data) {
  if (!post_data) {
    res.end('</div><script type="text/javascript">location.href = "' + dest + '";</script></body></html>');
  } else {
    var rest = '</div><form method="post" action="' + dest + '">';
    for (var k in post_data) {
      rest += '<input type="hidden" name="' + k + '" value="' + post_data[k]
        + '" />';
    }
    rest += '</form><script type="text/javascript">document.forms[0].submit();</script></body></html>';
    res.end(rest);
  }
}

exports.registerRepoCreator = function (app, controller, script) {
  app.all(controller, function (req, res) {
    var show_form = !('password' in req.body);
    var message = req.body.message;
    if (!show_form && req.body.project.indexOf(' ') != -1) {
      message = "The project identifier can't contain a space.";
      show_form = true;
    }
    if (show_form) {
      res.render("newproj.ejs", {message: message});
    } else {
      exports.startWait(res);
      execFile(
        __dirname + "/bin/new-repo.sh",
        [req.body.project, req.body.username, req.body.password],
        function (error, stdout, stderr) {
          if (error) {
            console.log('new', error, stderr);
            exports.finishWait(res, controller,
                               {message: stderr || "Creation failed."});
            return;
          }
          execFile(
            script,
            [req.body.project, req.body.username],
            function (error, stdout, stderr) {
              if (error) {
                console.log('init', error, stderr);
                exports.finishWait(res, controller,
                           {message: stderr || "Creation failed."});
                return;
              }
              queue().defer(
                svn.svn_sync, req.body.project, new exports.WaitTicker(res))
                .defer(svn.createSpecialPads, req.body.project)
                .await(function () {
                  exports.finishWait(res, '/g/' + req.body.project + '/login');
                });
            });
        });
    }
  });
}

var HIDE_NAMES = {
  "_template.tex": true,
  "bin/": true,
  "LaTeX/": true,
  "Extras/": true,
  "Postscript/": true,
  "README": true,
  "README.tex": true,
  "Production/": true,
  "Gameki/": true,
};

var HELP = {
  "Bluesheets/": "sheets that describe groups",
  "Greensheets/": "sheets that describe mechanics not in the rules",
  "Notebooks/": "books of folded pages for research or other mechanics",
  "Handouts/": "rules, scenario, etc.",
  "Whitesheets/": "transferable in-game documents",
  "Notes/": "GM notes",
  "Lists/": "items and other game object information",
  "Mail/": "templates for casting and sheets emails",
}

exports.expressCreateServer = function (hook_name, context, cb) {
  var views = context.app.get('views');
  if (typeof(views) == 'string') { views = [views]; }
  context.app.set('views', views.concat(__dirname + '/templates/'));

  context.app.use(require('body-parser').urlencoded({ extended: true }));
  context.app.use(require('cookie-parser')());

  exports.register_path_url(
    context.app, 'e', function(project, path, info, res) {
      // If it's a directory, use the ls mode.
      if (path == '' || endsWith(path, '/')) {
        fs.readdir(
          util.get_checkout(project) + path, function (error, contents) {
            if (error) { ERR(error, res); return; }
            
            contents = contents.filter(function (n) {
              return !startsWith(n, '.');
            });
            async.map(
              contents.map(function (n) {
                return util.get_checkout(project) + path + n;
              }),
              fs.stat, function (error, stats) {
                if (error) { ERR(error, res); return; }
                
                var files = {};
                var hidden = {};
                for (var i = 0; i < contents.length; ++i) {
                  var suf = '';
                  if (stats[i].isDirectory()) {
                    suf = '/';
                  }
                  var fpath = '/g/' + project + '/e/' + path + contents[i]
                    + suf;
                  if (endsWith(fpath, '.inform/')) {
                    fpath += 'Source/story.ni';
                  }
                  if (contents[i] + suf in HIDE_NAMES) {
                    hidden[contents[i] + suf] = fpath;
                  } else {
                    files[contents[i] + suf] = fpath;
                  }
                }
                
                var buttons = {};
                if (path == '' && !('Notes/' in files)) {
                  buttons['Add Notes Folder']
                    = '/g/' + project + '/mkdir/Notes';
                }
                if (path != '' && Object.keys(files).length == 0) {
                  buttons['Delete Folder'] = '/g/' + project + '/rm/'
                    + path;
                }
                // TODO(xavid): this is not the right criterion.
                if (/^[^\/]+sheets\/$/.exec(path)) {
                  buttons[
                    'Create New ' 
                      + util.singularForClass(
                        project, util.classForDirectory(project, path))]
                    = '/g/' + project + '/new/'
                      + util.classForDirectory(project, path);
                }
                
                var default_filename = null;
                if (path == 'Notes/') {
                  default_filename = new Date().toISOString().slice(0,10)
                    + '.txt';
                }
                if (default_filename in files) {
                  default_filename = null;
                }
                
                res.render("ls.ejs", {
                  files: files,
                  hidden: hidden,
                  buttons: buttons,
                  default_filename: default_filename,
                  HELP: HELP,
                });
              });
          });
      } else {
        // File case.
        fs.stat(util.get_checkout(project) + path, function (error, stat) {
          if (error) { ERR(error, res); return; }
          
          if (stat.isDirectory()) {
            res.redirect('/g/' + project + '/e/' + path + '/');
            return;
          }
          
        var view = exports.viewForFile(path);
          VIEWS[view](project, path, info, res);
        });
      }
    });

  // /g/.../edit/
  exports.register_path_url(context.app, 'edit', VIEWS.edit);

  // /g/.../users
  exports.register_plain_url(
    context.app, 'users', function (project, info, res) {
      var message = '';
      if ('name' in info.body) {
        if (!info.body.name) {
          message = "Invalid username.";
        } else if (!info.body.password) {
          message = "Invalid password.";
        } else {
          execFile(
            __dirname + "/bin/add-user.sh",
            [project, info.body.name, info.body.password],
            function (error, stdout, stderr) {
              if (error) { console.log('add-user', error, stderr); return; }
              res.redirect('/g/' + project + '/users');
            });
          return;
        }
      }
      execFile(
        __dirname + "/bin/list-users.sh", [project],
        function (error, stdout, stderr) {
          if (error) {
            console.log('users', error, stderr);
            return;
          }
          res.render("users.ejs", {
            users: stdout.split('\n').slice(0, -1),
            message: message,
          });
        });
    });

  // /g/.../nuke
  exports.register_plain_url(
    context.app, 'nuke/:arg?', function(project, info, res) {
      exports.startWait(res);
      var full_reset = (info.params.arg == 'full');
      svn.svn_read_all(
        project, new exports.WaitTicker(res), full_reset, function () {
          exports.finishWait(res, '/g/' + project + '/e/');
        });
    });

  // Special snowflakes

  // /g/.../login
  context.app.all(/^\/g\/([^\/]+)\/login(.*)$/, function (req, res) {
    var project = req.params[0];
    if (!('password' in req.body)) {
      res.render("login.ejs", {project: project});
    } else {
      execFile(
        __dirname + "/bin/check-password.sh",
        [project, req.body.username, req.body.password],
        function (error, stdout, stderr) {
          if (error) {
            console.log('password', error, stderr);
            res.render("login.ejs", {message: stderr || "Login failed.",
                                     project: project});
            return;
          }
          var author = req.body.username;
          queue().defer(db.get_groupid, project)
            .defer(AuthorManager.createAuthorIfNotExistsFor, author, author)
            .await(function (error, groupid, authordata) {
              if (error) { console.log('prelogin', error); return; }
              SessionManager.createSession(
                groupid, authordata.authorID,
                Math.floor(new Date().getTime()/1000 + 7 * 24 * 60 * 60),
                function (error, data) {
                  if (error) { console.log('login', error); return; }
                  var new_cookie;
                  if (req.cookies.sessionID) {
                    new_cookie = req.cookies.sessionID + ','
                      + data["sessionID"];
                  } else {
                    new_cookie = data["sessionID"];
                  }
                  res.cookie("sessionID", new_cookie);
                  var dest = req.params[1];
                  if (!dest) {
                    dest = '/g/' + project + '/e/';
                  }
                  res.redirect(dest);
                });
            });
        });
    }
  });

  // /g/.../logout
  context.app.get('/g/:project/logout', function (req, res) {
    res.clearCookie("sessionID");
    res.render("login.ejs", {project: req.params.project,
                             message: 'Logged out.',
                             action: '/g/' + req.params.project + '/login'});
  });
}
