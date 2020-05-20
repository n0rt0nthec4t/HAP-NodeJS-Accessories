// HAP-Nodejs Nest devices in HomeKit
//
// Supported:
// -- Nest Thermostat, includes custom integration of hydronic system for heating and daikin A/C (wifi controlled) for cooling centrally controlled from Nest
// -- Nest Temperature Sensors
// -- Nest Protect
//
// Daikin A/C control https://github.com/ael-code/daikin-control
// Nest "unoffical API" https://www.wiredprairie.us/blog/index.php/archives/1754
// Unofficial Nest Learning Thermostat API https://github.com/gboudreau/nest-api
//
// todo
// -- 2FA due to Nest changes end of May 2020??
// -- add Nest home name to pairing names (for easier for mutiple homes)??
// -- Nest Hello (doorbell?)
// -- Nest Thermostat
//      -- Fan service - dynamic add/remove also
//      -- Correctly display F temps if selected. HomeKit bug??
//      -- Switching between range (low/high) to heat or cool, update correct target temp. Maybe need to get from nest ??
//
// -- Nest Temperature Sensor
//      -- Generate CRC-24 for "fake" device mac address using Nest Labs prefix
//
// -- Nest Protect
//      -- Add replacement date as custom HomeKit characteristic??
//      -- CO levels
//
// done
// -- periodically refresh Nest token expiry time
// -- history recording - testing of own solution
// -- dymanically removed/add accessories when added/removed from Nest app
// -- fully convert to axios library
// -- subscribe to events rather than polling every 30secs
// -- recoded device getting from Nest
// -- ground work for subscribe updates
// -- Nest Thermostat
//      -- Migrated from NestThermostat_accfactory (v4) coding
//      -- re-coded to use un-offical API due to Nest shutting down REST APIs 31/8/2019
//      -- Get MAC of thermostat automactially
//      -- Get serial number automatically
//      -- Set model type automatically 
//      -- Battery Level
//      -- Occupancy sensor for home/away status
//      -- Fixed software version number reporting
//      -- Use Characteristic.StatusActive for online status
//      -- Nest temperature sensors, including using sensor temp on thermostat if selected
//      -- Switching bewteen C and F adjust temperature steps - 0.5 for C /1.0 for F
//      -- Battery charging state
//
// -- Nest Temperature Sensor
//      -- Online status for Nest Temperature sensors
//      -- HomeKit status fault if no data for upto 1hr
//
// -- Nest Protect
//      -- Battery charging state
//      -- LED ring colour in internal stucture
//
// bugs
// -- Sarting Jan 2020, google has enabled reCAPTCHA for Nest Accounts. Modfied code to no longer use user/name password login, but access token
//    Access token can be view by logging in to https//home.nest.com on webbrowser then in going to https://home.nest.com/session  Seems access token expires every 30days
//    so needs manually updating (havent seen it expire yet.....)
//
// Version 13/5/2020
// Mark Hulskamp

module.exports = accessories = [];

var Accessory = require("../").Accessory; 
var Service = require("../").Service;
var Characteristic = require("../").Characteristic;
var uuid = require("../").uuid;
var axios = require("axios");
var HomeKitHistory = require("./HomeKitHistory");

// Defines for the accessory
const AccessoryName =  "NEST";
const AccessoryPincode = "031-45-154";
const NestAccessToken = "<<<<<<insert nest token here>>>>>";
const nestUserAgent = "Nest/5.0.0.23 (iOScom.nestlabs.jasper.release) os=11.0";
const nestPutURL = "/v2/put";
const nestSubscribeURL = "/v5/subscribe";
const nest2FAURL = "/api/0.1/2fa/verify_pin";
const DaikinIP = "10.0.1.106";                  // IP for Daikin A/C system for cooling mode

function NestClass() {
    this.__nestToken = null;                    // Access token for requests
    this.__nestURL = null;                      // URL for nest requests
    this.__nestID = null;                       // User ID
    this.__tokenExpire = null;                  // Time when token expires (in Unix timestamp)
    this.__lastNestData = {};                   // Full copy of nest data
    this.__previousNestData = {};
    this.__currentNestData = {};
    this.__subscribed = [];                     // array of subscribed callbacks for each device
    this.__cancel = null;
}

// Create the thermostat object
function ThermostatClass() {
    this.__ThermostatService = null;            // HomeKit service for this thermostat
    this.__BatteryService = null;               // Status of Nest battery
    this.__OccupancyService = null;             // Status of Away/Home
    this.__FanService = null;                   // Fan service
    this.__nestObject = null;
    this.__nestCanHeat = null;
    this.__nestCanCool = null;
    this.__nestHasFan = null;
    this.__nestDeviceID = null;                 // Nest device ID for this thermostat
    this.__updatingHomeKit = false;             // Flag if were doing an HomeKit or not
    this.__DaikinActive = false;                // Track if we've turned hteh AC on or off
    this.historyService = null;                 // History logging service
}

// Create the sensor object
function TempSensorClass() {
    this.__TemperatureService = null;           // HomeKit service for this temperature sensor
    this.__BatteryService = null;               // Status of Nest Temperature Sensor Battery
    this.__nestDeviceID = null;                 // Nest device ID for this Temperature Sensor
    this.__updatingHomeKit = false;             // Flag if were doing an HomeKit or not
    this.historyService = null;                 // History logging service
}

// Create the sensor object
function SmokeSensorClass() {
    this.__SmokeService = null;                 // HomeKit service for this smoke sensor
    this.__COService = null;                    // HomeKit service for this CO sensor
    this.__BatteryService = null;               // Status of Nest Protect Sensor Battery
    this.__MotionService = null;                // Status of Nest Protect motion sensor
    this.__nestDeviceID = null;                 // Nest device ID for this Protect Sensor
    this.__updatingHomeKit = false;             // Flag if were doing an HomeKit or not
}


// Nest Thermostat
ThermostatClass.prototype.addThermostat = function(HomeKitAccessory, thisServiceName, serviceNumber, thisNestDevice) {
    // Add this thermostat to the "master" accessory and set properties
    this.__ThermostatService = HomeKitAccessory.addService(Service.Thermostat, thisServiceName, serviceNumber);
    this.__ThermostatService.addCharacteristic(Characteristic.CurrentRelativeHumidity);
    this.__ThermostatService.addCharacteristic(Characteristic.StatusActive);

    // Add battery service to display battery level
    this.__BatteryService = HomeKitAccessory.addService(Service.BatteryService, "", serviceNumber);
    this.__ThermostatService.addLinkedService(this.__BatteryService);

    // Add home/away status as an occupancy sensor
    this.__OccupancyService = HomeKitAccessory.addService(Service.OccupancySensor, thisServiceName + " Occupancy Sensor", serviceNumber);
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
    
    // Set default ranges - based on celsuis ranges
    this.__ThermostatService.setCharacteristic(Characteristic.TemperatureDisplayUnits, Characteristic.TemperatureDisplayUnits.CELSIUS);
    this.__ThermostatService.getCharacteristic(Characteristic.CurrentTemperature).setProps({minStep: 0.5});
    this.__ThermostatService.getCharacteristic(Characteristic.TargetTemperature).setProps({minStep: 0.5}, {minValue: 9}, {maxValue: 32});
    this.__ThermostatService.getCharacteristic(Characteristic.CoolingThresholdTemperature).setProps({minStep: 0.5}, {minValue: 9}, {maxValue: 32});
    this.__ThermostatService.getCharacteristic(Characteristic.HeatingThresholdTemperature).setProps({minStep: 0.5}, {minValue: 9}, {maxValue: 32});

    // Setup set callbacks for characteristics
    this.__ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).on('set', this.setDisplayUnits.bind(this));
    this.__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).on('set', this.setMode.bind(this));
    this.__ThermostatService.getCharacteristic(Characteristic.TargetTemperature).on('set', (value, callback) => {this.setTemperature(Characteristic.TargetTemperature, value, callback)});
    this.__ThermostatService.getCharacteristic(Characteristic.CoolingThresholdTemperature).on('set', (value, callback) => {this.setTemperature(Characteristic.CoolingThresholdTemperature, value, callback)});
    this.__ThermostatService.getCharacteristic(Characteristic.HeatingThresholdTemperature).on('set', (value, callback) => {this.setTemperature(Characteristic.HeatingThresholdTemperature, value, callback)});

    // Setup logging
    this.historyService = new HomeKitHistory(HomeKitAccessory, {});
    this.historyService.linkToEveHome(HomeKitAccessory, this.__ThermostatService);

    this.updateHomeKit(HomeKitAccessory, thisNestDevice);  // Do initial HomeKit update
    console.log("Setup Nest Thermostat '%s' on '%s'", thisServiceName, HomeKitAccessory.username);
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
    if (typeof callback === 'function') callback();  // do callback if defined
    
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
            
            if (this.__nestObject.__previousNestData != null && this.__nestObject.__currentNestData != null && this.__nestObject.__previousNestData.target_temperature_type == "range" && (tempMode == "heat" || tempMode == "cool")) {
                // If switching from range to heat/cool, update HomeKit using previous target temp
                this.__ThermostatService.getCharacteristic(Characteristic.TargetTemperature).updateValue(this.__nestObject.__currentNestData.target_temperature);
            }
        }
    }
    if (typeof callback === 'function') callback();  // do callback if defined

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
    if (typeof callback === 'function') callback();  // do callback if defined

    this.__updatingHomeKit = false;
}

ThermostatClass.prototype.updateHomeKit = function(HomeKitAccessory, thisNestDevice) {
    var historyEntry = {};

    if (typeof thisNestDevice == 'object' && this.__updatingHomeKit == false)
    {
        if (this.__ThermostatService != null && this.__BatteryService != null && this.__OccupancyService != null) {
            HomeKitAccessory.getService(Service.AccessoryInformation).getCharacteristic(Characteristic.FirmwareRevision).updateValue(thisNestDevice.software_version);   // Update firmware version
            this.__ThermostatService.getCharacteristic(Characteristic.CurrentRelativeHumidity).updateValue(thisNestDevice.current_humidity);
            this.__ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).updateValue(thisNestDevice.temperature_scale.toUpperCase() == "C" ? Characteristic.TemperatureDisplayUnits.CELSIUS : Characteristic.TemperatureDisplayUnits.FAHRENHEIT);
            this.__ThermostatService.getCharacteristic(Characteristic.CurrentTemperature).updateValue(thisNestDevice.active_temperature);
            this.__ThermostatService.getCharacteristic(Characteristic.StatusActive).updateValue(thisNestDevice.online == true ? true : false);  // If Nest isnt online, report in HomeKits

            // Update HomeKit steps and ranges for temperatures
            this.__ThermostatService.getCharacteristic(Characteristic.CurrentTemperature).setProps({minStep: (this.__ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 0.5 : 1)});
            this.__ThermostatService.getCharacteristic(Characteristic.TargetTemperature).setProps({minStep: (this.__ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 0.5 : 1)}, {minValue: (this.__ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 9 : 48)}, {maxValue: (this.__ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 32 : 90)});
            this.__ThermostatService.getCharacteristic(Characteristic.CoolingThresholdTemperature).setProps({minStep: (this.__ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 0.5 : 1)}, {minValue: (this.__ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 9 : 48)}, {maxValue: (this.__ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 32 : 90)});
            this.__ThermostatService.getCharacteristic(Characteristic.HeatingThresholdTemperature).setProps({minStep: (this.__ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 0.5 : 1)}, {minValue: (this.__ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 9 : 48)}, {maxValue: (this.__ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 32 : 90)});
    
            // Battery status if defined, below 3.6v battery is low
            var tempBatteryLevel = __scale(thisNestDevice.battery_level, 3.3, 3.95, 0, 100);
            this.__BatteryService.getCharacteristic(Characteristic.BatteryLevel).updateValue(tempBatteryLevel);
            this.__BatteryService.getCharacteristic(Characteristic.StatusLowBattery).updateValue(tempBatteryLevel > 3.6 ? Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL : Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);
            this.__BatteryService.getCharacteristic(Characteristic.ChargingState).updateValue(thisNestDevice.battery_charging_state == true ? Characteristic.ChargingState.CHARGING : Characteristic.ChargingState.NOT_CHARGING);
    
            // Update for away/home status. Away = no occupancy detected, Home = Occupancy Detected
            this.__OccupancyService.getCharacteristic(Characteristic.OccupancyDetected).updateValue(thisNestDevice.away == true ? Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED : Characteristic.OccupancyDetected.OCCUPANCY_DETECTED);
            this.__OccupancyService.getCharacteristic(Characteristic.StatusActive).updateValue(thisNestDevice.online == true ? true : false);  // If Nest isnt online, report in HomeKit

            this.__ThermostatService.getCharacteristic(Characteristic.TargetTemperature).updateValue(thisNestDevice.target_temperature);
            this.__ThermostatService.getCharacteristic(Characteristic.HeatingThresholdTemperature).updateValue(thisNestDevice.target_temperature_low);
            this.__ThermostatService.getCharacteristic(Characteristic.CoolingThresholdTemperature).updateValue(thisNestDevice.target_temperature_high);

            if (this.__nestHasFan != thisNestDevice.has_fan) {
                // fan setup has changed on thermostat

                if (this.__nestHasFan == false && thisNestDevice.has_fan == true) {
                    // A fan has been added
                    // TODO
                }
                if (this.__nestHasFan == true && thisNestDevice.has_fan == false) {
                    // A fan has been removed
                    // TODO
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
                } else if (thisNestDevice.can_cool == true && thisNestDevice.can_heat == false) {
                    // Can cool only
                    this.__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.COOL]});
                } else if (thisNestDevice.can_cool == true && thisNestDevice.can_heat == true) {
                    // heat and cool 
                    this.__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.HEAT, Characteristic.TargetHeatingCoolingState.COOL, Characteristic.TargetHeatingCoolingState.AUTO]});
                } else if (thisNestDevice.can_cool == false && thisNestDevice.can_heat == false) {
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
                historyEntry.target = {low: hisNestDevice.target_temperature, high: 0};    // single target temperature for heating limit
            }
            if (thisNestDevice.hvac_mode.toUpperCase() == "RANGE") {
                this.__ThermostatService.getCharacteristic(Characteristic.HeatingThresholdTemperature).updateValue(thisNestDevice.target_temperature_low);
                this.__ThermostatService.getCharacteristic(Characteristic.CoolingThresholdTemperature).updateValue(thisNestDevice.target_temperature_high);
                this.__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).updateValue(Characteristic.TargetHeatingCoolingState.AUTO);
                historyEntry.target = {low: thisNestDevice.target_temperature_low, high: thisNestDevice.target_temperature_high};    // target temperature range
            }
            if (thisNestDevice.hvac_mode.toUpperCase() == "OFF") {
                this.__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).updateValue(Characteristic.TargetHeatingCoolingState.OFF);
                historyEntry.target = {low: 0, high: 0};    // thermostat off, so no target temperatures
            }

            // Update current state
            if (thisNestDevice.hvac_state.toUpperCase() == "HEATING") {
                if (thisNestDevice.can_heat == true) {
                    if ((thisNestDevice.can_cool == true && thisNestDevice.previous_hvac_state.toUpperCase() == "COOLING") && this.__DaikinActive == true) {
                        // Switched to heating mode from cooling mode, so stop aircon
                        this.setDaikinAC(0, 3, thisNestDevice.target_temperature_high, 0, "A", 3);
                    }
                    this.__ThermostatService.getCharacteristic(Characteristic.CurrentHeatingCoolingState).updateValue(Characteristic.CurrentHeatingCoolingState.HEAT);
                    historyEntry.status = 2;    // heating
                }
            }
            if (thisNestDevice.hvac_state.toUpperCase() == "COOLING") {
                if (thisNestDevice.can_cool == true) {
                    // Switched to cooling mode, so start up aircon
                    this.setDaikinAC(1, 3, this.__ThermostatService.getCharacteristic(Characteristic.TargetTemperature).value, 0, "A", 3);
                    this.__ThermostatService.getCharacteristic(Characteristic.CurrentHeatingCoolingState).updateValue(Characteristic.CurrentHeatingCoolingState.COOL);
                    historyEntry.status = 3;    // cooling
                }
            }
            if (thisNestDevice.hvac_state.toUpperCase() == "OFF") {
                if (thisNestDevice.can_cool == true) {
                    if ((thisNestDevice.previous_hvac_state.toUpperCase() == "COOLING" || thisNestDevice.previous_hvac_state.toUpperCase() == "FAN") && this.__DaikinActive == true) {
                        // Currently switched to off, so stop aircon if previous mode was cooling and/or fan was running
                        this.setDaikinAC(0, 3, thisNestDevice.target_temperature_high, 0, "A", 3);
                    }
                }
                this.__ThermostatService.getCharacteristic(Characteristic.CurrentHeatingCoolingState).updateValue(Characteristic.CurrentHeatingCoolingState.OFF);
                historyEntry.status = 0;    // off
            }
            if (thisNestDevice.hvac_state.toUpperCase() == "FAN") {
                // Fan configured. work out status of fan from thermostat and start/stop on the Daikin as required
                if (thisNestDevice.has_fan == true && this.__DaikinActive == false) {
                    this.setDaikinAC(1, 6, "--", "--", "A", 3);

                    // Report to HomeKit current mode is "OFF" as there is no seprate FAN linked.
                    this.__ThermostatService.getCharacteristic(Characteristic.CurrentHeatingCoolingState).updateValue(Characteristic.CurrentHeatingCoolingState.OFF);
                    historyEntry.status = 1;    // fan
                }
                // TODO --- Something to update HomeKit for a fan going. Probably needs a fan servce or something.
            }

            // Log history
            if (this.historyService != null) {
                historyEntry.time = Math.floor(new Date() / 1000);
                historyEntry.temperature = thisNestDevice.active_temperature;
                historyEntry.humidity = thisNestDevice.current_humidity;
                this.historyService.addHistory(this.__ThermostatService, {time: historyEntry.time, status: historyEntry.status, temperature: historyEntry.temperature, target: historyEntry.target, humidity: historyEntry.humidity});
            }
         
            // Updated cached values
            this.__cachedTemp = thisNestDevice.target_temperature;
        }
    }
}
    
ThermostatClass.prototype.setDaikinAC = function(daikinPwr, daikinMode, daikinTemp, daikinHumid, daikinFanSpeed, daikinFanMode) {
    axios.get("http://" + DaikinIP + "/aircon/set_control_info?pow=" + daikinPwr + "&mode=" + daikinMode + "&stemp=" + daikinTemp + "&shum=" + daikinHumid + "&f_rate=" + daikinFanSpeed + "&f_dir=" + daikinFanMode)
    .then(response => {
        if (response.status == 200) {
            this.__DaikinActive = (daikinPwr == 1) ? true : false;  // update if Daikin on or off
            console.log("setDaikinAC Pwr: '%s' Mode: '%s' Temp: '%s' Fan Mode: '%s' Fan Speed: '%s'", daikinPwr, daikinMode, daikinTemp, daikinFanMode, daikinFanSpeed);
        }
    })
    .catch(error => console.log("DEBUG: " + arguments.callee.name, AccessoryName, error.message));
}


// Nest Temperature Sensors
TempSensorClass.prototype.addTemperatureSensor = function(HomeKitAccessory, thisServiceName, serviceNumber, thisNestDevice) {
    // Add this temperature sensor to the "master" accessory and set properties   
    this.__TemperatureService = HomeKitAccessory.addService(Service.TemperatureSensor, thisServiceName, serviceNumber);
    this.__TemperatureService.addCharacteristic(Characteristic.StatusActive);

    // Add battery service to display battery level    
    this.__BatteryService = HomeKitAccessory.addService(Service.BatteryService, "", serviceNumber);
    this.__BatteryService.getCharacteristic(Characteristic.ChargingState).updateValue(Characteristic.ChargingState.NOT_CHARGEABLE); // Temp sensors dont charge as run off battery
    this.__TemperatureService.addLinkedService(this.__BatteryService);

    // Setup logging
    this.historyService = new HomeKitHistory(HomeKitAccessory, {});
    this.historyService.linkToEveHome(HomeKitAccessory, this.__TemperatureService);

    this.updateHomeKit(HomeKitAccessory, thisNestDevice);  // Do initial HomeKit update    
    console.log("Setup Nest Temperature Sensor '%s' on '%s'", thisServiceName, HomeKitAccessory.username);
}

TempSensorClass.prototype.updateHomeKit = function(HomeKitAccessory, thisNestDevice) {
    if (typeof thisNestDevice == 'object' && this.__updatingHomeKit == false)
    {
        if (this.__TemperatureService != null && this.__BatteryService != null) {
            this.__TemperatureService.getCharacteristic(Characteristic.StatusActive).updateValue(thisNestDevice.online == true ? true : false);  // If Nest isnt online, report in HomeKit

            // Update temperature
            this.__TemperatureService.getCharacteristic(Characteristic.CurrentTemperature).updateValue(thisNestDevice.current_temperature);

            if (this.historyService != null) this.historyService.addHistory(this.__TemperatureService, {time: Math.floor(new Date() / 1000), temperature: thisNestDevice.current_temperature});
      
            // Update battery level
            var tempBatteryLevel = __scale(thisNestDevice.battery_level, 0, 100, 0, 100);
            this.__BatteryService.getCharacteristic(Characteristic.BatteryLevel).updateValue(tempBatteryLevel);
            this.__BatteryService.getCharacteristic(Characteristic.StatusLowBattery).updateValue(tempBatteryLevel > 5 ? Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL : Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);  
        }
    }
}


// Nest Protect
SmokeSensorClass.prototype.addSmokeCOSensor = function(HomeKitAccessory, thisServiceName, serviceNumber, thisNestDevice) {
    // Add this smoke sensor & CO sensor to the "master" accessory and set properties   
    this.__SmokeService = HomeKitAccessory.addService(Service.SmokeSensor, thisServiceName + " Smoke Sensor", serviceNumber);
    this.__SmokeService.addCharacteristic(Characteristic.StatusActive);
    this.__COService = HomeKitAccessory.addService(Service.CarbonMonoxideSensor, thisServiceName + " CO Sensor", serviceNumber);
    this.__COService.addOptionalCharacteristic(Characteristic.CarbonMonoxideLevel);
    this.__COService.addOptionalCharacteristic(Characteristic.CarbonMonoxidePeakLevel);
    this.__COService.addCharacteristic(Characteristic.StatusActive);
    
    // Set maximum valkues for COPPM limits
    this.__COService.getCharacteristic(Characteristic.CarbonMonoxideLevel).setProps({maxValue: 2000});
    this.__COService.getCharacteristic(Characteristic.CarbonMonoxidePeakLevel).setProps({maxValue: 2000})

    // Add battery service to display battery level
    this.__BatteryService = HomeKitAccessory.addService(Service.BatteryService, "", serviceNumber);
    this.__BatteryService.removeCharacteristic(Characteristic.ChargingState);
    this.__SmokeService.addLinkedService(this.__BatteryService);
    this.__COService.addLinkedService(this.__BatteryService);

    // Add montion sensor if supported (only on wired versions)
    if (thisNestDevice.wired_or_battery == 0) {
        this.__MotionService = HomeKitAccessory.addService(Service.MotionSensor, thisServiceName + " Motion Sensor", serviceNumber);
        this.__MotionService.addCharacteristic(Characteristic.StatusActive);
        this.__MotionService.addLinkedService(this.__BatteryService);
    }

    this.updateHomeKit(HomeKitAccessory, thisNestDevice);  // Do initial HomeKit update
    console.log("Setup Nest Protect '%s' on '%s'", thisServiceName, HomeKitAccessory.username, (this.__MotionService != null ? "with motion sensor" : ""));
}

SmokeSensorClass.prototype.updateHomeKit = function(HomeKitAccessory, thisNestDevice) {
    if (typeof thisNestDevice == 'object' && this.__updatingHomeKit == false)
    {
        if (this.__SmokeService != null && this.__COService != null && this.__BatteryService != null) {
            HomeKitAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, thisNestDevice.software_version);
            this.__SmokeService.getCharacteristic(Characteristic.StatusActive).updateValue(thisNestDevice.online == true ? true : false);  // If Nest isnt online, report in HomeKit
            this.__COService.getCharacteristic(Characteristic.StatusActive).updateValue(thisNestDevice.online == true ? true : false);  // If Nest isnt online, report in HomeKit
        
            if (this.__MotionService != null) {
                // Motion detect if auto_away = false. Not supported on battery powered Nest Protects
                this.__MotionService.getCharacteristic(Characteristic.StatusActive).updateValue(thisNestDevice.online == true ? true : false);  // If Nest isnt online, report in HomeKit
                this.__MotionService.getCharacteristic(Characteristic.MotionDetected).updateValue(thisNestDevice.away == false ? true : false);
            }

            // Update battery level
            var tempBatteryLevel = __scale(thisNestDevice.battery_level, 0, 5400, 0, 100);
            this.__BatteryService.getCharacteristic(Characteristic.BatteryLevel).updateValue(tempBatteryLevel);
            this.__BatteryService.getCharacteristic(Characteristic.StatusLowBattery).updateValue((tempBatteryLevel > 5 && thisNestDevice.battery_health_state == 0 && ((thisNestDevice.line_power_present == true && thisNestDevice.wired_or_battery == 0) || (thisNestDevice.line_power_present == false && thisNestDevice.wired_or_battery == 1))) ? Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL : Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);
            this.__BatteryService.getCharacteristic(Characteristic.ChargingState).updateValue(thisNestDevice.battery_charging_state == true ? Characteristic.ChargingState.CHARGING : Characteristic.ChargingState.NOT_CHARGING);
    
            // Update smoke and CO detected status 'ok': 0, 'warning': 1, 'emergency': 2
            this.__SmokeService.getCharacteristic(Characteristic.SmokeDetected).updateValue(thisNestDevice.smoke_status == 0 ? Characteristic.SmokeDetected.SMOKE_NOT_DETECTED : Characteristic.SmokeDetected.SMOKE_DETECTED);
            this.__COService.getCharacteristic(Characteristic.CarbonMonoxideDetected).updateValue(thisNestDevice.co_status == 0 ? Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL : Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL);

            // Update CO levels
            //this.__COService.getCharacteristic(Characteristic.CarbonMonoxideLevel).updateValue(thisNestDevice.????);
            this.__COService.getCharacteristic(Characteristic.CarbonMonoxidePeakLevel).updateValue(thisNestDevice.co_previous_peak);
        }
    }
}


// Nest object
NestClass.prototype.doLogin = async function(tokenRefresh) {
    if (this.__nestToken == null && this.__nestURL == null && this.__nestID == null) {
        await axios.get("https://home.nest.com/session", {headers: {"user-agent": nestUserAgent, "Authorization": "Basic " + NestAccessToken} })
        .then(response => {
            if (response.status == 200) {
                this.__nestToken = response.data.access_token;
                this.__nestURL = response.data.urls.transport_url;
                this.__nestID = response.data.userid;
                this.__tokenExpire = Math.floor(new Date(response.data.expires_in) / 1000);

                // Set timer to refresh token expiry time/date 
                setInterval(async function() {
                    this.doLogin(true);
                }.bind(this), (3600 * 12 * 1000)); // Refresh every day
            }
        })
        .catch(error => {
            if (error.status == 400) {
                // Invalid token
            } else if (error.status == 401 && error.response && error.response.data && error.response.data.truncated_phone_number) {
                // 2FA required. prompt user to input PIN recieved to phone
                console.log("DEBUG: 2FA enabled")
                // get 2FA PIN
            /*    await axios.post("https://home.nest.com" + nest2FAURL, JSON.stringify( { "pin": PIN, "2fa_token": error.response.data['2fa_token']}))
                .then(response => {
                    await axios.get("https://home.nest.com/session", {headers: {"user-agent": nestUserAgent, "Authorization": "Basic " + response.data.access_token} })
                    .then(response => {
                        if (response.status == 200) {
                            this.__nestToken = response.data.access_token;
                            this.__nestURL = response.data.urls.transport_url;
                            this.__nestID = response.data.userid;
                            this.__tokenExpire = Math.floor(new Date(response.data.expires_in) / 1000);

                            // Set timer to refresh token expiry time/date 
                            setInterval(async function() {
                                this.doLogin(true);
                            }.bind(this), (3600 * 12 * 1000)); // Refresh every day
                        }
                    })
                })
                .catch(error => {
                    console.log("DEBUG: " + arguments.callee.name, AccessoryName, "Nest login failed", error.message);
                }); */
            } else {
                console.log("DEBUG: " + arguments.callee.name, AccessoryName, "Nest login failed", error.message);
            }
        });
    }
    if (tokenRefresh && tokenRefresh == true && this.__nestToken != null) {
        // called login to only refresh token expiry time
        await axios.get("https://home.nest.com/session", {headers: {"user-agent": nestUserAgent, "Authorization": "Basic " + this.__nestToken} })
        .then(response => {
            if (response.status == 200) {
                this.__nestURL = response.data.urls.transport_url;
                this.__tokenExpire = Math.floor(new Date(response.data.expires_in) / 1000);
            }
        })
        .catch(error => {
            console.log("DEBUG: " + arguments.callee.name, AccessoryName, "Nest token expiry time refresh", error.message);
        });
    }
}

NestClass.prototype.getNestData = async function(process) {
    await this.doLogin(false);
    if (this.__nestToken != null && this.__nestURL != null && this.__nestID != null) {
        await axios.get(this.__nestURL + "/v3/mobile/user." + this.__nestID, {headers: {"content-type": "application/json", "user-agent": nestUserAgent, "Authorization": "Basic " + this.__nestToken}, data: ""})
        .then(response => {
            if (response.status == 200) {
                this.__lastNestData = response.data;    // Used to generate subscribed versions/times
                if (process == true) {
                    this.__processNestData(this.__lastNestData);
                }   
            }
        })
        .finally(() => {
        })
        .catch(error => {console.log("DEBUG: " + arguments.callee.name, AccessoryName, error.message)});
    }
}

NestClass.prototype.setNestValue = async function(nestStructure, key, value, targetChange) {
    await this.doLogin(false);
    if (this.__nestToken != null && this.__nestURL != null && this.__nestID != null) {
        await axios.post(this.__nestURL + nestPutURL + "/" + nestStructure, JSON.stringify( { "target_change_pending": targetChange, [key]: value}), {headers: {"content-type": "application/json", "user-agent": nestUserAgent, "Authorization": "Basic " + this.__nestToken} })
        .then(response => {
            if (response.status == 200) {
                return console.log("Set value of '%s' to '%s' on '%s", key, value, nestStructure);;
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
        this.__cancel && this.__cancel("subscription update loop cancelled");
    }
}

NestClass.prototype.removeSubcription = function(deviceID) {
    var subscribeIndex = this.__subscribed.findIndex( ({ device }) => device === deviceID);
    if (subscribeIndex != -1) {
        // have an active subscription, so remove from the subscribed array
        this.__subscribed.splice(subscribeIndex, 1);
        this.__cancel && this.__cancel("subscription update loop cancelled");
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

NestClass.prototype.__processNestData = function(nestData) {
    if (nestData && typeof nestData == "object") {
        this.__previousNestData = this.__currentNestData;
        if (typeof this.__previousNestData.device != "object") {
            this.__previousNestData.device = {};
        }
    
        // Process Nest structure and build our return structure for all devices we support (Thermostat, Temp Sensor and Protect)
        this.__currentNestData = {};
        this.__currentNestData.device = {};

        nestData.device && Object.entries(nestData.device).forEach(([deviceID, thermostat]) => {
            // process thermostats
            this.__currentNestData.device[thermostat.serial_number] = {};
            this.__currentNestData.device[thermostat.serial_number].device_type = "thermostat";  // nest thermostat
            this.__currentNestData.device[thermostat.serial_number].orgNestStructure = "device." + deviceID;
            this.__currentNestData.device[thermostat.serial_number].software_version = thermostat.current_version.replace(/-/g, "."); // fix software version for HomeKit
            this.__currentNestData.device[thermostat.serial_number].mac_address= thermostat.mac_address.toUpperCase();
            this.__currentNestData.device[thermostat.serial_number].current_humidity = thermostat.current_humidity;
            this.__currentNestData.device[thermostat.serial_number].temperature_scale = thermostat.temperature_scale;
            this.__currentNestData.device[thermostat.serial_number].backplate_temperature = thermostat.backplate_temperature;
            this.__currentNestData.device[thermostat.serial_number].battery_level = thermostat.battery_level;
            this.__currentNestData.device[thermostat.serial_number].serial_number = thermostat.serial_number;
            this.__currentNestData.device[thermostat.serial_number].online = nestData.track[thermostat.serial_number].online;
            this.__currentNestData.device[thermostat.serial_number].has_fan = thermostat.has_fan;
            this.__currentNestData.device[thermostat.serial_number].can_cool = nestData.shared[thermostat.serial_number].can_cool;
            this.__currentNestData.device[thermostat.serial_number].can_heat = nestData.shared[thermostat.serial_number].can_heat;
            this.__currentNestData.device[thermostat.serial_number].description = nestData.shared[thermostat.serial_number].hasOwnProperty("name") ? nestData.shared[thermostat.serial_number].name : "";
            this.__currentNestData.device[thermostat.serial_number].target_temperature_type = nestData.shared[thermostat.serial_number].target_temperature_type;
            this.__currentNestData.device[thermostat.serial_number].target_temperature = __adjustTemperature(nestData.shared[thermostat.serial_number].target_temperature, "C", "C");
            this.__currentNestData.device[thermostat.serial_number].target_temperature_high = __adjustTemperature(nestData.shared[thermostat.serial_number].target_temperature_high, "C", "C");
            this.__currentNestData.device[thermostat.serial_number].target_temperature_low = __adjustTemperature(nestData.shared[thermostat.serial_number].target_temperature_low, "C", "C");
            this.__currentNestData.device[thermostat.serial_number].backplate_temperature = __adjustTemperature(thermostat.backplate_temperature, "C", "C");
            this.__currentNestData.device[thermostat.serial_number].hvac_mode = nestData.shared[thermostat.serial_number].target_temperature_type;
        
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
            if (nestData.shared[thermostat.serial_number].hvac_fan_state == true) {
                this.__currentNestData.device[thermostat.serial_number].hvac_state = "fan";
            }

            // Setup previous modes and states
            if (typeof this.__previousNestData.device[thermostat.serial_number] != "object") {
                this.__previousNestData.device[thermostat.serial_number] = {};
                this.__previousNestData.device[thermostat.serial_number].hvac_mode = this.__currentNestData.device[thermostat.serial_number].hvac_mode;
                this.__previousNestData.device[thermostat.serial_number].hvac_state = this.__currentNestData.device[thermostat.serial_number].hvac_state;
                this.__previousNestData.device[thermostat.serial_number].previous_hvac_mode = this.__currentNestData.device[thermostat.serial_number].hvac_mode;
                this.__previousNestData.device[thermostat.serial_number].previous_hvac_state = this.__currentNestData.device[thermostat.serial_number].hvac_state;
                this.__previousNestData.device[thermostat.serial_number].battery_level = 0;
                this.__currentNestData.device[thermostat.serial_number].previous_hvac_mode = this.__currentNestData.device[thermostat.serial_number].hvac_mode;
                this.__currentNestData.device[thermostat.serial_number].previous_hvac_state = this.__currentNestData.device[thermostat.serial_number].hvac_state;
            }

            if (this.__currentNestData.device[thermostat.serial_number].hvac_mode != this.__previousNestData.device[thermostat.serial_number].hvac_mode) {
                this.__currentNestData.device[thermostat.serial_number].previous_hvac_mode = this.__previousNestData.device[thermostat.serial_number].hvac_mode;
            } else {
                this.__currentNestData.device[thermostat.serial_number].previous_hvac_mode = this.__previousNestData.device[thermostat.serial_number].previous_hvac_mode;
            }
            if (this.__currentNestData.device[thermostat.serial_number].hvac_state != this.__previousNestData.device[thermostat.serial_number].hvac_state) {
                this.__currentNestData.device[thermostat.serial_number].previous_hvac_state = this.__previousNestData.device[thermostat.serial_number].hvac_state;
            } else {
                this.__currentNestData.device[thermostat.serial_number].previous_hvac_state = this.__previousNestData.device[thermostat.serial_number].previous_hvac_state;
            }

            // Get device location name
            this.__currentNestData.device[thermostat.serial_number].location = "";
            nestData.where[nestData.link[thermostat.serial_number].structure.split('.')[1]].wheres.forEach(where => {
                if (thermostat.where_id == where.where_id) {
                    this.__currentNestData.device[thermostat.serial_number].location = where.name;
                }
            });
            
            this.__currentNestData.device[thermostat.serial_number].battery_charging_state = typeof this.__previousNestData.device == "object" && thermostat.battery_level > this.__previousNestData.device[thermostat.serial_number].battery_level && this.__previousNestData.device[thermostat.serial_number].battery_level != 0 ? true : false;
            this.__currentNestData.device[thermostat.serial_number].away = nestData.structure[nestData.link[thermostat.serial_number].structure.split('.')[1]].away;    // away status
            this.__currentNestData.device[thermostat.serial_number].home_name = nestData.structure[nestData.link[thermostat.serial_number].structure.split('.')[1]].name;  // Home name
            this.__currentNestData.device[thermostat.serial_number].orgNestStructureID = nestData.link[thermostat.serial_number].structure.split('.')[1]; // structure ID

            // Link in any temperature sensors
            this.__currentNestData.device[thermostat.serial_number].active_rcs_sensor = (nestData.rcs_settings[thermostat.serial_number].active_rcs_sensors.length == 0 ? "" : nestData.kryptonite[nestData.rcs_settings[thermostat.serial_number].active_rcs_sensors[0].split('.')[1]].serial_number);
            this.__currentNestData.device[thermostat.serial_number].active_temperature = (nestData.rcs_settings[thermostat.serial_number].active_rcs_sensors.length == 0 ? __adjustTemperature(thermostat.backplate_temperature, "C", "C") : __adjustTemperature(nestData.kryptonite[nestData.rcs_settings[thermostat.serial_number].active_rcs_sensors[0].split('.')[1]].current_temperature, "C", "C"));
            this.__currentNestData.device[thermostat.serial_number].linked_rcs_sensors = [];
            nestData.rcs_settings[thermostat.serial_number].associated_rcs_sensors.forEach(sensor => {
                this.__currentNestData.device[thermostat.serial_number].linked_rcs_sensors.push(nestData.kryptonite[sensor.split('.')[1]].serial_number);
            });
        });

        nestData.kryptonite && Object.entries(nestData.kryptonite).forEach(([deviceID, sensor]) => {
            this.__currentNestData.device[sensor.serial_number] = {}
            this.__currentNestData.device[sensor.serial_number].device_type = "sensor";  // nest temperature sensor
            this.__currentNestData.device[sensor.serial_number].orgNestStructure = "kryptonite." + deviceID;
            this.__currentNestData.device[sensor.serial_number].serial_number = sensor.serial_number;
            this.__currentNestData.device[sensor.serial_number].description = sensor.hasOwnProperty("description") ? sensor.description : ""; 
            this.__currentNestData.device[sensor.serial_number].mac_address = "641666" + deviceID.substr(10,6); // Generate a CRC24 instead for mac last 6 digits
            this.__currentNestData.device[sensor.serial_number].mac_address.toUpperCase();
            this.__currentNestData.device[sensor.serial_number].current_temperature = sensor.current_temperature;
            this.__currentNestData.device[sensor.serial_number].battery_level = sensor.battery_level;
            this.__currentNestData.device[sensor.serial_number].battery_charging_state = false; // on battery, so doesnt charge
            this.__currentNestData.device[sensor.serial_number].software_version = "1.0";
            this.__currentNestData.device[sensor.serial_number].current_temperature = __adjustTemperature(sensor.current_temperature, "C", "C");

            // Get device location name
            this.__currentNestData.device[sensor.serial_number].location = "";
            nestData.where[sensor.structure_id].wheres.forEach(where => {
                if (sensor.where_id == where.where_id) {
                    this.__currentNestData.device[sensor.serial_number].location = where.name;
                }
            });

            this.__currentNestData.device[sensor.serial_number].online = (Math.floor(new Date() / 1000) - sensor.last_updated_at) < (3600 * 3) ? true : false;    // online status. allow upto 3hrs for reporting before report sensor offline
            this.__currentNestData.device[sensor.serial_number].home_name = nestData.structure[sensor.structure_id].name;    // Home name
            this.__currentNestData.device[sensor.serial_number].orgNestStructureID = sensor.structure_id; // structure ID
        });

        nestData.topaz && Object.entries(nestData.topaz).forEach(([deviceID, protect]) => {
            if (typeof this.__previousNestData.device[protect.serial_number] != "object") {
                this.__previousNestData.device[protect.serial_number] = {};
                this.__previousNestData.device[protect.serial_number].battery_level = 0;
            }

            // process smoke detectors
            this.__currentNestData.device[protect.serial_number] = {};
            this.__currentNestData.device[protect.serial_number].device_type = "protect";  // nest protect
            this.__currentNestData.device[protect.serial_number].orgNestStructure = "topaz." + deviceID;
            this.__currentNestData.device[protect.serial_number].serial_number = protect.serial_number;
            this.__currentNestData.device[protect.serial_number].line_power_present = protect.line_power_present;
            this.__currentNestData.device[protect.serial_number].wired_or_battery = protect.wired_or_battery;
            this.__currentNestData.device[protect.serial_number].battery_level = protect.battery_level;
            this.__currentNestData.device[protect.serial_number].battery_health_state = protect.battery_health_state;
            this.__currentNestData.device[protect.serial_number].smoke_status = protect.smoke_status;
            this.__currentNestData.device[protect.serial_number].co_status = protect.co_status;
            this.__currentNestData.device[protect.serial_number].co_previous_peak = protect.co_previous_peak;
            this.__currentNestData.device[protect.serial_number].mac_address = protect.wifi_mac_address.toUpperCase();
            this.__currentNestData.device[protect.serial_number].online = nestData.widget_track[protect.thread_mac_address.toUpperCase()].online;
            this.__currentNestData.device[protect.serial_number].description = protect.hasOwnProperty("description") ? protect.description : "";
            this.__currentNestData.device[protect.serial_number].software_version = protect.software_version.replace(/-/g, ".");    // fix software version for HomeKit
            this.__currentNestData.device[protect.serial_number].ui_color_state = "grey";
            if (protect.battery_health_state == 0 && protect.co_status == 0 && protect.smoke_status == 0) this.__currentNestData.device[protect.serial_number].ui_color_state = "green";
            if (protect.battery_health_state != 0 || protect.co_status == 1 || protect.smoke_status == 1) this.__currentNestData.device[protect.serial_number].ui_color_state = "yellow";
            if (protect.co_status == 2 || protect.smoke_status == 2) this.__currentNestData.device[protect.serial_number].ui_color_state = "red";
        
            // Get device location name
            this.__currentNestData.device[protect.serial_number].location = "";
            nestData.where[protect.structure_id].wheres.forEach(where => {
                if (protect.where_id == where.where_id) {
                    this.__currentNestData.device[protect.serial_number].location = where.name;
                }
            });
            this.__currentNestData.device[protect.serial_number].battery_charging_state = typeof this.__previousNestData.device == "object" && protect.battery_level > this.__previousNestData.device[protect.serial_number].battery_level && this.__previousNestData.device[protect.serial_number].battery_level != 0 ? true : false;
            this.__currentNestData.device[protect.serial_number].away = protect.auto_away;   // away status
            this.__currentNestData.device[protect.serial_number].home_name = nestData.structure[protect.structure_id].name;  // Home name
            this.__currentNestData.device[protect.serial_number].orgNestStructureID = protect.structure_id; // structure ID
        });

        nestData.quartz && Object.entries(nestData.quartz).forEach(([deviceID, camera]) => {
            // process cameras - todo
            this.__currentNestData.device[camera.serial_number] = {};
            this.__currentNestData.device[camera.serial_number].device_type = "camera";  // nest camera's
            this.__currentNestData.device[camera.serial_number].orgNestStructure = "quartz." + deviceID;
            this.__currentNestData.device[camera.serial_number].serial_number = camera.serial_number;
            this.__currentNestData.device[camera.serial_number].software_version = camera.software_version.replace(/-/g, "."); // fix software version for HomeKit
            this.__currentNestData.device[camera.serial_number].mac_address = camera.mac_address.toUpperCase();
            this.__currentNestData.device[camera.serial_number].description = camera.hasOwnProperty("description") ? camera.description : "";
            this.__currentNestData.device[camera.serial_number].camera_type = camera.camera_type;

            // Get device location name
            this.__currentNestData.device[camera.serial_number].location = "";
            nestData.where[camera.structure_id].wheres.forEach(where => {
                if (camera.where_id == where.where_id) {
                    this.__currentNestData.device[camera.serial_number].location = where.name;
                }
            });
            this.__currentNestData.device[camera.serial_number].home_name = nestData.structure[camera.structure_id].name;  // Home name
            this.__currentNestData.device[camera.serial_number].orgNestStructureID = camera.structure_id; // structure ID
        });
    }
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

NestClass.prototype.__interalTimer = function() {
    // Build object for subscription, based upon subscribed device types
    var subscribeData = {objects: []};

    this.__lastNestData && Object.entries(this.__lastNestData).forEach(([mainKey]) => {
        // shared, track, device, structure, where, rcs_settings, kryptonite, topaz, widget_track, link, quart

        Object.entries(this.__lastNestData[mainKey]).forEach(([subKey]) => {
            // See if this key relates to a subscribed device (device, topaz, kryptonite, quartz)
            if (mainKey == "device" || mainKey == "kryptonite" || mainKey == "topaz" || mainKey == "quartz" || mainKey == "shared" || mainKey == "track" || mainKey == "rcs_settings" || mainKey == "widget_track" || mainKey == "link" ) {
                if (this.__subscribed.findIndex( ({ nestID }) => nestID && nestID.split('.')[1] === subKey) != -1 ) {
                    subscribeData.objects.push({"object_key" :  mainKey + "." + subKey, "object_revision" : this.__lastNestData[mainKey][subKey]["$version"], "object_timestamp": this.__lastNestData[mainKey][subKey]["$timestamp"]});
                }
            }
            if (mainKey == "structure" || mainKey == "where") {
                // Always subscribe to structure and where object changes
                subscribeData.objects.push({"object_key" :  mainKey + "." + subKey, "object_revision" : this.__lastNestData[mainKey][subKey]["$version"], "object_timestamp": this.__lastNestData[mainKey][subKey]["$timestamp"]});
            }
        });
    });

    // Do subscription for the data we need.. Timeout after 2mins
    var tempDeviceList = [];
    axios({
        method: "post",
        url: this.__nestURL + nestSubscribeURL,
        data: JSON.stringify(subscribeData), 
        headers: {"user-agent": nestUserAgent, "Authorization": "Basic " + this.__nestToken}, 
        responseType: "json", 
        timeout: 120000, // 2minutes
        cancelToken: new axios.CancelToken(c => { this.__cancel = c; })
    })
    .then(async (response) => {
        if (response.status == 200) {
            // Got subscribed update, so merge and process them
            response.data.objects.forEach(updatedData => {
                var mainKey = updatedData.object_key.split('.')[0];
                var subKey = updatedData.object_key.split('.')[1];
        
                // See if we have a structure change and the "swarm" property list has changed.. Means new or removed devices
                if (mainKey.toUpperCase() == "STRUCTURE" && updatedData.value.swarm && this.__lastNestData[mainKey][subKey].swarm.toString() !== updatedData.value.swarm.toString()) {
                    var oldDeviceList = this.__lastNestData[mainKey][subKey].swarm.toString().split(',').map(String);
                    var newDeviceList = updatedData.value.swarm.toString().split(',').map(String);
                    for (var index in oldDeviceList) {
                        if (!newDeviceList.includes(oldDeviceList[index])) {
                            tempDeviceList.push({"nestID": oldDeviceList[index], "action" : false});    // Deleted
                        }
                    }
                    for (index in newDeviceList) {
                        if (!oldDeviceList.includes(newDeviceList[index])) {
                            tempDeviceList.push({"nestID": newDeviceList[index], "action" : true}); // Added
                        }
                    }
                    tempDeviceList = tempDeviceList.sort((a, b) => a - b);  // filter out duplicates
                } else {                  
                    // Update internal saved nest structure
                    this.__lastNestData[mainKey][subKey] = updatedData.value;   // Updated object data
                    this.__lastNestData[mainKey][subKey]["$version"] = updatedData.object_revision; // Updated version of object
                    this.__lastNestData[mainKey][subKey]["$timestamp"] = updatedData.object_timestamp;  // Updated timestam of object
                }
            });
            
            if (tempDeviceList.length > 0) {
                // Change in devices, so get current data before we process
                await this.getNestData(false);
            }
            this.__processNestData(this.__lastNestData);

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
                        if (nestDevice.action == true) {
                            this.__currentNestData.device && Object.entries(this.__currentNestData.device).forEach(([deviceID, device]) => {
                                if (device.orgNestStructure == nestDevice.nestID) {
                                    // Process new device into HomeKit
                                    subscribedDevice.callback(this, device, true);
                                }
                            });
                        }
                        if (nestDevice.action == false) {
                            this.__previousNestData.device && Object.entries(this.__previousNestData.device).forEach(([deviceID, device]) => {
                                if (device.orgNestStructure == nestDevice.nestID) {
                                    subscribedDevice.callback(this, device, false);
                                }
                            });
                        }
                    });
                }
            });
        }
    })
    .catch(async (error) => {
        if (axios.isCancel(error) == false && error.code !== 'ECONNABORTED') {
            if (error.response && error.response.status == 404) {
                // Subscription failed with a 404 error "not found", so this could indicate devices have change. we'll check here also
                await this.getNestData(true);  // get current data and process

                // compare current vs previous devices to see if things added and/or removed
                var oldDeviceList = Object.entries(this.__previousNestData.device).toString().split(',').map(String);
                var newDeviceList = Object.entries(this.__currentNestData.device).toString().split(',').map(String);
                for (var index in oldDeviceList) {
                    if (!newDeviceList.includes(oldDeviceList[index])) {
                        tempDeviceList.push({"nestID": oldDeviceList[index], "action" : false});    // Deleted
                    }
                }
                for (index in newDeviceList) {
                    if (!oldDeviceList.includes(newDeviceList[index])) {
                        tempDeviceList.push({"nestID": newDeviceList[index], "action" : true}); // Added
                    }
                }
                tempDeviceList = tempDeviceList.sort((a, b) => a - b);  // filter out duplicates
                if (tempDeviceList.length > 0) {
                    // Process subscribed callbacks
                    this.__subscribed.forEach(subscribedDevice => {
                        if (subscribedDevice.device == null) {
                            // have a device addition or removal to process
                            tempDeviceList.forEach(nestDevice => {
                                if (nestDevice.action == true) {
                                    this.__currentNestData.device && Object.entries(this.__currentNestData.device).forEach(([deviceID, device]) => {
                                        if (device.serial_number == nestDevice.nestID) {
                                            // Process new device into HomeKit
                                            subscribedDevice.callback(this, device, true);
                                        }
                                    });
                                }
                                if (nestDevice.action == false) {
                                    this.__previousNestData.device && Object.entries(this.__previousNestData.device).forEach(([deviceID, device]) => {
                                        if (device.serial_number == nestDevice.nestID) {
                                            subscribedDevice.callback(this, device, false);
                                        }
                                    });
                                }
                            });
                        }
                    });
                }
            } else {
                // Log error if request not cancelled or item not found
                console.log("DEBUG: " + arguments.callee.name, AccessoryName, error.message);
            }
        }
    })
    .finally(() => {
        // subscribe again after small delay :-)
        setTimeout(this.__interalTimer.bind(this), 500);
    });
}


// General funxctions
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
    var tempMACAddress = nestDevice.mac_address.substr(0,2) + ":" + nestDevice.mac_address.substr(2,2) + ":" + nestDevice.mac_address.substr(4,2) + ":" + nestDevice.mac_address.substr(6,2) + ":" + nestDevice.mac_address.substr(8,2) + ":" + nestDevice.mac_address.substr(10,2);
    if (action == true && typeof nestDevice == "object") {
        // adding device into HomeKit
        // Generate some common things
        var tempName = (nestDevice.description == "" ? nestDevice.location : nestDevice.location + " (" + nestDevice.description + ")");
        var tempModel = "";

        switch (nestDevice.device_type) {
            case "thermostat" : {
                // Nest Thermostat

                tempModel = "Thermostat";
                if (nestDevice.serial_number.substr(0,2) == "15") tempModel = tempModel + " E";  // Nest Thermostat E
                if (nestDevice.serial_number.substr(0,2) == "09") tempModel = tempModel + " 3rd Gen";  // Nest Thermostat 3rd Gen
                if (nestDevice.serial_number.substr(0,2) == "02") tempModel = tempModel + " 2nd Gen";  // Nest Thermostat 2nd Gen
                if (nestDevice.serial_number.substr(0,2) == "01") tempModel = tempModel + " 1st Gen";  // Nest Thermostat 1st Gen
                if (tempName == "") tempName = "Nest Thermostat";

                // Create accessory for each discovered nest
                var tempAccessory = exports.accessory = new Accessory("Nest Thermostat", uuid.generate("hap-nodejs:accessories:nest_" + nestDevice.serial_number));
                tempAccessory.username = tempMACAddress;
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
                tempAccessory.publish({username: tempAccessory.username, pincode: tempAccessory.pincode, category: tempAccessory.category});    // Publish accessory on local network
                nestObject.addSubscription(tempAccessory.__thisObject.__nestDeviceID, tempAccessory, tempAccessory.__thisObject.updateHomeKit.bind(tempAccessory.__thisObject));
                break;
            }

            case "sensor" : {
                // Nest Temperature Sensor

                tempModel = "Temperature Sensor";
                if (nestDevice.serial_number.substr(0,2) == "22") tempModel = tempModel + " 1st Gen";  // Nest Temperature Sensor 1st Gen
                if (tempName == "") tempName = "Nest Temperature Sensor";

                var tempAccessory = exports.accessory = new Accessory("Nest Temperature Sensor", uuid.generate("hap-nodejs:accessories:nest_" + nestDevice.serial_number));
                tempAccessory.username = tempMACAddress;
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
                tempAccessory.publish({username: tempAccessory.username, pincode: tempAccessory.pincode, category: tempAccessory.category});    // Publish accessory on local network
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
                if (tempName == "") tempName = "Nest Protect";

                var tempAccessory = exports.accessory = new Accessory("Nest Protect", uuid.generate("hap-nodejs:accessories:nest_" + nestDevice.serial_number));
                tempAccessory.username = tempMACAddress;
                tempAccessory.pincode = AccessoryPincode;
                tempAccessory.category = Accessory.Categories.SENSOR;  // Sensor type accessory
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, "Nest");
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Model, tempModel);
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.SerialNumber, nestDevice.serial_number);
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, nestDevice.software_version);

                tempAccessory.__thisObject = new SmokeSensorClass(); // Store the object
                tempAccessory.__thisObject.__nestDeviceID = nestDevice.serial_number;
                tempAccessory.__thisObject.__orgNestDeviceID = nestDevice.orgNestStructure;
                tempAccessory.__thisObject.addSmokeCOSensor(tempAccessory, tempName, 1, nestDevice); 

                accessories.push(tempAccessory);   // Push onto export array for HAP-NodeJS "accessory factory"
                tempAccessory.publish({username: tempAccessory.username, pincode: tempAccessory.pincode, category: tempAccessory.category}); // Publish accessory on local network
                nestObject.addSubscription(tempAccessory.__thisObject.__nestDeviceID, tempAccessory, tempAccessory.__thisObject.updateHomeKit.bind(tempAccessory.__thisObject));
                break;
            }

            case "camera" : {
                // Nest Camera
                // TODO
                break;
            }
        }
    }

    if (action == false && typeof nestDevice == "object") {
        // Removing device from HomeKit.. not sure want todo this yet... :-)
        // perhaps if has been published and un-paired, unpublish from HomeKit???
        nestObject.removeSubcription(nestDevice.serial_number); // Remove any active subscription for this device

        // find our accessory, then unpublish it and remove from HAP-NodeJS "accessory factory"
        var accessoryIndex = accessories.findIndex(({username}) => username === tempMACAddress);
        if (accessoryIndex != -1 && accessories[accessoryIndex] && accessories[accessoryIndex].__thisObject.__nestDeviceID == nestDevice.serial_number) {
            console.log("Removed Nest Device '%s' on '%s'", accessories[accessoryIndex].displayName, accessories[accessoryIndex].username);
            accessories[accessoryIndex].unpublish();
            accessories.splice(accessoryIndex, 1);
        }
    }
}


// Startup code
var nest = new NestClass();
nest.getNestData(true)
.then(() => {
    nest.__currentNestData.device && Object.entries(nest.__currentNestData.device).forEach(([deviceID, nestDevice]) => {
        // Process discovered device into HomeKit
        processDeviceforHomeKit(nest, nestDevice, true);    
    });
    nest.addSubscription(null, null, processDeviceforHomeKit);  // Subscribe for device additions/removals
});