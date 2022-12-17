import { TuyaDeviceSchemaIntegerProperty, TuyaDeviceStatus } from '../device/TuyaDevice';
import { TuyaStreamingDelegate } from '../util/TuyaStreamDelegate';
import { limit, remap } from '../util/util';
import BaseAccessory from './BaseAccessory';
import { configureOn } from './characteristic/On';
import { configureProgrammableSwitchEvent, onProgrammableSwitchEvent } from './characteristic/ProgrammableSwitchEvent';

const SCHEMA_CODE = {
  MOTION_ON: ['motion_switch'],
  MOTION_DETECT: ['movement_detect_pic'],
  // Indicates that this is possibly a doorbell
  DOORBELL: ['wireless_powermode', 'doorbell_ring_exist'],
  // Notifies when a doorbell ring occurs.
  DOORBELL_RING: ['doorbell_pic'],
  // Notifies when a doorbell ring occurs.
  ALARM_MESSAGE: ['alarm_message'],
  LIGHT_ON: ['floodlight_switch'],
  LIGHT_BRIGHTNESS: ['floodlight_lightness'],
};

export default class CameraAccessory extends BaseAccessory {

  private stream: TuyaStreamingDelegate | undefined;

  requiredSchema() {
    return [];
  }

  configureServices() {
    this.configureDoorbell();
    this.configureCamera();
    this.configureFloodLight();
    this.configureMotion();
  }

  configureFloodLight() {
    const onSchema = this.getSchema(...SCHEMA_CODE.LIGHT_ON);
    if (!onSchema) {
      return;
    }

    const service = this.getLightService();

    configureOn(this, service, onSchema);

    const brightnessSchema = this.getSchema(...SCHEMA_CODE.LIGHT_BRIGHTNESS);
    if (brightnessSchema) {
      const { min, max } = brightnessSchema.property as TuyaDeviceSchemaIntegerProperty;
      service.getCharacteristic(this.Characteristic.Brightness)
        .onGet(() => {
          const status = this.getStatus(brightnessSchema.code)!;
          let value = status.value as number;
          value = remap(value, 0, max, 0, 100);
          value = Math.round(value);
          value = limit(value, min, max);
          return value;
        })
        .onSet(value => {
          this.log.debug(`Characteristic.Brightness set to: ${value}`);
          let brightValue = value as number;
          brightValue = remap(brightValue, 0, 100, 0, max);
          brightValue = Math.round(brightValue);
          brightValue = limit(brightValue, min, max);
          this.sendCommands([{ code: brightnessSchema.code, value: brightValue }], true);
        });
    }
  }

  configureMotion() {
    const onSchema = this.getSchema(...SCHEMA_CODE.MOTION_ON);
    if (onSchema) {
      const onService = this.accessory.getService(onSchema.code)
        || this.accessory.addService(this.Service.Switch, onSchema.code, onSchema.code);

      configureOn(this, onService, onSchema);
    }

    this.getMotionService().setCharacteristic(this.Characteristic.MotionDetected, false);
  }

  configureDoorbell() {
    // Check to see if it is indeed a doorbell.
    if (!this.getSchema(...SCHEMA_CODE.DOORBELL)) {
      return;
    }

    const schema = this.getSchema(...SCHEMA_CODE.DOORBELL_RING, ...SCHEMA_CODE.ALARM_MESSAGE);
    if (!schema) {
      return;
    }

    configureProgrammableSwitchEvent(this, this.getDoorbellService(), schema);
  }

  configureCamera() {
    if (this.stream !== undefined) {
      return;
    }

    if (this.device.isVirtualDevice()) {
      return;
    }

    this.stream = new TuyaStreamingDelegate(this);
    this.accessory.configureController(this.stream.controller);
  }

  getLightService() {
    return this.accessory.getService(this.Service.Lightbulb)
      || this.accessory.addService(this.Service.Lightbulb, this.accessory.displayName + ' Floodlight');
  }

  getDoorbellService() {
    return this.accessory.getService(this.Service.Doorbell)
      || this.accessory.addService(this.Service.Doorbell);
  }

  getMotionService() {
    return this.accessory.getService(this.Service.MotionSensor)
      || this.accessory.addService(this.Service.MotionSensor, this.accessory.displayName + ' Motion Detect');
  }

  async onDeviceStatusUpdate(status: TuyaDeviceStatus[]) {
    super.onDeviceStatusUpdate(status);

    const doorbellRingSchema = this.getSchema(...SCHEMA_CODE.DOORBELL_RING);
    const alarmMessageSchema = this.getSchema(...SCHEMA_CODE.ALARM_MESSAGE);
    if (this.getSchema(...SCHEMA_CODE.DOORBELL) && (doorbellRingSchema || alarmMessageSchema)) {
      const doorbellRingStatus = status.find(_status => _status.code === doorbellRingSchema?.code);
      const alarmMessageStatus = status.find(_status => _status.code === alarmMessageSchema?.code);
      if (doorbellRingStatus && (doorbellRingStatus.value as string).length > 1) { // Compared with '1' in order to filter value '$'
        onProgrammableSwitchEvent(this, this.getDoorbellService(), doorbellRingStatus);
      } else if (alarmMessageStatus && (alarmMessageStatus.value as string).length > 1) {
        onProgrammableSwitchEvent(this, this.getDoorbellService(), alarmMessageStatus);
      }
    }

    const motionSchema = this.getSchema(...SCHEMA_CODE.MOTION_DETECT);
    if (motionSchema) {
      const motionStatus = status.find(_status => _status.code === motionSchema.code);
      motionStatus && this.onMotionDetected(motionStatus);
    }
  }

  private timer?: NodeJS.Timeout;
  onMotionDetected(status: TuyaDeviceStatus) {
    if (!this.intialized) {
      return;
    }

    const data = Buffer.from(status.value as string, 'base64').toString('binary');
    if (data.length === 0) {
      return;
    }

    this.log.info('Motion event:', data);
    const characteristic = this.getMotionService().getCharacteristic(this.Characteristic.MotionDetected);
    characteristic.updateValue(true);

    this.timer && clearTimeout(this.timer);
    this.timer = setTimeout(() => characteristic.updateValue(false), 30 * 1000);
  }

}