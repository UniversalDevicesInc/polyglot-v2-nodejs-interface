'use strict';

function useCloud() {
  return process.env.MQTTENDPOINT && process.env.STAGE;
}

// If we are connecting to Polyglot Cloud, use the PGC interface instead;
module.exports = useCloud() ? require('pgc_interface') : {
  // Interface class for Polyglot
  Interface: require('./lib/Interface.js'),

  // Node class from which all nodes are extended from
  Node: require('./lib/Node.js'),

  // Logger utility for the NodeServer (Entries will be tagged with NS:)
  logger: require('./lib/logger.js').ns,
};

