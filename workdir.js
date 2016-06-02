var execFile = require('child_process').execFile;

var workdirs_root = "workdirs/";

exports.get_path = function (repo) {
  return workdirs_root + repo + '/';
}

exports.sync = function (repo, callback) {
  execFile(__dirname + '/bin/sync-workdir.sh', [repo],
           function (error, stdout, stderr) {
             callback(error);
           });
}
