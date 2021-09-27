// HAP-Nodejs Nest devices in HomeKit
//
// Supported:
// -- Nest Thermostat, includes custom integration of daikin A/C (wifi controlled) for cooling centrally controlled from Nest
// -- Nest Temperature Sensors
// -- Nest Protect
// -- Nest Hello
//
// Daikin A/C control https://github.com/ael-code/daikin-control
// Nest "unoffical API" https://www.wiredprairie.us/blog/index.php/archives/1754
// Unofficial Nest Learning Thermostat API https://github.com/gboudreau/nest-api
// HomeBridge nest-cam https://github.com/Brandawg93/homebridge-nest-cam    <- camera coding taken/adapted from here
//
// todo
// -- 2FA due to Nest changes end of May 2020??
// -- add Nest home name to pairing names (easier for mutiple homes)??
// -- Google auth???? Not worried yet as only use Nest auth
// -- Locks??
//
// -- Nest Cam(s)
//      -- Add support once doorbell code working (may need device to test)
//
// -- Nest Hello (doorbell?)
//      -- Subscribe to events??? firebase cloud messaging??
//      -- Reconfiguration of HomeKit streaming details
//      -- Battery level details??
//      -- Add face detection alerting
//      -- Add package detection alerting
//      -- Add motion alerting (would be quite "chatty")
//      -- Speed up snapshot getting (maynot be possible??)
//      -- Ensure snapshot return isnt an empty buffer... cached image??
//
// -- Nest Thermostat
//      -- Correctly display F temps if selected. HomeKit bug??
//      -- Switching between range (low/high) to heat or cool, update correct target temp. Maybe need to get from nest ??
//      -- What todo when switches to ECO mode??
//      -- Childlock PIN set/clear based on a stored configuration??
//      -- "Hey Siri, turn on the fan for x minutes"????
//
// -- Nest Protect
//      -- Add replacement date as custom HomeKit characteristic??
//      -- CO levels
//      -- Motion history in Eve App
//
// done
// -- accessories are advertised using "ciao" backend for hap-nodejs
// -- added retry for axios code requests
// -- external configuration file
// -- mechanism to exclude devices from HomeKit publishing
// -- periodically refresh Nest token expiry time
// -- history recording - testing of own solution
// -- dymanically remove/add accessories when added/removed from Nest app
// -- fully convert to axios library
// -- subscribe to events rather than polling every 30secs
// -- recoded device getting from Nest
// -- ground work for subscribe updates
// -- Nest Thermostat
//      -- Migrated from NestThermostat_accfactory (v4) coding
//      -- re-coded to use un-offical API due to Nest shutting down REST APIs 31/8/2019
//      -- Get MAC of thermostat automatically
//      -- Get serial number automatically
//      -- Set model type automatically 
//      -- Battery Level
//      -- Occupancy sensor for home/away status
//      -- Fixed software version number reporting
//      -- Use Characteristic.StatusActive for online status
//      -- Nest temperature sensors, including using sensor temp on thermostat if selected
//      -- Switching bewteen C and F adjust temperature steps - 0.5 for C /1.0 for F
//      -- Battery charging state
//      -- Childlock
//      -- Fan service - dynamic add/remove also
//      -- Option for seperate humidity sensor
//
// -- Nest Temperature Sensor
//      -- Online status for Nest Temperature sensors
//      -- HomeKit status fault if no data for upto 1hr
//      -- Generate CRC-24 for "fake" device mac address using Nest Labs prefix
//
// -- Nest Protect
//      -- Battery charging state
//      -- LED ring colour in internal stucture
//      -- Further integration with Eve App
//
// -- Nest Hello
//      -- initial coding.. need to get hands on one - done
//      -- get "website_2" cookie automatically
//      -- get "zones" to allow for seperate motion sensors
//
// bugs
// -- Sarting Jan 2020, google has enabled reCAPTCHA for Nest Accounts. Modfied code to no longer use user/name password login, but access token
//    Access token can be view by logging in to https//home.nest.com on webbrowser then in going to https://home.nest.com/session  Seems access token expires every 30days
//    so needs manually updating (haven't seen it expire yet.....)
//
// Version 16/9/2021
// Mark Hulskamp

module.exports = accessories = [];

var Accessory = require("../").Accessory; 
var Service = require("../").Service;
var Characteristic = require("../").Characteristic;
var uuid = require("../").uuid;
var axios = require("axios");
var HomeKitHistory = require("./HomeKitHistory");

// Needed for camera support
var NexusStreamer = require("./nexusstreamer");
var DoorbellController = require("../").DoorbellController;
var CameraController = require("../").CameraController;
var dgram = require("dgram");
var net = require("net");
var ip = require("ip");
var fs = require("fs");
var {spawn} = require("child_process");

// Defines for the accessory
const AccessoryName =  "NEST";
const AccessoryPincode = "031-45-154";
const USERAGENT = "Nest/5.54.0.3 (iOScom.nestlabs.jasper.release) os=14.0";
const PUTURL = "/v2/put";
const SUBSCRIBEURL = "/v6/subscribe";
const MFAURL = "/api/0.1/2fa/verify_pin";
const CAMERAAPIHOST = "https://webapi.camera.home.nest.com";
const CAMERAPOLLING = 2000;                         // Camera polling timer, 2 seconds
const EVENTCOOLDOWN1 = 60000;                       // Nest camera alert cooldown, 1 min
const EVENTCOOLDOWN2 = 120000;                      // Nest camera alert cooldown. 2 min
const VIDEOCODEC = "h264_omx";                      // h264_omx hw accel on raspberry pi (or libx264 for software)
const AUDIOCODEC = "libfdk_aac";
const LOW_BATTERY_LEVEL = 10;                       // Low level battery percentage

class NestClass {
	constructor() {
        this.__nestToken = null;                    // Access token for requests
        this.__nestCookie = null;                   // WEBSITE_2 cookie. used for camera requests
        this.__nestURL = null;                      // URL for nest requests
        this.__nestID = null;                       // User ID
        this.__tokenExpire = null;                  // Time when token expires (in Unix timestamp)
        this.__tokenTimer = null;                   // Handle for token refresh timer
        this.__lastNestData = {};                   // Full copy of nest data
        this.__previousNestData = {};
        this.__currentNestData = {};
        this.__subscribed = [];                     // array of subscribed callbacks for each device
        this.__excludedDevices = [];                // array of excluded devices (by serial number). We don't process these devices
        this.__extraOptions = {};                   // Extra options per device to inject into Nest data stream
        this.__cancel = null;

        // Load configuration
        if (fs.existsSync(__dirname + "/Nest_config.json")) {
            var config = require(__dirname + "/Nest_config.json");

            config && Object.entries(config).forEach(([key, value]) => {
                // Process configuration items
                if (key.toUpperCase() == "SESSIONTOKEN") this.__nestToken = value;  // Session token to use for Nest calls
                if (typeof value == "object") {
                    // Assume since key value is an object, its a device configuration for matching serial number
                    this.__extraOptions[key.toUpperCase()] = {};
                    Object.entries(value).forEach(([subKey, value]) => {
                        if (subKey.toUpperCase() == "EXCLUDE" && typeof value == "boolean" && value == true) this.__excludedDevices.push(key.toUpperCase());    // Push this devices serial number onto our list
                        if (subKey.split('.')[0].toUpperCase() == "OPTION" && subKey.split('.')[1]) {
                            // device option we'll insert into the Nest data. also allows us to override existing Nest data for the device, such as MAC address etc
                            this.__extraOptions[key.toUpperCase()][subKey.split('.')[1]] = value;
                        }
                    });
                }
            });
        }        
    }
}

// Create the thermostat object
function ThermostatClass() {
    this.__ThermostatService = null;            // HomeKit service for this thermostat
    this.__BatteryService = null;               // Status of Nest Thermostat battery
    this.__OccupancyService = null;             // Status of Away/Home
    this.__HumidityService = null;              // Seperate humidity sensor
    this.__FanService = null;                   // Fan service
    this.__nestObject = null;
    this.__nestCanHeat = null;
    this.__nestCanCool = null;
    this.__nestHasFan = null;
    this.__nestDeviceID = null;                 // Nest device ID for this Nest Thermostat
    this.__updatingHomeKit = false;             // Flag if were doing an HomeKit or not
    this.historyService = null;                 // History logging service
}

// Create the sensor object
function TempSensorClass() {
    this.__TemperatureService = null;           // HomeKit service for this temperature sensor
    this.__BatteryService = null;               // Status of Nest Temperature Sensor Battery
    this.__nestDeviceID = null;                 // Nest device ID for this Nest Temperature Sensor
    this.__updatingHomeKit = false;             // Flag if were doing an HomeKit or not
    this.historyService = null;                 // History logging service
}

// Create the sensor object
function SmokeSensorClass() {
    this.__SmokeService = null;                 // HomeKit service for this smoke sensor
    this.__COService = null;                    // HomeKit service for this CO sensor
    this.__BatteryService = null;               // Status of Nest Protect Sensor Battery
    this.__MotionService = null;                // Status of Nest Protect motion sensor
    this.__nestDeviceID = null;                 // Nest device ID for this Nest Protect Sensor
    this.__nestObject = null;
    this.__updatingHomeKit = false;             // Flag if were doing an HomeKit or not
}

// Create the camera object
function CameraClass() {
    this.__doorbellController = null;           // HomeKit Doorbell controller services
    this.__cameraController = null;             // HomeKit camera controller services
    this.__nestObject = null;
    this.__BatteryService = null;               // Status of Nest Hello/Cam(s) Battery
    this.__MotionServices = [];                 // Status of Nest Hello/Cam(s) motion sensor(s)
    this.__nestDeviceID = null;                 // Nest device ID for this Nest Hello/Cam(s)
    this.__updatingHomeKit = false;             // Flag if were doing an HomeKit or not
    this.rangDoorbell = false;
    this.personDetected = false;
    this.packageDetected = false;
    this.faceDetected = false;
    this.snapshotEvent = {type: "", time: 0, id: 0, "done": false};
    this.historyService = null;                 // History logging service
    this.pendingSessions = [];                      
    this.ongoingSessions = [];
    this.ongoingStreams = [];
}


// Nest Thermostat
ThermostatClass.prototype.addThermostat = function(HomeKitAccessory, thisServiceName, serviceNumber, thisNestDevice) {
    // Add this thermostat to the "master" accessory and set properties
    this.__ThermostatService = HomeKitAccessory.addService(Service.Thermostat, "Thermostat", 1);
    this.__ThermostatService.addCharacteristic(Characteristic.StatusActive);
    this.__ThermostatService.addCharacteristic(Characteristic.LockPhysicalControls);    // Seeting can only be accessed via Eve App (or other 3rd party). Will code in some logic to use it

    // Add battery service to display battery level
    this.__BatteryService = HomeKitAccessory.addService(Service.BatteryService, "", 1);

    // Seperate humidity sensor if configured todo so
    if (thisNestDevice.humidity_sensor && thisNestDevice.humidity_sensor == true) {
        this.__HumidityService = HomeKitAccessory.addService(Service.HumiditySensor, "Humidity", 1);      // Humidity will be listed under seperate sensor
    } else {
        this.__ThermostatService.addCharacteristic(Characteristic.CurrentRelativeHumidity); // Humidity will be listed under thermostat only
    }

    // Add home/away status as an occupancy sensor
    this.__OccupancyService = HomeKitAccessory.addService(Service.OccupancySensor, "Occupancy", 1);
    this.__OccupancyService.addCharacteristic(Characteristic.StatusActive);

    // Limit prop ranges
    if (thisNestDevice.can_cool == false && thisNestDevice.can_heat == true)
    {
        // Can heat only, so set values allowed for mode off/heat
        this.__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.HEAT]});
    } else if (thisNestDevice.can_cool == true && thisNestDevice.can_heat == false) {
        // Can cool only
        this.__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.COOL]});
    } else if (thisNestDevice.can_cool == true && thisNestDevice.can_heat == true) {
        // heat and cool 
        this.__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.HEAT, Characteristic.TargetHeatingCoolingState.COOL, Characteristic.TargetHeatingCoolingState.AUTO]});
    } else {
        // only off mode
        this.__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF]});
    }

    // Add fan service if Nest supports a fan
    if (thisNestDevice.has_fan == true) {
        this.__FanService = HomeKitAccessory.addService(Service.Fan, "Fan", 1);
        this.__FanService.getCharacteristic(Characteristic.On).on("set", this.setFan.bind(this));
    }
    
    // Set default ranges - based on celsuis ranges
    this.__ThermostatService.setCharacteristic(Characteristic.TemperatureDisplayUnits, Characteristic.TemperatureDisplayUnits.CELSIUS);
    this.__ThermostatService.getCharacteristic(Characteristic.CurrentTemperature).setProps({minStep: 0.5});
    this.__ThermostatService.getCharacteristic(Characteristic.TargetTemperature).setProps({minStep: 0.5}, {minValue: 9}, {maxValue: 32});
    this.__ThermostatService.getCharacteristic(Characteristic.CoolingThresholdTemperature).setProps({minStep: 0.5}, {minValue: 9}, {maxValue: 32});
    this.__ThermostatService.getCharacteristic(Characteristic.HeatingThresholdTemperature).setProps({minStep: 0.5}, {minValue: 9}, {maxValue: 32});

    // Setup set callbacks for characteristics
    this.__ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).on("set", this.setDisplayUnits.bind(this));
    this.__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).on("set", this.setMode.bind(this));
    this.__ThermostatService.getCharacteristic(Characteristic.TargetTemperature).on("set", (value, callback) => {this.setTemperature(Characteristic.TargetTemperature, value, callback)});
    this.__ThermostatService.getCharacteristic(Characteristic.CoolingThresholdTemperature).on("set", (value, callback) => {this.setTemperature(Characteristic.CoolingThresholdTemperature, value, callback)});
    this.__ThermostatService.getCharacteristic(Characteristic.HeatingThresholdTemperature).on("set", (value, callback) => {this.setTemperature(Characteristic.HeatingThresholdTemperature, value, callback)});
    this.__ThermostatService.getCharacteristic(Characteristic.LockPhysicalControls).on("set", (value, callback) => {this.setChildlock("", value, callback)});

    // Setup logging
    this.historyService = new HomeKitHistory(HomeKitAccessory, {});
    this.historyService.linkToEveHome(HomeKitAccessory, this.__ThermostatService, {});

    this.updateHomeKit(HomeKitAccessory, thisNestDevice);  // Do initial HomeKit update
    console.log("Setup Nest Thermostat '%s' on '%s'", thisServiceName, HomeKitAccessory.username, (this.__HumidityService != null ? "with seperate humidity sensor" : ""));
}

ThermostatClass.prototype.setFan = function(value, callback) {
    this.__updatingHomeKit = true;

    this.__FanService.getCharacteristic(Characteristic.On).updateValue(value);
    this.__nestObject.setNestValue("device." + this.__orgNestDeviceID.split('.')[1], "fan_timer_timeout", value == false ? 0 : this.__nestObject.__currentNestData.device[this.__nestDeviceID].fan_duration + Math.floor(new Date() / 1000));

    if (typeof callback === "function") callback();  // do callback if defined
    this.__updatingHomeKit = false;
}

ThermostatClass.prototype.setDisplayUnits = function(value, callback) {
    this.__updatingHomeKit = true;

    // Update HomeKit steps and ranges for temperatures
    this.__ThermostatService.getCharacteristic(Characteristic.CurrentTemperature).setProps({minStep: (value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 0.5 : 1)});
    this.__ThermostatService.getCharacteristic(Characteristic.TargetTemperature).setProps({minStep: (value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 0.5 : 1)}, {minValue: (value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 9 : 48)}, {maxValue: (value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 9 : 90)});
    this.__ThermostatService.getCharacteristic(Characteristic.CoolingThresholdTemperature).setProps({minStep: (value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 0.5 : 1)}, {minValue: (value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 9 : 48)}, {maxValue: (value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 9 : 90)});
    this.__ThermostatService.getCharacteristic(Characteristic.HeatingThresholdTemperature).setProps({minStep: (value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 0.5 : 1)}, {minValue: (value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 9 : 48)}, {maxValue: (value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 9 : 90)});

    this.__ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).updateValue(value);
    this.__nestObject.setNestValue("device." + this.__orgNestDeviceID.split('.')[1], "temperature_scale", value == Characteristic.TemperatureDisplayUnits.CELSIUS ? "C" : "F");
    if (typeof callback === "function") callback();  // do callback if defined

    this.__updatingHomeKit = false;
}

ThermostatClass.prototype.setMode = function(value, callback) {
    this.__updatingHomeKit = true;

    if (value != this.__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).value) {
        // Only change heating/cooling mode if change requested is different than current HomeKit state
        var tempMode = "";
        var tempValue = null;

        if (value == Characteristic.TargetHeatingCoolingState.HEAT && this.__nestCanHeat == true) {
            tempMode = "heat";
            tempValue = Characteristic.TargetHeatingCoolingState.HEAT;
        }
        if (value == Characteristic.TargetHeatingCoolingState.COOL && this.__nestCanCool == true) {
            tempMode = "cool";
            tempValue = Characteristic.TargetHeatingCoolingState.COOL;
        }
        if (value == Characteristic.TargetHeatingCoolingState.AUTO) {
            // Workaround for "Hey Siri, turn on my thermostat". Appears to automatically request mode as "auto", but we need to see what Nest device supports
            if (this.__nestCanCool == true && this.__nestCanHeat == true) {
                tempMode = "range";
                tempValue = Characteristic.TargetHeatingCoolingState.AUTO;
            } else if (this.__nestCanCool == true && this.__nestCanHeat == false) {
                tempMode = "cool";
                tempValue = Characteristic.TargetHeatingCoolingState.COOL;
            } else if (this.__nestCanCool == false && this.__nestCanHeat == true) {
                tempMode = "heat";
                tempValue = Characteristic.TargetHeatingCoolingState.HEAT;
            } else {
                tempMode = "off"
                tempValue = Characteristic.TargetHeatingCoolingState.OFF;
            }
        }
        if (value == Characteristic.TargetHeatingCoolingState.OFF) {
            tempMode = "off";
            tempValue = Characteristic.TargetHeatingCoolingState.OFF;
        }

        if (tempValue != null && tempMode != "") {
            this.__nestObject.setNestValue("shared." + this.__orgNestDeviceID.split('.')[1], "target_temperature_type", tempMode, false);
            this.__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).updateValue(tempValue);
            
            if (this.__nestObject.__previousNestData != null && this.__nestObject.__currentNestData != null && this.__nestObject.__previousNestData.device[this.__nestDeviceID].target_temperature_type == "range" && (tempMode == "heat" || tempMode == "cool")) {
                // If switching from range to heat/cool, update HomeKit using previous target temp
                this.__ThermostatService.getCharacteristic(Characteristic.TargetTemperature).updateValue(this.__nestObject.__currentNestData.device[this.__nestDeviceID].target_temperature);
            }
        }
    }
    if (typeof callback === "function") callback();  // do callback if defined

    this.__updatingHomeKit = false;
}

ThermostatClass.prototype.setTemperature = function(characteristic, value, callback) {
    this.__updatingHomeKit = true;

    if (characteristic == Characteristic.TargetTemperature && this.__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).value != Characteristic.TargetHeatingCoolingState.AUTO) {
        this.__nestObject.setNestValue("shared." + this.__orgNestDeviceID.split('.')[1], "target_temperature", __adjustTemperature(value, "C", "C"), false);
    }
    if (characteristic == Characteristic.HeatingThresholdTemperature && this.__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).value == Characteristic.TargetHeatingCoolingState.AUTO) {
        this.__nestObject.setNestValue("shared." + this.__orgNestDeviceID.split('.')[1], "target_temperature_low", __adjustTemperature(value, "C", "C"), false);
    }
    if (characteristic == Characteristic.CoolingThresholdTemperature && this.__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).value == Characteristic.TargetHeatingCoolingState.AUTO) {
        this.__nestObject.setNestValue("shared." + this.__orgNestDeviceID.split('.')[1], "target_temperature_high", __adjustTemperature(value, "C", "C"), false);
    }

    this.__ThermostatService.getCharacteristic(characteristic).updateValue(value);  // Update HomeKit with value
    if (typeof callback === "function") callback();  // do callback if defined

    this.__updatingHomeKit = false;
}

ThermostatClass.prototype.setChildlock = function(pin, value, callback) {
    this.__updatingHomeKit = true;
    // TODO - pincode setting when turning on. Writes to device.xxxxxxxx.temperature_lock_pin_hash. How is the hash calculated???
    // Do we set temperature range limits when child lock on??
    // temperature_lock_pin_hash: 'QPIkbIOM4OEg5qja56LqQ6Egecs='  === 4 1 9 2

    this.__ThermostatService.getCharacteristic(Characteristic.LockPhysicalControls).updateValue(value);  // Update HomeKit with value
    if (value == Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED) {
        // Set pin hash????
    }
    if (value == Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED) {
        // Clear pin hash????
    }
    this.__nestObject.setNestValue("device." + this.__orgNestDeviceID.split('.')[1], "temperature_lock", value == Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED ? true : false);
    
    if (typeof callback === "function") callback();  // do callback if defined
    
    this.__updatingHomeKit = false;
}

ThermostatClass.prototype.updateHomeKit = function(HomeKitAccessory, thisNestDevice) {
    var historyEntry = {};

    if (typeof thisNestDevice == "object" && this.__updatingHomeKit == false)
    {
        if (this.__ThermostatService != null && this.__BatteryService != null && this.__OccupancyService != null) {
            HomeKitAccessory.getService(Service.AccessoryInformation).getCharacteristic(Characteristic.FirmwareRevision).updateValue(thisNestDevice.software_version);   // Update firmware version
            this.__ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).updateValue(thisNestDevice.temperature_scale.toUpperCase() == "C" ? Characteristic.TemperatureDisplayUnits.CELSIUS : Characteristic.TemperatureDisplayUnits.FAHRENHEIT);
            this.__ThermostatService.getCharacteristic(Characteristic.CurrentTemperature).updateValue(thisNestDevice.active_temperature);
            this.__ThermostatService.getCharacteristic(Characteristic.StatusActive).updateValue((thisNestDevice.online == true || thisNestDevice.removed_from_base == false) ? true : false);  // If Nest isn't online or removed from base, report in HomeKit
            this.__ThermostatService.getCharacteristic(Characteristic.LockPhysicalControls).updateValue(thisNestDevice.temperature_lock == true ? Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED : Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED);
            
            // Update HomeKit steps and ranges for temperatures
            // Do we limit ranges when childlock on????
            this.__ThermostatService.getCharacteristic(Characteristic.CurrentTemperature).setProps({minStep: (this.__ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 0.5 : 1)});
            this.__ThermostatService.getCharacteristic(Characteristic.TargetTemperature).setProps({minStep: (this.__ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 0.5 : 1)}, {minValue: (this.__ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 9 : 48)}, {maxValue: (this.__ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 32 : 90)});
            this.__ThermostatService.getCharacteristic(Characteristic.CoolingThresholdTemperature).setProps({minStep: (this.__ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 0.5 : 1)}, {minValue: (this.__ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 9 : 48)}, {maxValue: (this.__ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 32 : 90)});
            this.__ThermostatService.getCharacteristic(Characteristic.HeatingThresholdTemperature).setProps({minStep: (this.__ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 0.5 : 1)}, {minValue: (this.__ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 9 : 48)}, {maxValue: (this.__ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 32 : 90)});
    
            // Battery status if defined. Since Nest needs 3.6 volts to turn on, we'll use that as the lower limit. Havent seen battery level above 3.9ish, so assume 3.9 is upper limit
            var tempBatteryLevel = __scale(thisNestDevice.battery_level, 3.6, 3.9, 0, 100);
            this.__BatteryService.getCharacteristic(Characteristic.BatteryLevel).updateValue(tempBatteryLevel);
            this.__BatteryService.getCharacteristic(Characteristic.StatusLowBattery).updateValue(tempBatteryLevel > LOW_BATTERY_LEVEL ? Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL : Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);
            this.__BatteryService.getCharacteristic(Characteristic.ChargingState).updateValue(thisNestDevice.battery_charging_state == true ? Characteristic.ChargingState.CHARGING : Characteristic.ChargingState.NOT_CHARGING);
    
            // Update for away/home status. Away = no occupancy detected, Home = Occupancy Detected
            this.__OccupancyService.getCharacteristic(Characteristic.OccupancyDetected).updateValue(thisNestDevice.away == true ? Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED : Characteristic.OccupancyDetected.OCCUPANCY_DETECTED);
            this.__OccupancyService.getCharacteristic(Characteristic.StatusActive).updateValue((thisNestDevice.online == true || thisNestDevice.removed_from_base == false) ? true : false);  // If Nest isn't online or removed from base, report in HomeKit

            // Update seperate humidity sensor if configured todo so
            if (this.__HumidityService != null) {
                this.__HumidityService.getCharacteristic(Characteristic.CurrentRelativeHumidity).updateValue(thisNestDevice.current_humidity);  // Humidity will be listed under seperate sensor
            } else {
                this.__ThermostatService.getCharacteristic(Characteristic.CurrentRelativeHumidity).updateValue(thisNestDevice.current_humidity);    // Humidity will be listed under thermostat only
            }

            this.__ThermostatService.getCharacteristic(Characteristic.TargetTemperature).updateValue(thisNestDevice.target_temperature);
            this.__ThermostatService.getCharacteristic(Characteristic.HeatingThresholdTemperature).updateValue(thisNestDevice.target_temperature_low);
            this.__ThermostatService.getCharacteristic(Characteristic.CoolingThresholdTemperature).updateValue(thisNestDevice.target_temperature_high);

            if (this.__nestHasFan != thisNestDevice.has_fan) {
                // fan setup has changed on thermostat
                if (this.__nestHasFan == false && thisNestDevice.has_fan == true && this.__FanService == null) {
                    // A fan has been added
                    this.__FanService = HomeKitAccessory.addService(Service.Fan, "Fan", 1);
                    this.__FanService.getCharacteristic(Characteristic.On).on("set", this.setFan.bind(this));
                }
                if (this.__nestHasFan == true && thisNestDevice.has_fan == false && this.__FanService != null) {
                    // A fan has been removed
                    HomeKitAccessory.removeService(this.__FanService);
                    this.__FanService = null;
                }
            }

            // Update fan mode
            this.__nestHasFan = thisNestDevice.has_fan;

            if (this.__nestCanCool != thisNestDevice.can_cool || this.__nestCanHeat != thisNestDevice.can_heat) {
                // Heating and/cooling setup has changed on thermostat

                // Limit prop ranges
                if (thisNestDevice.can_cool == false && thisNestDevice.can_heat == true)
                {
                    // Can heat only, so set values allowed for mode off/heat
                    this.__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.HEAT]});
                }
                if (thisNestDevice.can_cool == true && thisNestDevice.can_heat == false) {
                    // Can cool only
                    this.__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.COOL]});
                }
                if (thisNestDevice.can_cool == true && thisNestDevice.can_heat == true) {
                    // heat and cool 
                    this.__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.HEAT, Characteristic.TargetHeatingCoolingState.COOL, Characteristic.TargetHeatingCoolingState.AUTO]});
                }
                if (thisNestDevice.can_cool == false && thisNestDevice.can_heat == false) {
                    // only off mode
                    this.__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF]});
                }
            } 

            // update cooling/heating modes
            this.__nestCanCool = thisNestDevice.can_cool;
            this.__nestCanHeat = thisNestDevice.can_heat;

            // Update current mode
            if (thisNestDevice.hvac_mode.toUpperCase() == "HEAT") {
                this.__ThermostatService.getCharacteristic(Characteristic.TargetTemperature).updateValue(thisNestDevice.target_temperature);
                this.__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).updateValue(Characteristic.TargetHeatingCoolingState.HEAT);
                historyEntry.target = {low: 0, high: thisNestDevice.target_temperature};    // single target temperature for heating limit
            }
            if (thisNestDevice.hvac_mode.toUpperCase() == "COOL") {
                this.__ThermostatService.getCharacteristic(Characteristic.TargetTemperature).updateValue(thisNestDevice.target_temperature);
                this.__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).updateValue(Characteristic.TargetHeatingCoolingState.COOL);
                historyEntry.target = {low: thisNestDevice.target_temperature, high: 0};    // single target temperature for heating limit
            }
            if (thisNestDevice.hvac_mode.toUpperCase() == "RANGE") {
                this.__ThermostatService.getCharacteristic(Characteristic.HeatingThresholdTemperature).updateValue(thisNestDevice.target_temperature_low);
                this.__ThermostatService.getCharacteristic(Characteristic.CoolingThresholdTemperature).updateValue(thisNestDevice.target_temperature_high);
                this.__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).updateValue(Characteristic.TargetHeatingCoolingState.AUTO);
                historyEntry.target = {low: thisNestDevice.target_temperature_low, high: thisNestDevice.target_temperature_high};    // target temperature range
            }
            if (thisNestDevice.hvac_mode.toUpperCase() == "OFF") {
                this.__ThermostatService.getCharacteristic(Characteristic.TargetTemperature).updateValue(thisNestDevice.target_temperature);
                this.__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).updateValue(Characteristic.TargetHeatingCoolingState.OFF);
                historyEntry.target = {low: 0, high: 0};    // thermostat off, so no target temperatures
            }

            // Update current state
            if (thisNestDevice.hvac_state.toUpperCase() == "HEATING") {
                if (thisNestDevice.previous_hvac_state.toUpperCase() == "COOLING" && thisNestDevice.coolingURL) {
                    // Switched to heating mode and external cooling URL was being used, so stop cooling via cooling URL
                    this.setDaikinAC(thisNestDevice.coolingURL, 0, 3, thisNestDevice.target_temperature_high, 0, "A", 3);
                }
                if (thisNestDevice.previous_hvac_state.toUpperCase() != "HEATING" && thisNestDevice.heatingURL) {
                    // Switched to heating mode and external heating URL is being used, so start heating via heating URL
                    // Insert code here to startup external heating source
                }
                this.__ThermostatService.getCharacteristic(Characteristic.CurrentHeatingCoolingState).updateValue(Characteristic.CurrentHeatingCoolingState.HEAT);
                historyEntry.status = 2;    // heating
            }
            if (thisNestDevice.hvac_state.toUpperCase() == "COOLING") {
                if (thisNestDevice.previous_hvac_state.toUpperCase() == "HEATING" && thisNestDevice.heatingURL) {
                    // Switched to cooling mode and external heating URL was being used, so stop heating via heating URL
                    // Insert code here to stop external heating source
                }
                if (thisNestDevice.previous_hvac_state.toUpperCase() != "COOLING" && thisNestDevice.coolingURL) {
                    // Switched to cooling mode and external cooling URL is being used, so start cooling via cooling URL
                    this.setDaikinAC(thisNestDevice.coolingURL, 1, 3, this.__ThermostatService.getCharacteristic(Characteristic.TargetTemperature).value, 0, "A", 3);
                }
                this.__ThermostatService.getCharacteristic(Characteristic.CurrentHeatingCoolingState).updateValue(Characteristic.CurrentHeatingCoolingState.COOL);
                historyEntry.status = 3;    // cooling
            }
            if (thisNestDevice.hvac_state.toUpperCase() == "OFF") {
                if (thisNestDevice.previous_hvac_state.toUpperCase() == "COOLING" && thisNestDevice.coolingURL) {
                    // Switched to off mode and external cooling URL was being used, so stop cooling via cooling URL
                    this.setDaikinAC(thisNestDevice.coolingURL, 0, 3, thisNestDevice.target_temperature, 0, "A", 3);
                }
                if (thisNestDevice.previous_hvac_state.toUpperCase() == "HEATING" && thisNestDevice.heatingURL) {
                    // Switched to off mode and external heating URL was being used, so stop heating via heating URL
                    // Insert code here to stop external heating source
                }
                this.__ThermostatService.getCharacteristic(Characteristic.CurrentHeatingCoolingState).updateValue(Characteristic.CurrentHeatingCoolingState.OFF);
                historyEntry.status = 0;    // off
            }

            if (this.__FanService != null) {
                if (thisNestDevice.previous_fan_state = false && thisNestDevice.fan_state == true) {
                    // Fan mode was switched on and external fan URL is being used, so start fan via fan URL
                    thisNestDevice.fanURL && this.setDaikinAC(thisNestDevice.fanURL, 1, 6, "--", "--", "A", 3);
                }
                if (thisNestDevice.previous_fan_state == true && thisNestDevice.fan_state == false) {
                    // Fan mode was switched off and external fan URL was being used, so stop fan via fan URL
                    thisNestDevice.fanURL && this.setDaikinAC(thisNestDevice.fanURL, 0, 3, thisNestDevice.target_temperature, 0, "A", 3);
                }

                this.__FanService.getCharacteristic(Characteristic.On).updateValue(thisNestDevice.fan_state);   // fan status on or off
                historyEntry.status = 1;    // fan
            }

            // Log thermostat metrics to history only if changed to previous recording
            if (this.historyService != null) {
                var tempEntry = this.historyService.lastHistory(this.__ThermostatService);
                if (tempEntry == null || (typeof tempEntry == "object" && tempEntry.status != historyEntry.status || tempEntry.temperature != thisNestDevice.active_temperature || JSON.stringify(tempEntry.target) != JSON.stringify(historyEntry.target) || tempEntry.humidity != thisNestDevice.current_humidity)) {
                    this.historyService.addHistory(this.__ThermostatService, {time: Math.floor(new Date() / 1000), status: historyEntry.status, temperature: thisNestDevice.active_temperature, target: historyEntry.target, humidity: thisNestDevice.current_humidity});
                }
            }
        }
    }
}
    
ThermostatClass.prototype.setDaikinAC = async function(daikinURL, daikinPwr, daikinMode, daikinTemp, daikinHumid, daikinFanSpeed, daikinFanMode) {
    await axios.get(daikinURL + "/aircon/set_control_info?pow=" + daikinPwr + "&mode=" + daikinMode + "&stemp=" + daikinTemp + "&shum=" + daikinHumid + "&f_rate=" + daikinFanSpeed + "&f_dir=" + daikinFanMode)
    .then(response => {
        if (response.status == 200) {
            console.log("setDaikinAC Pwr: '%s' Mode: '%s' Temp: '%s' Fan Mode: '%s' Fan Speed: '%s'", daikinPwr, daikinMode, daikinTemp, daikinFanMode, daikinFanSpeed);
        }
    })
    .catch(error => console.log("DEBUG: setDaikinAC failed", error.message));
}


// Nest Temperature Sensors
TempSensorClass.prototype.addTemperatureSensor = function(HomeKitAccessory, thisServiceName, serviceNumber, thisNestDevice) {
    // Add this temperature sensor to the "master" accessory and set properties   
    this.__TemperatureService = HomeKitAccessory.addService(Service.TemperatureSensor, "Temperature Sensor", 1);
    this.__TemperatureService.addCharacteristic(Characteristic.StatusActive);

    // Add battery service to display battery level    
    this.__BatteryService = HomeKitAccessory.addService(Service.BatteryService, "", 1);
    this.__BatteryService.getCharacteristic(Characteristic.ChargingState).updateValue(Characteristic.ChargingState.NOT_CHARGEABLE); // Temp sensors dont charge as run off battery

    // Setup logging
    this.historyService = new HomeKitHistory(HomeKitAccessory, {});
    this.historyService.linkToEveHome(HomeKitAccessory, this.__TemperatureService, {});

    this.updateHomeKit(HomeKitAccessory, thisNestDevice);  // Do initial HomeKit update    
    console.log("Setup Nest Temperature Sensor '%s' on '%s'", thisServiceName, HomeKitAccessory.username);
}

TempSensorClass.prototype.updateHomeKit = function(HomeKitAccessory, thisNestDevice) {
    if (typeof thisNestDevice == "object" && this.__updatingHomeKit == false)
    {
        if (this.__TemperatureService != null && this.__BatteryService != null) {
            this.__TemperatureService.getCharacteristic(Characteristic.StatusActive).updateValue(thisNestDevice.online == true ? true : false);  // If Nest isn't online, report in HomeKit

            // Update temperature
            this.__TemperatureService.getCharacteristic(Characteristic.CurrentTemperature).updateValue(thisNestDevice.current_temperature);

            // Log temperture to history only if changed to previous recording
            if ((this.historyService != null && typeof this.__nestObject != "object") || (this.historyService != null && this.__nestObject && thisNestDevice.current_temperature != this.__nestObject.__previousNestData.device[this.__nestDeviceID].current_temperature)) {
                this.historyService.addHistory(this.__TemperatureService, {time: Math.floor(new Date() / 1000), temperature: thisNestDevice.current_temperature});
            }
      
            // Update battery level
            var tempBatteryLevel = __scale(thisNestDevice.battery_level, 0, 100, 0, 100);
            this.__BatteryService.getCharacteristic(Characteristic.BatteryLevel).updateValue(tempBatteryLevel);
            this.__BatteryService.getCharacteristic(Characteristic.StatusLowBattery).updateValue(tempBatteryLevel > LOW_BATTERY_LEVEL ? Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL : Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);  
        }
    }
}


// Nest Protect
SmokeSensorClass.prototype.addSmokeCOSensor = function(HomeKitAccessory, thisServiceName, serviceNumber, thisNestDevice) {
    // Add this smoke sensor & CO sensor to the "master" accessory and set properties   
    this.__SmokeService = HomeKitAccessory.addService(Service.SmokeSensor, "Smoke", 1);
    this.__SmokeService.addCharacteristic(Characteristic.StatusActive);

    this.__COService = HomeKitAccessory.addService(Service.CarbonMonoxideSensor, "Carbon Monoxide", 1);
    this.__COService.addOptionalCharacteristic(Characteristic.CarbonMonoxideLevel);
    this.__COService.addOptionalCharacteristic(Characteristic.CarbonMonoxidePeakLevel);
    this.__COService.addCharacteristic(Characteristic.StatusActive);

    // Set maximum valkues for COPPM limits
    this.__COService.getCharacteristic(Characteristic.CarbonMonoxideLevel).setProps({maxValue: 2000});
    this.__COService.getCharacteristic(Characteristic.CarbonMonoxidePeakLevel).setProps({maxValue: 2000});

    // Add battery service to display battery level
    this.__BatteryService = HomeKitAccessory.addService(Service.BatteryService, "", 1);
    this.__BatteryService.removeCharacteristic(Characteristic.ChargingState);

    // Add montion sensor if supported (only on wired versions)
    if (thisNestDevice.wired_or_battery == 0) {
        this.__MotionService = HomeKitAccessory.addService(Service.MotionSensor, "Motion", 1);
        this.__MotionService.addCharacteristic(Characteristic.StatusActive);
    }

    HomeKitAccessory.setPrimaryService(this.__SmokeService);

    // Setup logging
    this.historyService = new HomeKitHistory(HomeKitAccessory, {});
    this.historyService.linkToEveHome(HomeKitAccessory, this.__SmokeService, {GetCommand: this.__EveHomeGetCommand.bind(this),
                                                                              SetCommand: this.__EveHomeSetCommand.bind(this),
                                                                              EveSmoke_lastalarmtest: thisNestDevice.latest_alarm_test,
                                                                              EveSmoke_alarmtest: thisNestDevice.self_test_in_progress,
                                                                              EveSmoke_heatstatus: thisNestDevice.heat_status,
                                                                              EveSmoke_hushedstate: thisNestDevice.hushed_state,
                                                                              EveSmoke_statusled: thisNestDevice.ntp_green_led,
                                                                              EveSmoke_smoketestpassed: thisNestDevice.smoke_test_passed,
                                                                              EveSmoke_heattestpassed: thisNestDevice.heat_test_passed
                                                                             });

    this.updateHomeKit(HomeKitAccessory, thisNestDevice);  // Do initial HomeKit update
    console.log("Setup Nest Protect '%s' on '%s'", thisServiceName, HomeKitAccessory.username, (this.__MotionService != null ? "with motion sensor" : ""));
}

SmokeSensorClass.prototype.updateHomeKit = function(HomeKitAccessory, thisNestDevice) {
    if (typeof thisNestDevice == 'object' && this.__updatingHomeKit == false)
    {
        if (this.__SmokeService != null && this.__COService != null && this.__BatteryService != null) {
            HomeKitAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, thisNestDevice.software_version);
            this.__SmokeService.getCharacteristic(Characteristic.StatusActive).updateValue((thisNestDevice.online == true || thisNestDevice.removed_from_base == false) ? true : false);  // If Nest isn't online or removed from base, report in HomeKit
            this.__COService.getCharacteristic(Characteristic.StatusActive).updateValue((thisNestDevice.online == true || thisNestDevice.removed_from_base == false) ? true : false);  // If Nest isn't online or removed from base, report in HomeKit
        
            if (this.__MotionService != null) {
                // Motion detect if auto_away = false. Not supported on battery powered Nest Protects
                this.__MotionService.getCharacteristic(Characteristic.StatusActive).updateValue((thisNestDevice.online == true || thisNestDevice.removed_from_base == false) ? true : false);  // If Nest isn't online or removed from base, report in HomeKit
                this.__MotionService.getCharacteristic(Characteristic.MotionDetected).updateValue(thisNestDevice.away == false ? true : false);

                // Log motion to history only if changed to previous recording
                if ((this.historyService != null && typeof this.__nestObject != "object") || (this.historyService != null && this.__nestObject && thisNestDevice.away != this.__nestObject.__previousNestData.device[this.__nestDeviceID].away)) {
                    this.historyService.addHistory(this.__MotionService, {time: Math.floor(new Date() / 1000), status: thisNestDevice.away == false ? 1 : 0}); 
                }
            }

            // Update battery level
            var tempBatteryLevel = __scale(thisNestDevice.battery_level, 0, 5400, 0, 100);
            this.__BatteryService.getCharacteristic(Characteristic.BatteryLevel).updateValue(tempBatteryLevel);
            this.__BatteryService.getCharacteristic(Characteristic.StatusLowBattery).updateValue((tempBatteryLevel > LOW_BATTERY_LEVEL && thisNestDevice.battery_health_state == 0 && ((thisNestDevice.line_power_present == true && thisNestDevice.wired_or_battery == 0) || (thisNestDevice.line_power_present == false && thisNestDevice.wired_or_battery == 1))) ? Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL : Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);
            this.__BatteryService.getCharacteristic(Characteristic.ChargingState).updateValue(thisNestDevice.battery_charging_state == true ? Characteristic.ChargingState.CHARGING : Characteristic.ChargingState.NOT_CHARGING);
    
            // Update smoke and CO detected status 'ok': 0, 'warning': 1, 'emergency': 2
            this.__SmokeService.getCharacteristic(Characteristic.SmokeDetected).updateValue(thisNestDevice.smoke_status == 0 ? Characteristic.SmokeDetected.SMOKE_NOT_DETECTED : Characteristic.SmokeDetected.SMOKE_DETECTED);
            this.__COService.getCharacteristic(Characteristic.CarbonMonoxideDetected).updateValue(thisNestDevice.co_status == 0 ? Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL : Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL);

            // Update CO levels
            //this.__COService.getCharacteristic(Characteristic.CarbonMonoxideLevel).updateValue(thisNestDevice.????);
            this.__COService.getCharacteristic(Characteristic.CarbonMonoxidePeakLevel).updateValue(thisNestDevice.co_previous_peak);

            // Notify Eve App of device status changes??? */
            this.historyService.updateEveHome(this.__SmokeService, {GetCommand: this.__EveHomeGetCommand.bind(this)});
        }
    }
}

SmokeSensorClass.prototype.__EveHomeGetCommand = function(data) {
    // Pass back extra data for Eve Smoke "get" process command
    if (this.__nestObject.__currentNestData != null && typeof (this.__nestObject.__currentNestData.device[this.__nestDeviceID] == "object")) {
        data.lastalarmtest = this.__nestObject.__currentNestData.device[this.__nestDeviceID].latest_alarm_test;
        data.alarmtest = this.__nestObject.__currentNestData.device[this.__nestDeviceID].self_test_in_progress;
        data.heatstatus = this.__nestObject.__currentNestData.device[this.__nestDeviceID].heat_status;
        data.statusled = this.__nestObject.__currentNestData.device[this.__nestDeviceID].ntp_green_led;
        data.smoketestpassed = this.__nestObject.__currentNestData.device[this.__nestDeviceID].smoke_test_passed;
        data.heattestpassed = this.__nestObject.__currentNestData.device[this.__nestDeviceID].heat_test_passed;
        data.hushedstate = this.__nestObject.__currentNestData.device[this.__nestDeviceID].hushed_state;
    }
    return data;
}

SmokeSensorClass.prototype.__EveHomeSetCommand = function(processed) {
    if (processed.hasOwnProperty("alarmtest")) {
        //console.log("Eve Smoke Alarm test", (processed.alarmtest == true ? "start" : "stop"));
    }
    if (processed.hasOwnProperty("statusled")) {
        this.__nestObject.__currentNestData.device[this.__nestDeviceID].ntp_green_led = processed.statusled;    // Do quick status update as setting nest values does take sometime
        this.__nestObject.setNestValue("topaz." + this.__orgNestDeviceID.split('.')[1], "ntp_green_led_enable", processed.statusled);
    }
}


// Nest Hello/Cam(s)
CameraClass.prototype.addCamera = function(HomeKitAccessory, thisServiceName, serviceNumber, thisNestDevice) {
    // TODO
}

CameraClass.prototype.addDoorbell = function(HomeKitAccessory, thisServiceName, serviceNumber, thisNestDevice) {
    this.__doorbellController = new DoorbellController({
        //name : "doorbell",  // Acessory name <- requires update to hap-nodejs
        cameraStreamCount: 2, // HomeKit requires at least 2 streams, but 1 is also just fine
        delegate: this, // Our class is the delgate for handling streaming/images
        streamingOptions: {
            supportedCryptoSuites: [0], // SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80
            video: {
                resolutions: [
                    [1920, 1080, 30],   // width, height, framerate
                    [1600, 1200, 30],   // Native res of Nest Hello
                    [1280, 960, 30],
                    [1280, 720, 30],
                    [1024, 768, 30],
                    [640, 480, 30],
                    [640, 360, 30],
                    [480, 360, 30],
                    [480, 270, 30],
                    [320, 240, 30],
                    [320, 240, 15],     // Apple Watch requires this configuration (Apple Watch also seems to required OPUS @16K)
                    [320, 180, 30],
                ],
                codec: {
                    profiles : [0, 1, 2], // H264Profile.HIGH = 0x02, as default profile in streamer is VIDEO_H264_2MBIT_L40
                    levels: [0, 1, 2], // H264Level.LEVEL4_0 = 0x02, as Default level in streamer is VIDEO_H264_2MBIT_L40
                },
            },
            audio : {
                twoWayAudio: (parseInt(thisNestDevice.software_version) >= 4110019 ? true : false),  // Nest Hello enabled two/way audio in firmware 4110019 or later
                codecs: [
                    {
                        type: "AAC-eld", // AudioStreamingCodecType.AAC_ELD
                        samplerate: 16, // AudioStreamingSamplerate.KHZ_16
                    },
                ], 
            },
        }
    });

    HomeKitAccessory.configureController(this.__doorbellController); 
    this.__doorbellController.doorbellService.addCharacteristic(Characteristic.StatusActive);

    // Motion service(s) for doorbell. Zone id of 0 is the main sensor zone on camera/doorbell
    thisNestDevice.activity_zones.forEach(zone => {
        var tempService = HomeKitAccessory.addService(Service.MotionSensor, (zone.id == 0 ? "Motion" : zone.name), zone.id);
        this.__MotionServices.push({"service": tempService, "id": zone.id})
    });

    // Setup logging
    this.historyService = new HomeKitHistory(HomeKitAccessory, {});
    this.historyService.linkToEveHome(HomeKitAccessory, this.__doorbellController.doorbellService, {});

    this.updateHomeKit(HomeKitAccessory, thisNestDevice);  // Do initial HomeKit update
    console.log("Setup Nest Hello '%s' on '%s'", thisServiceName, HomeKitAccessory.username, this.__MotionServices.length >= 1 ? "with motion sensor(s)" : "");
}

CameraClass.prototype.handleSnapshotRequest = async function(request, callback) {
    // Get current image from doorbell
    var imageBuffer = [];

    if (this.__nestDeviceID != null && typeof this.__nestObject.__currentNestData.device[this.__nestDeviceID] == "object") {
        if (this.__nestObject.__currentNestData.device[this.__nestDeviceID] && this.__nestObject.__currentNestData.device[this.__nestDeviceID].streaming_enabled == true && this.__nestObject.__currentNestData.device[this.__nestDeviceID].online == true) { 
            // grab snapshot from camera stream. If we have an current event, get the snpashot for that event
            if (this.snapshotEvent.type != "" && this.snapshotEvent.done == false) {
                // TODO - pass event "short" video as notification rather than still image. Is this even possible??
                await axios.get(this.__nestObject.__currentNestData.device[this.__nestDeviceID].nexus_api_http_server_url + "/event_snapshot/" + this.__nestObject.__currentNestData.device[this.__nestDeviceID].camera_uuid + "/" + this.snapshotEvent.id + "?crop_type=timeline" /*+ "&width=" + request.width */, {responseType: "arraybuffer", headers: {"user-agent": USERAGENT, "cookie": "website_2=" + this.__nestObject.__nestCookie}, timeout: 3000, retry: 3, retryDelay: 1000})
                .then(response => {
                    if (response.status == 200) {
                        imageBuffer = response.data;
                        this.snapshotEvent.done = true;  // Successfully got the snapshot for the event
                    }
                })
                .catch(error => {
                });
            } else {
                // Get a snapshot from the current camera feed
                await axios.get(this.__nestObject.__currentNestData.device[this.__nestDeviceID].nexus_api_http_server_url + "/get_image?uuid=" + this.__nestObject.__currentNestData.device[this.__nestDeviceID].camera_uuid /*+ "&width=" + request.width*/, {responseType: "arraybuffer", headers: {"user-agent": USERAGENT, "cookie": "website_2=" + this.__nestObject.__nestCookie}, timeout: 3000, retry: 3, retryDelay: 1000})
                .then(response => {
                    if (response.status == 200) {
                        imageBuffer = response.data;
                    } 
                })
                .catch(error => {
                });
            }
        }

        if (this.__nestObject.__currentNestData.device[this.__nestDeviceID] && this.__nestObject.__currentNestData.device[this.__nestDeviceID].streaming_enabled == false && this.__nestObject.__currentNestData.device[this.__nestDeviceID].online == true) { 
            // Load "camera switched off" jpg, and return that to image buffer
            if (fs.existsSync(__dirname + "/Nest_cameraoff.jpg")) {
                imageBuffer = fs.readFileSync(__dirname + "/Nest_cameraoff.jpg");
            }
        }

        if (this.__nestObject.__currentNestData.device[this.__nestDeviceID] && this.__nestObject.__currentNestData.device[this.__nestDeviceID].online == false) {
            // load "camera offline" jpg, and return that to image buffer
            if (fs.existsSync(__dirname + "/Nest_offline.jpg")) {
                imageBuffer = fs.readFileSync(__dirname + "/Nest_offline.jpg");
            }
        }
    }    

    callback(null, imageBuffer);
}

CameraClass.prototype.prepareStream = async function(request, callback) {
    const getPort = options => new Promise((resolve, reject) => {
        var server = net.createServer();
        server.unref();
        server.on("error", reject);
        server.listen(options, () => {
            var {port} = server.address();
            server.close(() => {
                resolve(port);
            });
        });
    });

    // Generate streaming session information
    var sessionInfo = {
        HomeKitSessionID: request.sessionID,  // Store session ID
        address: request.targetAddress,
        videoPort: request.video.port,
        localVideoPort: await getPort(),
        videoCryptoSuite: request.video.srtpCryptoSuite,
        videoSRTP: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
        videoSSRC: this.__doorbellController != null ? DoorbellController.generateSynchronisationSource() : CameraController.generateSynchronisationSource(),

        audioPort: request.audio.port,
        localAudioPort: await getPort(),
        twoWayAudioPort: await getPort(),
        audioServerPort: await getPort(),
        audioCryptoSuite: request.video.srtpCryptoSuite,
        audioSRTP: Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]),
        audioSSRC: this.__doorbellController != null ? DoorbellController.generateSynchronisationSource() : CameraController.generateSynchronisationSource(),

        rtpSplitter: null,
        ffmpegVideo: null,
        ffmpegAudio: null,
        ffmpegAudioReturn: null, 
        video: null,
        audio: null
    };

    // setup for splitting audio stream into seperate parts to allow two/way audio 
    sessionInfo.rtpSplitter = dgram.createSocket("udp4");
    sessionInfo.rtpSplitter.on("error", function(error) {
        sessionInfo.rtpSplitter.close();
    });
    sessionInfo.rtpSplitter.on("message", function(message) {
        payloadType = (message.readUInt8(1) & 0x7f);
        if (payloadType > 90 || payloadType === 0) {
            if (message.length > 50) {
                sessionInfo.rtpSplitter.send(message, sessionInfo.twoWayAudioPort, "localhost");
            } else {
                sessionInfo.rtpSplitter.send(message, sessionInfo.localAudioPort, "localhost");
            }
        } else {
            sessionInfo.rtpSplitter.send(message, sessionInfo.localAudioPort, "localhost");
            // Send RTCP to return audio as a heartbeat
            sessionInfo.rtpSplitter.send(message, sessionInfo.twoWayAudioPort, "localhost");
        }
    });
    sessionInfo.rtpSplitter.bind(sessionInfo.audioServerPort);

    // Build response back to HomeKit with our details
    var response = {
        address: ip.address("public", request.addressVersion), // ip Address version must match
        video: {
            port: sessionInfo.localVideoPort,
            ssrc: sessionInfo.videoSSRC,
            srtp_key: request.video.srtp_key,
            srtp_salt: request.video.srtp_salt,
        },
        audio: {
            port: sessionInfo.audioServerPort,
            ssrc: sessionInfo.audioSSRC,
            srtp_key: request.audio.srtp_key,
            srtp_salt: request.audio.srtp_salt,
        }
    };
    this.pendingSessions[request.sessionID] = sessionInfo;  // Store the session information
    callback(null, response);
}

CameraClass.prototype.handleStreamRequest = function (request, callback) {
    // called when HomeKit asks stream to start/stop/reconfigure
    switch (request.type) {
        case "start" : {         
            // Build ffmpeg command for streaming
            var ffmpegVideo = this.__buildVideoStream(request.video, this.pendingSessions[request.sessionID], callback);
            var ffmpegAudio = this.__buildAudioStream(request.audio, this.pendingSessions[request.sessionID], callback);
            this.ongoingSessions[request.sessionID] = this.pendingSessions[request.sessionID];  // Move our pending session to ongoing session
            this.ongoingSessions[request.sessionID].ffmpegVideo = ffmpegVideo;  // Store ffmpeg video process ID
            this.ongoingSessions[request.sessionID].ffmpegAudio = ffmpegAudio.ffmpegAudio;  // Store ffmpeg audio process ID
            this.ongoingSessions[request.sessionID].ffmpegAudioReturn = ffmpegAudio.ffmpegAudioReturn;  // Store ffmpeg audio return process ID
            this.ongoingSessions[request.sessionID].video = request.video;  // Cache the video request details
            this.ongoingSessions[request.sessionID].audio = request.audio;  // Cache the audio request details
            delete this.pendingSessions[request.sessionID]; // remove this pending session information

            // Start streaming from doorbell/camera
            this.ongoingStreams[request.sessionID] = new NexusStreamer(this.__nestObject.__nestCookie, this.__nestObject.__currentNestData.device[this.__nestDeviceID]);
            this.ongoingStreams[request.sessionID].connectToStream(this.ongoingSessions[request.sessionID].ffmpegVideo, this.ongoingSessions[request.sessionID].ffmpegAudio,  this.ongoingSessions[request.sessionID].ffmpegAudioReturn);
            this.ongoingStreams[request.sessionID].startPlayback();
            break;
        }

        case "stop" : {
            if (typeof this.ongoingStreams[request.sessionID] != "undefined") {
                this.ongoingStreams[request.sessionID].stopPlayback();
                delete this.ongoingStreams[request.sessionID];  // ongoing stream finished
            }
            if (typeof this.ongoingSessions[request.sessionID] != "undefined") {
                this.ongoingSessions[request.sessionID].rtpSplitter.close();
                this.ongoingSessions[request.sessionID].ffmpegVideo.kill('SIGKILL');
                this.ongoingSessions[request.sessionID].ffmpegAudio.kill('SIGKILL');
                this.ongoingSessions[request.sessionID].ffmpegAudioReturn.kill('SIGKILL');
                if (this.__doorbellController != null) this.__doorbellController.forceStopStreamingSession(this.ongoingSessions[request.sessionID]);
                if (this.__cameraController != null) this.__cameraController.forceStopStreamingSession(this.ongoingSessions[request.sessionID]);
                delete this.ongoingSessions[request.sessionID]; // this session has finished
            }
            callback();
            break;
        }

        case "reconfigure" : {
            // todo - implement???
            callback();
            break;
        }
    }
}

CameraClass.prototype.updateHomeKit = function(HomeKitAccessory, thisNestDevice) {
    if (typeof thisNestDevice == 'object' && this.__updatingHomeKit == false)
    {
        HomeKitAccessory.getService(Service.AccessoryInformation).getCharacteristic(Characteristic.FirmwareRevision).updateValue(thisNestDevice.software_version);   // Update firmware version
        if (this.__doorbellController != null) this.__doorbellController.doorbellService.getCharacteristic(Characteristic.StatusActive).updateValue(thisNestDevice.online == true ? true : false);  // If Nest isn't online, report in HomeKit
        if (this.__cameraController != null) this.__cameraController.cameraService.getCharacteristic(Characteristic.StatusActive).updateValue(thisNestDevice.online == true ? true : false);  // If Nest isn't online, report in HomeKit

        // Streaming enabled/disabled/turned off etc. If currently streaming, we need to reconfigure stream
        this.ongoingStreams && Object.entries(this.ongoingStreams).forEach(([sessionID, stream]) => {
            stream.reconfigureStream(this.__nestObject.__nestCookie, thisNestDevice, this.ongoingSessions[sessionID].ffmpegVideo, this.ongoingSessions[sessionID].ffmpegVideo, this.ongoingSessions[sessionID].ffmpegAudioReturn);
        });

        // Process activity zones to see if any were removed or added.
        thisNestDevice.activity_zones.forEach(zone => {
            if (zone.id != 0) {
                var index = this.__MotionServices.findIndex( ({ id }) => id == zone.id);
                if (index == -1) {
                    // Zone doesn't have an associated motion sensor, so add one
                    var tempService = HomeKitAccessory.addService(Service.MotionSensor, zone.name, zone.id);
                    this.__MotionServices.push({"service": tempService, "id": zone.id})
                } else {
                    // found an associated motion sensor for this zone, so update name
                    this.__MotionServices[index].service.getCharacteristic(Characteristic.Name).updateValue(zone.name);
                }
            }
        });

        this.__MotionServices.forEach((motionService, index) => {
            if (motionService.id != 0) {
                if (thisNestDevice.activity_zones.findIndex( ({ id }) => id == motionService.id) == -1) {
                    // Motion service we created doesn't appear in zone list anymore, so assume deleted
                    HomeKitAccessory.removeService(motionService.service);
                    this.__MotionServices.splice(index, 1);
                }
            }
        });

        // Process alerts after current activity zones are processed. 
        // Do reverse order so do most recent first??
        thisNestDevice.current_alert.reverse().forEach(event => {
            // Handle doorbell event
            if (event.types.includes("doorbell") == true) {
                if (this.__doorbellController != null && this.rangDoorbell == false) {
                    // Doorbell button pressed and we haven't trigger the doorbell button on the HomeKit service
                    this.rangDoorbell = true;
                    this.snapshotEvent = {type: "ring", time: event.playback_time, id : event.id, done: false};

                    this.__doorbellController.ringDoorbell();
      
                    if (this.historyService != null) this.historyService.addHistory(this.__doorbellController.doorbellService, {time: Math.floor(new Date() / 1000), status: 1});

                    setTimeout(function () {
                        this.rangDoorbell = false; // Cool down for doorbell button being pressed finished
                        if (this.historyService != null) this.historyService.addHistory(this.__doorbellController.doorbellService, {time: Math.floor(new Date() / 1000), status: 0});
                    }.bind(this), EVENTCOOLDOWN1);
                }
            }

            // Handle person event
            if (event.types.includes("person") == true) {
                if (this.rangDoorbell == false && this.personDetected == false) {
                    this.personDetected = true;
                    this.snapshotEvent = {type: "person", time: event.playback_time, id : event.id, done: false};

                    // Check which zone triggered the person alert and update associated motion sensor(s)
                    event.zone_ids.forEach(zoneID => {
                        var index = this.__MotionServices.findIndex( ({ id }) => id == zoneID);
                        if (index != -1) {
                            this.__MotionServices[index].service.getCharacteristic(Characteristic.MotionDetected).updateValue(true);    // Trigger motion for matching zone
                            if (this.historyService != null) this.historyService.addHistory(this.__MotionServices[index].service, {time: Math.floor(new Date() / 1000), status: 1});   // Motion started
                        }
                    });

                    setTimeout(function () {
                        this.__MotionServices.forEach((motionService, index) => { 
                            motionService.service.getCharacteristic(Characteristic.MotionDetected).updateValue(false);  // clear any motion
                            if (this.historyService != null) this.historyService.addHistory(motionService.service, {time: Math.floor(new Date() / 1000), status: 0});   // Motion finished
                        });
                        this.personDetected = false; // Cool down for person being detected finished
                    }.bind(this), EVENTCOOLDOWN2);
                }
            }

            if (event.types.includes("motion") == true) {
            }

            if (event.types.includes("sound") == true) {
            }

            if (event.types.includes("package") == true) {
            }

            if (event.types.includes("face") == true) {
            }
        });
    }
}

CameraClass.prototype.__buildVideoStream = function(request, sessionInfo, callback) {
    // Build our ffmpeg command string for the video stream
    var ffmpegCommand = "-f h264" 
        + " -use_wallclock_as_timestamps 1"
        + " -i pipe:"
        + " -c copy"    // Appears since we have a H264 stream, shouldn't need to transcode, so just copy the stream. Otherwise use h264_omx/libx264
        + " -map 0:0"
        + " -preset ultrafast"
        + " -tune zerolatency"
        + " -r " + request.fps
        + " -b:v " + request.max_bit_rate + "k"
        + " -bufsize " + (request.max_bit_rate * 2) + "k"
        + " -maxrate " + request.max_bit_rate + "k"
        //+ " -vf scale=" + request.width + ":" + request.height    // Do we need to scale??? If so, probably need to keep correct aspect ratio
        + " -payload_type " + request.pt
        + " -ssrc " + sessionInfo.videoSSRC
        + " -f rtp"
        + " -srtp_out_suite AES_CM_128_HMAC_SHA1_80 -srtp_out_params " + sessionInfo.videoSRTP.toString("base64")
        + " srtp://" + sessionInfo.address + ":" + sessionInfo.videoPort + "?rtcpport=" + sessionInfo.videoPort + "&localrtcpport=" + sessionInfo.localVideoPort + "&pkt_size=" + request.mtu;

    var ffmpegStarted = false;
    var ffmpegVideo = spawn("ffmpeg", ffmpegCommand.split(" "), { env: process.env });

    ffmpegVideo.stderr.on("data", function (data) {
        if (ffmpegStarted == false) {
            ffmpegStarted = true;
            callback(); // We've setup stream, so let HomeKit know. Only needed first time streaming started
        }
    });
    ffmpegVideo.on("error", function (error) {
        console.log("DEBUG: Failed to start video stream:", error.message);
        callback(new Error("ffmpeg process creation failed!"));
    });
    ffmpegVideo.on("exit", function (code, signal) {
        if (signal != "SIGKILL" || signal == null) {
            console.log("DEBUG: Video stream stopped", code, signal);
            if (ffmpegStarted == false) {
                callback(new Error("Streaming stopped"));
            }
            else {
                if (this.__doorbellController != null) this.__doorbellController.forceStopStreamingSession(sessionInfo);
                if (this.__cameraController != null) this.__cameraController.forceStopStreamingSession(sessionInfo);
            }
        }
    }.bind(this));
    return ffmpegVideo;
}

CameraClass.prototype.__buildAudioStream = function(request, sessionInfo, callback) {
    var ffmpegAudio = null;
    var ffmpegAudioReturn = null;

    var ffmpegCommand = "-hide_banner"
        + " -c:a " + AUDIOCODEC
        + " -i pipe:"
        + " -c:a " + AUDIOCODEC
        + " -profile:a aac_eld"
        + " -ac 1"
        + " -ar " + request.sample_rate + "k"
        + " -b:a " + request.max_bit_rate + "k"
        + " -flags +global_header"
        + " -payload_type " + request.pt
        + " -ssrc " + sessionInfo.audioSSRC
        + " -f rtp"
        + " -srtp_out_suite AES_CM_128_HMAC_SHA1_80 -srtp_out_params " + sessionInfo.audioSRTP.toString("base64")
        + " srtp://" + sessionInfo.address + ":" + sessionInfo.audioPort + "?rtcpport=" + sessionInfo.audioPort + "&localrtcpport=" + sessionInfo.localAudioPort + "&pkt_size=188";

    ffmpegAudio = spawn("ffmpeg", ffmpegCommand.split(" "), { env: process.env });
    ffmpegAudio.on("error", function (error) {
        console.log("DEBUG: Failed to start audio stream:", error.message);
        callback(new Error("ffmpeg process creation failed!"));
    });

    ffmpegAudio.on("exit", function (code, signal) {
    });

    ffmpegCommand = "-hide_banner"
        + " -protocol_whitelist pipe,udp,rtp,file,crypto"
        + " -f sdp"
        + " -c:a " + AUDIOCODEC
        + " -i pipe:0"
        + " -map 0:0"
        + " -c:a libspeex"
        + " -frames_per_packet 4"
        //+ " -af atempo=2.0,asetrate=16000/0.95"
        //+ " -frames_per_packet 2"
        //+ " -cbr_quality 10"
        + " -ac 1"
        + " -ar 16k"
        + " -f data pipe:1";
    
    ffmpegAudioReturn = spawn("ffmpeg", ffmpegCommand.split(" "), { env: process.env });
    ffmpegAudioReturn.on("error", function (error) {
        console.log("DEBUG: Failed to start audio stream:", error.message);
        callback(new Error("ffmpeg process creation failed!"));
    });

    ffmpegAudioReturn.on("exit", function (code, signal) {
    });

    // Write our SDP configuration out
    ffmpegAudioReturn.stdin.write("v=0\n"
        + "o=- 0 0 IN " + (sessionInfo.ipv6 ? "IP6" : "IP4") + " " + sessionInfo.address + "\n"
        + "s=Talk\n"
        + "c=IN " + (sessionInfo.ipv6 ? "IP6" : "IP4") + " " + sessionInfo.address + "\n"
        + "t=0 0\n"
        + "a=tool:libavformat 58.29.100\n"  // Match the version of libavformat that's compiled into ffmpeg we're using???
        + "m=audio " + sessionInfo.twoWayAudioPort + " RTP/AVP 110\n"
        + "b=AS:24\n"
        + "a=rtpmap:110 MPEG4-GENERIC/16000/1\n"
        + "a=rtcp-mux\n"
        + "a=fmtp:110 profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3; config=F8F0212C00BC00\n"
        + "a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:" + sessionInfo.audioSRTP.toString('base64'));
    ffmpegAudioReturn.stdin.end();
    return {ffmpegAudio, ffmpegAudioReturn}; // return object for both audio streaming handles
}


// Nest object
NestClass.prototype.doLogin = async function(tokenRefresh) {
    if ((tokenRefresh && tokenRefresh == true) || this.__nestToken != null || this.__nestURL == null || this.__nestID == null || this.__nestCookie == null) {
        await axios.get("https://home.nest.com/session", {headers: {"user-agent": USERAGENT, "Authorization": "Basic " + this.__nestToken} })
        .then(async (response) => {
            if (response.status == 200) {
                //this.__nestToken = response.data.access_token;    // Token from response SHOULD be the same as whats inour configuration, so no need to update internal token??
                this.__nestURL = response.data.urls.transport_url;
                this.__nestID = response.data.userid;
                this.__tokenExpire = Math.floor(new Date(response.data.expires_in) / 1000);

                // Set timer to refresh access token expiry time/date if we haven't started one yet
                if (this.__tokenTimer == null) {
                    this.__tokenTimer = setInterval(async function() {
                        this.doLogin(true);
                    }.bind(this), (3600 * 12 * 1000)); // Refresh every day
                }
            }
        })
        .catch(error => {
            if (error.status == 400) {
                // Invalid access token
                console.log("DEBUG: Invalid Nest Session Token")
            } else if (error.status == 401 && error.response && error.response.data && error.response.data.truncated_phone_number) {
                // 2FA required. prompt user to input PIN recieved to phone
                console.log("DEBUG: 2FA enabled");

                // TODO - code it up
            } else {
                console.log("DEBUG: " + arguments.callee.name, AccessoryName, "Nest login failed", error.message);
            }
        });

        // need the WEBSITE_2 cookie for camera API requests
        if (this.__nestToken != null) {
            await axios.post(CAMERAAPIHOST + "/api/v1/login.login_nest", Buffer.from("access_token=" + this.__nestToken, "utf8"), {withCredentials: true, headers: {"referer": "https://home.nest.com", "Content-Type": "application/x-www-form-urlencoded", "user-agent": USERAGENT} })
            .then(response => {
                if (response.status == 200 && response.data && response.data.status == 0) {
                    this.__nestCookie = response.data.items[0].session_token;    // WEBSITE_2 cookie
                }
            })
            .catch(error => {
                console.log("DEBUG: Failed to get WEBSITE_2 cookie", error);
            });
        }
    }
}

NestClass.prototype.getNestData = async function(process) {
    await this.doLogin(false);
    if (this.__nestToken != null && this.__nestURL != null && this.__nestID != null) {
        await axios.get(this.__nestURL + "/v3/mobile/user." + this.__nestID, {headers: {"content-type": "application/json", "user-agent": USERAGENT, "Authorization": "Basic " + this.__nestToken}, data: ""})
        .then(async (response)=> {
            if (response.status == 200) {
                // Fetch other details for any cameras we have, such as activity zones, alerts etc
                // we'll merge into the normal Nest structure for processing 
                response.data.quartz && await Promise.all(Object.entries(response.data.quartz).map(async ([deviceID, camera]) => {
                    var cameraDetails = await this.__getCameraDetails(camera.nexus_api_http_server_url, deviceID);
                    if (cameraDetails != null) {
                        response.data.quartz[deviceID].camera_get_details = cameraDetails.details;
                        response.data.quartz[deviceID].camera_get_zones = cameraDetails.activity_zones;
                        response.data.quartz[deviceID].camera_get_alerts = cameraDetails.alerts;
                    }
                }));

                this.__lastNestData = response.data;    // Used to generate subscribed versions/times

                if (process == true) {
                    await this.__processNestData(this.__lastNestData);
                }   
            }
        })
        .finally(() => {
        })
        .catch(error => {
        });
    }
}

NestClass.prototype.setNestValue = async function(nestStructure, key, value, targetChange) {
    await this.doLogin(false);
    if (this.__nestToken != null && this.__nestURL != null && this.__nestID != null) {
        await axios.post(this.__nestURL + PUTURL + "/" + nestStructure, JSON.stringify( { "target_change_pending": targetChange, [key]: value}), {headers: {"content-type": "application/json", "user-agent": USERAGENT, "Authorization": "Basic " + this.__nestToken} })
        .then(response => {
            if (response.status == 200) {
                return console.log("DEBUG: Set value of '%s' to '%s' on '%s", key, value, nestStructure);
            }
        })
        .catch(error => console.log("DEBUG: " + arguments.callee.name, AccessoryName, error.message));
    }
}

NestClass.prototype.addSubscription = function(deviceID, HomeKitAccessory, callback) {
    var subscribeIndex = this.__subscribed.findIndex( ({ device }) => device === deviceID);
    if (subscribeIndex == -1) {
        // No subscription for this device, so add to list
        this.__subscribed.push({"device": deviceID, "nestID": (deviceID == null ? null : this.__currentNestData.device[deviceID].orgNestStructure), "accessory": HomeKitAccessory, "callback": callback });
    } else {
        // We current have a subscription for this device, so update details
        this.__subscribed[subscribeIndex] = {"device": deviceID, "nestID": (deviceID == null ? null : this.__currentNestData.device[deviceID].orgNestStructure), "accessory": HomeKitAccessory, "callback": callback };
    }
    if (this.__subscribed.length == 1) {
        this.__interalTimer();
    } else {
        this.__cancel && this.__cancel("DEBUG: subscription update loop cancelled");
    }
}

NestClass.prototype.removeSubcription = function(deviceID) {
    var subscribeIndex = this.__subscribed.findIndex( ({ device }) => device === deviceID);
    if (subscribeIndex != -1) {
        // have an active subscription, so remove from the subscribed array
        this.__subscribed.splice(subscribeIndex, 1);
        this.__cancel && this.__cancel("DEBUG: subscription update loop cancelled");
    }
}

NestClass.prototype.getLocationWeather = async function(deviceID) {
    await this.doLogin(false);
    if (deviceID !=  "" && typeof this.__currentNestData == "object" && typeof this.__lastNestData == "object") {
        await axios.get("https://home.nest.com/api/0.1/weather/forecast/" + this.__lastNestData.structure[this.__currentNestData.device[deviceID].orgNestStructureID].postal_code + "," + this.__lastNestData.structure[this.__currentNestData.device[deviceID].orgNestStructureID].country_code)
        .then(response => {
            if (response.status == 200) {
                return response.data;
            }
        })
        .catch(error => console.log("DEBUG: " + arguments.callee.name, AccessoryName, error.message));
    }
}

NestClass.prototype.__makeValidHomeKitName = function(name) {
    // Strip invalid characters to conform to HomeKit requirements
    // Ensure only letters or numbers at beginning/end of string
    return name.replace(/[^A-Za-z0-9 ,.-]/g, "").replace(/^[^a-zA-Z0-9]*/g, "").replace(/[^a-zA-Z0-9]+$/g, "");
}

NestClass.prototype.__processNestData = async function(nestData, onlyID) {
    if (nestData && typeof nestData == "object") {
        this.__previousNestData = this.__currentNestData;
        if (typeof this.__previousNestData.device != "object") {
            this.__previousNestData.device = {};
        }
    
        // Process Nest structure and build our return structure for all devices we support (Thermostat, Temp Sensor, Protect, Cam(s))
        this.__currentNestData = {};
        this.__currentNestData.device = {};

        nestData.device && Object.entries(nestData.device).forEach(([deviceID, thermostat]) => {
            // process thermostats
            var tempMACAddress = thermostat.mac_address.toUpperCase();
            tempMACAddress = tempMACAddress.substr(0,2) + ":" + tempMACAddress.substr(2,2) + ":" + tempMACAddress.substr(4,2) + ":" + tempMACAddress.substr(6,2) + ":" + tempMACAddress.substr(8,2) + ":" + tempMACAddress.substr(10,2)
            if (this.__excludedDevices.includes(thermostat.serial_number.toUpperCase()) == false) {
                // Device is not in excluded list, so include
                this.__currentNestData.device[thermostat.serial_number] = {};
                this.__currentNestData.device[thermostat.serial_number].device_type = "thermostat";  // nest thermostat
                this.__currentNestData.device[thermostat.serial_number].orgNestStructure = "device." + deviceID;
                this.__currentNestData.device[thermostat.serial_number].software_version = thermostat.current_version.replace(/-/g, "."); // fix software version for HomeKit
                this.__currentNestData.device[thermostat.serial_number].mac_address = tempMACAddress;    // Our created MAC address
                this.__currentNestData.device[thermostat.serial_number].current_humidity = thermostat.current_humidity;
                this.__currentNestData.device[thermostat.serial_number].temperature_scale = thermostat.temperature_scale;
                this.__currentNestData.device[thermostat.serial_number].backplate_temperature = thermostat.backplate_temperature;
                this.__currentNestData.device[thermostat.serial_number].battery_level = thermostat.battery_level;
                this.__currentNestData.device[thermostat.serial_number].serial_number = thermostat.serial_number.toUpperCase();
                this.__currentNestData.device[thermostat.serial_number].removed_from_base = thermostat.nlclient_state.toUpperCase() == "BPD" ? false : true;
                this.__currentNestData.device[thermostat.serial_number].online = nestData.track[thermostat.serial_number].online;
                this.__currentNestData.device[thermostat.serial_number].has_fan = thermostat.has_fan;
                this.__currentNestData.device[thermostat.serial_number].can_cool = nestData.shared[thermostat.serial_number].can_cool;
                this.__currentNestData.device[thermostat.serial_number].can_heat = nestData.shared[thermostat.serial_number].can_heat;
                this.__currentNestData.device[thermostat.serial_number].description = nestData.shared[thermostat.serial_number].hasOwnProperty("name") ? this.__makeValidHomeKitName(nestData.shared[thermostat.serial_number].name) : "";
                this.__currentNestData.device[thermostat.serial_number].target_temperature_type = nestData.shared[thermostat.serial_number].target_temperature_type;
                this.__currentNestData.device[thermostat.serial_number].target_temperature = __adjustTemperature(nestData.shared[thermostat.serial_number].target_temperature, "C", "C");
                this.__currentNestData.device[thermostat.serial_number].target_temperature_high = __adjustTemperature(nestData.shared[thermostat.serial_number].target_temperature_high, "C", "C");
                this.__currentNestData.device[thermostat.serial_number].target_temperature_low = __adjustTemperature(nestData.shared[thermostat.serial_number].target_temperature_low, "C", "C");
                this.__currentNestData.device[thermostat.serial_number].backplate_temperature = __adjustTemperature(thermostat.backplate_temperature, "C", "C");
                this.__currentNestData.device[thermostat.serial_number].hvac_mode = nestData.shared[thermostat.serial_number].target_temperature_type;
                this.__currentNestData.device[thermostat.serial_number].temperature_lock = thermostat.temperature_lock;
                this.__currentNestData.device[thermostat.serial_number].temperature_lock_pin_hash = thermostat.temperature_lock_pin_hash;
                this.__currentNestData.device[thermostat.serial_number].temperature_lock_high_temp = thermostat.temperature_lock_high_temp;
                this.__currentNestData.device[thermostat.serial_number].temperature_lock_high_low = thermostat.temperature_lock_high_low;
            
                // Work out current state ie" heating, cooling etc
                if (nestData.shared[thermostat.serial_number].hvac_heater_state == true || nestData.shared[thermostat.serial_number].hvac_heat_x2_state == true || 
                    nestData.shared[thermostat.serial_number].hvac_heat_x3_state == true || nestData.shared[thermostat.serial_number].hvac_aux_heater_state == true || 
                    nestData.shared[thermostat.serial_number].hvac_alt_heat_x2_state == true || nestData.shared[thermostat.serial_number].hvac_emer_heat_state == true ||
                    nestData.shared[thermostat.serial_number].hvac_alt_heat_state == true) {
                    
                    // A heating source is on, so we're in heating mode
                    this.__currentNestData.device[thermostat.serial_number].hvac_state = "heating";
                }
                if (nestData.shared[thermostat.serial_number].hvac_ac_state == true || nestData.shared[thermostat.serial_number].hvac_cool_x2_state == true || nestData.shared[thermostat.serial_number].hvac_cool_x3_state == true) {
                    
                    // A cooling source is on, so we're in cooling mode
                    this.__currentNestData.device[thermostat.serial_number].hvac_state = "cooling";
                }
                if (nestData.shared[thermostat.serial_number].hvac_heater_state == false && nestData.shared[thermostat.serial_number].hvac_heat_x2_state == false && 
                    nestData.shared[thermostat.serial_number].hvac_heat_x3_state == false && nestData.shared[thermostat.serial_number].hvac_aux_heater_state == false && 
                    nestData.shared[thermostat.serial_number].hvac_alt_heat_x2_state == false && nestData.shared[thermostat.serial_number].hvac_emer_heat_state == false &&
                    nestData.shared[thermostat.serial_number].hvac_alt_heat_state == false && nestData.shared[thermostat.serial_number].hvac_ac_state == false &&
                    nestData.shared[thermostat.serial_number].hvac_cool_x2_state == false && nestData.shared[thermostat.serial_number].hvac_cool_x3_state == false) {
                    
                    // No heating or cooling sources are on, so we're in off mode
                    this.__currentNestData.device[thermostat.serial_number].hvac_state = "off";
                }

                // Update fan status, on or off
                this.__currentNestData.device[thermostat.serial_number].fan_duration = thermostat.fan_timer_duration;   // default runtime for fan
                this.__currentNestData.device[thermostat.serial_number].fan_state = false;
                if (thermostat.fan_timer_timeout > 0 || nestData.shared[thermostat.serial_number].hvac_fan_state == true) this.__currentNestData.device[thermostat.serial_number].fan_state = true;

                // Setup previous modes and states
                if (typeof this.__previousNestData.device[thermostat.serial_number] != "object") {
                    this.__previousNestData.device[thermostat.serial_number] = {};
                    this.__previousNestData.device[thermostat.serial_number].hvac_mode = this.__currentNestData.device[thermostat.serial_number].hvac_mode;
                    this.__previousNestData.device[thermostat.serial_number].hvac_state = this.__currentNestData.device[thermostat.serial_number].hvac_state;
                    this.__previousNestData.device[thermostat.serial_number].fan_state = this.__currentNestData.device[thermostat.serial_number].fan_state;
                    this.__previousNestData.device[thermostat.serial_number].previous_hvac_mode = this.__currentNestData.device[thermostat.serial_number].hvac_mode;
                    this.__previousNestData.device[thermostat.serial_number].previous_hvac_state = this.__currentNestData.device[thermostat.serial_number].hvac_state;
                    this.__previousNestData.device[thermostat.serial_number].previous_fan_state = this.__currentNestData.device[thermostat.serial_number].fan_state;
                    this.__previousNestData.device[thermostat.serial_number].battery_level = 0;
                    this.__currentNestData.device[thermostat.serial_number].previous_hvac_mode = this.__currentNestData.device[thermostat.serial_number].hvac_mode;
                    this.__currentNestData.device[thermostat.serial_number].previous_hvac_state = this.__currentNestData.device[thermostat.serial_number].hvac_state;
                    this.__currentNestData.device[thermostat.serial_number].previous_fan_state = this.__currentNestData.device[thermostat.serial_number].fan_state;    
                }

                if (this.__currentNestData.device[thermostat.serial_number].hvac_mode != this.__previousNestData.device[thermostat.serial_number].hvac_mode) {
                    this.__currentNestData.device[thermostat.serial_number].previous_hvac_mode = this.__previousNestData.device[thermostat.serial_number].hvac_mode;
                } else {
                    this.__currentNestData.device[thermostat.serial_number].previous_hvac_mode = this.__currentNestData.device[thermostat.serial_number].hvac_mode;
                }
                if (this.__currentNestData.device[thermostat.serial_number].hvac_state != this.__previousNestData.device[thermostat.serial_number].hvac_state) {
                    this.__currentNestData.device[thermostat.serial_number].previous_hvac_state = this.__previousNestData.device[thermostat.serial_number].hvac_state;
                } else {
                    this.__currentNestData.device[thermostat.serial_number].previous_hvac_state = this.__currentNestData.device[thermostat.serial_number].hvac_state;
                }
                if (this.__currentNestData.device[thermostat.serial_number].fan_state != this.__previousNestData.device[thermostat.serial_number].fan_state) {
                    this.__currentNestData.device[thermostat.serial_number].previous_fan_state = this.__previousNestData.device[thermostat.serial_number].fan_state;
                } else {
                    this.__currentNestData.device[thermostat.serial_number].previous_fan_state = this.__currentNestData.device[thermostat.serial_number].fan_state;
                }

                // Get device location name
                this.__currentNestData.device[thermostat.serial_number].location = "";
                nestData.where[nestData.link[thermostat.serial_number].structure.split('.')[1]].wheres.forEach(where => {
                    if (thermostat.where_id == where.where_id) {
                        this.__currentNestData.device[thermostat.serial_number].location = this.__makeValidHomeKitName(where.name);
                    }
                });
                
                this.__currentNestData.device[thermostat.serial_number].battery_charging_state = typeof this.__previousNestData.device == "object" && thermostat.battery_level > this.__previousNestData.device[thermostat.serial_number].battery_level && this.__previousNestData.device[thermostat.serial_number].battery_level != 0 ? true : false;
                this.__currentNestData.device[thermostat.serial_number].away = nestData.structure[nestData.link[thermostat.serial_number].structure.split('.')[1]].away;    // away status
                this.__currentNestData.device[thermostat.serial_number].vacation_mode = nestData.structure[nestData.link[thermostat.serial_number].structure.split('.')[1]].vacation_mode;  // vacation mode
                this.__currentNestData.device[thermostat.serial_number].home_name = this.__makeValidHomeKitName(nestData.structure[nestData.link[thermostat.serial_number].structure.split('.')[1]].name);  // Home name
                this.__currentNestData.device[thermostat.serial_number].orgNestStructureID = nestData.link[thermostat.serial_number].structure.split('.')[1]; // structure ID

                // Link in any temperature sensors, checking to ensure any aren't excluded
                this.__currentNestData.device[thermostat.serial_number].active_rcs_sensor = "";
                this.__currentNestData.device[thermostat.serial_number].active_temperature = __adjustTemperature(thermostat.backplate_temperature, "C", "C");
                this.__currentNestData.device[thermostat.serial_number].linked_rcs_sensors = [];
                nestData.rcs_settings[thermostat.serial_number].associated_rcs_sensors.forEach(sensor => {
                    var sensorInfo = nestData.kryptonite[sensor.split('.')[1]];
                    if (this.__excludedDevices.includes(sensorInfo.serial_number.toUpperCase()) == false) {
                        // Associated temperature sensor isn't excluded
                        this.__currentNestData.device[thermostat.serial_number].linked_rcs_sensors.push(sensorInfo.serial_number.toUpperCase());

                        // Is this sensor the active one? If so, get some details about it
                        if (nestData.rcs_settings[thermostat.serial_number].active_rcs_sensors.length > 0 && sensorInfo.serial_number.toUpperCase() == nestData.kryptonite[nestData.rcs_settings[thermostat.serial_number].active_rcs_sensors[0].split('.')[1]].serial_number.toUpperCase()) {
                            this.__currentNestData.device[thermostat.serial_number].active_rcs_sensor = nestData.kryptonite[nestData.rcs_settings[thermostat.serial_number].active_rcs_sensors[0].split('.')[1]].serial_number.toUpperCase();
                            this.__currentNestData.device[thermostat.serial_number].active_temperature =  __adjustTemperature(nestData.kryptonite[nestData.rcs_settings[thermostat.serial_number].active_rcs_sensors[0].split('.')[1]].current_temperature, "C", "C")
                        }
                    }
                });

                // Get associated schedules
                // TODO
                //nestData.schedule[thermostat.serial_number].

                // Insert any extra options we've read in from configuration file
                this.__extraOptions[thermostat.serial_number] && Object.entries(this.__extraOptions[thermostat.serial_number]).forEach(([key, value]) => {
                    this.__currentNestData.device[thermostat.serial_number][key] = value;
                });
             }
        });

        nestData.kryptonite && Object.entries(nestData.kryptonite).forEach(([deviceID, sensor]) => {
            // Process temperature sensors
            var tempMACAddress = "18B430" + __crc24(sensor.serial_number.toUpperCase()).toUpperCase(); // Use a Nest Labs prefix for first 6 digits, followed by a CRC24 based off serial number for last 6 digits.
            tempMACAddress = tempMACAddress.substr(0,2) + ":" + tempMACAddress.substr(2,2) + ":" + tempMACAddress.substr(4,2) + ":" + tempMACAddress.substr(6,2) + ":" + tempMACAddress.substr(8,2) + ":" + tempMACAddress.substr(10,2);

            if (this.__excludedDevices.includes(sensor.serial_number.toUpperCase()) == false) {
                // Device is not in excluded list, so include
                this.__currentNestData.device[sensor.serial_number] = {}
                this.__currentNestData.device[sensor.serial_number].device_type = "sensor";  // nest temperature sensor
                this.__currentNestData.device[sensor.serial_number].orgNestStructure = "kryptonite." + deviceID;
                this.__currentNestData.device[sensor.serial_number].serial_number = sensor.serial_number.toUpperCase();
                this.__currentNestData.device[sensor.serial_number].description = sensor.hasOwnProperty("description") ? this.__makeValidHomeKitName(sensor.description) : ""; 
                this.__currentNestData.device[sensor.serial_number].mac_address = tempMACAddress;   // Our created MAC address
                this.__currentNestData.device[sensor.serial_number].current_temperature = sensor.current_temperature;
                this.__currentNestData.device[sensor.serial_number].battery_level = sensor.battery_level;
                this.__currentNestData.device[sensor.serial_number].battery_charging_state = false; // on battery, so doesn't charge
                this.__currentNestData.device[sensor.serial_number].software_version = "1.0";
                this.__currentNestData.device[sensor.serial_number].current_temperature = __adjustTemperature(sensor.current_temperature, "C", "C");

                // Get device location name
                this.__currentNestData.device[sensor.serial_number].location = "";
                nestData.where[sensor.structure_id].wheres.forEach(where => {
                    if (sensor.where_id == where.where_id) {
                        this.__currentNestData.device[sensor.serial_number].location = this.__makeValidHomeKitName(where.name);
                    }
                });

                this.__currentNestData.device[sensor.serial_number].online = (Math.floor(new Date() / 1000) - sensor.last_updated_at) < (3600 * 3) ? true : false;    // online status. allow upto 3hrs for reporting before report sensor offline
                this.__currentNestData.device[sensor.serial_number].home_name = this.__makeValidHomeKitName(nestData.structure[sensor.structure_id].name);    // Home name
                this.__currentNestData.device[sensor.serial_number].orgNestStructureID = sensor.structure_id; // structure ID

                // Insert any extra options we've read in from configuration file for this device
                this.__extraOptions[sensor.serial_number] && Object.entries(this.__extraOptions[sensor.serial_number]).forEach(([key, value]) => {
                    this.__currentNestData.device[sensor.serial_number][key] = value;
                });
            }
        });

        nestData.topaz && Object.entries(nestData.topaz).forEach(([deviceID, protect]) => {            
            // Process smoke detectors
            var tempMACAddress = protect.wifi_mac_address.toUpperCase();
            tempMACAddress = tempMACAddress.substr(0,2) + ":" + tempMACAddress.substr(2,2) + ":" + tempMACAddress.substr(4,2) + ":" + tempMACAddress.substr(6,2) + ":" + tempMACAddress.substr(8,2) + ":" + tempMACAddress.substr(10,2)
            if (this.__excludedDevices.includes(protect.serial_number.toUpperCase()) == false) {
                // Device is not in excluded list, so include
                if (typeof this.__previousNestData.device[protect.serial_number] != "object") {
                    this.__previousNestData.device[protect.serial_number] = {};
                    this.__previousNestData.device[protect.serial_number].battery_level = 0;
                }

                this.__currentNestData.device[protect.serial_number] = {};
                this.__currentNestData.device[protect.serial_number].device_type = "protect";  // nest protect
                this.__currentNestData.device[protect.serial_number].orgNestStructure = "topaz." + deviceID;
                this.__currentNestData.device[protect.serial_number].serial_number = protect.serial_number.toUpperCase();
                this.__currentNestData.device[protect.serial_number].line_power_present = protect.line_power_present;
                this.__currentNestData.device[protect.serial_number].wired_or_battery = protect.wired_or_battery;
                this.__currentNestData.device[protect.serial_number].battery_level = protect.battery_level;
                this.__currentNestData.device[protect.serial_number].battery_health_state = protect.battery_health_state;
                this.__currentNestData.device[protect.serial_number].smoke_status = protect.smoke_status;
                this.__currentNestData.device[protect.serial_number].co_status = protect.co_status;
                this.__currentNestData.device[protect.serial_number].heat_status = protect.heat_status;
                this.__currentNestData.device[protect.serial_number].hushed_state = protect.hushed_state;
                this.__currentNestData.device[protect.serial_number].ntp_green_led = protect.ntp_green_led_enable;
                this.__currentNestData.device[protect.serial_number].smoke_test_passed = protect.component_smoke_test_passed;
                this.__currentNestData.device[protect.serial_number].heat_test_passed = protect.component_temp_test_passed; // Seems heat test component test is always false, so use temp test??
                this.__currentNestData.device[protect.serial_number].replacement_date = protect.replace_by_date_utc_secs;
                this.__currentNestData.device[protect.serial_number].co_previous_peak = protect.co_previous_peak;
                this.__currentNestData.device[protect.serial_number].mac_address = tempMACAddress;  // Our created MAC address
                this.__currentNestData.device[protect.serial_number].online = nestData.widget_track[protect.thread_mac_address.toUpperCase()].online;
                this.__currentNestData.device[protect.serial_number].removed_from_base = protect.removed_from_base;
                this.__currentNestData.device[protect.serial_number].latest_alarm_test = protect.latest_manual_test_end_utc_secs;
                this.__currentNestData.device[protect.serial_number].self_test_in_progress = nestData.safety[protect.structure_id].manual_self_test_in_progress;
                this.__currentNestData.device[protect.serial_number].description = protect.hasOwnProperty("description") ? this.__makeValidHomeKitName(protect.description) : "";
                this.__currentNestData.device[protect.serial_number].software_version = protect.software_version.replace(/-/g, ".");    // fix software version for HomeKit
                this.__currentNestData.device[protect.serial_number].ui_color_state = "grey";
                if (protect.battery_health_state == 0 && protect.co_status == 0 && protect.smoke_status == 0) this.__currentNestData.device[protect.serial_number].ui_color_state = "green";
                if (protect.battery_health_state != 0 || protect.co_status == 1 || protect.smoke_status == 1) this.__currentNestData.device[protect.serial_number].ui_color_state = "yellow";
                if (protect.co_status == 2 || protect.smoke_status == 2) this.__currentNestData.device[protect.serial_number].ui_color_state = "red";
            
                // Get device location name
                this.__currentNestData.device[protect.serial_number].location = "";
                nestData.where[protect.structure_id].wheres.forEach(where => {
                    if (protect.where_id == where.where_id) {
                        this.__currentNestData.device[protect.serial_number].location = this.__makeValidHomeKitName(where.name);
                    }
                });
                this.__currentNestData.device[protect.serial_number].battery_charging_state = typeof this.__previousNestData.device == "object" && protect.battery_level > this.__previousNestData.device[protect.serial_number].battery_level && this.__previousNestData.device[protect.serial_number].battery_level != 0 ? true : false;
                this.__currentNestData.device[protect.serial_number].away = protect.auto_away;   // away status
                this.__currentNestData.device[protect.serial_number].vacation_mode = nestData.structure[protect.structure_id].vacation_mode;  // vacation mode
                this.__currentNestData.device[protect.serial_number].home_name = this.__makeValidHomeKitName(nestData.structure[protect.structure_id].name);  // Home name
                this.__currentNestData.device[protect.serial_number].orgNestStructureID = protect.structure_id; // structure ID

                // Insert any extra options we've read in from configuration file for this device
                this.__extraOptions[protect.serial_number] && Object.entries(this.__extraOptions[protect.serial_number]).forEach(([key, value]) => {
                    this.__currentNestData.device[protect.serial_number][key] = value;
                });
            }
        });

        // get full camera details from the nest structure and seperate API
        nestData.quartz && Object.entries(nestData.quartz).forEach(([deviceID, camera]) => {
            // Process cameras
            var tempMACAddress = camera.mac_address.toUpperCase();
            tempMACAddress = tempMACAddress.substr(0,2) + ":" + tempMACAddress.substr(2,2) + ":" + tempMACAddress.substr(4,2) + ":" + tempMACAddress.substr(6,2) + ":" + tempMACAddress.substr(8,2) + ":" + tempMACAddress.substr(10,2)
            if (this.__excludedDevices.includes(camera.serial_number.toUpperCase()) == false) {
                // Device is not in excluded list, so include
                if (typeof this.__previousNestData.device[camera.serial_number] != "object") {
                    this.__previousNestData.device[camera.serial_number] = {};
                    this.__previousNestData.device[camera.serial_number].battery_level = 0;
                    this.__previousNestData.device[camera.serial_number].current_alert = [];
                    this.__previousNestData.device[camera.serial_number].activity_zones = [];
                }
                
                this.__currentNestData.device[camera.serial_number] = {};
                this.__currentNestData.device[camera.serial_number].device_type = camera.camera_type == 12 ? "doorbell" : "camera";  // nest doorbell or camera
                this.__currentNestData.device[camera.serial_number].orgNestStructure = "quartz." + deviceID;
                this.__currentNestData.device[camera.serial_number].serial_number = camera.serial_number.toUpperCase();
                this.__currentNestData.device[camera.serial_number].software_version = camera.software_version.replace(/-/g, "."); // fix software version for HomeKit
                this.__currentNestData.device[camera.serial_number].mac_address = tempMACAddress;  // Our created MAC address;
                this.__currentNestData.device[camera.serial_number].description = camera.hasOwnProperty("description") ? this.__makeValidHomeKitName(camera.description) : "";
                this.__currentNestData.device[camera.serial_number].camera_uuid = deviceID;  // Can generate from .orgNestStructure anyway
                this.__currentNestData.device[camera.serial_number].direct_nexustalk_host = camera.direct_nexustalk_host;
                this.__currentNestData.device[camera.serial_number].streaming_enabled = (camera.streaming_state.includes("enabled") ? true : false);
    
                // process other details we added to the "quartz" camera structure 
                //this.__currentNestData.device[camera.serial_number].streaming_enabled = camera.camera_get_details.is_streaming_enabled;
                //this.__currentNestData.device[camera.serial_number].direct_nexustalk_host = camera.camera_get_details.direct_nexustalk_host;
                this.__currentNestData.device[camera.serial_number].nexus_api_http_server_url = camera.camera_get_details.hasOwnProperty("nexus_api_http_server") ? camera.camera_get_details.nexus_api_http_server : camera.nexus_api_http_server_url;
                this.__currentNestData.device[camera.serial_number].nexus_api_nest_domain_host = camera.camera_get_details.nexus_api_nest_domain_host;
                this.__currentNestData.device[camera.serial_number].battery_level = camera.camera_get_details.rq_battery_battery_volt;
                this.__currentNestData.device[camera.serial_number].battery_charging_state = typeof this.__previousNestData.device == "object" && camera.camera_get_details.rq_battery_battery_volt > this.__previousNestData.device[camera.serial_number].battery_level && this.__previousNestData.device[camera.serial_number].battery_level != 0 ? true : false;
                this.__currentNestData.device[camera.serial_number].online = camera.camera_get_details.hasOwnProperty("is_online") ? camera.camera_get_details.is_online : true;
                this.__currentNestData.device[camera.serial_number].capabilities = camera.camera_get_details.capabilities;
                this.__currentNestData.device[camera.serial_number].properties = camera.camera_get_details.properties;

                // process activity zones for camera
                this.__currentNestData.device[camera.serial_number].activity_zones = [];
                camera.camera_get_zones.forEach(zone => {
                    if (zone.type.toUpperCase() == "ACTIVITY" || zone.type.toUpperCase() == "REGION") this.__currentNestData.device[camera.serial_number].activity_zones.push({"id": zone.id, "name": this.__makeValidHomeKitName(zone.label)})
                });

                // process alerts
                this.__currentNestData.device[camera.serial_number].current_alert = [];
                if (camera.camera_get_alerts.length >= 1) {
                    this.__currentNestData.device[camera.serial_number].current_alert.push(camera.camera_get_alerts[camera.camera_get_alerts.length - 1]); // Last event
                }
        
                // Get device location name
                this.__currentNestData.device[camera.serial_number].location = "";
                nestData.where[camera.structure_id].wheres.forEach(where => {
                    if (camera.where_id == where.where_id) {
                        this.__currentNestData.device[camera.serial_number].location = this.__makeValidHomeKitName(where.name);
                    }
                });
                this.__currentNestData.device[camera.serial_number].away = nestData.structure[camera.structure_id].away;    // away status
                this.__currentNestData.device[camera.serial_number].vacation_mode = nestData.structure[camera.structure_id].vacation_mode;  // vacation mode
                this.__currentNestData.device[camera.serial_number].home_name = this.__makeValidHomeKitName(nestData.structure[camera.structure_id].name);  // Home name
                this.__currentNestData.device[camera.serial_number].orgNestStructureID = camera.structure_id; // structure ID

                // Insert any extra options we've read in from configuration file for this device
                this.__extraOptions[camera.serial_number] && Object.entries(this.__extraOptions[camera.serial_number]).forEach(([key, value]) => {
                    this.__currentNestData.device[camera.serial_number][key] = value;
                });
            }
        });
    }
}

NestClass.prototype.__getCameraDetails = async function(cameraURL, cameraUUID) {
    var cameraDetails = null;
    await axios.all([
        axios.get(CAMERAAPIHOST + "/api/cameras.get_with_properties?uuid=" + cameraUUID, {headers: {"user-agent": USERAGENT, "cookie": "website_2=" + this.__nestCookie} }),
        axios.get(cameraURL + "/cuepoint_category/" + cameraUUID, {headers: {"user-agent": USERAGENT, "cookie": "website_2=" + this.__nestCookie} }),
        axios.get(cameraURL + "/cuepoint/" + cameraUUID + "/2?start_time=" + Math.floor((Date.now() / 1000) - 29), {headers: {"user-agent": USERAGENT, "cookie": "website_2=" + this.__nestCookie} })
    ])
    .then(axios.spread(function (details, zones, alerts) {
        if (details.status == 200 && details.data.status == 0 && zones.status == 200 && alerts.status == 200) {
            cameraDetails = {};
            cameraDetails.details = details.data.items[0];
            cameraDetails.activity_zones = zones.data;
            cameraDetails.alerts = alerts.data;

            // Fix up alert zone id's. Appears if no Nest Aware subscription, the zone_id in the associated alert is left blank. We'll assign the alert zone to '0' in this case
            cameraDetails.alerts.forEach(alert => {
                if (alert.zone_ids.length == 0) {
                    alert.zone_ids = [0];   // Default zone ID ie: main zone
                }
            });
        }
    }.bind(this)))
    .catch(error => {
    });
    return cameraDetails;
}

NestClass.prototype.__deviceChanged = function(deviceID) {
    var compare = false;
    if (deviceID != "" && typeof this.__currentNestData.device[deviceID] == "object" && typeof this.__previousNestData.device[deviceID] == "object") {
        compare = JSON.stringify(this.__currentNestData.device[deviceID]) == JSON.stringify(this.__previousNestData.device[deviceID]) ? false : true;
    }
    return compare;
}

NestClass.prototype.__deviceKeysChanged = function(deviceID) {
    var changed = {};
    this.__currentNestData.device[deviceID] && Object.entries(this.__currentNestData.device[deviceID]).forEach(([subKey]) => {
        if (this.__currentNestData.device[deviceID][subKey].toString() !== this.__previousNestData.device[deviceID][subKey].toString()) {
            if (typeof changed.device !== "object") changed.device = {};
            if (typeof changed.device[deviceID] !== "object") changed.device[deviceID] = {}
            changed.device[deviceID][subKey] = this.__currentNestData.device[deviceID][subKey];
        }
    });
    return changed;
}

NestClass.prototype.__interalTimer = async function() {
    // Build object for subscription, based upon subscribed device types
    var subscribeData = {objects: []};
    var cameraPolling = [];

    this.__currentNestData.device && Object.entries(this.__currentNestData.device).forEach(([deviceID]) => {
        var mainKey = this.__currentNestData.device[deviceID].orgNestStructure.split('.')[0];
        var subKey = this.__currentNestData.device[deviceID].orgNestStructure.split('.')[1];
        var structure = this.__currentNestData.device[deviceID].orgNestStructureID;
        if (this.__currentNestData.device[deviceID].device_type == "thermostat") {
            // for thermostats, we need to subscribe to device, shared, track, link, rcs_settings, schedule
            subscribeData.objects.push({"object_key" :  "device." + subKey, "object_revision" : this.__lastNestData["device"][subKey]["$version"], "object_timestamp": this.__lastNestData["device"][subKey]["$timestamp"]});
            subscribeData.objects.push({"object_key" :  "shared." + subKey, "object_revision" : this.__lastNestData["shared"][subKey]["$version"], "object_timestamp": this.__lastNestData["shared"][subKey]["$timestamp"]});
            subscribeData.objects.push({"object_key" :  "track." + subKey, "object_revision" : this.__lastNestData["track"][subKey]["$version"], "object_timestamp": this.__lastNestData["track"][subKey]["$timestamp"]});
            subscribeData.objects.push({"object_key" :  "link." + subKey, "object_revision" : this.__lastNestData["link"][subKey]["$version"], "object_timestamp": this.__lastNestData["link"][subKey]["$timestamp"]});
            subscribeData.objects.push({"object_key" :  "rcs_settings." + subKey, "object_revision" : this.__lastNestData["rcs_settings"][subKey]["$version"], "object_timestamp": this.__lastNestData["rcs_settings"][subKey]["$timestamp"]});
            subscribeData.objects.push({"object_key" :  "schedule." + subKey, "object_revision" : this.__lastNestData["schedule"][subKey]["$version"], "object_timestamp": this.__lastNestData["schedule"][subKey]["$timestamp"]});
        }
        if (this.__currentNestData.device[deviceID].device_type == "sensor") {
            // for temperature sensors, we need to subscribe to kryptonite
            subscribeData.objects.push({"object_key" :  "kryptonite." + subKey, "object_revision" : this.__lastNestData["kryptonite"][subKey]["$version"], "object_timestamp": this.__lastNestData["kryptonite"][subKey]["$timestamp"]});
        }
        if (this.__currentNestData.device[deviceID].device_type == "protect") {
            // for protects, we need to subscribe to topaz, widget_track
            subscribeData.objects.push({"object_key" :  "topaz." + subKey, "object_revision" : this.__lastNestData["topaz"][subKey]["$version"], "object_timestamp": this.__lastNestData["topaz"][subKey]["$timestamp"]});
            subscribeData.objects.push({"object_key" :  "widget_track." + subKey, "object_revision" : this.__lastNestData["widget_track"][subKey]["$version"], "object_timestamp": this.__lastNestData["widget_track"][subKey]["$timestamp"]});
        }
        if (this.__currentNestData.device[deviceID].device_type == "doorbell" || this.__currentNestData.device[deviceID].device_type == "camera") {
            // for doorbells/cameras, we need to subscribe to quartz
            subscribeData.objects.push({"object_key" :  "quartz." + subKey, "object_revision" : this.__lastNestData["quartz"][subKey]["$version"], "object_timestamp": this.__lastNestData["quartz"][subKey]["$timestamp"]});

            // Additionally, run a seperate process for camera(s) to get changes to alerts etc as these don't appear in the normal Nest structure
            // TODO - find a subscribe endpoint???? protentially firebase cloud messaging is used??
            // Maybe a way to get ALL details for all cameras in one hit, rather than polling for each??
            var tempTimer = setInterval(async function() {
                var cameraDetails = await this.__getCameraDetails(this.__currentNestData.device[deviceID].nexus_api_http_server_url, this.__currentNestData.device[deviceID].camera_uuid);
                if (cameraDetails != null) {
                    this.__lastNestData[mainKey][subKey].camera_get_details = cameraDetails.details;
                    this.__lastNestData[mainKey][subKey].camera_get_zones = cameraDetails.activity_zones
                    this.__lastNestData[mainKey][subKey].camera_get_alerts = cameraDetails.alerts;
                }
    
                // Process updated device data for this doorbell/camera
                await this.__processNestData(this.__lastNestData);
                
                // Process subscribed callbacks
                if (this.__deviceChanged(this.__currentNestData.device[deviceID].serial_number)) {
                    var subscribeIndex = this.__subscribed.findIndex( ({ device }) => device === this.__currentNestData.device[deviceID].serial_number);
                    if (subscribeIndex != -1) {       
                        this.__subscribed[subscribeIndex].callback(this.__subscribed[subscribeIndex].accessory, this.__currentNestData.device[this.__subscribed[subscribeIndex].device]);
                    }
                }
            }.bind(this), CAMERAPOLLING);   // Every 2 seconds
            cameraPolling.push(tempTimer);  // push onto camera polling timer list
        }

        // Always subscribe to structure and where if we havent already included
        if (subscribeData.objects.findIndex( ({ object_key }) => object_key === "structure." + structure) == -1 ) subscribeData.objects.push({"object_key" :  "structure." + structure, "object_revision" : this.__lastNestData["structure"][structure]["$version"], "object_timestamp": this.__lastNestData["structure"][structure]["$timestamp"]});
        if (subscribeData.objects.findIndex( ({ object_key }) => object_key === "where." + structure) == -1 ) subscribeData.objects.push({"object_key" :  "where." + structure, "object_revision" : this.__lastNestData["where"][structure]["$version"], "object_timestamp": this.__lastNestData["where"][structure]["$timestamp"]});
    });

    // Do subscription for the data we need from the Nest structure.. Timeout after 2mins if no data received, and if timed-out, rinse and repeat :-) 
    var tempDeviceList = [];
    axios({
        method: "post",
        url: this.__nestURL + SUBSCRIBEURL,
        data: JSON.stringify(subscribeData), 
        headers: {"user-agent": USERAGENT, "Authorization": "Basic " + this.__nestToken}, 
        responseType: "json", 
        timeout: 120000, // 2 minutes
        cancelToken: new axios.CancelToken(c => { this.__cancel = c; })
    })
    .then(async (response) => {
        if (response.status && response.status == 200) {
            // Got subscribed update, so merge and process them
            response.data.objects && await Promise.all(response.data.objects.map(async (updatedData) => {
                var mainKey = updatedData.object_key.split('.')[0];
                var subKey = updatedData.object_key.split('.')[1];
        
                // See if we have a structure change and the "swarm" property list has changed, seems to indicated a new or removed device(s)
                if (mainKey == "structure" && updatedData.value.swarm && this.__lastNestData[mainKey][subKey].swarm.toString() !== updatedData.value.swarm.toString()) {
                    var oldDeviceList = this.__lastNestData[mainKey][subKey].swarm.toString().split(',').map(String);
                    var newDeviceList = updatedData.value.swarm.toString().split(',').map(String);
                    for (var index in oldDeviceList) {
                        if (!newDeviceList.includes(oldDeviceList[index])) {
                            tempDeviceList.push({"nestID": oldDeviceList[index], "action" : "remove"});    // Removed device
                        }
                    }
                    for (index in newDeviceList) {
                        if (!oldDeviceList.includes(newDeviceList[index])) {
                            tempDeviceList.push({"nestID": newDeviceList[index], "action" : "add"}); // Added device
                        }
                    }
                    tempDeviceList = tempDeviceList.sort((a, b) => a - b);  // filter out duplicates
                } else {                  
                    // Update internal saved Nest structure for the changed key/value pairs
                    for (const [fieldKey, fieldValue] of Object.entries(updatedData.value)) {
                        this.__lastNestData[mainKey][subKey][fieldKey] = fieldValue;
                    }
                    this.__lastNestData[mainKey][subKey]["$version"] = updatedData.object_revision; // Updated version of object. needed for future subscription calls
                    this.__lastNestData[mainKey][subKey]["$timestamp"] = updatedData.object_timestamp;  // Updated timestam of object. needed for future subscription calls
                }
            }));
            
            if (tempDeviceList.length > 0) {
                // Change in devices, so get current data before we process
                await this.getNestData(false);
            }
            await this.__processNestData(this.__lastNestData);

            // Process subscribed callbacks
            this.__subscribed.forEach(subscribedDevice => {
                if (subscribedDevice.device != null) {
                    if (this.__deviceChanged(subscribedDevice.device)) {
                        subscribedDevice.callback(subscribedDevice.accessory, this.__currentNestData.device[subscribedDevice.device]);
                    }
                }
                if (subscribedDevice.device == null && tempDeviceList.length > 0) {
                    // have a device addition or removal to process
                    tempDeviceList.forEach(nestDevice => {
                        if (nestDevice.action == "add") {
                            this.__currentNestData.device && Object.entries(this.__currentNestData.device).forEach(([deviceID, device]) => {
                                if (device.orgNestStructure == nestDevice.nestID) {
                                    // Process new device into HomeKit
                                    subscribedDevice.callback(this, device, "add");
                                }
                            });
                        }
                        if (nestDevice.action == "remove") {
                            this.__previousNestData.device && Object.entries(this.__previousNestData.device).forEach(([deviceID, device]) => {
                                if (device.orgNestStructure == nestDevice.nestID) {
                                    subscribedDevice.callback(this, device, "remove");
                                }
                            });
                        }
                    });
                }
            });
        }
        else {
            console.log("DEBUG response", response)
        }
    })
    .catch(async (error) => {
        if (axios.isCancel(error) == false && error.code !== 'ECONNABORTED') {
            if (error.response && error.response.status == 404) {
                // Subscription failed with a 404 error "not found", so this could indicate idevice(s)have change. we'll check here also
                await this.getNestData(true);  // get current data and process

                // compare current vs previous devices to see if things have been added and/or removed
                var oldDeviceList = Object.entries(this.__previousNestData.device).toString().split(',').map(String);
                var newDeviceList = Object.entries(this.__currentNestData.device).toString().split(',').map(String);
                for (var index in oldDeviceList) {
                    if (!newDeviceList.includes(oldDeviceList[index])) {
                        tempDeviceList.push({"nestID": oldDeviceList[index], "action" : "remove"});    // Removed device
                    }
                }
                for (index in newDeviceList) {
                    if (!oldDeviceList.includes(newDeviceList[index])) {
                        tempDeviceList.push({"nestID": newDeviceList[index], "action" : "add"}); // Added device
                    }
                }
                tempDeviceList = tempDeviceList.sort((a, b) => a - b);  // filter out duplicates
                if (tempDeviceList.length > 0) {
                    // Process subscribed callbacks
                    this.__subscribed.forEach(subscribedDevice => {
                        if (subscribedDevice.device == null) {
                            // have a device addition or removal to process
                            tempDeviceList.forEach(nestDevice => {
                                if (nestDevice.action == "add") {
                                    this.__currentNestData.device && Object.entries(this.__currentNestData.device).forEach(([deviceID, device]) => {
                                        if (device.serial_number == nestDevice.nestID) {
                                            // Process new device into HomeKit
                                            subscribedDevice.callback(this, device, "add");
                                        }
                                    });
                                }
                                if (nestDevice.action == "remove") {
                                    this.__previousNestData.device && Object.entries(this.__previousNestData.device).forEach(([deviceID, device]) => {
                                        if (device.serial_number == nestDevice.nestID) {
                                            subscribedDevice.callback(this, device, "remove");
                                        }
                                    });
                                }
                            });
                        }
                    });
                }
            } else {
                // Log error if request not cancelled or item not found
                if (error.response && error.response.status == 400) {
                    //console.log("DEBUG: Bad subscribe", subscribeData);
                }
                console.log("DEBUG: " + arguments.callee.name, AccessoryName, error.message);
            }
        }
    })
    .finally(() => {
        // Clear any camera polling timers
        cameraPolling.forEach(timer => {
            clearInterval(timer); // clear the timer to stop polling 
        });
        // subscribe again after small delay :-)
        setTimeout(this.__interalTimer.bind(this), 500);
    });
}


// General functions
function __crc24(value) {
    var hashTable = [
        0x000000, 0x864cfb, 0x8ad50d, 0x0c99f6, 0x93e6e1, 0x15aa1a, 0x1933ec, 0x9f7f17, 
        0xa18139, 0x27cdc2, 0x2b5434, 0xad18cf, 0x3267d8, 0xb42b23, 0xb8b2d5, 0x3efe2e, 
        0xc54e89, 0x430272, 0x4f9b84, 0xc9d77f, 0x56a868, 0xd0e493, 0xdc7d65, 0x5a319e, 
        0x64cfb0, 0xe2834b, 0xee1abd, 0x685646, 0xf72951, 0x7165aa, 0x7dfc5c, 0xfbb0a7, 
        0x0cd1e9, 0x8a9d12, 0x8604e4, 0x00481f, 0x9f3708, 0x197bf3, 0x15e205, 0x93aefe, 
        0xad50d0, 0x2b1c2b, 0x2785dd, 0xa1c926, 0x3eb631, 0xb8faca, 0xb4633c, 0x322fc7, 
        0xc99f60, 0x4fd39b, 0x434a6d, 0xc50696, 0x5a7981, 0xdc357a, 0xd0ac8c, 0x56e077, 
        0x681e59, 0xee52a2, 0xe2cb54, 0x6487af, 0xfbf8b8, 0x7db443, 0x712db5, 0xf7614e, 
        0x19a3d2, 0x9fef29, 0x9376df, 0x153a24, 0x8a4533, 0x0c09c8, 0x00903e, 0x86dcc5, 
        0xb822eb, 0x3e6e10, 0x32f7e6, 0xb4bb1d, 0x2bc40a, 0xad88f1, 0xa11107, 0x275dfc, 
        0xdced5b, 0x5aa1a0, 0x563856, 0xd074ad, 0x4f0bba, 0xc94741, 0xc5deb7, 0x43924c, 
        0x7d6c62, 0xfb2099, 0xf7b96f, 0x71f594, 0xee8a83, 0x68c678, 0x645f8e, 0xe21375, 
        0x15723b, 0x933ec0, 0x9fa736, 0x19ebcd, 0x8694da, 0x00d821, 0x0c41d7, 0x8a0d2c, 
        0xb4f302, 0x32bff9, 0x3e260f, 0xb86af4, 0x2715e3, 0xa15918, 0xadc0ee, 0x2b8c15, 
        0xd03cb2, 0x567049, 0x5ae9bf, 0xdca544, 0x43da53, 0xc596a8, 0xc90f5e, 0x4f43a5, 
        0x71bd8b, 0xf7f170, 0xfb6886, 0x7d247d, 0xe25b6a, 0x641791, 0x688e67, 0xeec29c, 
        0x3347a4, 0xb50b5f, 0xb992a9, 0x3fde52, 0xa0a145, 0x26edbe, 0x2a7448, 0xac38b3, 
        0x92c69d, 0x148a66, 0x181390, 0x9e5f6b, 0x01207c, 0x876c87, 0x8bf571, 0x0db98a, 
        0xf6092d, 0x7045d6, 0x7cdc20, 0xfa90db, 0x65efcc, 0xe3a337, 0xef3ac1, 0x69763a, 
        0x578814, 0xd1c4ef, 0xdd5d19, 0x5b11e2, 0xc46ef5, 0x42220e, 0x4ebbf8, 0xc8f703, 
        0x3f964d, 0xb9dab6, 0xb54340, 0x330fbb, 0xac70ac, 0x2a3c57, 0x26a5a1, 0xa0e95a, 
        0x9e1774, 0x185b8f, 0x14c279, 0x928e82, 0x0df195, 0x8bbd6e, 0x872498, 0x016863, 
        0xfad8c4, 0x7c943f, 0x700dc9, 0xf64132, 0x693e25, 0xef72de, 0xe3eb28, 0x65a7d3, 
        0x5b59fd, 0xdd1506, 0xd18cf0, 0x57c00b, 0xc8bf1c, 0x4ef3e7, 0x426a11, 0xc426ea, 
        0x2ae476, 0xaca88d, 0xa0317b, 0x267d80, 0xb90297, 0x3f4e6c, 0x33d79a, 0xb59b61, 
        0x8b654f, 0x0d29b4, 0x01b042, 0x87fcb9, 0x1883ae, 0x9ecf55, 0x9256a3, 0x141a58, 
        0xefaaff, 0x69e604, 0x657ff2, 0xe33309, 0x7c4c1e, 0xfa00e5, 0xf69913, 0x70d5e8, 
        0x4e2bc6, 0xc8673d, 0xc4fecb, 0x42b230, 0xddcd27, 0x5b81dc, 0x57182a, 0xd154d1, 
        0x26359f, 0xa07964, 0xace092, 0x2aac69, 0xb5d37e, 0x339f85, 0x3f0673, 0xb94a88, 
        0x87b4a6, 0x01f85d, 0x0d61ab, 0x8b2d50, 0x145247, 0x921ebc, 0x9e874a, 0x18cbb1, 
        0xe37b16, 0x6537ed, 0x69ae1b, 0xefe2e0, 0x709df7, 0xf6d10c, 0xfa48fa, 0x7c0401, 
        0x42fa2f, 0xc4b6d4, 0xc82f22, 0x4e63d9, 0xd11cce, 0x575035, 0x5bc9c3, 0xdd8538
    ]
    var crc = 0xb704ce; // init crc24 hash;
    var buffer = Buffer.from(value);    // convert value into buffer for processing
    for (var index = 0; index < value.length; index++) {
        crc = (hashTable[((crc >> 16) ^ buffer[index]) & 0xff] ^ (crc << 8)) & 0xffffff;
    }
    return crc.toString(16);    // return crc24 as hex string
}
  
function __scale(num, in_min, in_max, out_min, out_max) {
    if (num > in_max) num = in_max;
    if (num < in_min) num = in_min;
    return ((num - in_min) * (out_max - out_min) / (in_max - in_min)) + out_min;
}

function __adjustTemperature(temp_in, unit_in, unit_out) {
    // Converts temperatures between C/F and vice-versa. 
    // Also rounds temperatures to 0.5 increments for C and 1.0 for F
    var adjustedTemperature = temp_in;

    if (unit_in != unit_out) {
        if ((unit_in == "C" || unit_in == "c" || unit_in == Characteristic.TemperatureDisplayUnits.CELSIUS) && (unit_out == "F" || unit_out == "f" || unit_out == Characteristic.TemperatureDisplayUnits.FAHRENHEIT)) {
            // convert from C to F
            adjustedTemperature = (temp_in * 9 / 5) + 32;
        }

        if ((unit_in == "F" || unit_in == "f" || unit_in == Characteristic.TemperatureDisplayUnits.FAHRENHEIT) && (unit_out == "C" || unit_out == "c" || unit_out == Characteristic.TemperatureDisplayUnits.CELSIUS)) {
            // convert from F to C
            adjustedTemperature = (temp_in - 32) * 5 / 9
        }
    }

    if (unit_out == "C" || unit_out == "c" || unit_out == Characteristic.TemperatureDisplayUnits.CELSIUS) adjustedTemperature = Math.round(adjustedTemperature * 2) / 2;   // round to neartest 0.5
    if (unit_out == "F" || unit_out == "f" || unit_out == Characteristic.TemperatureDisplayUnits.FAHRENHEIT) adjustedTemperature = Math.round(adjustedTemperature); // round to neartest 1

    return adjustedTemperature;
}

function processDeviceforHomeKit(nestObject, nestDevice, action) {
    if (action == "add" && typeof nestDevice == "object") {
        // adding device into HomeKit
        // Generate some common things
        var tempName = (nestDevice.description == "" ? nestDevice.location : nestDevice.location + " - " + nestDevice.description);    // Need to generate valid HomeKit name
        var tempModel = "";

        switch (nestDevice.device_type) {
            case "thermostat" : {
                // Nest Thermostat
                tempModel = "Thermostat";
                if (nestDevice.serial_number.substr(0,2) == "15") tempModel = tempModel + " E";  // Nest Thermostat E
                if (nestDevice.serial_number.substr(0,2) == "09") tempModel = tempModel + " 3rd Gen";  // Nest Thermostat 3rd Gen
                if (nestDevice.serial_number.substr(0,2) == "02") tempModel = tempModel + " 2nd Gen";  // Nest Thermostat 2nd Gen
                if (nestDevice.serial_number.substr(0,2) == "01") tempModel = tempModel + " 1st Gen";  // Nest Thermostat 1st Gen

                // Create accessory for each discovered nest
                var tempAccessory = exports.accessory = new Accessory("Nest Thermostat", uuid.generate("hap-nodejs:accessories:nest_" + nestDevice.serial_number));
                tempAccessory.username = nestDevice.mac_address;
                tempAccessory.pincode = AccessoryPincode;
                tempAccessory.category = Accessory.Categories.THERMOSTAT;  // Thermostat type accessory
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, "Nest");
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Model, tempModel);
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.SerialNumber, nestDevice.serial_number);
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, nestDevice.software_version);
            
                tempAccessory.__thisObject = new ThermostatClass(); // Store the object
                tempAccessory.__thisObject.__nestDeviceID = nestDevice.serial_number;
                tempAccessory.__thisObject.__orgNestDeviceID = nestDevice.orgNestStructure;
                tempAccessory.__thisObject.__nestObject = nest;
                tempAccessory.__thisObject.addThermostat(tempAccessory, tempName, 1, nestDevice); 

                accessories.push(tempAccessory);   // Push onto export array for HAP-NodeJS "accessory factory"
                tempAccessory.publish({username: tempAccessory.username, pincode: tempAccessory.pincode, category: tempAccessory.category, advertiser: "ciao"});    // Publish accessory on local network
                nestObject.addSubscription(tempAccessory.__thisObject.__nestDeviceID, tempAccessory, tempAccessory.__thisObject.updateHomeKit.bind(tempAccessory.__thisObject));
                break;
            }

            case "sensor" : {
                // Nest Temperature Sensor
                tempModel = "Temperature Sensor";
                if (nestDevice.serial_number.substr(0,2) == "22") tempModel = tempModel + " 1st Gen";  // Nest Temperature Sensor 1st Gen

                var tempAccessory = exports.accessory = new Accessory("Nest Temperature Sensor", uuid.generate("hap-nodejs:accessories:nest_" + nestDevice.serial_number));
                tempAccessory.username = nestDevice.mac_address;
                tempAccessory.pincode = AccessoryPincode;
                tempAccessory.category = Accessory.Categories.SENSOR;  // Sensor type accessory
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, "Nest");
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Model, tempModel);
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.SerialNumber, nestDevice.serial_number);
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, nestDevice.software_version);

                tempAccessory.__thisObject = new TempSensorClass(); // Store the object
                tempAccessory.__thisObject.__nestDeviceID = nestDevice.serial_number;
                tempAccessory.__thisObject.__orgNestDeviceID = nestDevice.orgNestStructure;
                tempAccessory.__thisObject.addTemperatureSensor(tempAccessory, tempName, 1, nestDevice); 

                accessories.push(tempAccessory);   // Push onto export array for HAP-NodeJS "accessory factory"
                tempAccessory.publish({username: tempAccessory.username, pincode: tempAccessory.pincode, category: tempAccessory.category, advertiser: "ciao"});    // Publish accessory on local network
                nestObject.addSubscription(tempAccessory.__thisObject.__nestDeviceID, tempAccessory, tempAccessory.__thisObject.updateHomeKit.bind(tempAccessory.__thisObject));
                break;
            }

            case "protect" : {
                // Nest Protect
                tempModel = "Protect";
                if (nestDevice.serial_number.substr(0,2) == "06") tempModel = tempModel + " 2nd Gen";  // Nest Protect 2nd Gen
                if (nestDevice.serial_number.substr(0,2) == "05") tempModel = tempModel + " 1st Gen";  // Nest Protect 1st Gen
                if (nestDevice.wired_or_battery == 0) tempModel = tempModel + " (Wired)";    // Mains powered
                if (nestDevice.wired_or_battery == 1) tempModel = tempModel + " (Battery)";    // Battery powered

                var tempAccessory = exports.accessory = new Accessory("Nest Protect", uuid.generate("hap-nodejs:accessories:nest_" + nestDevice.serial_number));
                tempAccessory.username = nestDevice.mac_address;
                tempAccessory.pincode = AccessoryPincode;
                tempAccessory.category = Accessory.Categories.SENSOR;  // Sensor type accessory
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, "Nest");
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Model, tempModel);
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.SerialNumber, nestDevice.serial_number);
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, nestDevice.software_version);

                tempAccessory.__thisObject = new SmokeSensorClass(); // Store the object
                tempAccessory.__thisObject.__nestDeviceID = nestDevice.serial_number;
                tempAccessory.__thisObject.__orgNestDeviceID = nestDevice.orgNestStructure;
                tempAccessory.__thisObject.__nestObject = nest;
                tempAccessory.__thisObject.addSmokeCOSensor(tempAccessory, tempName, 1, nestDevice); 

                accessories.push(tempAccessory);   // Push onto export array for HAP-NodeJS "accessory factory"
                tempAccessory.publish({username: tempAccessory.username, pincode: tempAccessory.pincode, category: tempAccessory.category, advertiser: "ciao"}); // Publish accessory on local network
                nestObject.addSubscription(tempAccessory.__thisObject.__nestDeviceID, tempAccessory, tempAccessory.__thisObject.updateHomeKit.bind(tempAccessory.__thisObject));
                break;
            }

            case "camera" : 
            case "doorbell" : {
                // Nest Hello and Nest Cam(s)
                // Basically the same 
                tempModel = "";
                if (nestDevice.serial_number.substr(0,2) == "19") tempModel = "Hello";    // Nest Hello 1st generation
                if (nestDevice.serial_number.substr(0,2) == "xx") tempModel = "Cam Indoor";
                if (nestDevice.serial_number.substr(0,2) == "xx") tempModel = "Cam IQ Indoor";
                if (nestDevice.serial_number.substr(0,2) == "xx") tempModel = "Cam Outdoor";
                if (nestDevice.serial_number.substr(0,2) == "17") tempModel = "Cam IQ Outdoor";
                if (tempModel == "") tempModel = "Cam unknown " + nestDevice.serial_number.substr(0,2) ; // Unknown camera type

                var tempAccessory = exports.accessory = new Accessory("Nest " + tempModel, uuid.generate("hap-nodejs:accessories:nest_" + nestDevice.serial_number));
                tempAccessory.username = nestDevice.mac_address;
                tempAccessory.pincode = AccessoryPincode;
                tempAccessory.category = nestDevice.device_type == "doorbell" ? Accessory.Categories.VIDEO_DOORBELL : Accessory.Categories.IP_CAMERA;
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, "Nest");
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Model, tempModel);
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.SerialNumber, nestDevice.serial_number);
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, nestDevice.software_version);

                tempAccessory.__thisObject = new CameraClass(); // Store the object
                tempAccessory.__thisObject.__nestDeviceID = nestDevice.serial_number;
                tempAccessory.__thisObject.__orgNestDeviceID = nestDevice.orgNestStructure;
                tempAccessory.__thisObject.__nestObject = nest;
                
                if (nestDevice.device_type == "doorbell") tempAccessory.__thisObject.addDoorbell(tempAccessory, tempName, 1, nestDevice);
                if (nestDevice.device_type == "camera") tempAccessory.__thisObject.addCamera(tempAccessory, tempName, 1, nestDevice);

                accessories.push(tempAccessory);   // Push onto export array for HAP-NodeJS "accessory factory"
                tempAccessory.publish({username: tempAccessory.username, pincode: tempAccessory.pincode, category: tempAccessory.category, advertiser: "ciao"}); // Publish accessory on local network
                nestObject.addSubscription(tempAccessory.__thisObject.__nestDeviceID, tempAccessory, tempAccessory.__thisObject.updateHomeKit.bind(tempAccessory.__thisObject));
                break;
            }
        }
    }

    if (action == "remove" && typeof nestDevice == "object") {
        // Removing device from HomeKit.. not sure want todo this yet... :-)
        nestObject.removeSubcription(nestDevice.serial_number); // Remove any active subscription for this device

        // find our accessory, then unpublish it and remove from HAP-NodeJS "accessory factory"
        var accessoryIndex = accessories.findIndex(({username}) => username === nestDevice.mac_address);
        if (accessoryIndex != -1 && accessories[accessoryIndex] && accessories[accessoryIndex].__thisObject.__nestDeviceID == nestDevice.serial_number) {
            console.log("DEBUG: Removed Nest Device '%s' on '%s'", accessories[accessoryIndex].displayName, accessories[accessoryIndex].username);
            accessories[accessoryIndex].unpublish();
            accessories.splice(accessoryIndex, 1);
        }
    }
}

// Below taken from https://lifesaver.codes/answer/adding-retry-parameter
axios.interceptors.response.use(undefined, function axiosRetryInterceptor(err) {
    var config = err.config;
    // If config does not exist or the retry option is not set, reject
    if (!config || !config.retry) return Promise.reject(err);
    
    // Set the variable for keeping track of the retry count
    config.__retryCount = config.__retryCount || 0;
    
    // Check if we've maxed out the total number of retries
    if (config.__retryCount >= config.retry) {
        // Reject with the error
        return Promise.reject(err);
    }
    
    // Increase the retry count
    config.__retryCount += 1;
    
    // Create new promise to handle exponential backoff
    var backoff = new Promise(function(resolve) {
        setTimeout(function() {
            resolve();
        }, config.retryDelay || 1);
    });
    
    // Return the promise in which re-calls axios to retry the request
    return backoff.then(function() {
        return axios(config);
    });
});


// Startup code
var nest = new NestClass();
if (nest.__nestToken != null) {
    nest.getNestData(true)
    .then(() => {
        nest.__currentNestData.device && Object.entries(nest.__currentNestData.device).forEach(([deviceID, nestDevice]) => {
            // Process discovered device into HomeKit
            processDeviceforHomeKit(nest, nestDevice, "add");    
        });
        nest.addSubscription(null, null, processDeviceforHomeKit);  // Subscribe for device additions/removals
    });
} else {
    console.log("No or invalid session token was specified in configuration");
}
