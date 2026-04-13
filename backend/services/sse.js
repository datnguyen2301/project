const clients = new Map(); // clientId -> response

let nextId = 1;

function addClient(res) {
  const id = nextId++;
  clients.set(id, res);
  console.log(`[sse] Client connected: #${id} (total: ${clients.size})`);
  return id;
}

function removeClient(id) {
  clients.delete(id);
}

function send(id, event, data) {
  const res = clients.get(id);
  if (!res) return;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (err) {
    clients.delete(id);
  }
}

function broadcast(event, data) {
  const dead = [];
  for (const [id, res] of clients) {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (_) {
      dead.push(id);
    }
  }
  dead.forEach((id) => clients.delete(id));
}

function sendWatcherEvent(cameraId, eventData) {
  broadcast('watcher-event', { cameraId, ...eventData });
}

function sendWatcherStatus(status) {
  broadcast('watcher-status', status);
}

module.exports = {
  addClient,
  removeClient,
  send,
  broadcast,
  sendWatcherEvent,
  sendWatcherStatus,
};
