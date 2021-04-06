import { stringify, parse } from 'jsan';
import socketCluster from 'socketcluster-client';
import getHostForRN from 'rn-host-detect';
import { defaultSocketOptions } from './constants';

let socket;
let channel;
const listeners = {};

export function extractState(message) {
  if (!message || !message.state) return undefined;
  if (typeof message.state === 'string') return parse(message.state);
  return message.state;
}

export function generateId() {
  return Math.random().toString(36).substr(2);
}

function handleMessages(message) {
  if (!message.payload) message.payload = message.action;
  Object.keys(listeners).forEach(id => {
    if (message.instanceId && id !== message.instanceId) return;
    if (typeof listeners[id] === 'function') listeners[id](message);
    else listeners[id].forEach(fn => { fn(message); });
  });
}

function watch() {
  if (channel) return;
  socket.emit('login', 'master', (err, channelName) => {
    if (err) { console.log(err); return; }
    channel = socket.subscribe(channelName);
    channel.watch(handleMessages);
    socket.on(channelName, handleMessages);
  });
}

function connectToServer(options) {
  if (socket) return;
  let socketOptions;
  if (options.port) {
    socketOptions = {
      port: options.port,
      hostname: getHostForRN(options.hostname || 'localhost'),
      secure: !!options.secure
    };
  } else socketOptions = defaultSocketOptions;
  socket = socketCluster.create(socketOptions);
  watch();
}

async function start(options, hostnamePromise) {
  try {
    if (!options.hostname) {
      options.hostname = await hostnamePromise;
    }
    connectToServer(options);
  } catch (err) {
    throw new Error('Error obtaining socket hostname: ' + err.toString());
  }
}

function transformAction(action, config) {
  if (action.action) return action;
  const liftedAction = { timestamp: Date.now() };
  if (action) {
    if (config.getActionType) liftedAction.action = config.getActionType(action);
    else {
      if (typeof action === 'string') liftedAction.action = { type: action };
      else if (!action.type) liftedAction.action = { type: 'update' };
      else liftedAction.action = action;
    }
  } else {
    liftedAction.action = { type: action };
  }
  return liftedAction;
}

export function send(action, state, options, type, instanceId, hostnamePromise) {
  setTimeout(async () => {
    // makes sure the connection is established
    await start(options, hostnamePromise);
    const message = {
      payload: state ? stringify(state) : '',
      action: type === 'ACTION' ? stringify(transformAction(action, options)) : action,
      type: type || 'ACTION',
      id: socket.id,
      instanceId,
      name: options.name
    };
    socket.emit(socket.id ? 'log' : 'log-noid', message);
  }, 0);
}

export function connect(options = {}, hostnamePromise) {
  const id = generateId(options.instanceId);
  if (!options.port) {
    // no port provided - we should throw!
    throw new Error('no port provided');
  }
  return {
    init: (state, action) => {
      send(action || {}, state, options, 'INIT', id, hostnamePromise);
    },
    subscribe: (listener) => {
      if (!listener) return undefined;
      if (!listeners[id]) listeners[id] = [];
      listeners[id].push(listener);

      return function unsubscribe() {
        const index = listeners[id].indexOf(listener);
        listeners[id].splice(index, 1);
      };
    },
    unsubscribe: () => {
      delete listeners[id];
    },
    send: (action, payload) => {
      if (action) {
        send(action, payload, options, 'ACTION', id, hostnamePromise);
      } else {
        send(undefined, payload, options, 'STATE', id, hostnamePromise);
      }
    },
    error: (payload) => {
      // like in the `send` function
      setTimeout(async () => {
        // makes sure the connection is established
        await start(options, hostnamePromise);
        socket.emit({ type: 'ERROR', payload, id: socket.id, instanceId: id });
      }, 0);
    }
  };
}

export function connectViaExtension(options) {
  if (options && options.remote || typeof window === 'undefined' || !window.__REDUX_DEVTOOLS_EXTENSION__) {
    return connect(options);
  }
  return window.__REDUX_DEVTOOLS_EXTENSION__.connect(options);
}

export default { connect, connectViaExtension, send, extractState, generateId };
