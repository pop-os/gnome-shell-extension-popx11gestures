/*
 * Copyright 2021 José Expósito <jose.exposito89@gmail.com>
 *
 * This file is part of gnome-shell-extension-x11gestures.
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation,  either version 3 of the License,  or (at your option)  any later
 * version.
 *
 * This program is distributed in the hope that it will be useful,  but  WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE.
 * See the GNU General Public License for more details.
 *
 * You should have received a copy of the  GNU General Public License along with
 * this program. If not, see <http://www.gnu.org/licenses/>.
 */
const {
  GObject,
  GLib,
  Gio,
  Clutter,
  Gdk,
} = imports.gi;

const { GestureType, GestureDirection, DeviceType } = imports['x11gestures@joseexposito.github.io'].src.ToucheggTypes;

/**
 * Daemon D-Bus address.
 */
const DBUS_ADDRESS = 'unix:abstract=touchegg';

/**
 * D-Bus interface name.
 */
const DBUS_INTERFACE_NAME = 'io.github.joseexposito.Touchegg';

/**
 * D-Bus object path.
 */
const DBUS_OBJECT_PATH = '/io/github/joseexposito/Touchegg';

/**
 * Signal names.
 */
const DBUS_ON_GESTURE_BEGIN = 'OnGestureBegin';
const DBUS_ON_GESTURE_UPDATE = 'OnGestureUpdate';
const DBUS_ON_GESTURE_END = 'OnGestureEnd';

/**
 * Touchégg percentage multiplier to get a good UX on GNOME Shell.
 */
const PERCENTAGE_MULTIPLIER = 0.01;

/**
 * Time to sleep between reconnection attempts.
 */
const RECONNECTION_SLEEP_TIME = 5000;

/**
 * This class connects to the Touchégg daemon to receive touch events.
 * See: https://github.com/JoseExposito/touchegg.
 *
 * It mimics the behaviour of gnome-shell/js/ui/TouchpadSwipeGesture.
 */
const ToucheggClient = GObject.registerClass({
  Properties: {
    enabled: GObject.ParamSpec.boolean(
      'enabled', 'enabled', 'enabled',
      GObject.ParamFlags.READWRITE,
      true,
    ),
    orientation: GObject.ParamSpec.enum(
      'orientation', 'orientation', 'orientation',
      GObject.ParamFlags.READWRITE,
      Clutter.Orientation, Clutter.Orientation.VERTICAL,
    ),
  },
  Signals: {
    begin: { param_types: [GObject.TYPE_UINT, GObject.TYPE_DOUBLE, GObject.TYPE_DOUBLE] },
    update: { param_types: [GObject.TYPE_UINT, GObject.TYPE_DOUBLE] },
    end: { param_types: [GObject.TYPE_UINT] },
  },
}, class ToucheggClient extends GObject.Object {
  _init() {
    super._init();
    this.onNewMessage = this.onNewMessage.bind(this);
    this.onDisconnected = this.onDisconnected.bind(this);

    // Store the last received signal and signal parameters so in case of disconnection in the
    // middle of a gesture we can finish it
    this.lastSignalReceived = null;
    this.lastParamsReceived = null;
  }

  async stablishConnection() {
    let connected = false;

    while (!connected) {
      try {
        log('Connecting to Touchégg daemon');
        // eslint-disable-next-line no-await-in-loop
        this.connection = await ToucheggClient.dbusConnect();

        log('Connection with Touchégg established');
        connected = true;

        this.connection.signal_subscribe(null, DBUS_INTERFACE_NAME, null, DBUS_OBJECT_PATH,
          null, Gio.DBusSignalFlags.NONE, this.onNewMessage);
        this.connection.connect('closed', this.onDisconnected);
      } catch (error) {
        log(`Error connecting to Touchégg daemon: ${error && error.message}`);
        connected = false;

        log('Reconnecting to Touchégg daemon in 5 seconds');
        await ToucheggClient.sleep(RECONNECTION_SLEEP_TIME); // eslint-disable-line no-await-in-loop
      }
    }
  }

  closeConnection() {
    try {
      if (!this.connection.is_closed()) {
        this.connection.close_sync(null);
      }
    } catch (error) {
      // Ignore this error, the extension is being disabled as this point
    }
  }

  static dbusConnect() {
    return new Promise((resolve, reject) => {
      Gio.DBusConnection.new_for_address(
        DBUS_ADDRESS,
        Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT,
        null,
        null,
        (self, res) => {
          try {
            const connection = Gio.DBusConnection.new_for_address_finish(res);
            if (connection) {
              resolve(connection);
            } else {
              reject();
            }
          } catch (error) {
            reject(error);
          }
        },
      );
    });
  }

  static sleep(time) {
    return new Promise((resolve) => {
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, time, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
      });
    });
  }

  onNewMessage(connection, senderName, objectPath, interfaceName, signalName, parameters) {
    // log('On new message');
    // log(`senderName: ${senderName}`);
    // log(`objectPath: ${objectPath}`);
    // log(`interfaceName: ${interfaceName}`);
    // log(`signalName: ${signalName}`);
    // log(`parameters: ${parameters}`);

    this.lastSignalReceived = signalName;
    this.lastParamsReceived = parameters;

    this.emitGestureEvent(signalName, parameters);
  }

  onDisconnected(connection, remotePeerVanished, error) {
    log(`Connection with Touchégg daemon lost: ${error && error.message}`);

    if (this.lastSignalReceived === DBUS_ON_GESTURE_BEGIN
        || this.lastSignalReceived === DBUS_ON_GESTURE_UPDATE) {
      log('Connection lost in the middle of a gesture, ending it');
      this.emitGestureEvent(DBUS_ON_GESTURE_END, this.lastParamsReceived);
    }

    // From the docs:
    // If Gio.DBusConnection.close is called, remote_peer_vanished is set to false and error is null
    // Do not reconnect in that case
    if (remotePeerVanished || error) {
      this.stablishConnection();
    } else {
      log('Connection manually closed, not reconnecting to the daemon');
    }
  }

  emitGestureEvent(signalName, parameters) {
    // const type = parameters.get_child_value(0).get_uint32();
    const direction = parameters.get_child_value(1).get_uint32();
    const percentage = parameters.get_child_value(2).get_double();
    // const fingers = parameters.get_child_value(3).get_int32();
    // const performedOnDeviceType = parameters.get_child_value(4).get_uint32();
    const time = Date.now();

    // TODO Handle type and fingers
    // TODO Should we also handle touchscreen gestures?

    switch (signalName) {
      case DBUS_ON_GESTURE_BEGIN: {
        this.previosPercentage = 0;
        const { x, y } = ToucheggClient.getMousePosition();
        this.emit('begin', time, x, y);
        break;
      }
      case DBUS_ON_GESTURE_UPDATE: {
        // TODO Use the natural scrolling user preferences
        const percentageDelta = (direction === GestureDirection.LEFT
          || direction === GestureDirection.UP)
          ? (percentage - this.previosPercentage)
          : (this.previosPercentage - percentage);
        const delta = percentageDelta * PERCENTAGE_MULTIPLIER;
        this.previosPercentage = percentage;
        this.emit('update', time, delta);
        break;
      }
      case DBUS_ON_GESTURE_END:
        this.emit('end', time);
        break;
      default:
        break;
    }
  }

  static getMousePosition() {
    const display = Gdk.Display.get_default();
    const seat = display.get_default_seat();
    const pointer = seat.get_pointer();
    const [, x, y] = pointer.get_position();
    return { x, y };
  }
});

var toucheggClient = // eslint-disable-line
  new ToucheggClient();