// HAP-Nodejs Nest devices in HomeKit
//
// Supported:
// -- Nest Thermostat, includes custom integration of daikin A/C (wifi controlled) for cooling centrally controlled from Nest
// -- Nest Temperature Sensors
// -- Nest Protect
// -- Nest Hello/Cams
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
// -- weather accessory using nest weather data API???
//
// -- Nest Hello/Cam(s)
//      -- Subscribe to events rather than polling??? firebase cloud messaging??
//      -- Reconfiguration of HomeKit streaming details
//      -- re-code cam event snapshots
//      -- Audio recording for HKSV
//      -- Improve alert getting
//
// -- Nest Thermostat
//      -- Correctly display F temps if selected. HomeKit bug??
//      -- Switching between range (low/high) to heat or cool, update correct target temp. Maybe need to get from nest ??
//      -- Childlock PIN set/clear based on a stored configuration??
//      -- "Hey Siri, turn on the fan for x minutes"????
//      -- Changes triggered from HomeKit when in ECO mode
//      -- Add leaf mode as custom HomeKit characteristic??
//
// -- Nest Protect
//      -- Add replacement date as custom HomeKit characteristic??
//      -- Motion history in Eve App
//      -- Pathway light as a light service? No sure can get info
//
// done
// -- recoding and renaming (9/3/2022) - minus deprecated functions
// -- use events framework for notifying internally of device updates
// -- debugging option in configuration file
// -- accessories are advertised using "ciao" backend for hap-nodejs
// -- external configuration file
// -- mechanism to exclude devices from HomeKit publishing
// -- periodically refresh Nest token expiry time
// -- history recording - testing of own solution
// -- dynamically remove/add accessories when added/removed from Nest app
// -- fully convert to axios library
// -- subscribe to events rather than polling every 30secs
// -- recoded device getting from Nest
// -- ground work for subscribe updates
// -- removed extra call to API for camera details. maybe very slightly faster updating
// -- split out camera details/alerts into sperate polling loop
//
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
//      -- ECO mode temperatures reflect in HomeKit
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
// -- Nest Hello/Cam(s)
//      -- initial coding.. need to get hands on one - done
//      -- get "website_2" cookie automatically
//      -- get "zones" to allow for seperate motion sensors
//      -- person motion alerting
//      -- Tested only with Nest Hello & Cam Outdoor, but should be fine for other Nest Cams
//      -- HomeKit Secure Video (HKSV) - initial work, video recording only
//
// bugs
// -- Sarting Jan 2020, google has enabled reCAPTCHA for Nest Accounts. Modfied code to no longer use user/name password login, but access token
//    Access token can be view by logging in to https//home.nest.com on webbrowser then in going to https://home.nest.com/session  Seems access token expires every 30days
//    so needs manually updating (haven't seen it expire yet.....)
//
// Version 19/4/2022
// Mark Hulskamp

module.exports = accessories = [];

var Accessory = require("../").Accessory; 
var Service = require("../").Service;
var Characteristic = require("../").Characteristic;
var uuid = require("../").uuid;
var axios = require("axios");
var EventEmitter = require("events");
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
const AccessoryName =  "Nest";
const AccessoryPincode = "031-45-154";
const USERAGENT = "iPhone iOS 15.4 Dropcam/5.67.0.6 com.nestlabs.jasper.release Darwin";
const REFERER = "https://home.nest.com"
const CAMERAAPIHOST = "https://webapi.camera.home.nest.com";
const NESTAPITIMEOUT = 10000;                       // Calls to Nest API timeout
const CAMERAALERTPOLLING = 3000;                    // Camera alerts polling timer
const CAMERAZONEPOLLING = 30000;                    // Camera zones changes polling timer
const DOORBELLCOOLDOWN = 60000;                     // Cooldown for Nest doorbell button pressed
const PERSONCOOLDOWN = 120000;                      // Cooldown for Nest camera detecting a person/face
const MOTIONCOOLDOWN = 60000;                       // Cooldown for HomeKit Secure Video motion recording
const HKSVBUFFERSIZE = 30000;                       // Default time we hold in HomeKit Secure Video buffering
const LOWBATTERYLEVEL = 10;                         // Low level battery percentage

const NESTSTRUCTURECHANGE = "structure";            // Nest structure change event

class NestClass extends EventEmitter {
	constructor() {
        super();

        this.nestToken = "";                        // Access token for requests
        this.nestCookie = "";                       // WEBSITE_2 cookie. used for camera requests
        this.nestURL = "";                          // URL for nest requests
        this.nestID = "";                           // User ID
        this.tokenExpire = null;                    // Time when token expires (in Unix timestamp)
        this.tokenTimer = null;                     // Handle for token refresh timer
        this.rawNestData = {};                      // Full copy of nest structure data
        this.previousDevices = {};                  // Our previous processed Nest devices
        this.nestDevices = {};                      // Our current processed Nest devices
        this.deviceEvents = {};                     // array of device id's linking to HomeKit accessory 
        this.excludedDevices = [];                  // array of excluded devices (by serial number). We don't process these devices
        this.extraOptions = {};                     // Extra options per device to inject into Nest data stream
        this.cancel = null;
        this.debug = false;                         // Enable debug output, no by default
        this.HomeKitSecureVideo = false;            // Enable HKSV for all camera/doorbells, no by default
        this.startTime = null;                      // Time we started the object. used to filter out old alerts

        // Load configuration
        if (fs.existsSync(__dirname + "/Nest_config.json")) {
            var config = require(__dirname + "/Nest_config.json");

            config && Object.entries(config).forEach(([key, value]) => {
                // Process configuration items
                if (key.toUpperCase() == "SESSIONTOKEN") this.nestToken = value;  // Session token to use for Nest calls
                if (key.toUpperCase() == "DEBUG" && typeof value == "boolean") this.debug = value;  // Debugging output
                if (key.toUpperCase() == "HKSV" && typeof value == "boolean") this.HomeKitSecureVideo = value;    // default for HomeKit Secure Video
                if (typeof value == "object") {
                    // Assume since key value is an object, its a device configuration for matching serial number
                    this.extraOptions[key.toUpperCase()] = {};
                    Object.entries(value).forEach(([subKey, value]) => {
                        if (subKey.toUpperCase() == "EXCLUDE" && typeof value == "boolean" && value == true) this.excludedDevices.push(key.toUpperCase());    // Push this devices serial number onto our list
                        if (subKey.split('.')[0].toUpperCase() == "OPTION" && subKey.split('.')[1]) {
                            // device options we'll insert into the Nest data for non excluded devices
                            // also allows us to override existing Nest data for the device, such as MAC address etc
                            this.extraOptions[key.toUpperCase()][subKey.split('.')[1]] = value;
                        }
                    });

                    // Remove any extra options if the device is marked as excluded
                    if (this.excludedDevices.includes(key.toUpperCase()) == true) {
                        delete this.extraOptions[key.toUpperCase()];
                    }
                }
            });
        }

        this.startTime = Math.floor(new Date() / 1000);
    }
}

// Create the thermostat object
function ThermostatClass() {
    this.deviceID = null;                       // Device ID for this Nest Thermostat
    this.nestObject = null;
    this.ThermostatService = null;              // HomeKit service for this thermostat
    this.BatteryService = null;                 // Status of Nest Thermostat battery
    this.OccupancyService = null;               // Status of Away/Home
    this.HumidityService = null;                // Seperate humidity sensor
    this.FanService = null;                     // Fan service
    this.nestCanHeat = null;
    this.nestCanCool = null;
    this.nestHasFan = null;
    this.updatingHomeKit = false;               // Flag if were doing an HomeKit update or not
    this.historyService = null;                 // History logging service
}

// Create the sensor object
function TempSensorClass() {
    this.deviceID = null;                       // Device ID for this Nest Temperature Sensor
    this.nestObject = null;
    this.TemperatureService = null;             // HomeKit service for this temperature sensor
    this.BatteryService = null;                 // Status of Nest Temperature Sensor Battery
    this.updatingHomeKit = false;               // Flag if were doing an HomeKit update or not
    this.historyService = null;                 // History logging service
}

// Create the sensor object
function SmokeSensorClass() {
    this.deviceID = null;                       // Device ID for this Nest Protect Sensor
    this.nestObject = null;
    this.SmokeService = null;                   // HomeKit service for this smoke sensor
    this.COService = null;                      // HomeKit service for this CO sensor
    this.BatteryService = null;                 // Status of Nest Protect Sensor Battery
    this.MotionService = null;                  // Status of Nest Protect motion sensor
    this.LightService = null;                   // Status of Nest Protect Pathway light
    this.updatingHomeKit = false;               // Flag if were doing an HomeKit update or not
}

// Create the camera object
function CameraClass() {
    this.deviceID = null;                       // Device ID for this Nest Hello/Cam(s)
    this.nestObject = null;
    this.controller = null;                     // HomeKit Camera/Doorbell controller service
    this.MotionServices = [];                   // Status of Nest Hello/Cam(s) motion sensor(s)
    this.updatingHomeKit = false;               // Flag if were doing an HomeKit update or not
    this.snapshotEvent = {type: "", time: 0, id: 0, "done": false};
    this.pendingSessions = [];                      
    this.ongoingSessions = [];
    this.ongoingStreams = [];
    this.cachedSnapshot = null;                 // Cached camera snapshot from stream

    this.doorbellTimer = null;                  // Cooldown timer for doorbell events
    this.personTimer = null;                    // Cooldown timer for person/face events
    this.motionTimer = null;                    // Cooldown timer for motion events

    this.NexusStreamer =  null;                 // Object for the Nexus Streamer. Created when adding doorbell/camera

    // HKSV stuff
    this.HKSVEvents = null;                     // Event emitter
    this.HKSVRecordingConfig = {};              // HomeKit Secure Video recording configuration
    this.HKSVffmpegRecorder = null;             // ffmpeg process for HkSV recording
    this.HKSVBuffer = [];                       // HKSV mp4 fragment buffer
}


// Nest Thermostat
ThermostatClass.prototype.addThermostat = function(HomeKitAccessory, thisServiceName, serviceNumber, deviceData) {
    // Add this thermostat to the "master" accessory and set properties
    this.ThermostatService = HomeKitAccessory.addService(Service.Thermostat, "Thermostat", 1);
    this.ThermostatService.addCharacteristic(Characteristic.StatusActive);
    this.ThermostatService.addCharacteristic(Characteristic.LockPhysicalControls);    // Setting can only be accessed via Eve App (or other 3rd party).

    // Add battery service to display battery level
    this.BatteryService = HomeKitAccessory.addService(Service.BatteryService, "", 1);

    // Seperate humidity sensor if configured todo so
    if (deviceData.humidity_sensor && deviceData.humidity_sensor == true) {
        this.HumidityService = HomeKitAccessory.addService(Service.HumiditySensor, "Humidity", 1);      // Humidity will be listed under seperate sensor
    } else {
        this.ThermostatService.addCharacteristic(Characteristic.CurrentRelativeHumidity); // Humidity will be listed under thermostat only
    }

    // Add home/away status as an occupancy sensor
    this.OccupancyService = HomeKitAccessory.addService(Service.OccupancySensor, "Occupancy", 1);
    this.OccupancyService.addCharacteristic(Characteristic.StatusActive);

    // Limit prop ranges
    if (deviceData.can_cool == false && deviceData.can_heat == true)
    {
        // Can heat only, so set values allowed for mode off/heat
        this.ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.HEAT]});
    } else if (deviceData.can_cool == true && deviceData.can_heat == false) {
        // Can cool only
        this.ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.COOL]});
    } else if (deviceData.can_cool == true && deviceData.can_heat == true) {
        // heat and cool 
        this.ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.HEAT, Characteristic.TargetHeatingCoolingState.COOL, Characteristic.TargetHeatingCoolingState.AUTO]});
    } else {
        // only off mode
        this.ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF]});
    }

    // Add fan service if Nest supports a fan
    if (deviceData.has_fan == true) {
        this.FanService = HomeKitAccessory.addService(Service.Fan, "Fan", 1);
        this.FanService.getCharacteristic(Characteristic.On).on("set", this.setFan.bind(this));
    }
    
    // Set default ranges - based on celsuis ranges
    this.ThermostatService.setCharacteristic(Characteristic.TemperatureDisplayUnits, Characteristic.TemperatureDisplayUnits.CELSIUS);
    this.ThermostatService.getCharacteristic(Characteristic.CurrentTemperature).setProps({minStep: 0.5});
    this.ThermostatService.getCharacteristic(Characteristic.TargetTemperature).setProps({minStep: 0.5}, {minValue: 9}, {maxValue: 32});
    this.ThermostatService.getCharacteristic(Characteristic.CoolingThresholdTemperature).setProps({minStep: 0.5}, {minValue: 9}, {maxValue: 32});
    this.ThermostatService.getCharacteristic(Characteristic.HeatingThresholdTemperature).setProps({minStep: 0.5}, {minValue: 9}, {maxValue: 32});

    // Setup set callbacks for characteristics
    this.ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).on("set", this.setDisplayUnits.bind(this));
    this.ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).on("set", this.setMode.bind(this));
    this.ThermostatService.getCharacteristic(Characteristic.TargetTemperature).on("set", (value, callback) => {this.setTemperature(Characteristic.TargetTemperature, value, callback)});
    this.ThermostatService.getCharacteristic(Characteristic.CoolingThresholdTemperature).on("set", (value, callback) => {this.setTemperature(Characteristic.CoolingThresholdTemperature, value, callback)});
    this.ThermostatService.getCharacteristic(Characteristic.HeatingThresholdTemperature).on("set", (value, callback) => {this.setTemperature(Characteristic.HeatingThresholdTemperature, value, callback)});
    this.ThermostatService.getCharacteristic(Characteristic.LockPhysicalControls).on("set", (value, callback) => {this.setChildlock("", value, callback)});

    // Setup logging
    this.historyService = new HomeKitHistory(HomeKitAccessory, {});
    this.historyService.linkToEveHome(HomeKitAccessory, this.ThermostatService, {});

    this.updateHomeKit(HomeKitAccessory, deviceData);  // Do initial HomeKit update
    console.log("Setup Nest Thermostat '%s' on '%s'", thisServiceName, HomeKitAccessory.username, (this.HumidityService != null ? "with seperate humidity sensor" : ""));
}

ThermostatClass.prototype.setFan = function(value, callback) {
    this.updatingHomeKit = true;

    this.FanService.updateCharacteristic(Characteristic.On, value);
    this.nestObject.setNestStructure("device." + this.deviceStructure.split('.')[1], "fan_timer_timeout", value == false ? 0 : this.nestObject.nestDevices[this.deviceID].fan_duration + Math.floor(new Date() / 1000));

    if (typeof callback === "function") callback();  // do callback if defined
    this.updatingHomeKit = false;
}

ThermostatClass.prototype.setDisplayUnits = function(value, callback) {
    this.updatingHomeKit = true;

    // Update HomeKit steps and ranges for temperatures
    this.ThermostatService.getCharacteristic(Characteristic.CurrentTemperature).setProps({minStep: (value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 0.5 : 1)});
    this.ThermostatService.getCharacteristic(Characteristic.TargetTemperature).setProps({minStep: (value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 0.5 : 1)}, {minValue: (value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 9 : 48)}, {maxValue: (value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 9 : 90)});
    this.ThermostatService.getCharacteristic(Characteristic.CoolingThresholdTemperature).setProps({minStep: (value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 0.5 : 1)}, {minValue: (value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 9 : 48)}, {maxValue: (value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 9 : 90)});
    this.ThermostatService.getCharacteristic(Characteristic.HeatingThresholdTemperature).setProps({minStep: (value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 0.5 : 1)}, {minValue: (value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 9 : 48)}, {maxValue: (value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 9 : 90)});

    this.ThermostatService.updateCharacteristic(Characteristic.TemperatureDisplayUnits, value);
    this.nestObject.setNestStructure("device." + this.deviceStructure.split('.')[1], "temperature_scale", value == Characteristic.TemperatureDisplayUnits.CELSIUS ? "C" : "F");
    if (typeof callback === "function") callback();  // do callback if defined

    this.updatingHomeKit = false;
}

ThermostatClass.prototype.setMode = function(value, callback) {
    this.updatingHomeKit = true;

    if (value != this.ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).value) {
        // Only change heating/cooling mode if change requested is different than current HomeKit state
        var tempMode = "";
        var tempValue = null;

        if (value == Characteristic.TargetHeatingCoolingState.HEAT && this.nestCanHeat == true) {
            tempMode = "heat";
            tempValue = Characteristic.TargetHeatingCoolingState.HEAT;
        }
        if (value == Characteristic.TargetHeatingCoolingState.COOL && this.nestCanCool == true) {
            tempMode = "cool";
            tempValue = Characteristic.TargetHeatingCoolingState.COOL;
        }
        if (value == Characteristic.TargetHeatingCoolingState.AUTO) {
            // Workaround for "Hey Siri, turn on my thermostat". Appears to automatically request mode as "auto", but we need to see what Nest device supports
            if (this.nestCanCool == true && this.nestCanHeat == true) {
                tempMode = "range";
                tempValue = Characteristic.TargetHeatingCoolingState.AUTO;
            } else if (this.nestCanCool == true && this.nestCanHeat == false) {
                tempMode = "cool";
                tempValue = Characteristic.TargetHeatingCoolingState.COOL;
            } else if (this.nestCanCool == false && this.nestCanHeat == true) {
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
            this.nestObject.setNestStructure("shared." + this.deviceStructure.split('.')[1], "target_temperature_type", tempMode, false);
            this.ThermostatService.updateCharacteristic(Characteristic.TargetHeatingCoolingState, tempValue);
            
            if (typeof this.nestObject.previousDevices[this.deviceID] == "object" && typeof this.nestObject.nestDevices[this.deviceID] == "object" && this.nestObject.previousDevices[this.deviceID].target_temperature_type == "range" && (tempMode == "heat" || tempMode == "cool")) {
                // If switching from range to heat/cool, update HomeKit using previous target temp
                this.ThermostatService.updateCharacteristic(Characteristic.TargetTemperature, this.nestObject.nestDevices[this.deviceID].target_temperature);
            }
        }
    }
    if (typeof callback === "function") callback();  // do callback if defined

    this.updatingHomeKit = false;
}

ThermostatClass.prototype.setTemperature = function(characteristic, value, callback) {
    this.updatingHomeKit = true;

    if (characteristic == Characteristic.TargetTemperature && this.ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).value != Characteristic.TargetHeatingCoolingState.AUTO) {
        this.nestObject.setNestStructure("shared." + this.deviceStructure.split('.')[1], "target_temperature", __adjustTemperature(value, "C", "C"), false);
    }
    if (characteristic == Characteristic.HeatingThresholdTemperature && this.ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).value == Characteristic.TargetHeatingCoolingState.AUTO) {
        this.nestObject.setNestStructure("shared." + this.deviceStructure.split('.')[1], "target_temperature_low", __adjustTemperature(value, "C", "C"), false);
    }
    if (characteristic == Characteristic.CoolingThresholdTemperature && this.ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).value == Characteristic.TargetHeatingCoolingState.AUTO) {
        this.nestObject.setNestStructure("shared." + this.deviceStructure.split('.')[1], "target_temperature_high", __adjustTemperature(value, "C", "C"), false);
    }

    this.ThermostatService.updateCharacteristic(characteristic, value);  // Update HomeKit with value
    if (typeof callback === "function") callback();  // do callback if defined

    this.updatingHomeKit = false;
}

ThermostatClass.prototype.setChildlock = function(pin, value, callback) {
    this.updatingHomeKit = true;
    // TODO - pincode setting when turning on. Writes to device.xxxxxxxx.temperature_lock_pin_hash. How is the hash calculated???
    // Do we set temperature range limits when child lock on??

    this.ThermostatService.updateCharacteristic(Characteristic.LockPhysicalControls, value);  // Update HomeKit with value
    if (value == Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED) {
        // Set pin hash????
    }
    if (value == Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED) {
        // Clear pin hash????
    }
    this.nestObject.setNestStructure("device." + this.deviceStructure.split('.')[1], "temperature_lock", value == Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED ? true : false);
    
    if (typeof callback === "function") callback();  // do callback if defined
    
    this.updatingHomeKit = false;
}

ThermostatClass.prototype.updateHomeKit = function(HomeKitAccessory, deviceData) {
    var historyEntry = {};

    if (typeof deviceData == "object" && this.updatingHomeKit == false)
    {
        if (this.ThermostatService != null && this.BatteryService != null && this.OccupancyService != null) {
            HomeKitAccessory.getService(Service.AccessoryInformation).updateCharacteristic(Characteristic.FirmwareRevision, deviceData.software_version);   // Update firmware version
            this.ThermostatService.updateCharacteristic(Characteristic.TemperatureDisplayUnits, deviceData.temperature_scale.toUpperCase() == "C" ? Characteristic.TemperatureDisplayUnits.CELSIUS : Characteristic.TemperatureDisplayUnits.FAHRENHEIT);
            this.ThermostatService.updateCharacteristic(Characteristic.CurrentTemperature, deviceData.active_temperature);
            this.ThermostatService.updateCharacteristic(Characteristic.StatusActive, (deviceData.online == true && deviceData.removed_from_base == false) ? true : false);  // If Nest isn't online or removed from base, report in HomeKit
            this.ThermostatService.updateCharacteristic(Characteristic.LockPhysicalControls, deviceData.temperature_lock == true ? Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED : Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED);
            
            // Update HomeKit steps and ranges for temperatures
            // Do we limit ranges when childlock on????
            this.ThermostatService.getCharacteristic(Characteristic.CurrentTemperature).setProps({minStep: (this.ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 0.5 : 1)});
            this.ThermostatService.getCharacteristic(Characteristic.TargetTemperature).setProps({minStep: (this.ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 0.5 : 1)}, {minValue: (this.ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 9 : 48)}, {maxValue: (this.ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 32 : 90)});
            this.ThermostatService.getCharacteristic(Characteristic.CoolingThresholdTemperature).setProps({minStep: (this.ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 0.5 : 1)}, {minValue: (this.ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 9 : 48)}, {maxValue: (this.ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 32 : 90)});
            this.ThermostatService.getCharacteristic(Characteristic.HeatingThresholdTemperature).setProps({minStep: (this.ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 0.5 : 1)}, {minValue: (this.ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 9 : 48)}, {maxValue: (this.ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 32 : 90)});
    
            // Battery status if defined. Since Nest needs 3.6 volts to turn on, we'll use that as the lower limit. Havent seen battery level above 3.9ish, so assume 3.9 is upper limit
            var tempBatteryLevel = __scale(deviceData.battery_level, 3.6, 3.9, 0, 100);
            this.BatteryService.updateCharacteristic(Characteristic.BatteryLevel, tempBatteryLevel);
            this.BatteryService.updateCharacteristic(Characteristic.StatusLowBattery, tempBatteryLevel > LOWBATTERYLEVEL ? Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL : Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);
            this.BatteryService.updateCharacteristic(Characteristic.ChargingState, deviceData.battery_charging_state == true ? Characteristic.ChargingState.CHARGING : Characteristic.ChargingState.NOT_CHARGING);
    
            // Update for away/home status. Away = no occupancy detected, Home = Occupancy Detected
            this.OccupancyService.updateCharacteristic(Characteristic.OccupancyDetected, deviceData.away == true ? Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED : Characteristic.OccupancyDetected.OCCUPANCY_DETECTED);
            this.OccupancyService.updateCharacteristic(Characteristic.StatusActive, (deviceData.online == true && deviceData.removed_from_base == false) ? true : false);  // If Nest isn't online or removed from base, report in HomeKit

            // Update seperate humidity sensor if configured todo so
            if (this.HumidityService != null) {
                this.HumidityService.updateCharacteristic(Characteristic.CurrentRelativeHumidity, deviceData.current_humidity);  // Humidity will be listed under seperate sensor
            } else {
                this.ThermostatService.updateCharacteristic(Characteristic.CurrentRelativeHumidity, deviceData.current_humidity);    // Humidity will be listed under thermostat only
            }

            // fan setup has changed on thermostat
            if (this.nestHasFan != deviceData.has_fan) {
                if (this.nestHasFan == false && deviceData.has_fan == true && this.FanService == null) {
                    // A fan has been added
                    this.FanService = HomeKitAccessory.addService(Service.Fan, "Fan", 1);
                    this.FanService.getCharacteristic(Characteristic.On).on("set", this.setFan.bind(this));
                }
                if (this.nestHasFan == true && deviceData.has_fan == false && this.FanService != null) {
                    // A fan has been removed
                    HomeKitAccessory.removeService(this.FanService);
                    this.FanService = null;
                }
            }

            // Update fan mode
            this.nestHasFan = deviceData.has_fan;

            if (this.nestCanCool != deviceData.can_cool || this.nestCanHeat != deviceData.can_heat) {
                // Heating and/cooling setup has changed on thermostat

                // Limit prop ranges
                if (deviceData.can_cool == false && deviceData.can_heat == true)
                {
                    // Can heat only, so set values allowed for mode off/heat
                    this.ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.HEAT]});
                }
                if (deviceData.can_cool == true && deviceData.can_heat == false) {
                    // Can cool only
                    this.ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.COOL]});
                }
                if (deviceData.can_cool == true && deviceData.can_heat == true) {
                    // heat and cool 
                    this.ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.HEAT, Characteristic.TargetHeatingCoolingState.COOL, Characteristic.TargetHeatingCoolingState.AUTO]});
                }
                if (deviceData.can_cool == false && deviceData.can_heat == false) {
                    // only off mode
                    this.ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF]});
                }
            } 

            // update cooling/heating modes
            this.nestCanCool = deviceData.can_cool;
            this.nestCanHeat = deviceData.can_heat;

            // Update current mode temperatures
            if (deviceData.hvac_mode.toUpperCase() == "HEAT" || (deviceData.hvac_mode.toUpperCase() == "ECO" && deviceData.target_temperature_type.toUpperCase() == "HEAT")) {
                // heating mode, either eco or normal
                this.ThermostatService.updateCharacteristic(Characteristic.HeatingThresholdTemperature, deviceData.target_temperature_low);
                this.ThermostatService.updateCharacteristic(Characteristic.CoolingThresholdTemperature, deviceData.target_temperature_high);
                this.ThermostatService.updateCharacteristic(Characteristic.TargetTemperature, deviceData.target_temperature);
                this.ThermostatService.updateCharacteristic(Characteristic.TargetHeatingCoolingState, Characteristic.TargetHeatingCoolingState.HEAT);
                historyEntry.target = {low: 0, high: deviceData.target_temperature};    // single target temperature for heating limit
            }
            if (deviceData.hvac_mode.toUpperCase() == "COOL" || (deviceData.hvac_mode.toUpperCase() == "ECO" && deviceData.target_temperature_type.toUpperCase() == "COOL")) {
                // cooling mode, either eco or normal
                this.ThermostatService.updateCharacteristic(Characteristic.HeatingThresholdTemperature, deviceData.target_temperature_low);
                this.ThermostatService.updateCharacteristic(Characteristic.CoolingThresholdTemperature, deviceData.target_temperature_high);
                this.ThermostatService.updateCharacteristic(Characteristic.TargetTemperature, deviceData.target_temperature);
                this.ThermostatService.updateCharacteristic(Characteristic.TargetHeatingCoolingState, Characteristic.TargetHeatingCoolingState.COOL);
                historyEntry.target = {low: deviceData.target_temperature, high: 0};    // single target temperature for cooling limit
            }
            if (deviceData.hvac_mode.toUpperCase() == "RANGE" || (deviceData.hvac_mode.toUpperCase() == "ECO" && deviceData.target_temperature_type.toUpperCase() == "RANGE")) {
                // range mode, either eco or normal
                this.ThermostatService.updateCharacteristic(Characteristic.HeatingThresholdTemperature, deviceData.target_temperature_low);
                this.ThermostatService.updateCharacteristic(Characteristic.CoolingThresholdTemperature, deviceData.target_temperature_high);
                this.ThermostatService.updateCharacteristic(Characteristic.TargetHeatingCoolingState, Characteristic.TargetHeatingCoolingState.AUTO);
                historyEntry.target = {low: deviceData.target_temperature_low, high: deviceData.target_temperature_high};    // target temperature range
            }
            if (deviceData.hvac_mode.toUpperCase() == "OFF") {
                // off mode.
                this.ThermostatService.updateCharacteristic(Characteristic.HeatingThresholdTemperature, deviceData.target_temperature_low);
                this.ThermostatService.updateCharacteristic(Characteristic.CoolingThresholdTemperature, deviceData.target_temperature_high);
                this.ThermostatService.updateCharacteristic(Characteristic.TargetTemperature, deviceData.target_temperature);
                this.ThermostatService.updateCharacteristic(Characteristic.TargetHeatingCoolingState, Characteristic.TargetHeatingCoolingState.OFF);
                historyEntry.target = {low: 0, high: 0};    // thermostat off, so no target temperatures
            }

            // Update current state
            if (deviceData.hvac_state.toUpperCase() == "HEATING") {
                if (deviceData.previous_hvac_state.toUpperCase() == "COOLING" && deviceData.coolingURL) {
                    // Switched to heating mode and external cooling URL was being used, so stop cooling via cooling URL
                    __setDaikinAC(deviceData.coolingURL, 0, 3, deviceData.target_temperature_high, 0, "A", 3, this.nestObject.debug);
                }
                if (deviceData.previous_hvac_state.toUpperCase() != "HEATING" && deviceData.heatingURL) {
                    // Switched to heating mode and external heating URL is being used, so start heating via heating URL
                    // Insert code here to startup external heating source
                }
                this.ThermostatService.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, Characteristic.CurrentHeatingCoolingState.HEAT);
                historyEntry.status = 2;    // heating
            }
            if (deviceData.hvac_state.toUpperCase() == "COOLING") {
                if (deviceData.previous_hvac_state.toUpperCase() == "HEATING" && deviceData.heatingURL) {
                    // Switched to cooling mode and external heating URL was being used, so stop heating via heating URL
                    // Insert code here to stop external heating source
                }
                if (deviceData.previous_hvac_state.toUpperCase() != "COOLING" && deviceData.coolingURL) {
                    // Switched to cooling mode and external cooling URL is being used, so start cooling via cooling URL
                    __setDaikinAC(deviceData.coolingURL, 1, 3, this.ThermostatService.getCharacteristic(Characteristic.TargetTemperature).value, 0, "A", 3, this.nestObject.debug);
                }
                this.ThermostatService.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, Characteristic.CurrentHeatingCoolingState.COOL);
                historyEntry.status = 3;    // cooling
            }
            if (deviceData.hvac_state.toUpperCase() == "OFF") {
                if (deviceData.previous_hvac_state.toUpperCase() == "COOLING" && deviceData.coolingURL) {
                    // Switched to off mode and external cooling URL was being used, so stop cooling via cooling URL
                    __setDaikinAC(deviceData.coolingURL, 0, 3, deviceData.target_temperature, 0, "A", 3, this.nestObject.debug);
                }
                if (deviceData.previous_hvac_state.toUpperCase() == "HEATING" && deviceData.heatingURL) {
                    // Switched to off mode and external heating URL was being used, so stop heating via heating URL
                    // Insert code here to stop external heating source
                }
                this.ThermostatService.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, Characteristic.CurrentHeatingCoolingState.OFF);
                historyEntry.status = 0;    // off
            }

            if (this.FanService != null) {
                if (deviceData.previous_fan_state = false && deviceData.fan_state == true) {
                    // Fan mode was switched on and external fan URL is being used, so start fan via fan URL
                    deviceData.fanURL && __setDaikinAC(deviceData.fanURL, 1, 6, "--", "--", "A", 3, this.nestObject.debug);
                }
                if (deviceData.previous_fan_state == true && deviceData.fan_state == false) {
                    // Fan mode was switched off and external fan URL was being used, so stop fan via fan URL
                    deviceData.fanURL && __setDaikinAC(deviceData.fanURL, 0, 3, deviceData.target_temperature, 0, "A", 3, this.nestObject.debug);
                }

                this.FanService.updateCharacteristic(Characteristic.On, deviceData.fan_state);   // fan status on or off
                historyEntry.status = 1;    // fan
            }

            // Log thermostat metrics to history only if changed to previous recording
            if (this.historyService != null) {
                var tempEntry = this.historyService.lastHistory(this.ThermostatService);
                if (tempEntry == null || (typeof tempEntry == "object" && tempEntry.status != historyEntry.status || tempEntry.temperature != deviceData.active_temperature || JSON.stringify(tempEntry.target) != JSON.stringify(historyEntry.target) || tempEntry.humidity != deviceData.current_humidity)) {
                    this.historyService.addHistory(this.ThermostatService, {time: Math.floor(new Date() / 1000), status: historyEntry.status, temperature: deviceData.active_temperature, target: historyEntry.target, humidity: deviceData.current_humidity});
                }
            }
        }
    }
}


// Nest Temperature Sensors
TempSensorClass.prototype.addTemperatureSensor = function(HomeKitAccessory, thisServiceName, serviceNumber, deviceData) {
    // Add this temperature sensor to the "master" accessory and set properties   
    this.TemperatureService = HomeKitAccessory.addService(Service.TemperatureSensor, "Temperature", 1);
    this.TemperatureService.addCharacteristic(Characteristic.StatusActive);

    // Add battery service to display battery level    
    this.BatteryService = HomeKitAccessory.addService(Service.BatteryService, "", 1);
    this.BatteryService.updateCharacteristic(Characteristic.ChargingState, Characteristic.ChargingState.NOT_CHARGEABLE); //  dont charge as run off battery

    // Setup logging
    this.historyService = new HomeKitHistory(HomeKitAccessory, {});
    this.historyService.linkToEveHome(HomeKitAccessory, this.TemperatureService, {});

    this.updateHomeKit(HomeKitAccessory, deviceData);  // Do initial HomeKit update    
    console.log("Setup Nest Temperature Sensor '%s' on '%s'", thisServiceName, HomeKitAccessory.username);
}

TempSensorClass.prototype.updateHomeKit = function(HomeKitAccessory, deviceData) {
    if (typeof deviceData == "object" && this.updatingHomeKit == false)
    {
        if (this.TemperatureService != null && this.BatteryService != null) {
            this.TemperatureService.updateCharacteristic(Characteristic.StatusActive, deviceData.online == true ? true : false);  // If Nest isn't online, report in HomeKit

            // Update temperature
            this.TemperatureService.updateCharacteristic(Characteristic.CurrentTemperature, deviceData.current_temperature);
      
            // Update battery level
            var tempBatteryLevel = __scale(deviceData.battery_level, 0, 100, 0, 100);
            this.BatteryService.updateCharacteristic(Characteristic.BatteryLevel, tempBatteryLevel);
            this.BatteryService.updateCharacteristic(Characteristic.StatusLowBattery, tempBatteryLevel > LOWBATTERYLEVEL ? Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL : Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);

            // Log temperture to history only if changed to previous recording
            if ((this.historyService != null && typeof this.nestObject != "object") || (this.historyService != null && typeof this.nestObject.previousDevices[this.deviceID] == "object" && deviceData.current_temperature != this.nestObject.previousDevices[this.deviceID].current_temperature)) {
                this.historyService.addHistory(this.TemperatureService, {time: Math.floor(new Date() / 1000), temperature: deviceData.current_temperature});
            }
        }
    }
}


// Nest Protect
SmokeSensorClass.prototype.addSmokeCOSensor = function(HomeKitAccessory, thisServiceName, serviceNumber, deviceData) {
    // Add this smoke sensor & CO sensor to the "master" accessory and set properties   
    this.SmokeService = HomeKitAccessory.addService(Service.SmokeSensor, "Smoke", 1);
    this.SmokeService.addCharacteristic(Characteristic.StatusActive);

    this.COService = HomeKitAccessory.addService(Service.CarbonMonoxideSensor, "Carbon Monoxide", 1);
    this.COService.addCharacteristic(Characteristic.StatusActive);

    // Add battery service to display battery level
    this.BatteryService = HomeKitAccessory.addService(Service.BatteryService, "", 1);
    this.BatteryService.updateCharacteristic(Characteristic.ChargingState, Characteristic.ChargingState.NOT_CHARGEABLE); // dont charge as run off battery

    // Add motion sensor if supported (only on wired versions)
    if (deviceData.wired_or_battery == 0) {
        this.MotionService = HomeKitAccessory.addService(Service.MotionSensor, "Motion", 1);
        this.MotionService.addCharacteristic(Characteristic.StatusActive);
    }

    // Add light blub to represent "night light" if enabled
    if (deviceData.night_light_enable == true) {
        //this.LightService = HomeKitAccessory.addService(Service.Lightbulb, "Night Light", 1);
        //this.LightService.addCharacteristic(Characteristic.Brightness);
    }

    HomeKitAccessory.setPrimaryService(this.SmokeService);

    // Setup logging
    this.historyService = new HomeKitHistory(HomeKitAccessory, {});
    this.historyService.linkToEveHome(HomeKitAccessory, this.SmokeService, {GetCommand: this.__EveHomeGetCommand.bind(this),
                                                                              SetCommand: this.__EveHomeSetCommand.bind(this),
                                                                              EveSmoke_lastalarmtest: deviceData.latest_alarm_test,
                                                                              EveSmoke_alarmtest: deviceData.self_test_in_progress,
                                                                              EveSmoke_heatstatus: deviceData.heat_status,
                                                                              EveSmoke_hushedstate: deviceData.hushed_state,
                                                                              EveSmoke_statusled: deviceData.ntp_green_led,
                                                                              EveSmoke_smoketestpassed: deviceData.smoke_test_passed,
                                                                              EveSmoke_heattestpassed: deviceData.heat_test_passed
                                                                             });

    this.updateHomeKit(HomeKitAccessory, deviceData);  // Do initial HomeKit update
    console.log("Setup Nest Protect '%s' on '%s'", thisServiceName, HomeKitAccessory.username, (this.MotionService != null ? "with motion sensor" : ""));
}

SmokeSensorClass.prototype.updateHomeKit = function(HomeKitAccessory, deviceData) {
    if (typeof deviceData == 'object' && this.updatingHomeKit == false)
    {
        if (this.SmokeService != null && this.COService != null && this.BatteryService != null) {
            HomeKitAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, deviceData.software_version);
            this.SmokeService.updateCharacteristic(Characteristic.StatusActive, (deviceData.online == true && deviceData.removed_from_base == false) ? true : false);  // If Nest isn't online or removed from base, report in HomeKit
            this.SmokeService.updateCharacteristic(Characteristic.StatusFault, (Math.floor(new Date() / 1000) > deviceData.replacement_date) ? Characteristic.StatusFault.GENERAL_FAULT : Characteristic.StatusFault.NO_FAULT);  // General fault if replacement date past
            this.COService.updateCharacteristic(Characteristic.StatusActive, (deviceData.online == true && deviceData.removed_from_base == false) ? true : false);  // If Nest isn't online or removed from base, report in HomeKit
            this.COService.updateCharacteristic(Characteristic.StatusFault, (Math.floor(new Date() / 1000) > deviceData.replacement_date) ? Characteristic.StatusFault.GENERAL_FAULT : Characteristic.StatusFault.NO_FAULT);  // General fault if replacement date past
        
            if (this.MotionService != null) {
                // Motion detect if auto_away = false. Not supported on battery powered Nest Protects
                this.MotionService.updateCharacteristic(Characteristic.StatusActive, (deviceData.online == true && deviceData.removed_from_base == false) ? true : false);  // If Nest isn't online or removed from base, report in HomeKit
                this.MotionService.updateCharacteristic(Characteristic.MotionDetected, deviceData.away == false ? true : false);

                // Log motion to history only if changed to previous recording
                if ((this.historyService != null && typeof this.nestObject != "object") || (this.historyService != null && typeof this.nestObject.previousDevices[this.deviceID] == "object" && deviceData.away != this.nestObject.previousDevices[this.deviceID].away)) {
                    this.historyService.addHistory(this.MotionService, {time: Math.floor(new Date() / 1000), status: deviceData.away == false ? 1 : 0}); 
                }
            }

            // Update battery details
            var tempBatteryLevel = __scale(deviceData.battery_level, 0, 5400, 0, 100);
            this.BatteryService.updateCharacteristic(Characteristic.BatteryLevel, tempBatteryLevel);
            this.BatteryService.updateCharacteristic(Characteristic.StatusLowBattery, (tempBatteryLevel > LOWBATTERYLEVEL && deviceData.battery_health_state == 0 && ((deviceData.line_power_present == true && deviceData.wired_or_battery == 0) || (deviceData.line_power_present == false && deviceData.wired_or_battery == 1))) ? Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL : Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);
    
            // Update smoke and CO detected status 'ok': 0, 'warning': 1, 'emergency': 2
            this.SmokeService.updateCharacteristic(Characteristic.SmokeDetected, deviceData.smoke_status == 0 ? Characteristic.SmokeDetected.SMOKE_NOT_DETECTED : Characteristic.SmokeDetected.SMOKE_DETECTED);
            this.COService.updateCharacteristic(Characteristic.CarbonMonoxideDetected, deviceData.co_status == 0 ? Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL : Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL);

            // Notify Eve App of device status changes???
            this.historyService.updateEveHome(this.SmokeService, {GetCommand: this.__EveHomeGetCommand.bind(this)});
        }
        if (this.LightService != null) {
            // Update light status

            // TODO if possible
            //this.LightService.updateCharacteristic(Characteristic.On, false);    // light off
            //this.LightService.updateCharacteristic(Characteristic.Brightness, Math.round(deviceData.night_light_brightness * 33.33));    
        }
    }
}

SmokeSensorClass.prototype.__EveHomeGetCommand = function(data) {
    // Pass back extra data for Eve Smoke "get" process command
    if (this.nestObject.nestDevices && typeof this.nestObject.nestDevices[this.deviceID] == "object") {
        data.lastalarmtest = this.nestObject.nestDevices[this.deviceID].latest_alarm_test;
        data.alarmtest = this.nestObject.nestDevices[this.deviceID].self_test_in_progress;
        data.heatstatus = this.nestObject.nestDevices[this.deviceID].heat_status;
        data.statusled = this.nestObject.nestDevices[this.deviceID].ntp_green_led;
        data.smoketestpassed = this.nestObject.nestDevices[this.deviceID].smoke_test_passed;
        data.heattestpassed = this.nestObject.nestDevices[this.deviceID].heat_test_passed;
        data.hushedstate = this.nestObject.nestDevices[this.deviceID].hushed_state;
    }
    return data;
}

SmokeSensorClass.prototype.__EveHomeSetCommand = function(processed) {
    if (processed.hasOwnProperty("alarmtest")) {
        //console.log("Eve Smoke Alarm test", (processed.alarmtest == true ? "start" : "stop"));
    }
    if (processed.hasOwnProperty("statusled")) {
        this.nestObject.nestDevices[this.deviceID].ntp_green_led = processed.statusled;    // Do quick status update as setting nest values does take sometime
        this.nestObject.setNestStructure("topaz." + this.deviceStructure.split('.')[1], "ntp_green_led_enable", processed.statusled);
    }
}


// Nest Hello/Cam(s)
CameraClass.prototype.addDoorbellCamera = function(HomeKitAccessory, thisServiceName, serviceNumber, deviceData) {
    var options = {
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
                twoWayAudio: (deviceData.capabilities.includes("audio.speaker") && deviceData.capabilities.includes("audio.microphone")) ? true : false,    // If both speaker & microphone capabilities, then we support twoway audio
                codecs: [
                    {
                        type: "AAC-eld", // AudioStreamingCodecType.AAC_ELD
                        samplerate: 16, // AudioStreamingSamplerate.KHZ_16
                    },
                ], 
            },
        }
    };

    if (deviceData.capabilities.includes("detectors.on_camera")) {
        // We have a capability of motion sensing on camera/doorbell
        // Zone id of 0 is the main sensor zone on camera/doorbell
        var tempService = HomeKitAccessory.addService(Service.MotionSensor, "Motion", 0);
        tempService.updateCharacteristic(Characteristic.MotionDetected, false);     // No motion in creation
        this.MotionServices.push({"service": tempService, "id": 0})

        if (deviceData.HKSV == false) {
            // Setup any additional Motion service(s) for camera/doorbell as required if HKSV disabled
            deviceData.activity_zones && deviceData.activity_zones.forEach(zone => {
                if (zone.id != 0) {
                    var tempService = HomeKitAccessory.addService(Service.MotionSensor, zone.name, zone.id);
                    tempService.updateCharacteristic(Characteristic.MotionDetected, false); // No motion in creation
                    this.MotionServices.push({"service": tempService, "id": zone.id})
                }
            });
        }
    }

    if (deviceData.HKSV == true) {
        // Setup HomeKit secure video
        options.recording = {
            delegate: this, // Our class will also handle stream recording
            options: {
                audio : {
                    codecs: [
                        {
                            type: 1, // AudioRecordingCodecType.AAC_ELD
                            samplerate: 1, // AudioRecordingSamplerate.KHZ_16
                        },
                    ], 
                },
                mediaContainerConfiguration: [
                    {
                        fragmentLength: 4000,
                        type: 0x00  // FRAGMENTED_MP4
                    }
                ],

                prebufferLength: 4000,  // Seems to always be 4000???
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
                    parameters: {
                        profiles : [0, 1, 2], // H264Profile.HIGH = 0x02, as default profile in streamer is VIDEO_H264_2MBIT_L40
                        levels: [0, 1, 2], // H264Level.LEVEL4_0 = 0x02, as Default level in streamer is VIDEO_H264_2MBIT_L40
                    },
                    type: 0x00  // VideoCodecType.H264
                }
            }
        };

        if (deviceData.capabilities.includes("detectors.on_camera")) {
            options.sensors = {
                motion: this.MotionServices[0].service //motion service
            };
        }
    }

    // Setup HomeKit camera/doorbell controller
    this.controller = deviceData.device_type == "doorbell" ? new DoorbellController(options) : new CameraController(options);
    HomeKitAccessory.configureController(this.controller);

    if (deviceData.HKSV == true) {
        // extra setup for HSKV after created servies
        this.HKSVEvents = new EventEmitter.EventEmitter();
        deviceData.capabilities.includes("irled") && this.controller.recordingManagement.operatingModeService.addOptionalCharacteristic(Characteristic.NightVision);

        // Setup set callbacks for characteristics
        deviceData.capabilities.includes("irled") && this.controller.recordingManagement.operatingModeService.getCharacteristic(Characteristic.NightVision).on("set", (value, callback) => {
            var setValue = (value == true ? "auto_on" : "always_off");    
            if (setValue.toUpperCase() != this.nestObject.nestDevices[this.deviceID].properties["irled.state"].toUpperCase()) {
                // only change IRLed status value if different than on-device
                this.nestObject.setNestCamera(this.deviceID, "irled.state", setValue);
            }
            callback();
        });

        deviceData.capabilities.includes("audio.microphone") && this.controller.recordingManagement.recordingManagementService.getCharacteristic(Characteristic.RecordingAudioActive).on("set", (value, callback) => {
            var setValue = (value == Characteristic.RecordingAudioActive.ENABLE ? true : false)
            if (setValue != this.nestObject.nestDevices[this.deviceID].properties["audio.enabled"]) {
                // only change audio recording value if different than on-device
                this.nestObject.setNestCamera(this.deviceID, "audio.enabled", setValue);
            }
            callback();
        });
        
        this.controller.recordingManagement.operatingModeService.getCharacteristic(Characteristic.HomeKitCameraActive).on("set", (value, callback) => {
            var setValue = (value == Characteristic.HomeKitCameraActive.ON);
            if (this.nestObject.nestDevices[this.deviceID].properties['streaming.enabled'] != setValue) {
                // Camera state does not reflect HKSV requested state, so fix
                this.nestObject.setNestCamera(this.deviceID, "streaming.enabled", setValue)
            }
            if (setValue == false) {
                // Clear any inflight motion
                this.MotionServices[0].service.updateCharacteristic(Characteristic.MotionDetected, false);
            }
            callback();
        });
    }

    this.NexusStreamer = new NexusStreamer(this.nestObject.nestCookie, deviceData, this.nestObject.debug);  // Create streamer object

    this.updateHomeKit(HomeKitAccessory, deviceData);  // Do initial HomeKit update
    console.log("Setup %s '%s' on '%s'", HomeKitAccessory.displayName, thisServiceName, HomeKitAccessory.username, deviceData.HKSV == true ? "with HomeKit Secure Video" : this.MotionServices.length >= 1 ? "with motion sensor(s)" : "");
}

// Taken and adapted from https://github.com/hjdhjd/homebridge-unifi-protect/blob/eee6a4e379272b659baa6c19986d51f5bf2cbbbc/src/protect-ffmpeg-record.ts
CameraClass.prototype.handleRecordingStreamRequest = async function *(streamId) {
    if (this.MotionServices[0].service.getCharacteristic(Characteristic.MotionDetected).value == true) {
        // Should only be recording if motion detected. Seems sometimes when startup up, HAP or HomeKit triggers this even when motion isnt occuring

        var ffmpegCommand = "-hide_banner"
        + " -f h264"
        + " -use_wallclock_as_timestamps 1"
        + " -i pipe:0"
        + " -map 0:v"
        + " -codec:v h264_omx"    // Old Raspberry Pi hardware encoder/decoder
        //+ " -codec:v libx264"    // Old Raspberry Pi hardware encoder/decoder
        + " -pix_fmt yuv420p"
        + " -profile:v " + (this.HKSVRecordingConfig.videoCodec.parameters.profile == 0x02 ? "high" : this.HKSVRecordingConfig.videoCodec.parameters.profile == 0x02 ? "main" : "baseline")
        + " -level:v " + (this.HKSVRecordingConfig.videoCodec.parameters.level == 0x02 ? "4.0" : this.HKSVRecordingConfig.videoCodec.parameters.level == 0x01 ? "3.2": "3.1")
        + " -preset:v ultrafast"
        + " -tune zerolatency"
        + " -b:v " + this.HKSVRecordingConfig.videoCodec.parameters.bitRate + "k"
        + " -bufsize " + (2 * this.HKSVRecordingConfig.videoCodec.parameters.bitRate) + "k"
        + " -maxrate " + this.HKSVRecordingConfig.videoCodec.parameters.bitRate + "k"

        // Audio if enabled on doorbell/camera && audio recording configured for HKSV 
        if (this.nestObject.nestDevices[this.deviceID].audio_enabled == true && this.controller.recordingManagement.recordingManagementService.getCharacteristic(Characteristic.RecordingAudioActive).value == Characteristic.RecordingAudioActive.ENABLE) {
            // TODO
        }

        ffmpegCommand = ffmpegCommand 
        + " -force_key_frames expr:gte\(t,n_forced*" + this.HKSVRecordingConfig.videoCodec.parameters.iFrameInterval / 1000 + "\)"
        + " -r " + this.HKSVRecordingConfig.videoCodec.resolution[2].toString()
        + " -fflags +genpts+discardcorrupt+igndts"
        + " -reset_timestamps 1"
        + " -movflags frag_keyframe+empty_moov+default_base_moof"
        + " -f mp4"
        + " pipe:1";

        var isLastSegment = false;
        var header = Buffer.alloc(0);
        var bufferRemaining = Buffer.alloc(0);
        var dataLength = 0;
        var type = "";

        this.HKSVBuffer = [];
        this.HKSVffmpegRecorder = spawn("ffmpeg", ffmpegCommand.split(" "), { env: process.env });
        this.nestObject.debug && console.debug("[NEST] ffmpeg command is '%s'", ffmpegCommand);

        // Process FFmpeg output and parse out the fMP4 stream it's generating for HomeKit Secure Video.
        this.HKSVffmpegRecorder.stdout.on("data", function (datastream) {
            // If we have anything left from the last buffer we processed, prepend it to this buffer.
            if (bufferRemaining.length > 0) {
                datastream = Buffer.concat([bufferRemaining, datastream]);
                bufferRemaining = Buffer.alloc(0);
            }

            var offset = 0;
            for(;;) {
                var data;

                if (header.length == 0 && datastream.length >= 8) {
                    // need minimum size in datastream for header to be created
                    header = datastream.slice(0, 8);
                    dataLength = header.readUInt32BE(0) - 8;
                    type = header.slice(4).toString();
                    data = datastream.slice(8, dataLength + 8);
                    offset = 8;
                } else {
                    data = datastream.slice(0, dataLength);
                    offset = 0;
                }

                // If we don't have enough data in this buffer, save what we have for the next buffer we see and append it there.
                if (data.length < (dataLength - offset)) {
                    bufferRemaining = data;
                    break;
                }

                // Add it to our queue to be pushed out through the generator function.
                this.HKSVBuffer.push({ data: data, header: header, length: dataLength, type: type });
                this.HKSVEvents.emit("mp4box");

                // Prepare to start a new box for the next buffer that we will be processing.
                data = Buffer.alloc(0);
                header = Buffer.alloc(0);
                type = "";

                // We've parsed an entire box, and there's no more data in this buffer to parse.
                if (datastream.length === (offset + dataLength)) {
                    dataLength = 0;
                    break;
                }

                // If there's anything left in the buffer, move us to the new box and let's keep iterating.
                datastream = datastream.slice(offset + dataLength);
                dataLength = 0;
            }
        }.bind(this));

        this.HKSVffmpegRecorder.on("exit", function (code, signal) {
            if (signal != "SIGKILL") {
                this.nestObject.debug && console.debug("[NEST] HKSV ffmpeg recorder process exited", code, signal);
            }
        }.bind(this));

        this.HKSVffmpegRecorder.on("error", function (error) {
            this.nestObject.debug && console.debug("[NEST] HKSV ffmpeg recorder process error", error);
        }.bind(this));

        //this.HKSVffmpegRecorder.stderr.on("data", function (data) {
        //    this.nestObject.debug && console.debug(data.toString());
        //}.bind(this));

        this.NexusStreamer.startRecordStream("HKSV" + streamId, this.HKSVffmpegRecorder, this.HKSVffmpegRecorder.stdin, null);
        this.nestObject.debug && console.debug("[NEST] Started HKSV recording on '%s' with stream ID of '%s'", this.deviceID, streamId);

        try {
            for await (const mp4box of this.segmentGenerator()) {
                // We'll process segments while motion is still active
                var motionDetected = this.MotionServices[0].service.getCharacteristic(Characteristic.MotionDetected).value;
                isLastSegment = (motionDetected == false);
        
                yield {
                    data: mp4box,
                    isLast: isLastSegment,
                };

                if (isLastSegment == true) {
                    // Active motion ended, so end recording
                    return;
                }
            }
        } catch (error) {
            console.log("handleRecordingStreamRequest", error);
        }

        if (isLastSegment == false && this.HKSVffmpegRecorder != null) {
            // Seems we have haven't sent last segment notification to HKSV (likely some failure?), so do so now. Will still generate a HDS error in log
            yield { data: Buffer.alloc(0), isLast: true };
            return;
        }
    }
}

// Taken from https://github.com/hjdhjd/homebridge-unifi-protect/blob/eee6a4e379272b659baa6c19986d51f5bf2cbbbc/src/protect-ffmpeg-record.ts
CameraClass.prototype.segmentGenerator = async function *() {
    var segment = [];

    // Loop forever, generating either FTYP/MOOV box pairs or MOOF/MDAT box pairs for HomeKit Secure Video.
    for(;;) {
        if (this.HKSVffmpegRecorder == null) {
            // ffpmeg recorder process isnt running, so finish up
            return;
        }
        if (this.HKSVBuffer == null || this.HKSVBuffer.length == 0) {
            // since the ffmpeg recorder process hasn't notified us of any mp4 fragment boxes, so wait until there are some
            await EventEmitter.once(this.HKSVEvents, "mp4box", this.segmentGenerator);
        }

        var mp4box = this.HKSVBuffer && this.HKSVBuffer.shift();
        if (typeof mp4box != "object") {
            // Not an mp4 fragment box, so try again
            continue;
        }

        if (mp4box == null || mp4box.header == null) {
            console.log(mp4box);
        }

        // Queue up this fragment mp4 box to send back to HomeKit.
        segment.push(mp4box.header, mp4box.data);

        if (mp4box.type === "moov" || mp4box.type === "mdat") {
            yield Buffer.concat(segment);
            segment = [];
        }
    }
}

CameraClass.prototype.closeRecordingStream = function(streamId, reason) {
    var motionDetected = this.MotionServices[0].service.getCharacteristic(Characteristic.MotionDetected).value;
    if (motionDetected == true) {
        this.nestObject.debug && console.debug("[NEST] HKSV Motioned ended from closed stream");
        this.MotionServices[0].service.updateCharacteristic(Characteristic.MotionDetected, false);
        clearTimeout(this.motionTimer); // Clear any motion running timer
        this.motionTimer = null;   // No motion timer active
    }
    this.NexusStreamer && this.NexusStreamer.stopRecordStream("HKSV" + streamId);
    this.HKSVffmpegRecorder && this.HKSVffmpegRecorder.kill("SIGKILL");
    this.HKSVffmpegRecorder = null;
    this.HKSVEvents.emit("mp4box");
    this.HKSVEvents.removeListener("mp4box", this.segmentGenerator);  // Tidy up
    this.HKSVBuffer = null;
    this.nestObject.debug && console.debug("[NEST] Finished HKSV recording on stream '%s' with stream ID of '%s'", this.deviceID, streamId, reason);
}

CameraClass.prototype.acknowledgeStream = function(streamId) {
    this.closeRecordingStream(streamId, 0);  // HDSProtocolSpecificErrorReason.NORMAL
}

CameraClass.prototype.updateRecordingActive = function(active) {
    // We'll use the change here to determine if we start/stop any buffering
    if (active == true) {
        // Start a buffering stream for this camera/doorbell. Ensures motion captures all video on motion trigger
        // Required due to data delays by on prem Nest to cloud to HomeKit accessory to iCloud etc
        // Make sure have appropriate bandwidth!!!
        this.NexusStreamer.startBuffering(this.nestObject.nestDevices[this.deviceID].HKSVPreBuffer);
    }
    if (active == false) {
        this.NexusStreamer.stopBuffering();
    }
}

CameraClass.prototype.updateRecordingConfiguration = function(configuration) {
    this.HKSVRecordingConfig = configuration;   // Store the recording configuration 
    //this.HKSVRecordingConfig.prebufferLength);
}

CameraClass.prototype.handleSnapshotRequest = async function(request, callback) {
    // Get current image from doorbell/camera
    var image = Buffer.alloc(0);    // Empty buffer

    if (typeof this.nestObject.nestDevices[this.deviceID] == "object") {
        if (this.nestObject.nestDevices[this.deviceID].streaming_enabled == true && this.nestObject.nestDevices[this.deviceID].online == true) {
            // grab snapshot from doorbell/camera stream. If we have an current event, get the snapshot for that event for a non-HKSV camera
            if (this.nestObject.nestDevices[this.deviceID].HKSV == false && this.snapshotEvent.type != "" && this.snapshotEvent.done == false) {
                await axios.get(this.nestObject.nestDevices[this.deviceID].nexus_api_nest_domain_host + "/event_snapshot/" + this.nestObject.nestDevices[this.deviceID].camera_uuid + "/" + this.snapshotEvent.id + "?crop_type=timeline&width=" + request.width, {responseType: "arraybuffer", headers: {"user-agent": USERAGENT, "accept" : "*/*", "cookie": "website_2=" + this.nestObject.nestCookie}, timeout: NESTAPITIMEOUT, retry: 3 /*, retryDelay: 2000 */})
                .then(response => {
                    if (response.status == 200) {
                        image = response.data;
                        this.snapshotEvent.done = true;  // Successfully got the snapshot for the event
                    }
                })
                .catch(error => {
                    this.nestObject.debug && console.debug("[NEST] Failed to get event snapshot image. Error", error.message, error.config.url);
                });
            } else {
                    // Get current image from the doorbell/camera feed
                    await axios.get(this.nestObject.nestDevices[this.deviceID].nexus_api_http_server_url + "/get_image?width=" + request.width + "&uuid=" + this.nestObject.nestDevices[this.deviceID].camera_uuid, {responseType: "arraybuffer", headers: {"user-agent": USERAGENT, "accept" : "*/*", "cookie": "website_2=" + this.nestObject.nestCookie}, timeout: NESTAPITIMEOUT/*, retry: 3, retryDelay: 2000 */})
                    .then(response => {
                    if (response.status == 200) {
                        image = response.data;
                        this.cachedSnapshot = image;    // cache this image
                    }
                })
                .catch(error => {
                    this.debug && console.debug("[NEXUS] Failed to get current snapshot image. Error", error.message, error.config.url);
                });
            }
        }

        if (this.nestObject.nestDevices[this.deviceID].streaming_enabled == false && this.nestObject.nestDevices[this.deviceID].online == true) { 
            // Load "camera switched off" jpg, and return that to image buffer
            if (fs.existsSync(__dirname + "/Nest_cameraoff.jpg")) {
                image = fs.readFileSync(__dirname + "/Nest_cameraoff.jpg");
            }
        }

        if (this.nestObject.nestDevices[this.deviceID].online == false) {
            // load "camera offline" jpg, and return that to image buffer
            if (fs.existsSync(__dirname + "/Nest_offline.jpg")) {
                image = fs.readFileSync(__dirname + "/Nest_offline.jpg");
            }
        }
    }
    if (image.length == 0) {
         // catch all for an empty snapshot buffer
         image = this.cachedSnapshot; // use cached image.. could still be empty
    }
    callback(null, image);
}

CameraClass.prototype.prepareStream = async function(request, callback) {
    // Generate streaming session information
    var sessionInfo = {
        HomeKitSessionID: request.sessionID,  // Store session ID
        address: request.targetAddress,
        videoPort: request.video.port,
        localVideoPort: await getPort(),
        videoCryptoSuite: request.video.srtpCryptoSuite,
        videoSRTP: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
        videoSSRC: CameraController.generateSynchronisationSource(),

        audioPort: request.audio.port,
        localAudioPort: await getPort(),
        twoWayAudioPort: await getPort(),
        audioServerPort: await getPort(),
        audioCryptoSuite: request.video.srtpCryptoSuite,
        audioSRTP: Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]),
        audioSSRC: CameraController.generateSynchronisationSource(),

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

            this.ongoingStreams[request.sessionID] = this.NexusStreamer;    // Our streamer object

            this.ongoingStreams[request.sessionID].startLiveStream("HK" + request.sessionID, this.ongoingSessions[request.sessionID].ffmpegVideo.stdin, this.ongoingSessions[request.sessionID].ffmpegAudio.stdin,  this.ongoingSessions[request.sessionID].ffmpegAudioReturn.stdout);
            this.nestObject.debug && console.debug("[NEST] Started live stream on '%s'", this.deviceID);
            break;
        }

        case "stop" : {
            if (typeof this.ongoingStreams[request.sessionID] == "object") {
                this.ongoingStreams[request.sessionID].stopLiveStream("HK" + request.sessionID);
                delete this.ongoingStreams[request.sessionID];  // ongoing stream finished
                this.nestObject.debug && console.debug("[NEST] Stopped live stream on '%s'", this.deviceID);
            }
            if (typeof this.ongoingSessions[request.sessionID] == "object") {
                this.ongoingSessions[request.sessionID].rtpSplitter.close();
                this.ongoingSessions[request.sessionID].ffmpegVideo.kill("SIGKILL");
                this.ongoingSessions[request.sessionID].ffmpegAudio.kill("SIGKILL");
                this.ongoingSessions[request.sessionID].ffmpegAudioReturn.kill("SIGKILL");
                this.controller.forceStopStreamingSession(this.ongoingSessions[request.sessionID]);
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

CameraClass.prototype.updateHomeKit = function(HomeKitAccessory, deviceData) {
    if (typeof deviceData == "object" && this.updatingHomeKit == false)
    {
        HomeKitAccessory.getService(Service.AccessoryInformation).updateCharacteristic(Characteristic.FirmwareRevision, deviceData.software_version);   // Update firmware version
        this.controller.setSpeakerMuted(deviceData.audio_enabled == false ? true : false);    // if audio is disabled, we'll mute speaker

        // Update any camera details if we have a Nexus streamer object created
        this.NexusStreamer && this.NexusStreamer.update(this.nestObject.nestCookie, deviceData);

        // For non-HKSV enabled devices, we process activity zone changes
        if (deviceData.HKSV == false && (JSON.stringify(deviceData.activity_zones) != this.nestObject.nestDevices[this.deviceID].activity_zones)) {
            // Check to see if any activity zones were added
            deviceData.activity_zones.forEach(zone => {
                if (zone.id != 0) {
                    var index = this.MotionServices.findIndex( ({ id }) => id == zone.id);
                    if (index == -1) {
                        // Zone doesn't have an associated motion sensor, so add one
                        var tempService = HomeKitAccessory.addService(Service.MotionSensor, zone.name, zone.id);
                        this.MotionServices.push({"service": tempService, "id": zone.id})
                    } else {
                        // found an associated motion sensor for this zone, so update name
                        this.MotionServices[index].service.updateCharacteristic(Characteristic.Name, zone.name);
                    }
                }
            });

            // Check to see if any activity zones were removed
            this.MotionServices.forEach((motionService, index) => {
                if (motionService.id != 0) {
                    if (deviceData.activity_zones.findIndex( ({ id }) => id == motionService.id) == -1) {
                        // Motion service we created doesn't appear in zone list anymore, so assume deleted
                        HomeKitAccessory.removeService(motionService.service);
                        this.MotionServices.splice(index, 1);
                    }
                }
            });
        }

        // Process alerts, most recent first
        // For HKSV, we're interested in doorbell and motion events
        // For non-HKSV, we're interested in doorbell, face and person events (maybe sound and package later)
        deviceData.alerts.reverse().forEach(async event => {
            // Handle doorbell event, should always be handled first
            // We'll always process a doorbell press event regardless of Characteristic.HomeKitCameraActive state in HKSV
            if (typeof this.controller.doorbellService == "object" && event.types.includes("doorbell") == true) {
                if (this.doorbellTimer == null) {
                    this.nestObject.debug && console.debug("[NEST] Doorbell pressed on '%s'", this.deviceID);
                    
                    // Cooldown for doorbell button being pressed (filters out constant pressing for time period)
                    // Start this before we process further
                    this.doorbellTimer = setTimeout(function () {
                        this.snapshotEvent = {type: "", time: 0, id: 0, done: false}; // Clear snapshot event image after timeout
                        this.doorbellTimer = null;  // No doorbell timer active
                    }.bind(this), DOORBELLCOOLDOWN);

                    if (event.types.includes("motion") == false) {
                        // No motion event with the doorbell alert, so add one to support any HKSV recording
                        event.types.push("motion");
                    }

                    this.snapshotEvent = {type: "ring", time: event.playback_time, id : event.id, done: false}; // needed for a HKSV enabled doorbell???
                    this.controller.ringDoorbell(); // Finally "ring" doorbell
                }
            }

            // Handle motion event only for HKSV enabled camera. We will use this to trigger the starting of the HKSV recording
            // Motion is only activated if configured via Characteristic.HomeKitCameraActive == 1 (on)
            if (deviceData.HKSV == true && event.types.includes("motion") == true) {   
                if (this.controller.recordingManagement.operatingModeService.getCharacteristic(Characteristic.HomeKitCameraActive).value == Characteristic.HomeKitCameraActive.ON) {
                    if (this.MotionServices[0].service.getCharacteristic(Characteristic.MotionDetected).value != true) {
                        // Make sure if motion detected, the motion sensor is still active
                        this.nestObject.debug && console.debug("[NEST] Motion started on '%s'", this.deviceID);
                        this.MotionServices[0].service.updateCharacteristic(Characteristic.MotionDetected, true);    // Trigger motion
                    }

                    clearTimeout(this.motionTimer); // Clear any motion active timer so we can extend
                    this.motionTimer = setTimeout(function () {
                        this.nestObject.debug && console.debug("[NEST] Motion ended on '%s'", this.deviceID);
                        this.MotionServices[0].service.updateCharacteristic(Characteristic.MotionDetected, false);  // clear motion
                        this.motionTimer = null;   // No motion timer active
                    }.bind(this), MOTIONCOOLDOWN);
                }
            }

            // Handle person/face event for non HKSV enabled cameras and only those marked as important
            // We also treat a "face" event the same as a person event ie: if have a face, you have a person
            if (deviceData.HKSV == false && (event.types.includes("person") == true || event.types.includes("face")) == true) {
                if (event.is_important == true && this.doorbellTimer == null && this.personTimer == null) {
                    this.nestObject.debug && console.debug("[NEST] Person detected on '%s'", this.deviceID);

                    // Cooldown for person being detected
                    // Start this before we process further
                    this.personTimer = setTimeout(function () {
                        this.snapshotEvent = {type: "", time: 0, id: 0, done: false}; // Clear snapshot event image after timeout
                        this.MotionServices.forEach((motionService, index) => { 
                            motionService.service.updateCharacteristic(Characteristic.MotionDetected, false);  // clear any motion
                        });
                        this.personTimer = null;  // No person timer active
                    }.bind(this), PERSONCOOLDOWN);

                    // Check which zone triggered the person alert and update associated motion sensor(s)
                    this.snapshotEvent = {type: "person", time: event.playback_time, id : event.id, done: false};
                    event.zone_ids.forEach(zoneID => {
                        var index = this.MotionServices.findIndex( ({ id }) => id == zoneID);
                        if (index != -1) {
                            this.MotionServices[index].service.updateCharacteristic(Characteristic.MotionDetected, true);    // Trigger motion for matching zone
                        }
                    });
                }
            }

            // Handle package event for non HKSV enabled cameras
            // TODO
            if (deviceData.HKSV == false && event.types.includes("package") == true) {
            }

            // Handle motion event for non HKSV enabled cameras
            // TODO
            if (deviceData.HKSV == false && event.types.includes("motion") == true) { 
            }
            
            // Handle sound event for non HKSV enabled cameras
            // TODO
            if (deviceData.HKSV == false && event.types.includes("sound") == true) {
            }
        });
    }
}

CameraClass.prototype.__buildVideoStream = function(request, sessionInfo, callback) {
    // Build our ffmpeg command string for the video stream
    var ffmpegCommand = "-hide_banner"
        + " -f h264" 
        + " -use_wallclock_as_timestamps 1"
        + " -i pipe:0"
        + " -map 0:v"
        + " -codec:v copy"    // Appears since we have a H264 stream, shouldn't need to transcode, so just copy the stream. Otherwise use h264_omx/libx264
        + " -preset ultrafast"
        + " -tune zerolatency"
        + " -r " + request.fps
        + " -b:v " + request.max_bit_rate + "k"
        + " -bufsize " + (request.max_bit_rate * 2) + "k"
        + " -maxrate " + request.max_bit_rate + "k"
        + " -payload_type " + request.pt
        + " -ssrc " + sessionInfo.videoSSRC
        + " -f rtp"
        + " -srtp_out_suite AES_CM_128_HMAC_SHA1_80 -srtp_out_params " + sessionInfo.videoSRTP.toString("base64")
        + " srtp://" + sessionInfo.address + ":" + sessionInfo.videoPort + "?rtcpport=" + sessionInfo.videoPort + "&localrtcpport=" + sessionInfo.localVideoPort + "&pkt_size=" + request.mtu;

    var ffmpegStarted = false;
    var ffmpegVideo = spawn("ffmpeg", ffmpegCommand.split(" "), { env: process.env });

    ffmpegVideo.stderr.on("data", function (data) {
        // Ffmpeg outputs via stderr for its console output. 
        // We'll check for any output data that includes "frame", so we know ffmpeg is producing video output
        if (ffmpegStarted == false && data.toString().includes("frame=") == true) {
            ffmpegStarted = true;
            if (typeof callback == "function") callback();  // Notify HomeKit we've started video stream
        }
    }.bind(this));

    ffmpegVideo.on("error", function (error) {
        this.nestObject.debug && console.debug("[NEST] Failed to start Nest camera video stream", error.message);
        callback(new Error("ffmpeg process creation failed!"));
    }.bind(this));

    ffmpegVideo.on("exit", function (code, signal) {
        if (signal != "SIGKILL" || signal == null) {
            this.nestObject.debug && console.debug("[NEST] Video stream stopped", code, signal);
            if (ffmpegStarted == false) {
                callback(new Error("Streaming stopped"));
            }
            else {
                this.controller.forceStopStreamingSession(sessionInfo);
            }
        }
    }.bind(this));
    return ffmpegVideo;
}

CameraClass.prototype.__buildAudioStream = function(request, sessionInfo, callback) {
    var ffmpegAudio = null;
    var ffmpegAudioReturn = null;

    var ffmpegCommand = "-hide_banner"
        + " -c:a libfdk_aac"
        + " -i pipe:"
        + " -codec:a libfdk_aac"
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
        this.nestObject.debug && console.debug("[NEST] Failed to start Nest camera audio stream (microphone)", error.message);
        callback(new Error("ffmpeg process creation failed!"));
    }.bind(this));

    ffmpegAudio.on("exit", function (code, signal) {
    }.bind(this));

    ffmpegCommand = "-hide_banner"
        + " -protocol_whitelist pipe,udp,rtp,file,crypto"
        + " -f sdp"
        + " -codec:a libfdk_aac"
        + " -i pipe:0"
        + " -map 0:0"
        + " -c:a libspeex"
        + " -frames_per_packet 4"
        + " -ac 1"
        + " -ar 16k"
        + " -f data pipe:1";
    
    ffmpegAudioReturn = spawn("ffmpeg", ffmpegCommand.split(" "), { env: process.env });
    ffmpegAudioReturn.on("error", function (error) {
        this.nestObject.debug && console.debug("[NEST] Failed to start Nest camera audio stream (speaker)", error.message);
        callback(new Error("ffmpeg process creation failed!"));
    }.bind(this));

    ffmpegAudioReturn.on("exit", function (code, signal) {
    }.bind(this));

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
NestClass.prototype.initNestConnection = async function() {
    if (this.nestToken != "") {
        await Promise.all([
            axios.get("https://home.nest.com/session", {headers: {"user-agent": USERAGENT, "Authorization": "Basic " + this.nestToken} }),
            axios.post(CAMERAAPIHOST + "/api/v1/login.login_nest", Buffer.from("access_token=" + this.nestToken, "utf8"), {withCredentials: true, headers: {"referer": REFERER, "Content-Type": "application/x-www-form-urlencoded", "user-agent": USERAGENT} })
        ])
        .then(function (responses) {
            if (responses[0].status == 200) {
                this.nestToken = responses[0].data.access_token;
                this.nestURL = responses[0].data.urls.transport_url;
                this.nestID = responses[0].data.userid;
                this.tokenExpire = Math.floor(new Date(responses[0].data.expires_in) / 1000);

                // Set timer to refresh access token expiry time/date if we haven't started one yet
                if (this.tokenTimer == null) {
                    this.tokenTimer = setInterval(async function() {
                        this.initNestConnection();
                    }.bind(this), (3600 * 12 * 1000)); // Refresh every day
                }
            } else {
                this.debug && console.debug("[NEST] Failed to get access Nest API session. HTTP status returned", responses[0].status);
            }

            if (responses[1].status == 200 && responses[1].data && responses[1].data.status == 0) {
                this.nestCookie = responses[1].data.items[0].session_token;    // WEBSITE_2 cookie for camera API calls
            } else {
                this.debug && console.debug("[NEST] Failed to get WEBSITE_2 cookie for camera API calls. HTTP status returned", responses[1].status);
            }
        }.bind(this))
        .catch(error => {
            this.debug && console.debug("[NEST] Nest API access failed with error", error.message);
        });
    } else {
        this.debug && console.debug("[NEST] Empty access token in configuration file")
    }
}

NestClass.prototype.getNestData = async function() {
    if (this.nestToken != "" && this.nestURL != "" && this.nestID != "") {
        await axios.get(this.nestURL + "/v3/mobile/user." + this.nestID, {headers: {"content-type": "application/json", "user-agent": USERAGENT, "Authorization": "Basic " + this.nestToken}, data: ""})
        .then(async (response)=> {
            if (response.status == 200) {
                this.rawNestData = response.data;    // Used to generate subscribed versions/times
                response.data.quartz && await Promise.all(Object.entries(response.data.quartz).map(async ([deviceID, camera]) => {
                    // Fetch other details for any cameras we have, such as activity zones etc. We'll merge this into the Nest structure for processing
                    this.rawNestData.quartz[deviceID].activity_zones = [];  // no activity zones yet
                    this.rawNestData.quartz[deviceID].alerts = [];  // no active alerts yet
                    this.rawNestData.quartz[deviceID].properties = [];  // no properties yet
                    this.rawNestData.quartz[deviceID].nexus_api_nest_domain_host = camera.nexus_api_http_server_url.replace(/dropcam.com/ig, "camera.home.nest.com");  // avoid extra API call to get this detail by simple domain name replace
                    await axios.get(this.rawNestData.quartz[deviceID].nexus_api_nest_domain_host + "/cuepoint_category/" + deviceID, {headers: {"user-agent": USERAGENT, "cookie": "website_2=" + this.nestCookie} })
                    .then(async (response)=> {
                        if (response.status && response.status == 200) {
                            // Insert activity zones into the nest structure
                            response.data.forEach(zone => {
                                if (zone.type.toUpperCase() == "ACTIVITY" || zone.type.toUpperCase() == "REGION") {
                                    this.rawNestData.quartz[deviceID].activity_zones.push({"id": zone.id, "name": __makeValidHomeKitName(zone.label), "hidden": zone.hidden})
                                }
                            })
                        }
                    })
                    await axios.get(CAMERAAPIHOST + "/api/cameras.get_with_properties?uuid=" + deviceID, {headers: {"user-agent": USERAGENT, "Referer" : REFERER, "cookie": "website_2=" + this.nestCookie}, responseType: "json", timeout: NESTAPITIMEOUT})
                    .then((response) => {
                        if (response.status && response.status == 200) {
                            // Insert extra camera properties. We need this information to use with HomeKit Secure Video
                            this.rawNestData.quartz[deviceID].properties = response.data.items[0].properties;
                            //this.rawNestData.quartz[deviceID].nexus_api_nest_domain_host = response.data.items[0].nexus_api_nest_domain_host;
                        }
                    });
                }));
            }
            else {
                this.debug && console.debug("[NEST] Failed to get Nest data. HTTP status returned", response.status);
            }
        })
        .catch(error => {
            this.debug && console.debug("[NEST] Nest data get failed with error", error.message);
        });
    } else {
        this.debug && console.debug("[NEST] Empty access token or access URL or user ID when calling function");
    }
}

NestClass.prototype.setNestStructure = async function(nestStructure, key, value, targetChange) {
    var retValue = false;
    if (this.nestToken != "" && this.nestURL != "" && this.nestID != "") {
        await axios.post(this.nestURL + "/v2/put/" + nestStructure, JSON.stringify( { "target_change_pending": targetChange, [key]: value}), {headers: {"content-type": "application/json", "user-agent": USERAGENT, "Authorization": "Basic " + this.nestToken} })
        .then(response => {
            if (response.status == 200) {
                this.debug && console.debug("[NEST] Successfully set Nest structure element of '%s' to '%s' on '%s", key, value, nestStructure);
                retValue = true;    // successfully set Nest structure value
            } else {
                this.debug && console.debug("[NEST] Failed to set Nest structure element. HTTP status returned", response.status);
            }
        })
        .catch(error => {
            this.debug && console.debug("[NEST] Failed to set Nest structure element with error", error.message);
        });
    } else {
        this.debug && console.debug("[NEST] Empty access token or access URL or user ID when calling function");
    }
    return retValue;
}

NestClass.prototype.setNestCamera = async function(deviceID, key, value) {
    var retValue = false;
    if (this.nestToken != "" && this.nestURL != "" && this.nestID != "" && deviceID != "") {
        await axios.post(CAMERAAPIHOST + "/api/dropcams.set_properties", [key] + "=" + value + "&uuid=" + this.nestDevices[deviceID].camera_uuid, {headers: {"content-type": "application/x-www-form-urlencoded", "user-agent": USERAGENT, "Referer" : REFERER, "cookie": "website_2=" + this.nestCookie}, responseType: "json", timeout: NESTAPITIMEOUT})
        .then((response) => {
            if (response.status == 200 && response.data.status == 0) {
                this.debug && console.debug("[NEST] Successfully set Nest Camera element of '%s' to '%s' on '%s", key, value, deviceID);
                retValue = true;    // successfully set Nest camera value
            } else {
                this.debug && console.debug("[NEST] Failed to set Nest Camera element. HTTP status returned", response.status);
            }
        })
        .catch(error => {
            this.debug && console.debug("[NEST] Failed to set Nest Camera element with error", error.message);
        });
    }
    return retValue;
}

NestClass.prototype.deviceSubscribe = function(deviceID, HomeKitAccessory, callback, action) {
    if (deviceID != null) {
        if (action == "add") {
            if (typeof this.deviceEvents[deviceID] != "object") {
                this.deviceEvents[deviceID] = {};
                this.deviceEvents[deviceID].nestID = this.nestDevices[deviceID].nest_device_structure;
                this.deviceEvents[deviceID].accessory = HomeKitAccessory;
                this.deviceEvents[deviceID].callback = callback;
                this.addListener(deviceID, callback);   // Add lister for device updates

                if (this.nestDevices[deviceID].device_type == "doorbell" || this.nestDevices[deviceID].device_type == "camera") {
                    // since this device is also a doorbell/camera, startup the additional polling loop for activity zones and alerts changes
                    // This is done per doorbell/camera
                    // required for HKSV and non-HKSV enabled camera
                    this.__nestCameraPolling(deviceID, "alerts");   // for alerts
                    this.debug && console.debug("[NEST] Setup Nest Camera polling loop for alerts on '%s", HomeKitAccessory.username);

                    if (this.nestDevices[deviceID].HKSV == false) {
                        // for activity zone changes - only required for non-HKSV enabled camera
                        this.__nestCameraPolling(deviceID, "zones");
                        this.debug && console.debug("[NEST] Setup Nest Camera polling loop for zone changes on '%s", HomeKitAccessory.username);
                    }
                }
            }
            if (Object.keys(this.deviceEvents).length == 1) {
                 // Start main loop for Nest structure changes as this the first device subscription
                this.__nestAPISubscribe();
            } else {
                // Added another device, so cancel main loop for Nest structure changes. This will internally trigger a loop restart
                this.cancel && this.cancel("Subscription update loop cancelled");
            }
        }

        if (action == "remove") {
            if (typeof this.deviceEvents[deviceID] == "object") {
                this.removeListener(deviceID, this.deviceEvents[deviceID].callback);    // Remove lister for device updates
                delete this.deviceEvents[deviceID];
            }
            this.cancel && this.cancel("Subscription update loop cancelled");
        }
    }
}

NestClass.prototype.__makeValidHomeKitName = function(name) {
    // Strip invalid characters to conform to HomeKit naming requirements
    // Ensure only letters or numbers at beginning/end of string
    return name.replace(/[^A-Za-z0-9 ,.-]/g, "").replace(/^[^a-zA-Z0-9]*/g, "").replace(/[^a-zA-Z0-9]+$/g, "");
}

NestClass.prototype.__processNestData = function(nestData) {
    if (nestData && typeof nestData == "object") {
        this.previousDevices = this.nestDevices;
        if (typeof this.previousDevices != "object") {
            this.previousDevices = {};
        }
    
        // Process Nest structure and build our return structure for all devices we support (Thermostat, Temp Sensor, Protect, Cam(s))
        this.nestDevices = {};

        nestData.device && Object.entries(nestData.device).forEach(([deviceID, thermostat]) => {
            // process thermostats
            thermostat.serial_number = thermostat.serial_number.toUpperCase();  // ensure serial numbers are in upper case
            var tempMACAddress = thermostat.mac_address.toUpperCase();
            tempMACAddress = tempMACAddress.substring(0,2) + ":" + tempMACAddress.substring(2,4) + ":" + tempMACAddress.substring(4,6) + ":" + tempMACAddress.substring(6,8) + ":" + tempMACAddress.substring(8,10) + ":" + tempMACAddress.substring(10,12);
            if (this.excludedDevices.includes(thermostat.serial_number) == false) {
                // Device is not in excluded list, so include
                this.nestDevices[thermostat.serial_number] = {};
                this.nestDevices[thermostat.serial_number].device_type = "thermostat";  // nest thermostat
                this.nestDevices[thermostat.serial_number].nest_device_structure = "device." + deviceID;
                this.nestDevices[thermostat.serial_number].software_version = thermostat.current_version.replace(/-/g, "."); // fix software version for HomeKit
                this.nestDevices[thermostat.serial_number].mac_address = tempMACAddress;    // Our created MAC address
                this.nestDevices[thermostat.serial_number].current_humidity = thermostat.current_humidity;
                this.nestDevices[thermostat.serial_number].temperature_scale = thermostat.temperature_scale;
                this.nestDevices[thermostat.serial_number].battery_level = thermostat.battery_level;
                this.nestDevices[thermostat.serial_number].serial_number = thermostat.serial_number;
                this.nestDevices[thermostat.serial_number].removed_from_base = thermostat.nlclient_state.toUpperCase() == "BPD" ? true : false;
                this.nestDevices[thermostat.serial_number].online = nestData.track[thermostat.serial_number].online;
                this.nestDevices[thermostat.serial_number].has_fan = thermostat.has_fan;
                this.nestDevices[thermostat.serial_number].leaf = thermostat.leaf;
                this.nestDevices[thermostat.serial_number].can_cool = nestData.shared[thermostat.serial_number].can_cool;
                this.nestDevices[thermostat.serial_number].can_heat = nestData.shared[thermostat.serial_number].can_heat;
                this.nestDevices[thermostat.serial_number].description = nestData.shared[thermostat.serial_number].hasOwnProperty("name") ? __makeValidHomeKitName(nestData.shared[thermostat.serial_number].name) : "";
                this.nestDevices[thermostat.serial_number].target_temperature_type = nestData.shared[thermostat.serial_number].target_temperature_type;
                this.nestDevices[thermostat.serial_number].target_temperature = __adjustTemperature(nestData.shared[thermostat.serial_number].target_temperature, "C", "C");
                this.nestDevices[thermostat.serial_number].backplate_temperature = __adjustTemperature(thermostat.backplate_temperature, "C", "C");
                this.nestDevices[thermostat.serial_number].temperature_lock = thermostat.temperature_lock;
                this.nestDevices[thermostat.serial_number].temperature_lock_pin_hash = thermostat.temperature_lock_pin_hash;
                if (thermostat.eco.mode.toUpperCase() == "AUTO-ECO" || thermostat.eco.mode.toUpperCase() == "MANUAL-ECO") {
                    // thermostat is running in "eco" mode, we'll override the target temps to be that of eco mode ones
                    // also define a new hvac mode of "eco"
                    this.nestDevices[thermostat.serial_number].target_temperature_high = __adjustTemperature(thermostat.away_temperature_high, "C", "C");
                    this.nestDevices[thermostat.serial_number].target_temperature_low = __adjustTemperature(thermostat.away_temperature_low, "C", "C");
                    if (thermostat.away_temperature_high_enabled == true && thermostat.away_temperature_low_enabled == true) {
                        // eco range
                        this.nestDevices[thermostat.serial_number].hvac_mode = "eco";
                        this.nestDevices[thermostat.serial_number].target_temperature_type = "range"
                     }
                     if (thermostat.away_temperature_high_enabled == true && thermostat.away_temperature_low_enabled == false) {
                        // eco cool
                        this.nestDevices[thermostat.serial_number].hvac_mode = "eco";
                        this.nestDevices[thermostat.serial_number].target_temperature_type = "cool"
                        this.nestDevices[thermostat.serial_number].target_temperature = this.nestDevices[thermostat.serial_number].target_temperature_high;
                     }
                     if (thermostat.away_temperature_high_enabled == false && thermostat.away_temperature_low_enabled == true) {
                        // eco heat
                        this.nestDevices[thermostat.serial_number].hvac_mode = "eco";
                        this.nestDevices[thermostat.serial_number].target_temperature_type = "heat"
                        this.nestDevices[thermostat.serial_number].target_temperature = this.nestDevices[thermostat.serial_number].target_temperature_low;
                     }
                     if (thermostat.away_temperature_high_enabled == false && thermostat.away_temperature_low_enabled == false) {
                        // eco off or just off??
                        this.nestDevices[thermostat.serial_number].hvac_mode = "off";
                        this.nestDevices[thermostat.serial_number].target_temperature_type = "off"
                     }
                }
                else {
                    // Just a normal mode, ie: not eco type
                    this.nestDevices[thermostat.serial_number].target_temperature_high = __adjustTemperature(nestData.shared[thermostat.serial_number].target_temperature_high, "C", "C");
                    this.nestDevices[thermostat.serial_number].target_temperature_low = __adjustTemperature(nestData.shared[thermostat.serial_number].target_temperature_low, "C", "C");
                    this.nestDevices[thermostat.serial_number].hvac_mode = nestData.shared[thermostat.serial_number].target_temperature_type;
                }
            
                // Work out current state ie" heating, cooling etc
                if (nestData.shared[thermostat.serial_number].hvac_heater_state == true || nestData.shared[thermostat.serial_number].hvac_heat_x2_state == true || 
                    nestData.shared[thermostat.serial_number].hvac_heat_x3_state == true || nestData.shared[thermostat.serial_number].hvac_aux_heater_state == true || 
                    nestData.shared[thermostat.serial_number].hvac_alt_heat_x2_state == true || nestData.shared[thermostat.serial_number].hvac_emer_heat_state == true ||
                    nestData.shared[thermostat.serial_number].hvac_alt_heat_state == true) {
                    
                    // A heating source is on, so we're in heating mode
                    this.nestDevices[thermostat.serial_number].hvac_state = "heating";
                }
                if (nestData.shared[thermostat.serial_number].hvac_ac_state == true || nestData.shared[thermostat.serial_number].hvac_cool_x2_state == true || nestData.shared[thermostat.serial_number].hvac_cool_x3_state == true) {
                    
                    // A cooling source is on, so we're in cooling mode
                    this.nestDevices[thermostat.serial_number].hvac_state = "cooling";
                }
                if (nestData.shared[thermostat.serial_number].hvac_heater_state == false && nestData.shared[thermostat.serial_number].hvac_heat_x2_state == false && 
                    nestData.shared[thermostat.serial_number].hvac_heat_x3_state == false && nestData.shared[thermostat.serial_number].hvac_aux_heater_state == false && 
                    nestData.shared[thermostat.serial_number].hvac_alt_heat_x2_state == false && nestData.shared[thermostat.serial_number].hvac_emer_heat_state == false &&
                    nestData.shared[thermostat.serial_number].hvac_alt_heat_state == false && nestData.shared[thermostat.serial_number].hvac_ac_state == false &&
                    nestData.shared[thermostat.serial_number].hvac_cool_x2_state == false && nestData.shared[thermostat.serial_number].hvac_cool_x3_state == false) {
                    
                    // No heating or cooling sources are on, so we're in off mode
                    this.nestDevices[thermostat.serial_number].hvac_state = "off";
                }

                // Update fan status, on or off
                this.nestDevices[thermostat.serial_number].fan_duration = thermostat.fan_timer_duration;   // default runtime for fan
                this.nestDevices[thermostat.serial_number].fan_state = false;
                if (thermostat.fan_timer_timeout > 0 || nestData.shared[thermostat.serial_number].hvac_fan_state == true) this.nestDevices[thermostat.serial_number].fan_state = true;

                // Setup previous modes and states
                if (typeof this.previousDevices[thermostat.serial_number] != "object") {
                    this.previousDevices[thermostat.serial_number] = {};
                    this.previousDevices[thermostat.serial_number].hvac_mode = this.nestDevices[thermostat.serial_number].hvac_mode;
                    this.previousDevices[thermostat.serial_number].hvac_state = this.nestDevices[thermostat.serial_number].hvac_state;
                    this.previousDevices[thermostat.serial_number].fan_state = this.nestDevices[thermostat.serial_number].fan_state;
                    this.previousDevices[thermostat.serial_number].previous_hvac_mode = this.nestDevices[thermostat.serial_number].hvac_mode;
                    this.previousDevices[thermostat.serial_number].previous_hvac_state = this.nestDevices[thermostat.serial_number].hvac_state;
                    this.previousDevices[thermostat.serial_number].previous_fan_state = this.nestDevices[thermostat.serial_number].fan_state;
                    this.previousDevices[thermostat.serial_number].battery_level = 0;
                    this.nestDevices[thermostat.serial_number].previous_hvac_mode = this.nestDevices[thermostat.serial_number].hvac_mode;
                    this.nestDevices[thermostat.serial_number].previous_hvac_state = this.nestDevices[thermostat.serial_number].hvac_state;
                    this.nestDevices[thermostat.serial_number].previous_fan_state = this.nestDevices[thermostat.serial_number].fan_state;    
                }

                if (this.nestDevices[thermostat.serial_number].hvac_mode != this.previousDevices[thermostat.serial_number].hvac_mode) {
                    this.nestDevices[thermostat.serial_number].previous_hvac_mode = this.previousDevices[thermostat.serial_number].hvac_mode;
                } else {
                    this.nestDevices[thermostat.serial_number].previous_hvac_mode = this.nestDevices[thermostat.serial_number].hvac_mode;
                }
                if (this.nestDevices[thermostat.serial_number].hvac_state != this.previousDevices[thermostat.serial_number].hvac_state) {
                    this.nestDevices[thermostat.serial_number].previous_hvac_state = this.previousDevices[thermostat.serial_number].hvac_state;
                } else {
                    this.nestDevices[thermostat.serial_number].previous_hvac_state = this.nestDevices[thermostat.serial_number].hvac_state;
                }
                if (this.nestDevices[thermostat.serial_number].fan_state != this.previousDevices[thermostat.serial_number].fan_state) {
                    this.nestDevices[thermostat.serial_number].previous_fan_state = this.previousDevices[thermostat.serial_number].fan_state;
                } else {
                    this.nestDevices[thermostat.serial_number].previous_fan_state = this.nestDevices[thermostat.serial_number].fan_state;
                }

                // Get device location name
                this.nestDevices[thermostat.serial_number].location = "";
                nestData.where[nestData.link[thermostat.serial_number].structure.split('.')[1]].wheres.forEach(where => {
                    if (thermostat.where_id == where.where_id) {
                        this.nestDevices[thermostat.serial_number].location = __makeValidHomeKitName(where.name);
                    }
                });
                
                this.nestDevices[thermostat.serial_number].battery_charging_state = typeof this.previousDevices == "object" && thermostat.battery_level > this.previousDevices[thermostat.serial_number].battery_level && this.previousDevices[thermostat.serial_number].battery_level != 0 ? true : false;
                this.nestDevices[thermostat.serial_number].away = nestData.structure[nestData.link[thermostat.serial_number].structure.split('.')[1]].away;    // away status
                this.nestDevices[thermostat.serial_number].vacation_mode = nestData.structure[nestData.link[thermostat.serial_number].structure.split('.')[1]].vacation_mode;  // vacation mode
                this.nestDevices[thermostat.serial_number].home_name = __makeValidHomeKitName(nestData.structure[nestData.link[thermostat.serial_number].structure.split('.')[1]].name);  // Home name
                this.nestDevices[thermostat.serial_number].structureID = nestData.link[thermostat.serial_number].structure.split('.')[1]; // structure ID

                // Link in any temperature sensors, checking to ensure any aren't excluded
                this.nestDevices[thermostat.serial_number].active_rcs_sensor = "";
                this.nestDevices[thermostat.serial_number].active_temperature = thermostat.backplate_temperature;  // already adjusted temperature
                this.nestDevices[thermostat.serial_number].linked_rcs_sensors = [];
                nestData.rcs_settings[thermostat.serial_number].associated_rcs_sensors.forEach(sensor => {
                    var sensorInfo = nestData.kryptonite[sensor.split('.')[1]];
                    sensorInfo.serial_number = sensorInfo.serial_number.toUpperCase();
                    if (this.excludedDevices.includes(sensorInfo.serial_number) == false) {
                        // Associated temperature sensor isn't excluded
                        this.nestDevices[thermostat.serial_number].linked_rcs_sensors.push(sensorInfo.serial_number);

                        // Is this sensor the active one? If so, get some details about it
                        if (nestData.rcs_settings[thermostat.serial_number].active_rcs_sensors.length > 0 && sensorInfo.serial_number == nestData.kryptonite[nestData.rcs_settings[thermostat.serial_number].active_rcs_sensors[0].split('.')[1]].serial_number) {
                            this.nestDevices[thermostat.serial_number].active_rcs_sensor = nestData.kryptonite[nestData.rcs_settings[thermostat.serial_number].active_rcs_sensors[0].split('.')[1]].serial_number;
                            this.nestDevices[thermostat.serial_number].active_temperature =  __adjustTemperature(nestData.kryptonite[nestData.rcs_settings[thermostat.serial_number].active_rcs_sensors[0].split('.')[1]].current_temperature, "C", "C")
                        }
                    }
                });

                // Get associated schedules
                // TODO
                //nestData.schedule[thermostat.serial_number].

                // Insert any extra options we've read in from configuration file
                this.extraOptions[thermostat.serial_number] && Object.entries(this.extraOptions[thermostat.serial_number]).forEach(([key, value]) => {
                    this.nestDevices[thermostat.serial_number][key] = value;
                });
             }
        });

        nestData.kryptonite && Object.entries(nestData.kryptonite).forEach(([deviceID, sensor]) => {
            // Process temperature sensors
            sensor.serial_number = sensor.serial_number.toUpperCase();  // ensure serial numbers are in upper case
            var tempMACAddress = "18B430" + __crc24(sensor.serial_number).toUpperCase(); // Use a Nest Labs prefix for first 6 digits, followed by a CRC24 based off serial number for last 6 digits.
            tempMACAddress = tempMACAddress.substring(0,2) + ":" + tempMACAddress.substring(2,4) + ":" + tempMACAddress.substring(4,6) + ":" + tempMACAddress.substring(6,8) + ":" + tempMACAddress.substring(8,10) + ":" + tempMACAddress.substring(10,12);

            if (this.excludedDevices.includes(sensor.serial_number) == false) {
                // Device is not in excluded list, so include
                this.nestDevices[sensor.serial_number] = {}
                this.nestDevices[sensor.serial_number].device_type = "sensor";  // nest temperature sensor
                this.nestDevices[sensor.serial_number].nest_device_structure = "kryptonite." + deviceID;
                this.nestDevices[sensor.serial_number].serial_number = sensor.serial_number;
                this.nestDevices[sensor.serial_number].description = sensor.hasOwnProperty("description") ? __makeValidHomeKitName(sensor.description) : ""; 
                this.nestDevices[sensor.serial_number].mac_address = tempMACAddress;   // Our created MAC address
                this.nestDevices[sensor.serial_number].current_temperature = sensor.current_temperature;
                this.nestDevices[sensor.serial_number].battery_level = sensor.battery_level;
                this.nestDevices[sensor.serial_number].battery_charging_state = false; // on battery, so doesn't charge
                this.nestDevices[sensor.serial_number].software_version = "1.0";
                this.nestDevices[sensor.serial_number].current_temperature = __adjustTemperature(sensor.current_temperature, "C", "C");

                // Get device location name
                this.nestDevices[sensor.serial_number].location = "";
                nestData.where[sensor.structure_id].wheres.forEach(where => {
                    if (sensor.where_id == where.where_id) {
                        this.nestDevices[sensor.serial_number].location = __makeValidHomeKitName(where.name);
                    }
                });

                this.nestDevices[sensor.serial_number].online = (Math.floor(new Date() / 1000) - sensor.last_updated_at) < (3600 * 3) ? true : false;    // online status. allow upto 3hrs for reporting before report sensor offline
                this.nestDevices[sensor.serial_number].home_name = __makeValidHomeKitName(nestData.structure[sensor.structure_id].name);    // Home name
                this.nestDevices[sensor.serial_number].structureID = sensor.structure_id; // structure ID

                // Insert any extra options we've read in from configuration file for this device
                this.extraOptions[sensor.serial_number] && Object.entries(this.extraOptions[sensor.serial_number]).forEach(([key, value]) => {
                    this.nestDevices[sensor.serial_number][key] = value;
                });
            }
        });

        nestData.topaz && Object.entries(nestData.topaz).forEach(([deviceID, protect]) => {            
            // Process smoke detectors
            protect.serial_number = protect.serial_number.toUpperCase();  // ensure serial numbers are in upper case
            var tempMACAddress = protect.wifi_mac_address.toUpperCase();
            tempMACAddress = tempMACAddress.substring(0,2) + ":" + tempMACAddress.substring(2,4) + ":" + tempMACAddress.substring(4,6) + ":" + tempMACAddress.substring(6,8) + ":" + tempMACAddress.substring(8,10) + ":" + tempMACAddress.substring(10,12);
            if (this.excludedDevices.includes(protect.serial_number) == false) {
                // Device is not in excluded list, so include
                if (typeof this.previousDevices[protect.serial_number] != "object") {
                    this.previousDevices[protect.serial_number] = {};
                    this.previousDevices[protect.serial_number].battery_level = 0;
                }
   
                this.nestDevices[protect.serial_number] = {};
                this.nestDevices[protect.serial_number].device_type = "protect";  // nest protect
                this.nestDevices[protect.serial_number].nest_device_structure = "topaz." + deviceID;
                this.nestDevices[protect.serial_number].serial_number = protect.serial_number;
                this.nestDevices[protect.serial_number].line_power_present = protect.line_power_present;
                this.nestDevices[protect.serial_number].wired_or_battery = protect.wired_or_battery;
                this.nestDevices[protect.serial_number].battery_level = protect.battery_level;
                this.nestDevices[protect.serial_number].battery_health_state = protect.battery_health_state;
                this.nestDevices[protect.serial_number].smoke_status = protect.smoke_status;
                this.nestDevices[protect.serial_number].co_status = protect.co_status;
                this.nestDevices[protect.serial_number].heat_status = protect.heat_status;
                this.nestDevices[protect.serial_number].hushed_state = protect.hushed_state;
                this.nestDevices[protect.serial_number].ntp_green_led = protect.ntp_green_led_enable;
                this.nestDevices[protect.serial_number].ntp_green_led_brightness = protect.ntp_green_led_brightness;   // 1 = low, 2 = medium, 3 = high
                this.nestDevices[protect.serial_number].night_light_enable = protect.night_light_enable;
                this.nestDevices[protect.serial_number].night_light_brightness = protect.night_light_brightness;   // 1 = low, 2 = medium, 3 = high
                this.nestDevices[protect.serial_number].smoke_test_passed = protect.component_smoke_test_passed;
                this.nestDevices[protect.serial_number].heat_test_passed = protect.component_temp_test_passed; // Seems heat test component test is always false, so use temp test??
                this.nestDevices[protect.serial_number].replacement_date = protect.replace_by_date_utc_secs;
                this.nestDevices[protect.serial_number].co_previous_peak = protect.co_previous_peak;
                this.nestDevices[protect.serial_number].mac_address = tempMACAddress;  // Our created MAC address
                this.nestDevices[protect.serial_number].online = nestData.widget_track[protect.thread_mac_address.toUpperCase()].online;
                this.nestDevices[protect.serial_number].removed_from_base = protect.removed_from_base;
                this.nestDevices[protect.serial_number].latest_alarm_test = protect.latest_manual_test_end_utc_secs;
                this.nestDevices[protect.serial_number].self_test_in_progress = nestData.safety[protect.structure_id].manual_self_test_in_progress;
                this.nestDevices[protect.serial_number].description = protect.hasOwnProperty("description") ? __makeValidHomeKitName(protect.description) : "";
                this.nestDevices[protect.serial_number].software_version = protect.software_version.replace(/-/g, ".");    // fix software version for HomeKit
                this.nestDevices[protect.serial_number].ui_color_state = "grey";
                if (protect.battery_health_state == 0 && protect.co_status == 0 && protect.smoke_status == 0) this.nestDevices[protect.serial_number].ui_color_state = "green";
                if (protect.battery_health_state != 0 || protect.co_status == 1 || protect.smoke_status == 1) this.nestDevices[protect.serial_number].ui_color_state = "yellow";
                if (protect.co_status == 2 || protect.smoke_status == 2) this.nestDevices[protect.serial_number].ui_color_state = "red";
            
                // Get device location name
                this.nestDevices[protect.serial_number].location = "";
                nestData.where[protect.structure_id].wheres.forEach(where => {
                    if (protect.where_id == where.where_id) {
                        this.nestDevices[protect.serial_number].location = __makeValidHomeKitName(where.name);
                    }
                });
                this.nestDevices[protect.serial_number].battery_charging_state = false;    // batteries dont charge
                this.nestDevices[protect.serial_number].away = protect.auto_away;   // away status
                this.nestDevices[protect.serial_number].vacation_mode = nestData.structure[protect.structure_id].vacation_mode;  // vacation mode
                this.nestDevices[protect.serial_number].home_name = __makeValidHomeKitName(nestData.structure[protect.structure_id].name);  // Home name
                this.nestDevices[protect.serial_number].structureID = protect.structure_id; // structure ID

                // Insert any extra options we've read in from configuration file for this device
                this.extraOptions[protect.serial_number] && Object.entries(this.extraOptions[protect.serial_number]).forEach(([key, value]) => {
                    this.nestDevices[protect.serial_number][key] = value;
                });
            }
        });

        nestData.quartz && Object.entries(nestData.quartz).forEach(([deviceID, camera]) => {
            // Process cameras
            camera.serial_number = camera.serial_number.toUpperCase();  // ensure serial numbers are in upper case
            var tempMACAddress = camera.mac_address.toUpperCase();
            tempMACAddress = tempMACAddress.substring(0,2) + ":" + tempMACAddress.substring(2,4) + ":" + tempMACAddress.substring(4,6) + ":" + tempMACAddress.substring(6,8) + ":" + tempMACAddress.substring(8,10) + ":" + tempMACAddress.substring(10,12);
            if (this.excludedDevices.includes(camera.serial_number) == false) {
                // Device is not in excluded list, so include
                if (typeof this.previousDevices[camera.serial_number] != "object") {
                    this.previousDevices[camera.serial_number] = {};
                    this.previousDevices[camera.serial_number].alerts = [];
                    this.previousDevices[camera.serial_number].activity_zones = [];
                }
                
                this.nestDevices[camera.serial_number] = {};
                this.nestDevices[camera.serial_number].device_type = camera.camera_type == 12 ? "doorbell" : "camera";  // nest doorbell or camera
                this.nestDevices[camera.serial_number].nest_device_structure = "quartz." + deviceID;
                this.nestDevices[camera.serial_number].serial_number = camera.serial_number;
                this.nestDevices[camera.serial_number].software_version = camera.software_version.replace(/-/g, "."); // fix software version for HomeKit
                this.nestDevices[camera.serial_number].model = camera.model;   // Full model name ie "Nest Doorbell (wired)" etc
                this.nestDevices[camera.serial_number].mac_address = tempMACAddress;  // Our created MAC address;
                this.nestDevices[camera.serial_number].description = camera.hasOwnProperty("description") ? __makeValidHomeKitName(camera.description) : "";
                this.nestDevices[camera.serial_number].camera_uuid = deviceID;  // Can generate from .nest_device_structure anyway
                this.nestDevices[camera.serial_number].direct_nexustalk_host = camera.direct_nexustalk_host;
                this.nestDevices[camera.serial_number].websocket_nexustalk_host = camera.websocket_nexustalk_host;
                this.nestDevices[camera.serial_number].streaming_enabled = (camera.streaming_state.includes("enabled") ? true : false);
                this.nestDevices[camera.serial_number].nexus_api_http_server_url = camera.nexus_api_http_server_url;
                this.nestDevices[camera.serial_number].nexus_api_nest_domain_host = camera.nexus_api_http_server_url.replace(/dropcam.com/ig, "camera.home.nest.com");  // avoid extra API call to get this detail by simple domain name replace
                this.nestDevices[camera.serial_number].online = (camera.streaming_state.includes("offline") ? false : true);
                this.nestDevices[camera.serial_number].audio_enabled = camera.audio_input_enabled;
                this.nestDevices[camera.serial_number].capabilities = camera.capabilities;
                this.nestDevices[camera.serial_number].properties = camera.properties;  // structure elements we added
                this.nestDevices[camera.serial_number].activity_zones = camera.activity_zones; // structure elements we added
                this.nestDevices[camera.serial_number].alerts = camera.alerts; // structure elements we added

                // Get device location name
                this.nestDevices[camera.serial_number].location = "";
                nestData.where[camera.structure_id].wheres.forEach(where => {
                    if (camera.where_id == where.where_id) {
                        this.nestDevices[camera.serial_number].location = __makeValidHomeKitName(where.name);
                    }
                });
                this.nestDevices[camera.serial_number].away = nestData.structure[camera.structure_id].away;    // away status
                this.nestDevices[camera.serial_number].vacation_mode = nestData.structure[camera.structure_id].vacation_mode;  // vacation mode
                this.nestDevices[camera.serial_number].home_name = __makeValidHomeKitName(nestData.structure[camera.structure_id].name);  // Home name
                this.nestDevices[camera.serial_number].structureID = camera.structure_id; // structure ID

                // Insert any extra options we've read in from configuration file for this device
                this.nestDevices[camera.serial_number].HKSV = this.HomeKitSecureVideo;    // By default, we use the global config option for HomeKit Secure Video. Can override for each camera etc
                this.extraOptions[camera.serial_number] && Object.entries(this.extraOptions[camera.serial_number]).forEach(([key, value]) => {
                    this.nestDevices[camera.serial_number][key] = value;
                });
            }
        });
    }
}

NestClass.prototype.__nestCameraPolling = function(deviceID, action) {
    if (action == "alerts" && typeof this.nestDevices[deviceID] == "object") {
        // Get any alerts generated in the last 30 seconds
        axios.get(this.nestDevices[deviceID].nexus_api_nest_domain_host + "/cuepoint/" + this.nestDevices[deviceID].camera_uuid + "/2?start_time=" + Math.floor((Date.now() / 1000) - 30), {headers: {"user-agent": USERAGENT, "Referer" : REFERER, "cookie": "website_2=" + this.nestCookie}, responseType: "json", timeout: 1000, retry: 3, retryDelay: 1000})
        .then((response) => {
            if (response.status == 200) {
                // Filter out any alert which occured before we started this accessory
                response.data = response.data.filter(alert => (Math.floor(alert.start_time / 1000) >= this.startTime));

                // Fix up alert zone id's
                // Appears if no Nest Aware subscription, the zone_id in the associated alert is left blank
                // We'll assign the alert zone id to '0' ie: main zone in this case
                response.data.forEach(alert => {
                    if (alert.zone_ids.length == 0) {
                        alert.zone_ids = [0];   // Default zone ID ie: main zone
                    }
                });
    
                // Insert alerts into the nest structure
                this.rawNestData.quartz[this.nestDevices[deviceID].camera_uuid].alerts = response.data;

                // Process updated device data for this doorbell/camera
                this.previousDevices[deviceID].alerts = this.nestDevices[deviceID].alerts;
                this.nestDevices[deviceID].alerts = this.rawNestData.quartz[this.nestDevices[deviceID].camera_uuid].alerts;
                
                if (JSON.stringify(this.nestDevices[deviceID].alerts) != JSON.stringify(this.previousDevices[deviceID].alerts)) {
                    // Activity alerts have changed for this doorbell/camera, so notify HomeKit accessory of our updated Nest device data if have an event listener
                    this.deviceEvents[deviceID] && this.emit(deviceID, this.deviceEvents[deviceID].accessory, this.nestDevices[deviceID]);
                }
            }
        })
        .catch(error => {
            this.debug && console.debug("[NEST] Error getting alerts for '%s'", deviceID, error.message)
        })
        .finally(() => {
            // Poll again for alerts after configured delay
            setTimeout(this.__nestCameraPolling.bind(this), CAMERAALERTPOLLING, deviceID, "alerts");
        });
    }

    if (action == "zones" && typeof this.nestDevices[deviceID] == "object" && this.nestDevices[deviceID].HKSV == false) {
        // Get current activity zones for non-HSKV enabled camera
        axios.get(this.nestDevices[deviceID].nexus_api_nest_domain_host + "/cuepoint_category/" + this.nestDevices[deviceID].camera_uuid, {headers: {"user-agent": USERAGENT, "Referer" : REFERER, "cookie": "website_2=" + this.nestCookie}, responseType: "json", timeout: CAMERAZONEPOLLING})
        .then((response) => {
            if (response.status == 200) {
                // Insert activity zones into the nest structure we've read before
                this.rawNestData.quartz[this.nestDevices[deviceID].camera_uuid].activity_zones = [];
                response.data.forEach(zone => {
                    if (zone.hidden == false && (zone.type.toUpperCase() == "ACTIVITY" || zone.type.toUpperCase() == "REGION")) {
                        this.rawNestData.quartz[this.nestDevices[deviceID].camera_uuid].activity_zones.push({"id": zone.id, "name": __makeValidHomeKitName(zone.label)})
                    }
                });

                // Process updated device data for this doorbell/camera
                this.previousDevices[deviceID].activity_zones = this.nestDevices[deviceID].activity_zones;
                this.nestDevices[deviceID].activity_zones = this.rawNestData.quartz[this.nestDevices[deviceID].camera_uuid].activity_zones;
                    
                if (JSON.stringify(this.nestDevices[deviceID].activity_zones) != JSON.stringify(this.previousDevices[deviceID].activity_zones)) {
                    // Activity zones have changed for this doorbell/camera, so notify HomeKit accessory of our updated Nest device data if have an event listener
                    this.deviceEvents[deviceID] && this.emit(deviceID, this.deviceEvents[deviceID].accessory, this.nestDevices[deviceID]);
                }
            }
        })
        .catch(error => {
            this.debug && console.debug("[NEST] Error getting zone details for '%s'", deviceID, error.message)
        })
        .finally(() => {
            // Poll for activity zone changes again after configured delay
            setTimeout(this.__nestCameraPolling.bind(this), CAMERAZONEPOLLING, deviceID, "zones");
        });
    }
}

NestClass.prototype.__nestAPISubscribe = async function() {
    // Build object for subscription, based upon subscribed device types
    var subscribe = {objects: []};
    var subscribeAgainTimeout = 500;    // 500ms default before we subscribe again

    this.nestDevices && Object.entries(this.nestDevices).forEach(([deviceID]) => {
        var mainKey = this.nestDevices[deviceID].nest_device_structure.split('.')[0];
        var subKey = this.nestDevices[deviceID].nest_device_structure.split('.')[1];
        var structure = this.nestDevices[deviceID].structureID;
        if (this.nestDevices[deviceID].device_type == "thermostat") {
            // for thermostats, we need to subscribe to device, shared, track, link, rcs_settings, schedule
            subscribe.objects.push({"object_key" : "device." + subKey, "object_revision" : this.rawNestData["device"][subKey]["$version"], "object_timestamp": this.rawNestData["device"][subKey]["$timestamp"]});
            subscribe.objects.push({"object_key" : "shared." + subKey, "object_revision" : this.rawNestData["shared"][subKey]["$version"], "object_timestamp": this.rawNestData["shared"][subKey]["$timestamp"]});
            subscribe.objects.push({"object_key" : "track." + subKey, "object_revision" : this.rawNestData["track"][subKey]["$version"], "object_timestamp": this.rawNestData["track"][subKey]["$timestamp"]});
            subscribe.objects.push({"object_key" : "link." + subKey, "object_revision" : this.rawNestData["link"][subKey]["$version"], "object_timestamp": this.rawNestData["link"][subKey]["$timestamp"]});
            subscribe.objects.push({"object_key" : "rcs_settings." + subKey, "object_revision" : this.rawNestData["rcs_settings"][subKey]["$version"], "object_timestamp": this.rawNestData["rcs_settings"][subKey]["$timestamp"]});
            subscribe.objects.push({"object_key" : "schedule." + subKey, "object_revision" : this.rawNestData["schedule"][subKey]["$version"], "object_timestamp": this.rawNestData["schedule"][subKey]["$timestamp"]});
        }
        if (this.nestDevices[deviceID].device_type == "sensor") {
            // for temperature sensors, we need to subscribe to kryptonite
            subscribe.objects.push({"object_key" : "kryptonite." + subKey, "object_revision" : this.rawNestData["kryptonite"][subKey]["$version"], "object_timestamp": this.rawNestData["kryptonite"][subKey]["$timestamp"]});
        }
        if (this.nestDevices[deviceID].device_type == "protect") {
            // for protects, we need to subscribe to topaz, widget_track
            subscribe.objects.push({"object_key" : "topaz." + subKey, "object_revision" : this.rawNestData["topaz"][subKey]["$version"], "object_timestamp": this.rawNestData["topaz"][subKey]["$timestamp"]});
            subscribe.objects.push({"object_key" : "widget_track." + subKey, "object_revision" : this.rawNestData["widget_track"][subKey]["$version"], "object_timestamp": this.rawNestData["widget_track"][subKey]["$timestamp"]});
        }
        if (this.nestDevices[deviceID].device_type == "doorbell" || this.nestDevices[deviceID].device_type == "camera") {
            // for doorbells/cameras, we need to subscribe to quartz
            subscribe.objects.push({"object_key" : "quartz." + subKey, "object_revision" : this.rawNestData["quartz"][subKey]["$version"], "object_timestamp": this.rawNestData["quartz"][subKey]["$timestamp"]});
        }

        // Always subscribe to structure and where elements if we havent already included these
        if (subscribe.objects.findIndex( ({ object_key }) => object_key === "structure." + structure) == -1 ) subscribe.objects.push({"object_key" : "structure." + structure, "object_revision" : this.rawNestData["structure"][structure]["$version"], "object_timestamp": this.rawNestData["structure"][structure]["$timestamp"]});
        if (subscribe.objects.findIndex( ({ object_key }) => object_key === "where." + structure) == -1 ) subscribe.objects.push({"object_key" : "where." + structure, "object_revision" : this.rawNestData["where"][structure]["$version"], "object_timestamp": this.rawNestData["where"][structure]["$timestamp"]});
    });

    // Do subscription for the data we need from the Nest structure.. Timeout after 2mins if no data received, and if timed-out, rinse and repeat :-) 
    var tempDeviceList = [];
    axios({
        method: "post",
        url: this.nestURL + "/v6/subscribe",
        data: JSON.stringify(subscribe), 
        headers: {"user-agent": USERAGENT, "Authorization": "Basic " + this.nestToken}, 
        responseType: "json", 
        timeout: 120000, // 2 minutes
        cancelToken: new axios.CancelToken(c => { this.cancel = c; })
    })
    .then(async (response) => {
        if (response.status && response.status == 200) {
            // Got subscribed update, so merge and process them
            response.data.objects && await Promise.all(response.data.objects.map(async (updatedData) => {
                var mainKey = updatedData.object_key.split('.')[0];
                var subKey = updatedData.object_key.split('.')[1];
        
                // See if we have a structure change and the "swarm" property list has changed, seems to indicated a new or removed device(s)
                if (mainKey == "structure" && updatedData.value.swarm && this.rawNestData[mainKey][subKey].swarm.toString() !== updatedData.value.swarm.toString()) {
                    var oldDeviceList = this.rawNestData[mainKey][subKey].swarm.toString().split(',').map(String);
                    var newDeviceList = updatedData.value.swarm.toString().split(',').map(String);
                    for (var index in oldDeviceList) {
                        if (!newDeviceList.includes(oldDeviceList[index])) {
                            tempDeviceList.push({"nestID": oldDeviceList[index], "action" : "remove"});    // Removed device
                        }
                    }
                    for (index in newDeviceList) {
                        if (!oldDeviceList.includes(newDeviceList[index])) {
                            tempDeviceList.push({"nestID": newDeviceList[index], "action" : "add"});    // Added device
                        }
                    }
                    tempDeviceList = tempDeviceList.sort((a, b) => a - b);  // filter out duplicates
                } else {                  
                    // Update internal saved Nest structure for the changed key/value pairs
                    for (const [fieldKey, fieldValue] of Object.entries(updatedData.value)) {
                        this.rawNestData[mainKey][subKey][fieldKey] = fieldValue;
                    }
                    this.rawNestData[mainKey][subKey]["$version"] = updatedData.object_revision; // Updated version of object. needed for future subscription calls
                    this.rawNestData[mainKey][subKey]["$timestamp"] = updatedData.object_timestamp;  // Updated timestam of object. needed for future subscription calls

                    // Get extra camera properties if quartz change. We use this information with HomeKit Secure Video
                    if (mainKey == "quartz") {
                        await axios.get(CAMERAAPIHOST + "/api/cameras.get_with_properties?uuid=" + subKey, {headers: {"user-agent": USERAGENT, "Referer" : REFERER, "cookie": "website_2=" + this.nestCookie}, responseType: "json", timeout: NESTAPITIMEOUT})
                        .then((response) => {
                            if (response.status && response.status == 200) {
                                this.rawNestData[mainKey][subKey].properties = response.data.items[0].properties;
                            }
                        });
                    }
                }
            }));
            
            if (tempDeviceList.length > 0) {
                // Change in devices via an addition or removal, so get current Nest structure data before we process any device changes
                await this.getNestData();
            }
            this.__processNestData(this.rawNestData);
           
            // Process any updates for devices which aren't in the add/remove list
            this.nestDevices && Object.entries(this.nestDevices).forEach(([deviceID, deviceData]) => {
                if (tempDeviceList.findIndex( ({ nestID }) => nestID === this.deviceEvents[deviceID].nestID) == -1) {
                    if (typeof this.previousDevices[deviceID] == "object" && (JSON.stringify(deviceData) != JSON.stringify(this.previousDevices[deviceID]))) {
                        // data has changed, so notify HomeKit accessory of our updated Nest device data if have an event listener
                        this.deviceEvents[deviceID] && this.emit(deviceID, this.deviceEvents[deviceID].accessory, deviceData);
                    }
                }
            });

            // Process any device additions/removals 
            tempDeviceList.forEach(device => {
                if (device.action == "add") {
                    this.nestDevices && Object.entries(this.nestDevices).forEach(([deviceID, device]) => {
                        if (device.nest_device_structure == nestDevice.nestID) {
                            this.emit(NESTSTRUCTURECHANGE, this, device, "add");    // new device, so process addition to HomeKit
                        }
                    });
                }
                if (device.action == "remove") {
                    this.previousDevices && Object.entries(this.previousDevices).forEach(([deviceID, device]) => {
                        if (device.nest_device_structure == nestDevice.nestID) {
                            this.emit(NESTSTRUCTURECHANGE, this, device, "remove");   // device has been removed
                        }
                    });
                }
            });
        }
        else {
            this.debug && console.debug("[NEST] Nest subscription failed. HTTP status returned", response.status);
        }
    })
    .catch(async (error) => {
        if (axios.isCancel(error) == false && error.code !== 'ECONNABORTED') {
            if (error.response && error.response.status == 404) {
                // Subscription failed with a 404 error "not found", so this could indicate device(s) have change. we'll check here also
                await this.getNestData();  // get current data
                this.__processNestData(this.rawNestData);   // and process it

                // compare current vs previous devices to see if things have been added and/or removed
                var oldDeviceList = Object.entries(this.previousDevices).toString().split(',').map(String);
                var newDeviceList = Object.entries(this.nestDevices).toString().split(',').map(String);
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

                // Process any device additions/removals 
                tempDeviceList.forEach(device => {
                    if (device.action == "add") {
                        this.nestDevices && Object.entries(this.nestDevices).forEach(([deviceID, device]) => {
                            if (device.serial_number == nestDevice.nestID) {
                                this.emit(NESTSTRUCTURECHANGE, this, device, "add");    // new device, so process addition to HomeKit
                            }
                        });
                    }
                    if (device.action == "remove") {
                        this.previousDevices && Object.entries(this.previousDevices).forEach(([deviceID, device]) => {
                            if (device.serial_number == nestDevice.nestID) {
                                this.emit(NESTSTRUCTURECHANGE, this, device, "remove");   // device has been removed
                            }
                        });
                    }
                });
            } else if (error.response && error.response.status == 400) {
                // bad subscribe
                subscribeAgainTimeout = 5000;   // Since bad subscribe, try again after 5 seconds
                this.debug && console.debug("[NEST] Nest subscription failed. Bad subscription data");
            } else if (error.response && error.response.status == 502) {
                // gateway error
                subscribeAgainTimeout = 10000;  // Since bad gateway error, try again after 10 seconds
                this.debug && console.debug("[NEST] Nest subscription failed. Bad gateway");
            } else {
                // Other unknown error  
                subscribeAgainTimeout = 5000;   // Try again afer 5 seconds
                this.debug && console.debug("[NEST] Nest subscription failed with error", error.message);
            }
        }
    })
    .finally(() => {
        // subscribe again after delay :-)
        setTimeout(this.__nestAPISubscribe.bind(this), subscribeAgainTimeout);
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
    // Scales a number between range 1, to range 2
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

function __makeValidHomeKitName(name) {
    // Strip invalid characters to conform to HomeKit requirements
    // Ensure only letters or numbers at beginning/end of string
    return name.replace(/[^A-Za-z0-9 ,.-]/g, "").replace(/^[^a-zA-Z0-9]*/g, "").replace(/[^a-zA-Z0-9]+$/g, "");
}

async function __setDaikinAC(daikinURL, daikinPwr, daikinMode, daikinTemp, daikinHumid, daikinFanSpeed, daikinFanMode, debug) {
    await axios.get(daikinURL + "/aircon/set_control_info?pow=" + daikinPwr + "&mode=" + daikinMode + "&stemp=" + daikinTemp + "&shum=" + daikinHumid + "&f_rate=" + daikinFanSpeed + "&f_dir=" + daikinFanMode)
    .then(response => {
        if (response.status == 200) {
            debug && console.debug("[NEST] Sucessfully set DaikinAC with Pwr: '%s' Mode: '%s' Temp: '%s' Fan Mode: '%s' Fan Speed: '%s'", daikinPwr, daikinMode, daikinTemp, daikinFanMode, daikinFanSpeed);
        } else {
            debug && console.debug("[NEST] Failed to set DaikinAC. HTTP status returned", response.status);
        }
    })
    .catch(error => {
        debug && console.debug("[NEST] setDaikinAC failed", error.message);
    });
}

async function getPort(options) {
    return new Promise((resolve, reject) => {
        var server = net.createServer();
        server.unref();
        server.on("error", reject);
        server.listen(options, () => {
            var port = server.address().port;
            server.close(() => {
                resolve(port);  // return port
            });
        });
    });
}

function processDeviceforHomeKit(nestObjectClass, deviceData, action) {
    if (action == "add" && typeof deviceData == "object") {
        // adding device into HomeKit
        // Generate some common things
        var tempName = (deviceData.description == "" ? deviceData.location : deviceData.location + " - " + deviceData.description);    // Need to generate valid HomeKit name
        var tempModel = "";

        switch (deviceData.device_type) {
            case "thermostat" : {
                // Nest Thermostat
                tempModel = "Thermostat";
                if (deviceData.serial_number.substring(0,2) == "15") tempModel = tempModel + " E";  // Nest Thermostat E
                if (deviceData.serial_number.substring(0,2) == "09") tempModel = tempModel + " 3rd Generation";  // Nest Thermostat 3rd Gen
                if (deviceData.serial_number.substring(0,2) == "02") tempModel = tempModel + " 2nd Generation";  // Nest Thermostat 2nd Gen
                if (deviceData.serial_number.substring(0,2) == "01") tempModel = tempModel + " 1st Generation";  // Nest Thermostat 1st Gen

                // Create accessory for each discovered nest
                var tempAccessory = exports.accessory = new Accessory("Nest Thermostat", uuid.generate("hap-nodejs:accessories:nest_" + deviceData.serial_number));
                tempAccessory.username = deviceData.mac_address;
                tempAccessory.pincode = AccessoryPincode;
                tempAccessory.category = Accessory.Categories.THERMOSTAT;  // Thermostat type accessory
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, "Nest");
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Model, tempModel);
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.SerialNumber, deviceData.serial_number);
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, deviceData.software_version);
            
                tempAccessory.__thisObject = new ThermostatClass(); // Store the object
                tempAccessory.__thisObject.deviceID = deviceData.serial_number;
                tempAccessory.__thisObject.deviceStructure = deviceData.nest_device_structure;
                tempAccessory.__thisObject.nestObject = nestObjectClass;
                tempAccessory.__thisObject.addThermostat(tempAccessory, tempName, 1, deviceData); 

                accessories.push(tempAccessory);   // Push onto export array for HAP-NodeJS "accessory factory"
                tempAccessory.publish({username: tempAccessory.username, pincode: tempAccessory.pincode, category: tempAccessory.category, advertiser: "ciao"});    // Publish accessory on local network
                nestObjectClass.deviceSubscribe(tempAccessory.__thisObject.deviceID, tempAccessory, tempAccessory.__thisObject.updateHomeKit.bind(tempAccessory.__thisObject), "add");
                break;
            }

            case "sensor" : {
                // Nest Temperature Sensor
                tempModel = "Temperature Sensor";
                //if (deviceData.serial_number.substring(0,2) == "22") tempModel = tempModel + " 1st Generation";  // Nest Temperature Sensor 1st Gen

                var tempAccessory = exports.accessory = new Accessory("Nest Temperature Sensor", uuid.generate("hap-nodejs:accessories:nest_" + deviceData.serial_number));
                tempAccessory.username = deviceData.mac_address;
                tempAccessory.pincode = AccessoryPincode;
                tempAccessory.category = Accessory.Categories.SENSOR;  // Sensor type accessory
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, "Nest");
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Model, tempModel);
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.SerialNumber, deviceData.serial_number);
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, deviceData.software_version);

                tempAccessory.__thisObject = new TempSensorClass(); // Store the object
                tempAccessory.__thisObject.deviceID = deviceData.serial_number;
                tempAccessory.__thisObject.deviceStructure = deviceData.nest_device_structure;
                tempAccessory.__thisObject.nestObject = nestObjectClass;
                tempAccessory.__thisObject.addTemperatureSensor(tempAccessory, tempName, 1, deviceData); 

                accessories.push(tempAccessory);   // Push onto export array for HAP-NodeJS "accessory factory"
                tempAccessory.publish({username: tempAccessory.username, pincode: tempAccessory.pincode, category: tempAccessory.category, advertiser: "ciao"});    // Publish accessory on local network
                nestObjectClass.deviceSubscribe(tempAccessory.__thisObject.deviceID, tempAccessory, tempAccessory.__thisObject.updateHomeKit.bind(tempAccessory.__thisObject), "add");
                break;
            }

            case "protect" : {
                // Nest Protect
                tempModel = "Protect";
                if (deviceData.serial_number.substring(0,2) == "06") tempModel = tempModel + " 2nd Generation";  // Nest Protect 2nd Gen
                if (deviceData.serial_number.substring(0,2) == "05") tempModel = tempModel + " 1st Generation";  // Nest Protect 1st Gen
                if (deviceData.wired_or_battery == 0) tempModel = tempModel + " (wired)";    // Mains powered
                if (deviceData.wired_or_battery == 1) tempModel = tempModel + " (battery)";    // Battery powered

                var tempAccessory = exports.accessory = new Accessory("Nest Protect", uuid.generate("hap-nodejs:accessories:nest_" + deviceData.serial_number));
                tempAccessory.username = deviceData.mac_address;
                tempAccessory.pincode = AccessoryPincode;
                tempAccessory.category = Accessory.Categories.SENSOR;  // Sensor type accessory
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, "Nest");
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Model, tempModel);
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.SerialNumber, deviceData.serial_number);
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, deviceData.software_version);

                tempAccessory.__thisObject = new SmokeSensorClass(); // Store the object
                tempAccessory.__thisObject.deviceID = deviceData.serial_number;
                tempAccessory.__thisObject.deviceStructure = deviceData.nest_device_structure;
                tempAccessory.__thisObject.nestObject = nestObjectClass;
                tempAccessory.__thisObject.addSmokeCOSensor(tempAccessory, tempName, 1, deviceData); 

                accessories.push(tempAccessory);   // Push onto export array for HAP-NodeJS "accessory factory"
                tempAccessory.publish({username: tempAccessory.username, pincode: tempAccessory.pincode, category: tempAccessory.category, advertiser: "ciao"}); // Publish accessory on local network
                nestObjectClass.deviceSubscribe(tempAccessory.__thisObject.deviceID, tempAccessory, tempAccessory.__thisObject.updateHomeKit.bind(tempAccessory.__thisObject), "add");
                break;
            }

            case "camera" : 
            case "doorbell" : {
                // Nest Hello and Nest Cam(s)
                // Basically the same 
                tempModel = "";
                if (deviceData.serial_number.substring(0,2) == "19") tempModel = "Hello";    // Nest Hello/Doorbell (wired) 1st generation, type 12
                if (deviceData.serial_number.substring(0,2) == "xx") tempModel = "Cam Indoor";
                if (deviceData.serial_number.substring(0,2) == "14") tempModel = "Cam IQ Indoor";
                if (deviceData.serial_number.substring(0,2) == "18") tempModel = "Cam Outdoor";    // Type 9
                if (deviceData.serial_number.substring(0,2) == "17") tempModel = "Cam IQ Outdoor";

                var tempAccessory = exports.accessory = new Accessory("Nest " + tempModel, uuid.generate("hap-nodejs:accessories:nest_" + deviceData.serial_number));
                tempAccessory.username = deviceData.mac_address;
                tempAccessory.pincode = AccessoryPincode;
                tempAccessory.category = deviceData.device_type == "doorbell" ? Accessory.Categories.VIDEO_DOORBELL : Accessory.Categories.IP_CAMERA;
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, "Nest");
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Model, tempModel);
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.SerialNumber, deviceData.serial_number);
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, deviceData.software_version);

                tempAccessory.__thisObject = new CameraClass(); // Store the object
                tempAccessory.__thisObject.deviceID = deviceData.serial_number;
                tempAccessory.__thisObject.deviceStructure = deviceData.nest_device_structure;
                tempAccessory.__thisObject.nestObject = nestObjectClass;
                tempAccessory.__thisObject.addDoorbellCamera(tempAccessory, tempName, 1, deviceData);

                accessories.push(tempAccessory);   // Push onto export array for HAP-NodeJS "accessory factory"
                tempAccessory.publish({username: tempAccessory.username, pincode: tempAccessory.pincode, category: tempAccessory.category, advertiser: "ciao"}); // Publish accessory on local network
                nestObjectClass.deviceSubscribe(tempAccessory.__thisObject.deviceID, tempAccessory, tempAccessory.__thisObject.updateHomeKit.bind(tempAccessory.__thisObject), "add");
                break;
            }
        }
    }

    if (action == "remove" && typeof deviceData == "object") {
        // Removing device from HomeKit.. not sure want todo this yet... :-)
        nestObjectClass.deviceSubscribe(deviceData.serial_number, null, null, "remove"); // Remove any active subscription for this device

        // find our accessory, then unpublish it and remove from HAP-NodeJS "accessory factory"
        var accessoryIndex = accessories.findIndex(({username}) => username === deviceData.mac_address);
        if (accessoryIndex != -1 && accessories[accessoryIndex] && accessories[accessoryIndex].__thisObject.deviceID == deviceData.serial_number) {
            console.log("Removed Nest Device '%s' on '%s'", accessories[accessoryIndex].displayName, accessories[accessoryIndex].username);
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
if (nest.nestToken != "") {
    nest.initNestConnection()   // Initiate connection to Nest APIs
    .then(() => {
        nest.getNestData()
        .then(() => {
            // Process any discovered Nest devices into HomeKit
            nest.__processNestData(nest.rawNestData);
            nest.nestDevices && Object.entries(nest.nestDevices).forEach(([deviceID, deviceData]) => {
                processDeviceforHomeKit(nest, deviceData, "add");    
            })

            nest.addListener(NESTSTRUCTURECHANGE, processDeviceforHomeKit); // Notifications for any device additions/removals in Nest structure
        })
    })
} else {
    console.log("No or invalid access token was specified in configuration");
}