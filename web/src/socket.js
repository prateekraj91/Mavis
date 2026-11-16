// The one WebSocket to the helper. Every message {t, ...} from it is re-dispatched
// on `bus` as `helper:<t>` (helper:input, helper:front, ...), plus helper:open / helper:close.
//
//   const socket = connectHelper();   socket.send({t:'cursor', op:'move', x, y})

export const HELPER_WS = 'ws://localhost:7777/ws';
const RECONNECT_MS = 2000;

export function connectHelper({ bus = window, url = HELPER_WS } = {}) {
  const emit = (type, detail = {}) => bus.dispatchEvent(new CustomEvent(type, { detail }));
  let ws = null;

  function connect() {
    try { ws = new WebSocket(url); } catch { setTimeout(connect, RECONNECT_MS); return; }
    ws.onopen = () => emit('helper:open');
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (typeof msg?.t === 'string') emit(`helper:${msg.t}`, msg);
    };
    ws.onclose = () => { ws = null; emit('helper:close'); setTimeout(connect, RECONNECT_MS); };
    ws.onerror = () => {};
  }
  connect();

  return {
    /** False if the helper is not connected (the message is dropped). */
    send(msg) {
      if (ws?.readyState !== 1) return false;
      ws.send(JSON.stringify(msg));
      return true;
    },
    isOpen: () => ws?.readyState === 1,
  };
}
