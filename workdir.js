var process = require('process');
var execFile = require('child_process').execFile;
var svn = require('./svn');

var workdirs_root = process.cwd() + "/workdirs/";

exports.get_path = function (repo) {
  return workdirs_root + repo + '/';
}

exports.sync = function (repo, callback) {
  svn.svn_sync(repo, null, function () {
    execFile(__dirname + '/bin/sync-workdir.sh', [repo],
             function (error, stdout, stderr) {
               callback(error);
             });
  });
}
