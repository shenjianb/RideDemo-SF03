import {useEffect, useMemo, useRef, useState} from 'react';
import {createPortal} from 'react-dom';

type LogLevel = 'info' | 'warn' | 'error';

type FrameKind = 'start' | 'heartbeat' | 'unknown';

type LogItem = {
  ts: string;
  level: LogLevel;
  message: string;
};

const SERVICE_UUID = '0000ffe0-0000-1000-8000-00805f9b34fb';
const CHARACTERISTIC_UUID = '0000ffe1-0000-1000-8000-00805f9b34fb';

const START_FRAME_TYPE = 0x01;
const HEARTBEAT_FRAME_TYPE = 0x02;
const HEARTBEAT_TIMEOUT_MS = 15_000;

function parseFrame(view: DataView): {kind: FrameKind; rawHex: string} {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const rawHex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');

  const kind: FrameKind =
    bytes[0] === START_FRAME_TYPE
      ? 'start'
      : bytes[0] === HEARTBEAT_FRAME_TYPE
        ? 'heartbeat'
        : 'unknown';

  return {kind, rawHex};
}

export default function App() {
  const [connected, setConnected] = useState(false);
  const [startFrameReceived, setStartFrameReceived] = useState(false);
  const [lastHeartbeatAt, setLastHeartbeatAt] = useState<number | null>(null);
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [panelOpen, setPanelOpen] = useState(true);

  const deviceRef = useRef<BluetoothDevice | null>(null);
  const characteristicRef = useRef<BluetoothRemoteGATTCharacteristic | null>(null);

  const pushLog = (message: string, level: LogLevel = 'info') => {
    setLogs((prev) => {
      const next = [{ts: new Date().toLocaleTimeString(), level, message}, ...prev];
      return next.slice(0, 80);
    });
  };

  useEffect(() => {
    if (!connected) {
      return;
    }

    const timer = window.setInterval(() => {
      if (!lastHeartbeatAt) {
        return;
      }

      if (Date.now() - lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) {
        pushLog(`心跳超时（>${HEARTBEAT_TIMEOUT_MS / 1000}s），请检查硬件发送逻辑。`, 'warn');
      }
    }, 1_000);

    return () => window.clearInterval(timer);
  }, [connected, lastHeartbeatAt]);

  const onDisconnected = () => {
    setConnected(false);
    setStartFrameReceived(false);
    setLastHeartbeatAt(null);
    pushLog('蓝牙断开连接。', 'warn');
  };

  const onFrameReceived = (event: Event) => {
    const characteristic = event.target as BluetoothRemoteGATTCharacteristic;
    if (!characteristic.value) {
      return;
    }

    const {kind, rawHex} = parseFrame(characteristic.value);

    if (kind === 'start') {
      if (startFrameReceived) {
        pushLog(`收到重复起始帧：${rawHex}`, 'warn');
      } else {
        setStartFrameReceived(true);
        pushLog(`收到起始帧：${rawHex}`);
      }
      return;
    }

    if (kind === 'heartbeat') {
      if (!startFrameReceived) {
        pushLog(`起始帧前收到心跳帧：${rawHex}`, 'warn');
      }
      setLastHeartbeatAt(Date.now());
      pushLog(`收到心跳帧：${rawHex}`);
      return;
    }

    pushLog(`收到未知帧：${rawHex}`, 'warn');
  };

  const connect = async () => {
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{services: [SERVICE_UUID]}],
        optionalServices: [SERVICE_UUID],
      });

      deviceRef.current = device;
      pushLog(`已选择设备：${device.name ?? '未命名设备'}`);

      const server = await device.gatt?.connect();
      if (!server) {
        throw new Error('未能获取 GATT 连接');
      }

      const service = await server.getPrimaryService(SERVICE_UUID);
      const characteristic = await service.getCharacteristic(CHARACTERISTIC_UUID);
      characteristicRef.current = characteristic;

      await characteristic.startNotifications();
      characteristic.addEventListener('characteristicvaluechanged', onFrameReceived);
      device.addEventListener('gattserverdisconnected', onDisconnected);

      setConnected(true);
      setStartFrameReceived(false);
      setLastHeartbeatAt(null);
      pushLog('蓝牙连接成功，开始监听起始帧/心跳帧。');
    } catch (error) {
      pushLog(`连接失败：${String(error)}`, 'error');
    }
  };

  const statusText = useMemo(() => {
    if (!connected) return '未连接';
    if (!startFrameReceived) return '已连接，等待起始帧';
    return '已连接，通讯中';
  }, [connected, startFrameReceived]);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      {createPortal(
        <button
          type="button"
          className="fixed left-4 top-4 z-[2147483647] rounded-md border border-cyan-300 bg-slate-900 px-3 py-2 text-sm font-semibold text-cyan-200 shadow-2xl"
          onClick={() => setPanelOpen((v) => !v)}
        >
          {panelOpen ? '隐藏' : '显示'}协议监控面板
        </button>,
        document.body,
      )}

      {panelOpen &&
        createPortal(
          <section className="fixed left-4 top-16 z-[2147483647] w-[min(640px,calc(100vw-2rem))] rounded-lg border border-cyan-500/60 bg-slate-900/95 p-4 shadow-2xl backdrop-blur">
          <h1 className="text-lg font-bold text-cyan-300">SF03 蓝牙协议监控面板</h1>
          <p className="mt-1 text-sm text-slate-300">状态：{statusText}</p>
          <p className="text-sm text-slate-300">起始帧：{startFrameReceived ? '已收到' : '未收到'}</p>
          <p className="text-sm text-slate-300">
            最近心跳：{lastHeartbeatAt ? new Date(lastHeartbeatAt).toLocaleTimeString() : '暂无'}
          </p>

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className="rounded-md bg-cyan-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
              onClick={connect}
              disabled={connected}
            >
              {connected ? '已连接' : '连接蓝牙设备'}
            </button>
          </div>

          <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs text-slate-300">
            <li>连接后应先收到一次起始帧（0x01）。</li>
            <li>连接期间应持续收到心跳帧（0x02）。</li>
            <li>若 15 秒未收到心跳，将记录超时告警。</li>
          </ol>

          <div className="mt-3 max-h-64 overflow-auto rounded border border-slate-700 p-2 text-xs">
            {logs.length === 0 ? (
              <p className="text-slate-400">暂无日志</p>
            ) : (
              logs.map((log, idx) => (
                <p
                  key={`${log.ts}-${idx}`}
                  className={
                    log.level === 'error'
                      ? 'text-red-300'
                      : log.level === 'warn'
                        ? 'text-amber-200'
                        : 'text-slate-200'
                  }
                >
                  [{log.ts}] {log.message}
                </p>
              ))
            )}
          </div>
        </section>,
          document.body,
        )}
    </main>
  );
}
