// Node.js Interface for UDI Polyglot v2 NodeServers
// Written by Benoit Mercier

'use strict';

const events = require('events');
const mqtt = require('mqtt');
const logger = require('./logger.js');
const Queue = require('./Queue.js');
const Node = require('./Node.js');

// This is the interface class to Polyglot
module.exports = class Interface extends events.EventEmitter {
  // All node classes have to be declared to the interface
  constructor(declaredNodeClasses) {
    super();

    this.isCloud = false; // Allows the nodeserver to detect if using PGC

    // MQTT Host and port set from stdin
    this._mqttHost = null;
    this._mqttPort = null;

    // The mqtt topic relevant to our profile number
    this._mqttTopic = null;

    // The mqtt topic where polyglot advertises when it is connected
    this._mqttTopicPolyglotConnection = null;

    // ISY Profile number (int)
    this._profileNum = null;

    // This is the mqtt client, the result of mqtt.connect()
    this._mqttClient = null;

    // Are we connected to the queue?
    this._mqttClientConnected = false;

    // Is polyglot connected to the queue?
    this._mqttPolyglotConnected = false;

    // This is the last config received
    this._config = null;

    // Some polyglot messages are queued for processing
    this._queue = new Queue(
      this._onMessageQueued,
      this,
      'Message Queue Processor');

    // We use this to track the messages sent to Polyglot
    // We do this to return the response top sendMessageAsync
    this._messageAsyncTracking = {};

    // true if we received stop or delete
    this._shuttingDown = false;

    // These are the declared nodes classes (see below)
    this._nodeClasses = {};

    // This is our nodes with the classes applied to them
    this._nodes = {};

    // We use this to detect config sent continuously in a loop
    this._configCounter = 0;

    // Set this_nodeClasses correctly on startup
    const _this = this;
    declaredNodeClasses.forEach(function(nodeClass) {
      _this._nodeClasses[nodeClass.nodeDefId] = nodeClass;
    });
  }

  // Starts the interface by getting MQTT parameters from stdin
  async start() {
    logger.info('Interface starting');
    try {
      const stdinConfig = await this._getStdinConfig();
      this._mqttHost = stdinConfig.mqttHost;
      this._mqttPort = stdinConfig.mqttPort;
      this._profileNum = typeof stdinConfig.profileNum === 'string' ?
        parseInt(stdinConfig.profileNum, 10) :
        stdinConfig.profileNum;
      this._mqttTopic = 'udi/polyglot/ns/' + this._profileNum;
      this._mqttTopicPolyglotConnection = 'udi/polyglot/connections/polyglot';
      this._mqttStart();
    } catch (err) {
      logger.errorStack(err, 'Could not get and process stdin config:');
    }
  }

  // Currently not used in Polyglot V2
  stop() {}

  // Gets the config from stdin (MQTT parameters and profile number)
  async _getStdinConfig() {
    return new Promise(function(resolve, reject) {
      logger.info('Waiting for stdin');

      setTimeout(function() {
        reject(new Error('Timeout waiting for stdin'));
      }, 2000);

      process.stdin.setEncoding('utf8');

      process.stdin.on('readable', function() {
        let chunk;
        let data = '';

        while ((chunk = process.stdin.read())) {
          data += chunk;
        }

        if (data !== '' && data[data.length - 1] === '\n') {
          resolve(JSON.parse(data));
        }
      });
    });
  }

  // Starts the MQTT connection and setup the handlers
  _mqttStart() {
    const _this = this;

    const options = {
      port: this._mqttPort,
      clientId: 'mqttjs_' + Math.random().toString(16).substr(2, 8),
      username: 'admin',
      password: 'admin',
      rejectUnauthorized: false,
    };

    this._mqttClient = mqtt.connect('mqtts://' + this._mqttHost, options);

    this._mqttClient.on('error', () => {
      logger.error('MQTT Error');
    });

    this._mqttClient.on('connect', () => {
      try {
        logger.info('MQTT client connected');
        _this._mqttClientConnected = true;

        _this._mqttClient.subscribe(_this._mqttTopicPolyglotConnection);
        _this._mqttClient.subscribe(_this._mqttTopic);

        _this._sendMessage({node: _this.profileNum, connected: true}, true);

        _this.emit('mqttConnected');
      } catch (err) {
        logger.errorStack(err, 'Error on MQTT connect handler:');
      }
    });

    this._mqttClient.on('message', (topic, message) => {
      // We can get empty messages, such as when deleting the nodeserver
      if (message.length) {
        try {
          const parsedMessage = JSON.parse(message);

          // We are interested in messages from polyglot only (not ourselves)
          if (parsedMessage.node === 'polyglot') {
            if (topic === _this._mqttTopicPolyglotConnection) {
              _this._mqttPolyglotConnected = parsedMessage.connected;
            }

            if (topic === _this._mqttTopic) {
              _this._onMessage(parsedMessage);
            }
          }
        } catch (err) {
          logger.errorStack(err, 'Error processing %s:',
            _this._mqttTopicPolyglotConnection);
        }
      }
    });

    this._mqttClient.on('reconnect', () => {
      _this._mqttClientConnected = true;
      _this.emit('mqttReconnect');
    });

    this._mqttClient.on('offline', () => {
      _this._mqttClientConnected = false;
      _this.emit('mqttOffline');
    });

    this._mqttClient.on('close', () => {
      _this._mqttClientConnected = false;
      _this.emit('mqttClose');
    });

    this._mqttClient.on('end', () => {
      _this._mqttClientConnected = false;
      _this.emit('mqttEnd');
    });
  }

  // Handler for incoming Polyglot messages
  _onMessage(message) {
    const _this = this;
    this.emit('messageReceived', message);
    // logger.info('%o', message);

    const queuedMessages = [
      'config', 'query', 'command', 'status', 'shortPoll', 'longPoll',
    ];

    delete message.node; // Ignore the node property. We no longer need it.

    Object.keys(message).forEach(function(messageKey) {
      const messageContent = message[messageKey];
      switch (messageKey) {
        case 'result':
          _this._onResult(messageContent);
          break;

        case 'stop':
          logger.warn('Received stop message');
          _this._shuttingDown = true;
          _this.emit('stop');
          break;

        case 'delete':
          logger.warn('Received delete message');
          _this._shuttingDown = true;
          _this.emit('delete');
          break;

        default:
          if (queuedMessages.includes(messageKey)) {
            // The other messages are queued to be run sequentially by
            // this._onMessageQueued
            _this._queue.add({
              // We set it here to facilitate routing to the proper function
              messageKey: messageKey,
              messageContent: messageContent,
            });
          } else {
            logger.error('Invalid message %s received %o:',
              messageKey, message);
          }
      }
    });
  }

  // Handler for Polyglot messages that are queued
  async _onMessageQueued(opt) {
    const _this = this;
    const messageKey = opt.messageKey;
    const messageContent = opt.messageContent;

    if (!this._shuttingDown) {
      let node;

      switch (messageKey) {
        case 'config':
          _this._onConfig(messageContent);
          break;

        case 'query':
          node = _this.getNode(messageContent.address);
          if (node) {
            return node.query();
          }
          break;

        case 'status':
          node = _this.getNode(messageContent.address);
          if (node) {
            return node.status();
          }
          break;

        case 'command':
          node = _this.getNode(messageContent.address);
          if (node) {
            // Example messageContent: {
            //  address: 'node003',
            //  cmd: 'DON',
            //  value: '6',
            //  uom: '51'
            // }
            return node.runCmd(messageContent);
          }
          break;

        case 'shortPoll':
          this.emit('poll', false);
          break;

        case 'longPoll':
          this.emit('poll', true);
          break;

        default:
          logger.error('Invalid queued message %s received %o:',
            messageKey, messageContent);
      }
    } else {
      logger.warn('Message %s ignored: Shutting down nodeserver',
        messageKey);
    }
  }

  // Sets a newParamsDetected flag to the newConfig object
  _setParamsDetected(oldConfig, newConfig) {
    const oldConfigParamsKeys = oldConfig && oldConfig.customParams ?
      Object.keys(oldConfig.customParams) : [];
    const newConfigParamsKeys = newConfig && newConfig.customParams ?
      Object.keys(newConfig.customParams) : [];

    const changedParams = newConfigParamsKeys.filter(function(key) {
      return !(oldConfigParamsKeys.includes(key) &&
        oldConfig.customParams[key] === newConfig.customParams[key]);
    });

    newConfig.newParamsDetected = changedParams.length !== 0;
  }

  // Handler for the config message
  _onConfig(config) {
    const _this = this;
    const isInitialConfig = !this._config;

    // logger.info('Config received%s has %d nodes',
    //   isInitialConfig?' (Initial config)':'',
    //   config.newNodes.length);

    // Some of the properties received are converted
    const propertyMapper = {
      controller: function(val) {
        // Return boolean
        return typeof val === 'string' ? val === 'true' : val;
      },
      timeAdded: function(t) {
        // Return a Date object
        return typeof t === 'string' ? new Date(parseInt(t, 10)) : t;
      },
      profileNum: function(val) {
        // Return boolean
        return typeof val === 'string' ? val === 'true' : val;
      },
    };

    // Use the nodes configuration we get from the config to build the Nodes
    // with the class (Sets up this._nodes)
    config.newNodes.forEach(function(n) {
      const address = n.address.slice(5);
      let node;

      // If this node does not exists yet in this._nodes, create it
      if (!_this._nodes[address]) {
        const NodeClass = _this._nodeClasses[n.nodedef];
        const primary = n.primary.slice(5);

        if (NodeClass) {
          node = new NodeClass(_this, primary, address, n.name);
          _this._nodes[address] = node;
        } else {
          logger.error('Config node with address %s has an invalid class %s',
            address, n.nodedef);
        }
      } else {
        node = _this._nodes[address];
      }

      // If node did not have a valid class, we just ignore it
      if (node) {
        // node is either a new node, or the existing node.
        // Update the properties of the node with the config
        ['controller', 'drivers', 'isprimary', 'profileNum', 'timeAdded']
        .forEach(function(prop) {
          if (prop in n) {
            // logger.info('prop in n %s %s', prop, n[prop])
            if (propertyMapper[prop]) {
              node[prop] = propertyMapper[prop](n[prop]);
            } else {
              node[prop] = n[prop];
            }
          }
        });
      }
    });

    // Remove nodes from this._nodes that are no longer in the config
    if (config.newNodes.length !== Object.keys(_this._nodes).length) {
      Object.keys(_this._nodes).forEach(function(address) {
        const found = config.newNodes.find(function(n) {
          return address === n.address.slice(5);
        });

        if (!found) {
          logger.info('Node %s was removed from the config', address);
          delete _this._nodes[address];
        }
      });
    }

    // Sets the newParamsDetected flag in the config
    this._setParamsDetected(this._config, config);

    // Keep a reference to the config received
    this._config = config;

    // Let the node server know we have received a config
    // Processes the config, unless we are detecting a loop
    if (!this._detectConfigLoop()) {
      this.emit('config', Object.assign({}, config, {
        isInitialConfig: isInitialConfig,
        nodes: this._nodes,
      }));
    } else {
      logger.error('Config processing loop detected iteration %d. ' +
        'Skipping config processing.', _this._configCounter);
    }
  }

  // Used to detect if we get configs looping
  _detectConfigLoop() {
    const _this = this;
    this._configCounter++;

    setTimeout(function() {
      _this._configCounter--;
    }, 10000);

    // Trigger is over 30 configs within 10 seconds
    return this._configCounter > 30;
  }

  // Sample result message
  // {
  //     profileNum: '1',
  //     addnode: {
  //         success: true,
  //         reason: 'AddNode: n001_node006 added to database successfully.',
  //         address: 'node006'
  //     }
  // }

  // We can also have this message with a different format
  // {
  //     isyresponse: '',
  //     statusCode: 404,
  //     seq: false,
  //     elapsed: '15.02125ms',
  //     profileNum: '1',
  //     status: {
  //         success: false,
  //         reason: 'n001_controller or ST does not exist - ISY returned 404',
  //         address: 'n001_controller'
  //     }
  // }

  // Handle result messages (result of commands such as addnode)
  _onResult(messageContent) {
    const _this = this;
    const trackedCommands = ['addnode'];
    const ignoredKeys = [
      'removenode', 'profileNum',
      'statusCode', 'seq', 'elapsed', 'status', 'change', // isyresponse msgs
    ];

    // Finds the tracked request, if exists, and resolve/reject it.
    Object.keys(messageContent).forEach(function(key) {
      if (trackedCommands.includes(key)) {
        const address = messageContent[key].address;
        const trackedRequest = _this._messageAsyncTracking[key + '-' + address];
        if (trackedRequest) {
          if (messageContent[key].success) {
            trackedRequest.resolve(messageContent[key].reason);
          } else {
            trackedRequest.reject(messageContent[key].reason);
          }
        }
      } else if (key === 'isyresponse') {
        try {
          let cat = '';
          let reason = '';

          ['change', 'status'].forEach(function(key2) {
            if (messageContent[key2] && messageContent[key2].reason) {
              cat = key2; // 'status' or 'change'
              reason = messageContent[key2].reason;
            }
          });

          logger.info('Received result ISY Response [%s]: %s', cat, reason);
        } catch (err) {
          logger.errorStack(err, 'Error on Received result:');
          logger.info('Received result ISY Response: %o', messageContent);
        }
      } else if (ignoredKeys.includes(key)) {
      } else {
        logger.info('Received result for unhandled command %s: %o',
          key, messageContent);
      }
    });
  }

  // Finds the controller node. null if there are none.
  _getController() {
    const _this = this;

    const controllers = Object.keys(this._nodes)
    .filter(function(address) {
      return _this._nodes[address].controller;
    })
    .map(function(address) {
      return _this._nodes[address];
    });

    if (controllers.length >= 2) {
      logger.warn('There are %d controllers.', controllers.length);
    }

    return controllers.length ? controllers[0] : null;
  }

  // Sends a message to Polyglot. Don't check the connection status,
  // don't wait for the result. Used internally only.
  _sendMessage(message, retain = false) {
    // We need to add the node to the message (string)
    message.node = '' + this._profileNum;

    this.emit('messageSent', message);

    this._mqttClient.publish(
      this._mqttTopic,
      JSON.stringify(message),
      {retain: retain});
  }

  // Returns true if Polyglot and us are connected to MQTT.
  isConnected() {
    const connected = this._mqttClientConnected && this._mqttPolyglotConnected;

    if (!connected) {
      logger.warn('Polyglot connection is not connected. ' +
        'MQTT Client is%s connected, Polyglot is%s connected',
        this._mqttClientConnected ? '' : ' NOT',
        this._mqttPolyglotConnected ? '' : ' NOT');
    }

    return connected;
  }

  // Sends a message to Polyglot. Don't wait for the result.
  sendMessage(message) {
    if (this.isConnected()) {
      this._sendMessage(message);
    }
  }

  // Sends a message to Polyglot. Wait for the result message
  async sendMessageAsync(key, message, timeout = 15000) {
    const _this = this;

    // If we have an existing promise for the same key, make sure it is
    // finished before starting a new one
    if (_this._messageAsyncTracking[key] &&
      _this._messageAsyncTracking[key].promise) {

      try {
        await _this._messageAsyncTracking[key].promise;
      } catch (e) {
      }
    }

    let newTracker = {};

    newTracker.promise = new Promise(function(resolve, reject) {
      if (_this.isConnected()) {
        newTracker.resolve = resolve;
        newTracker.reject = reject;

        _this._sendMessage(message);

        if (timeout) {
          // Fail the request if timeout is reached
          setTimeout(function() {
            let err = new Error('Polyglot result message not received');

            // Allows catch to detect if the error is due to a timeout.
            err.name = 'timeout';
            reject(err);
          }, timeout);
        }
      } else {
        reject(new Error('Polyglot not connected'));
      }
    });

    // When we get the result message, we have access to the resolve and
    // reject callbacks. The promise is also available so that the next
    // sendMessageAsync can wait for this one to finish
    _this._messageAsyncTracking[key] = newTracker;

    return newTracker.promise;
  }

  // Adds a new node to polyglot and ISY
  async addNode(node) {
    if (!node instanceof Node) {
      logger.error('addNode error: node is not an instance of Node class');
    } else {
      const message = {
        addnode: {
          nodes: [{
            address: node.address,
            name: node.name,
            node_def_id: node.id,
            primary: node.primary,
            drivers:
              Object.keys(node.drivers)
              .map(function(key) {
                return Object.assign({},
                  node.drivers[key],
                  {driver: key});
              }),
          }],
        },
      };

      return await this.sendMessageAsync('addnode-' + node.address, message);
    }
  }

  // Return a copy of the existing config
  getConfig() {
    return Object.assign({}, this._config);
  }

  // Get all the nodes (with class applied)
  getNodes() {
    return this._nodes ? this._nodes : [];
  }

  // Get a single node
  getNode(address) {
    if (typeof address !== 'string') {
      logger.error('getNode error: Parameter is not a string');
    } else {
      const node = this._nodes[address];

      if (!node) {
        logger.error('Node %s not found', address);
      }

      return node;
    }
  }

  // Delete a single node
  delNode(node) {
    if (!node instanceof Node) {
      logger.error('addNode error: node is not an instance of Node class');
    } else {
      const message = {removenode: {address: node.address}};
      this.sendMessage(message);
    }
  }

  // Sends the profile to ISY
  updateProfile() {
    const message = {installprofile: {reboot: false}};
    this.sendMessage(message);
  }

  // Get all notices
  getNotices() {
    return this._config.notices ? this._config.notices : [];
  }

  noticeExists(key) {
    const keyedNotices = this.getCustomData('keyedNotices') || {};
    // logger.info('kk %o', keyedNotices)
    return keyedNotices[key];
  }

  // Add custom notice to the Polyglot front-end
  addNotice(key, text) {
    if (!this.noticeExists(key)) {
      // We keep track of the notices in custom data, under keyedNotices
      let keyedNotices = Object.assign({},
        this.getCustomData('keyedNotices'));
      keyedNotices[key] = text;
      this.addCustomData({keyedNotices: keyedNotices});

      // And we send the actual notice.
      const message = {addnotice: {key: key, value: text}};
      this.sendMessage(message);
    }
  }

  // Add custom notice for a few seconds
  addNoticeTemp(key, text, delaySec) {
    const _this = this;

    // logger.info('Adding temp notice %s (%s)', key, delaySec);
    this.addNotice(key, text);

    // Waits delaySec, then delete the notice
    setTimeout(function() {
      // logger.info('Removing temp notice %s', key);
      _this.removeNotice(key);
    }, delaySec * 1000);
  }

  // Remove custom notice to the Polyglot front-end.
  // If there are multiple notices with the same text, they are all removed.
  removeNotice(key) {
    if (this.noticeExists(key)) {
      // We keep track of the notices in custom data, under keyedNotices
      let keyedNotices = Object.assign({},
        this.getCustomData('keyedNotices'));
      delete keyedNotices[key];
      this.addCustomData({keyedNotices: keyedNotices});

      const message = {removenotice: {key: key}};
      this.sendMessage(message);
    }
  }

  // Remove all notices from the Polyglot front-end. Use the "text" approach.
  removeNoticesAll() {
    const _this = this;

    this.addCustomData({keyedNotices: {}});

    this.getNotices().forEach(function(text) {
      const message = {removenotice: text}; // We can delete by using the text.
      _this.sendMessage(message);
    });
  }


  // Get custom params (Keeps the existing params)
  getCustomParam(key) {
    if (typeof key !== 'string') {
      logger.error('getCustomParam error: Parameter is not a string.');
    } else {
      const params = this.getCustomParams();

      if (key in params) {
        return params[key];
      } else {
        logger.error('getCustomParam error: Parameter does not exist.');
      }
    }
  }

  // Get existing params from last config received
  getCustomParams() {
    return this._config.customParams;
  }

  // Sets the custom parameters to params (Will overwrite existing params)
  saveCustomParams(params) {
    if (typeof params !== 'object') {
      logger.error('saveCustomParams error: Parameter is not an object.');
    } else {
      const message = {customparams: params};
      this.sendMessage(message);
    }
  }

  // Add custom params (Keeps the existing params)
  addCustomParams(params) {
    if (typeof params !== 'object') {
      logger.error('addCustomParams error: Parameter is not an object.');
    } else {
      this.saveCustomParams(Object.assign(this.getCustomParams(), params));
    }
  }

  // Remove custom params (Keeps the existing params)
  removeCustomParams(key) {
    if (typeof key !== 'string') {
      logger.error('removeCustomParams error: Parameter is not a string.');
    } else {
      let params = this.getCustomParams();
      if (key in params) {
        delete params[key];
        this.saveCustomParams(params);
      }
    }
  }

  // Sets the custom parameters to params
  saveTypedParams(typedParams) {
    if (!Array.isArray(typedParams)) {
      logger.error('saveTypedParams error: Parameter is not an array.');
    } else {
      const message = {typedparams: typedParams};
      this.sendMessage(message);
    }
  }


  // Get whole custom data, or specific key if specified.
  // Comes from last config received
  getCustomData(key = null) {
    return key ? this._config.customData[key] : this._config.customData;
  }

  // Sets the custom data to data (Will overwrite existing custom data)
  saveCustomData(data) {
    if (typeof data !== 'object') {
      logger.error('saveCustomData error: Parameter is not an object');
    } else {
      const message = {customdata: data};
      this.sendMessage(message);
    }
  }

  // Add custom data (Keeps the existing data)
  addCustomData(data) {
    if (typeof data !== 'object') {
      logger.error('addCustomData error: Parameter is not an object.');
    } else {
      this.saveCustomData(Object.assign(this.getCustomData(), data));
    }
  }

  // Remove custom params (Keeps the existing params)
  removeCustomData(key) {
    if (typeof key !== 'string') {
      logger.error('removeCustomData error: Parameter is not a string.');
    } else {
      let data = this.getCustomData();

      if (key in data) {
        delete data[key];
        this.saveCustomData(data);
      }
    }
  }

  // Sets the customParams documentation shown in the UI
  setCustomParamsDoc(html) {
    if (typeof html !== 'string') {
      logger.error('setCustomParamsDocs error: Parameter is not a string.');
    } else {
      this.sendMessage({customparamsdoc: html});
    }
  }

  // Send a command to Polyglot to restart this NodeServer
  restart() {
    logger.warn('Telling Polyglot to restart this node server.');
    this.sendMessage({restart: {}});
  }
};
