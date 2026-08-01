/**
 * Live NMEA transports for the GPS Tracking tool (issue #1617): read a sentence
 * stream off a serial port or a Bluetooth receiver and hand {@link GpsFix}
 * records to the caller. The parsing half lives in `nmea.ts`; this module is
 * only I/O, so it stays thin and the interesting logic stays unit testable.
 *
 * Two transports, because "Bluetooth or COM port" covers three different kinds
 * of hardware:
 *
 * - **Web Serial** ({@link connectSerialNmea}) reads USB and RS-232 receivers.
 *   It also covers the common *classic* Bluetooth GNSS puck, which speaks the
 *   Serial Port Profile: those pair at the OS level and show up as an ordinary
 *   virtual COM port (`COM4`, `/dev/rfcomm0`), which is a serial port as far as
 *   the browser is concerned.
 * - **Web Bluetooth** ({@link connectBluetoothNmea}) reads receivers that
 *   stream over Bluetooth Low Energy. Web Bluetooth cannot reach classic
 *   Serial Port Profile devices at all, which is exactly why the serial path
 *   above is the one that handles most Bluetooth pucks.
 *
 * Both APIs are Chromium-only and require a secure context, and neither is
 * available in the Tauri webviews (WebKitGTK, WebView2). Callers must gate the
 * UI on {@link serialNmeaSupported} / {@link bluetoothNmeaSupported} and show
 * the reason rather than offering a button that cannot work.
 */
import type { GpsFix } from "./gps-tracking";
import { NmeaAssembler, type NmeaStreamStats, splitNmeaLines } from "./nmea";

/**
 * Minimal structural types for Web Serial and Web Bluetooth. Neither API is in
 * TypeScript's DOM library, and declaring the handful of members used here
 * avoids pulling in `@types/w3c-web-serial` and `@types/web-bluetooth` for two
 * functions.
 */
interface SerialPortLike {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  getInfo?(): { usbVendorId?: number; usbProductId?: number };
}

interface SerialLike {
  requestPort(options?: { filters?: unknown[] }): Promise<SerialPortLike>;
}

interface BluetoothCharacteristicLike extends EventTarget {
  startNotifications(): Promise<BluetoothCharacteristicLike>;
  stopNotifications(): Promise<BluetoothCharacteristicLike>;
  value?: DataView;
}

interface BluetoothServiceLike {
  getCharacteristic(uuid: string): Promise<BluetoothCharacteristicLike>;
}

interface BluetoothServerLike {
  connected: boolean;
  getPrimaryService(uuid: string): Promise<BluetoothServiceLike>;
  disconnect(): void;
}

interface BluetoothDeviceLike extends EventTarget {
  name?: string;
  gatt?: { connect(): Promise<BluetoothServerLike> };
}

interface BluetoothLike {
  requestDevice(options: {
    filters?: unknown[];
    optionalServices?: string[];
    acceptAllDevices?: boolean;
  }): Promise<BluetoothDeviceLike>;
}

function serialApi(): SerialLike | null {
  return (navigator as Navigator & { serial?: SerialLike }).serial ?? null;
}

function bluetoothApi(): BluetoothLike | null {
  return (navigator as Navigator & { bluetooth?: BluetoothLike }).bluetooth ?? null;
}

/** True when this browser exposes Web Serial (Chromium desktop, secure context). */
export function serialNmeaSupported(): boolean {
  return serialApi() != null;
}

/** True when this browser exposes Web Bluetooth. */
export function bluetoothNmeaSupported(): boolean {
  return bluetoothApi() != null;
}

/**
 * Baud rates offered for a serial receiver. 4800 is the NMEA 0183 standard rate
 * and what older pucks use; 9600 is the common default on modern USB GNSS, and
 * high-rate receivers run faster still.
 */
export const NMEA_BAUD_RATES = [4800, 9600, 19200, 38400, 57600, 115200] as const;

/** Default when the user has not chosen: the modern receiver default. */
export const DEFAULT_NMEA_BAUD_RATE = 9600;

/**
 * BLE services known to carry an NMEA stream, tried in order. Nordic UART is by
 * far the most common (it is what most BLE serial bridges expose); the others
 * cover the HM-10 style modules and u-blox's own port service.
 */
const BLE_NMEA_SERVICES: { service: string; notify: string; label: string }[] = [
  {
    label: "Nordic UART",
    service: "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
    notify: "6e400003-b5a3-f393-e0a9-e50e24dcca9e",
  },
  {
    label: "u-blox SPS",
    service: "2456e1b9-26e2-8f83-e744-f34f01e9d701",
    notify: "2456e1b9-26e2-8f83-e744-f34f01e9d703",
  },
  {
    label: "HM-10 serial",
    service: "0000ffe0-0000-1000-8000-00805f9b34fb",
    notify: "0000ffe1-0000-1000-8000-00805f9b34fb",
  },
];

/**
 * Classification of an {@link NmeaError}, so the UI can localize the cases it
 * recognizes. `failed` covers everything else, where the message is relayed
 * from the browser (a `DOMException` string) and is more informative than a
 * generic sentence would be.
 */
export type NmeaErrorCode =
  | "cancelled"
  | "unavailable"
  | "unsupported-device"
  | "disconnected"
  | "failed";

/** Why an NMEA connection could not be established or was lost. */
export class NmeaError extends Error {
  constructor(
    message: string,
    readonly code: NmeaErrorCode = "failed",
  ) {
    super(message);
    this.name = "NmeaError";
  }

  /** The user dismissed the browser's device chooser. */
  get cancelled(): boolean {
    return this.code === "cancelled";
  }
}

/** A live connection to an NMEA receiver. */
export interface NmeaConnection {
  /** Human-readable device label for the dialog, e.g. "Serial port @ 9600 baud". */
  readonly label: string;
  /** Stream health for the readout; recomputed on demand. */
  stats(): NmeaStreamStats;
  /**
   * Stop reading and release the port or GATT server. Safe to call twice, and
   * guaranteed not to deliver another fix once it has been called.
   */
  close(): Promise<void>;
}

interface ConnectHandlers {
  onFix: (fix: GpsFix) => void;
  /** A recoverable stream problem, or the connection dropping. */
  onError: (err: NmeaError) => void;
}

/** True for the DOMException browsers throw when a chooser is dismissed. */
function isChooserCancellation(err: unknown): boolean {
  return err instanceof Error && err.name === "NotFoundError";
}

/**
 * Cap on the unterminated tail carried between reads. A device that never emits
 * a line terminator would otherwise grow the buffer without bound.
 */
const MAX_LINE_BUFFER_BYTES = 8192;

/**
 * Fold one decoded chunk into the assembler, emitting whatever fixes it
 * completes, and return the unterminated remainder to carry into the next
 * chunk. Shared by both transports so their line-splitting and overflow rules
 * cannot drift apart.
 */
function consumeChunk(
  chunk: string,
  buffer: string,
  assembler: NmeaAssembler,
  onFix: (fix: GpsFix) => void,
): string {
  const { lines, rest } = splitNmeaLines(buffer + chunk);
  for (const line of lines) {
    const fix = assembler.push(line);
    if (fix) onFix(fix);
  }
  return rest.length > MAX_LINE_BUFFER_BYTES ? "" : rest;
}

/**
 * Open a serial port chosen by the user and stream fixes from it.
 *
 * Must be called from a user gesture: `requestPort()` shows the browser's port
 * chooser, which browsers only permit in response to a click.
 */
export async function connectSerialNmea(
  { baudRate }: { baudRate: number },
  { onFix, onError }: ConnectHandlers,
): Promise<NmeaConnection> {
  const serial = serialApi();
  if (!serial) throw new NmeaError("Web Serial is not available in this browser.", "unavailable");

  let port: SerialPortLike;
  try {
    port = await serial.requestPort();
  } catch (err) {
    if (isChooserCancellation(err)) throw new NmeaError("No port selected.", "cancelled");
    throw new NmeaError(err instanceof Error ? err.message : "Could not open the serial port.");
  }

  try {
    await port.open({ baudRate });
  } catch (err) {
    throw new NmeaError(err instanceof Error ? err.message : "Could not open the serial port.");
  }

  const assembler = new NmeaAssembler();
  let closed = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  const pump = async (): Promise<void> => {
    const readable = port.readable;
    if (!readable) {
      onError(new NmeaError("The serial port has no readable stream.", "disconnected"));
      return;
    }
    // Decoding is done here rather than with a piped TextDecoderStream so the
    // reader can be cancelled directly on close without the pipe locking the
    // port and blocking `port.close()`.
    const decoder = new TextDecoder();
    reader = readable.getReader();
    let buffer = "";
    let failure: NmeaError | null = null;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        buffer = consumeChunk(decoder.decode(value, { stream: true }), buffer, assembler, onFix);
      }
    } catch (err) {
      failure = new NmeaError(err instanceof Error ? err.message : "Serial read failed.");
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Already released by a concurrent cancel; nothing to do.
      }
    }
    // A read failure and a clean end-of-stream both end the session while still
    // connected, so report exactly one error, preferring the specific cause.
    if (!closed)
      onError(failure ?? new NmeaError("The serial device disconnected.", "disconnected"));
  };

  void pump();

  return {
    label: `Serial @ ${baudRate} baud`,
    stats: () => assembler.getStats(),
    close: async () => {
      if (closed) return;
      closed = true;
      // The half-assembled final epoch is deliberately dropped rather than
      // emitted: closing races with the caller's own teardown, so a late fix
      // can land after the position readout has already been cleared. At 1 Hz
      // that costs at most the last second of a track.
      try {
        await reader?.cancel();
      } catch {
        // The stream may already have errored out; closing the port is what matters.
      }
      try {
        await port.close();
      } catch {
        // Port already gone (device unplugged); nothing left to release.
      }
    },
  };
}

/**
 * Connect to a Bluetooth Low Energy receiver chosen by the user and stream
 * fixes from its NMEA notification characteristic.
 *
 * Must be called from a user gesture. Note this reaches BLE devices only: a
 * classic Bluetooth (Serial Port Profile) puck is unreachable from Web
 * Bluetooth and should be paired at the OS level and opened with
 * {@link connectSerialNmea} instead.
 */
export async function connectBluetoothNmea({
  onFix,
  onError,
}: ConnectHandlers): Promise<NmeaConnection> {
  const bluetooth = bluetoothApi();
  if (!bluetooth)
    throw new NmeaError("Web Bluetooth is not available in this browser.", "unavailable");

  const services = BLE_NMEA_SERVICES.map((s) => s.service);
  let device: BluetoothDeviceLike;
  try {
    device = await bluetooth.requestDevice({
      filters: services.map((service) => ({ services: [service] })),
      optionalServices: services,
    });
  } catch (err) {
    if (isChooserCancellation(err)) throw new NmeaError("No device selected.", "cancelled");
    throw new NmeaError(err instanceof Error ? err.message : "Could not open the device chooser.");
  }

  if (!device.gatt)
    throw new NmeaError("The selected device does not support GATT.", "unsupported-device");
  let server: BluetoothServerLike;
  try {
    server = await device.gatt.connect();
  } catch (err) {
    // Out of range, already bonded to another host, or refusing the connection:
    // normalize to NmeaError like every other failure path in this module, so
    // the caller never has to handle a raw DOMException.
    throw new NmeaError(err instanceof Error ? err.message : "Could not connect to the device.");
  }

  // The chooser filters on the services above, but a device may advertise one
  // and expose another, so try each until a notify characteristic is found.
  let characteristic: BluetoothCharacteristicLike | null = null;
  let serviceLabel = "";
  for (const candidate of BLE_NMEA_SERVICES) {
    try {
      const service = await server.getPrimaryService(candidate.service);
      characteristic = await service.getCharacteristic(candidate.notify);
      serviceLabel = candidate.label;
      break;
    } catch {
      // Not this one; try the next known NMEA service.
    }
  }
  if (!characteristic) {
    server.disconnect();
    throw new NmeaError(
      "No known NMEA service on this device. It may be a classic Bluetooth receiver, which must be paired in your system settings and opened as a serial port instead.",
      "unsupported-device",
    );
  }

  const assembler = new NmeaAssembler();
  const decoder = new TextDecoder();
  let buffer = "";
  let closed = false;

  const onValueChanged = (event: Event) => {
    const target = event.target as BluetoothCharacteristicLike;
    const value = target.value;
    if (!value) return;
    buffer = consumeChunk(decoder.decode(value, { stream: true }), buffer, assembler, onFix);
  };

  const onDisconnected = () => {
    if (!closed) onError(new NmeaError("The Bluetooth device disconnected.", "disconnected"));
  };

  characteristic.addEventListener("characteristicvaluechanged", onValueChanged);
  device.addEventListener("gattserverdisconnected", onDisconnected);
  try {
    await characteristic.startNotifications();
  } catch (err) {
    characteristic.removeEventListener("characteristicvaluechanged", onValueChanged);
    device.removeEventListener("gattserverdisconnected", onDisconnected);
    server.disconnect();
    throw new NmeaError(
      err instanceof Error ? err.message : "Could not subscribe to the device's NMEA stream.",
    );
  }

  const notifying = characteristic;
  return {
    label: device.name ? `${device.name} (${serviceLabel})` : `Bluetooth (${serviceLabel})`,
    stats: () => assembler.getStats(),
    close: async () => {
      if (closed) return;
      closed = true;
      // The half-assembled final epoch is dropped for the same reason as the
      // serial transport: a late fix would race the caller's teardown.
      notifying.removeEventListener("characteristicvaluechanged", onValueChanged);
      device.removeEventListener("gattserverdisconnected", onDisconnected);
      try {
        await notifying.stopNotifications();
      } catch {
        // The device may already be gone; disconnecting is what matters.
      }
      if (server.connected) server.disconnect();
    },
  };
}
