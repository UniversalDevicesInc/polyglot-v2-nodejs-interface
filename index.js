'use strict';

module.exports = {
  // Interface class for Polyglot
  Interface: require('./lib/Interface.js'),

  // Node class from which all nodes are extended from
  Node: require('./lib/Node.js'),

  // Logger utility for the NodeServer (Entries will be tagged with NS:)
  logger: require('./lib/logger.js').ns,
};
