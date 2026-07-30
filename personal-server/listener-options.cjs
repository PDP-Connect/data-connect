const PERSONAL_SERVER_HOSTNAME = '127.0.0.1';

function createPersonalServerServeOptions(fetch, port) {
  return {
    fetch,
    hostname: PERSONAL_SERVER_HOSTNAME,
    port,
  };
}

module.exports = {
  PERSONAL_SERVER_HOSTNAME,
  createPersonalServerServeOptions,
};
