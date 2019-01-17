'use strict';

const winston = require('winston'); // Logging framework
require('winston-daily-rotate-file');
const format = winston.format;

function zPad2(str) {
  return str.toString().padStart(2, '0');
}

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

const transports = [
  // new (winston.transports.Console)({
  //     handleExceptions: true,
  //     level: 'debug',
  //     format: format.combine(format.splat(), myFormat)
  // }),
  new (winston.transports.DailyRotateFile)({
    handleExceptions: true,
    filename: './logs/%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    zippedArchive: false,
    maxSize: '10m',
    maxFiles: '7d',
    level: 'debug',
    format: format.combine(format.splat(), myFormat),
  }),
];


// Polyinterface specific logger
winston.loggers.add('poly', {
  format: format.label({label: 'POLY'}),
  exitOnError: true,
  transports: transports,
});

// Custom node server specific logger. Will have NS: in the messages
winston.loggers.add('ns', {
  format: format.label({label: 'NS'}),
  exitOnError: true,
  transports: transports,
});


// This is the main logger for polyinterface
module.exports = winston.loggers.get('poly');
module.exports.ns = winston.loggers.get('ns');

// Usage: logger.errorStack(err, 'whatever %s:', variable)
module.exports.errorStack = function(err) {
  // Remove first argument
  const loggerArgs = Array.prototype.slice.call(arguments, 1);

  if (err instanceof Error) {
    loggerArgs[0] += ' ' + err.stack;
  } else {
    loggerArgs[0] += ' ' + err; // Example: throw 'abc_string'
  }

  module.exports.error.apply(this, loggerArgs);
};


