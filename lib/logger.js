'use strict';

const winston = require('winston'); // Logging framework
const util = require('util');
const exec = util.promisify(require('child_process').exec);

require('winston-daily-rotate-file');
const format = winston.format;

// Zero padding
function zPad2(str) {
  return str.toString().padStart(2, '0');
}

// Creates a debug.log symLink to the real log file to be used by Polyglot UI
async function makeDebugLogLink(filename) {
  const cwd = process.cwd();
  const logPath = filename.split('/').slice(0, -1).join('/'); // Keep path only
  const physicalFile = cwd + '/' + filename; // Complete name with full path
  const symLink = cwd + '/' + logPath + '/' + 'debug.log';
  const cmd = "ln -sf '" + physicalFile + "' '" + symLink + "'";
  try {
    await exec(cmd);
  } catch (err) {
    module.exports.error('Error renaming log file: %s', err.message, err.stack);
  }
}

// Log message formatter
const myFormat = winston.format.printf(info => {
  const d = new Date();
  const dStr = d.getFullYear() + '-' +
    zPad2(d.getMonth() + 1) + '-' +
    zPad2(d.getDate()) + ' ' +
    zPad2(d.getHours()) + ':' +
    zPad2(d.getMinutes()) + ':' +
    zPad2(d.getSeconds());

  return `${dStr} ${info.level}: ${info.label}: ${info.message}`;
});

// Winston transport to file which takes care of log rotation
const fileTransport = new (winston.transports.DailyRotateFile)({
  handleExceptions: true,
  filename: './logs/debug-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: false,
  maxSize: '10m',
  maxFiles: '7d',
  level: 'debug',
  format: format.combine(format.splat(), myFormat),
});

// Rotate is only triggered when rotating. Not when the first log is created.
// fileTransport.on('rotate', function(oldFilename, newFilename) {
//   makeDebugLogLink(newFilename);
// });

// The lower level 'new' event is triggered anytime a new log is created.
fileTransport.logStream.on('new', function(newFilename) {
  module.exports.debug('Log file set to: %s', newFilename);
  makeDebugLogLink(newFilename);
});

const transports = [ fileTransport ];

// Polyinterface specific logger
winston.loggers.add('poly', {
  format: format.label({label: 'POLY'}),
  exitOnError: true,
  transports: transports,
});

// Node server specific logger. Will have NS: in the messages
winston.loggers.add('ns', {
  format: format.label({label: 'NS'}),
  exitOnError: true,
  transports: transports,
});

// This is the main logger for polyinterface
module.exports = winston.loggers.get('poly');
module.exports.errorStack = errorStack;
module.exports.ns = winston.loggers.get('ns');
module.exports.ns.errorStack = errorStack;

// Usage: logger.errorStack(err, 'whatever %s:', variable)
function errorStack(err) {
  // Remove first argument
  const loggerArgs = Array.prototype.slice.call(arguments, 1);

  if (err instanceof Error) {
    loggerArgs[0] += ' ' + err.stack;
  } else {
    loggerArgs[0] += ' ' + err; // Example: throw 'abc_string'
  }

  module.exports.error.apply(this, loggerArgs);
}
