// Omnis JavaScript worker entrypoint / wrapper. Dispatches Omnis calls to the internal core.

// Provided by Omnis at runtime (see example_worker/omnis_calls.js for the interface).
const omnis_calls = require('omnis_calls.js');

const { run, operations } = require('./src/core.js');

// One Omnis "method" per registered operation - the method name is the operation name.
// Omnis passes the request payload as a single parameter. Registering a new operation
// in core.js's registry automatically exposes it here.
const methodMap = {};
for (const operation of Object.keys(operations)) {
  methodMap[operation] = function (payload) { return run(toRequest(operation, payload)); };
}

function toRequest(operation, payload) {
  return Object.assign({ operation: operation }, parsePayload(payload));
}

function parsePayload(payload) {
  if (payload === null || typeof payload === 'undefined') {
    return {};
  }

  if (Array.isArray(payload)) {
    return parsePayload(payload[0]);
  }

  if (typeof payload === 'string') {
    try {
      return JSON.parse(payload);
    } catch (e) {
      return {};
    }
  }

  return payload;
}

module.exports = {
  // Omnis calls this for every method invocation on the worker module.
  call: function (method, payload, response) {
    const handler = methodMap[method];
    if (!handler) {
      omnis_calls.sendError(response, 400, "Unknown method '" + method + "'");
      return false;
    }
    
    try {
      // run() encodes expected failures in its result ({ ok:false, error }), so a 200
      // JSON response carries every normal outcome; sendError is only for an actual
      // worker crash (an unexpected throw).
      const result = handler(payload);
      omnis_calls.sendResponse(result, response);
      return true;
    } catch (error) {
      omnis_calls.sendError(response, 500, error && error.stack ? error.stack : String(error));
      return false;
    }
  },
};
