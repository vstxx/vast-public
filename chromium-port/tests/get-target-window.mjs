const argument = name => {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length);
};

const port = Number.parseInt(argument('port') || '', 10);
const targetId = argument('target-id');
if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !targetId) {
  throw new Error('Pass --port=<DevTools port> and --target-id=<target id>.');
}

class CdpConnection {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, {once: true});
      this.socket.addEventListener(
          'error', () => reject(new Error('DevTools connection failed.')),
          {once: true});
    });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DevTools command timed out: ${method}`));
      }, 30_000);
      this.pending.set(id, {resolve, reject, timer});
      this.socket.send(JSON.stringify({id, method, params}));
    });
  }

  close() {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.close();
  }
}

const versionResponse = await fetch(`http://127.0.0.1:${port}/json/version`);
if (!versionResponse.ok) throw new Error('Could not read DevTools version data.');
const version = await versionResponse.json();
const connection = new CdpConnection(version.webSocketDebuggerUrl);
try {
  await connection.connect();
  const initial = await connection.send('Browser.getWindowForTarget', {targetId});
  const requestedBounds = {
    left: 37,
    top: 53,
    width: 1031,
    height: 719,
    windowState: 'normal',
  };
  await connection.send('Browser.setWindowBounds', {
    windowId: initial.windowId,
    bounds: requestedBounds,
  });
  const result = await connection.send('Browser.getWindowBounds', {
    windowId: initial.windowId,
  });
  console.log(JSON.stringify({windowId: initial.windowId, bounds: result.bounds}));
} finally {
  connection.close();
}
