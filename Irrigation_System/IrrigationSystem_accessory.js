// HAP-NodeJS Irrigation accessory
//
// Resources:
// https://github.com/simont77/fakegato-history
// https://github.com/sfeakes/SprinklerD
// https://github.com/geoffreypetri/water-flow-sensor
//
// note:
// /boot/config.txt needs "dtoverlay=gpio-no-irq"
// 
// todo
// -- detect valve current usage and switch valves if too much drawn in AMPs vs power supply
// -- weather sensor using online service
// -- Scheduling via Eve Home (Aqua)
// -- Integrate more with Eve Home
// -- Run each zone in a Zone Group for equal time
//
// done
// -- Group of zones, to make a "virtual" zone with combined runtime
// -- "smoothing" of water level data
// -- history recording - testing of own solution
// -- use system WIFI mac addr as AccessoryUsername (Override option also in config)
// -- low tank level distance (ie: minimun water level)
// -- virtual power switch
// -- save changes to zone names
// -- restructured code
// -- save configuration changes in off-line file for when system restarted
// -- master valve support and configurable per zone
// -- hardware rain sensor input
// -- flow meter - measure water usage & leaking
// -- support more than one tank - agregate water levels between then all as one percentage
// -- Can use hey siri to turn off/on system or configure to have a vitual power switch
// -- updated to use npm version of hap-nodejs directory structure (11/4/2020) 
// -- Master valve only closes when all zones have finished being active
//
// bugs
// -- running as a service at system startup, MAC address isnt returned when no IP assigned to wifi. Maybe just loop until assigned?. 
//    26/4/2019 -- Changed service startup to wait for network. Monitor
// -- hey siri to turn off/on system doesn't work in iOS 15??
//
// Version 12/01/2021
// Mark Hulskamp

var JSONPackage = require('../../package.json');
var Accessory = require('../').Accessory; 
var Service = require('../').Service;
var Characteristic = require('../').Characteristic;
var uuid = require('../').uuid;
var GPIO = require('rpio');
var fs = require('fs');
var os = require('os');
var axios = require('axios');
var HomeKitHistory = require("./HomeKitHistory");

// Defines for the accessory
const AccessoryName =  "Irrigation System";             // name of accessory
const AccessoryPincode = "031-45-154";                  // pin code for pairing 
const AccessoryManufacturer = "Mark Hulskamp";          // manufacturer (optional)
const AccessoryModel = "Home Irrigation System";        // model (optional)
const AccessorySerialNumber = "MH20210222";             // serial number (think this has to stay the same when using Evehome history??)
const AccessoryFirmwareRevision = JSONPackage.version;  // firmware revision (optional)

const WATERFLOWTIMER = 1000;                // Timer in ms for water flow testing

// Create the "valve" object. 
function ZoneClass() {
    this.ValveService = null;               // HomeKit service for this valve
    this.RunningTimer = null;   
    this.Name = "";                         // name of the zone
    this.Runtime = 0;                       // Zone runtime in seconds
    this.Enabled = false;                   // Is the zone enabled
    this.GPIO_ValvePin = 0;                 // GPIO Pin for valve control
    this.WaterTotal = 0;                    // Accumlative water flow total in litres
    this.UseMasterValve = false;            // Does this zone need to use the master valve
    this.belongsTo = [];                    // Zone groups zone belongs to
    this.GroupRunningZone = null;           // If this zone is a group, this will be the current zone when group is running
    this.UseGroupRuntime = false;           // Combined group runtime split evenly across group members rather than use each groups runtime
    this.endTimerMS = 0;
}

// Create the irrigation system object. 
function IrrigationSystemClass() {
    this.accessory = null;                  // Parent accessory object
    this.IrrigationService = null;          // HomeKit service for this irrigation system
    this.PowerSwitchService = null;         // HomeKit service for "virtual" on/off switch
    this.MaximumActiveZones = 1;            // Maximum active/running zones at any one time
    this.MaxZoneRunTime = 3600;             // Maximum runtime per zone (in seconds) 3600 is HomeKit default
    
    this.PowerState = false;                // Virtual power state of the irrigation system

    this.IrrigationZones = [];              // Array of irrigation zones (the valves)
    this.enabledZones = 0;                  // Numnber of enabled zones
    this.GPIO_MasterValvePin = 0;           // GPIO pin for master valve. 0 = no master valve enabled

    this.RainSensorService = null;          // HomeKit service for "virtual" rain sensor
    this.GPIO_RainSensorPin = 0;            // GPIO pin for hardware rain sensor input. 0 = disabled
    this.weatherAPI = "";                   // cached darksky.net weather API key
    this.weatherLat = "";                   // cached darksky.net weather Lat location
    this.weatherLong = "";                  // cached darksky.net weather Long location

    this.WaterTanks = [];                   // Array of water tanks under this system
    this.lastWaterLevel = null;             // Last water level read. Used to filter erratic readings

    this.LeakSensorService = null;          // HomeKit service for alerting on leaking water. Requires flow sensor
    this.FlowTimer = null;
    this.FlowPulseCount = 0;                // Counted pulses for time period
    this.FlowPulseStart = 0;                // When we started counting pulses
    this.FlowPulseStop = 0;                 // When we stopped counting pulses
    this.SensorFlowFactor = 0.0;            // Scaling factor for connected flow sensor
    this.lastValveTime = 0;                 // Time of last valve operation either an open or close
    this.FlowRates = [];                    // Array of water flows (rate/volume per index).. used for averaging in leak detection
    this.GPIO_FlowSensorPin = 0;            // GPIO pin for hardware water flow sensor input. 0 = disabled 

    this.__activeCheck = [];
    this.__activeCheckTimer = null;

    this.historyService = null;             // History logging service
    this.EveHome = null;                    // EveHome app integration object
}

// Create the eve app integration object. 
function EveHomeClass() {
    this.EveHomeAccessory = null;           // EveHome accessory service when linked to our history data
    this.pauseTimeout = 0;                  // used for HomeKit scene pause
    this.Flowrate = 0;                      // Eve Aqua flowrate in ml/Min or L/S
    this.Latitude = 0.0;                    // Location latitude if set
    this.Longitude = 0.0;                   // Location longitude if set
    this.Firmware = 1208;                   // Eve Aqua firmware revision
    this.UTCOffset = 0;                     // Timezone offset from UTC in seconds
    this.Programs = {};
    this.Programs.Enabled = false;          // Are schedules enabled or not
    this.Programs.Schedules = [];           // Array of schedulign information
}


IrrigationSystemClass.prototype.loadConfiguration = function() {
    // Loads the configuration from disk and validates entries if present
    var config = {};

    if (fs.existsSync(__filename.split('_accessory.js')[0] + "_config.json")) {
        config = require(__filename.split('_accessory.js')[0] + "_config.json");
    }
    if (config.hasOwnProperty("tanks") == false) config.tanks = [];
    if (config.hasOwnProperty("system") == false) config.system = {};
    if (config.hasOwnProperty("eveapp") == false) config.eveapp = {};
    if (config.hasOwnProperty("weather") == false) config.weather = {};
    if (config.hasOwnProperty("zones") == false) config.zones = [];
    if (config.hasOwnProperty("groups") == false) config.groups = [];

    // Validate tanks section
    config.tanks = (config.hasOwnProperty("tanks") && typeof config.tanks == 'object') ? config.tanks : [];
    for (var index in config.tanks) {
        config.tanks[index].Enabled = config.tanks[index].hasOwnProperty("Enabled") && typeof config.tanks[index].Enabled == "boolean" ? config.tanks[index].Enabled : false;
        config.tanks[index].TankHeight = config.tanks[index].hasOwnProperty("TankHeight") ? parseInt(config.tanks[index].TankHeight) : 0;
        config.tanks[index].MinimumLevel = config.tanks[index].hasOwnProperty("MinimumLevel") ? parseInt(config.tanks[index].MinimumLevel) : 0;
        config.tanks[index].SensorTrig = config.tanks[index].hasOwnProperty("SensorTrig") ? parseInt(config.tanks[index].SensorTrig) : 0;
        config.tanks[index].SensorEcho = config.tanks[index].hasOwnProperty("SensorEcho") ? parseInt(config.tanks[index].SensorEcho) : 0;
        if (config.tanks[index].MinimumLevel < 0) config.tanks[index].MinimumLevel = 0;
        if (config.tanks[index].MinimumLevel > config.tanks[index].TankHeight) config.tanks[index].MinimumLevel = config.tanks[index].TankHeight;
    }

    // validate tank section - convert to tanks array internally, then drop the tank object
    if (config.hasOwnProperty("tank") && typeof config.tank == 'object' && Object.keys(config.tank).length !== 0) {
        var lastIndex = config.tanks.length;
        config.tanks[lastIndex] = {};
        config.tanks[lastIndex].Enabled = true;
        config.tanks[lastIndex].TankHeight = config.tank.hasOwnProperty("TankHeight") ? parseInt(config.tank.TankHeight) : 0;
        config.tanks[lastIndex].MinimumLevel = config.tank.hasOwnProperty("MinimumLevel") ? parseInt(config.tank.MinimumLevel) : 0;
        config.tanks[lastIndex].SensorTrig = config.tank.hasOwnProperty("TankSensorTrigPin") ? parseInt(config.tank.TankSensorTrigPin) : 0;
        config.tanks[lastIndex].SensorEcho = config.tank.hasOwnProperty("TankSensorEchoPin") ? parseInt(config.tank.TankSensorEchoPin) : 0;
        if (config.tanks[lastIndex].MinimumLevel < 0) config.tanks[lastIndex].MinimumLevel = 0;
        if (config.tanks[lastIndex].MinimumLevel > config.tanks[lastIndex].TankHeight) config.tanks[lastIndex].MinimumLevel = config.tanks[lastIndex].TankHeight;
        delete config.tank; // remove old tank section
    }
    
    // validate system section
    config.system.PowerState = config.system.hasOwnProperty("PowerState") && config.system.PowerState.toUpperCase() == "ON" ? "on" : "off";
    config.system.PowerSwitch = config.system.hasOwnProperty("PowerSwitch") && typeof config.system.PowerSwitch == "boolean" ? config.system.PowerSwitch : false;
    config.system.MaxRunningZones = config.system.hasOwnProperty("MaxRunningZones") && parseInt(config.system.MaxRunningZones) > 0 ? parseInt(config.system.MaxRunningZones) : 1;
    config.system.MasterValvePin = config.system.hasOwnProperty("MasterValvePin") ? parseInt(config.system.MasterValvePin) : 0;
    config.system.FlowSensorPin = config.system.hasOwnProperty("FlowSensorPin") ? parseInt(config.system.FlowSensorPin) : 0;
    config.system.FlowSensorRate = config.system.hasOwnProperty("FlowSensorRate") ? parseFloat(config.system.FlowSensorRate) : 0.0;
    config.system.WaterLeakAlert = config.system.hasOwnProperty("WaterLeakAlert") && typeof config.system.WaterLeakAlert == "boolean" ? config.system.WaterLeakAlert : false;
    config.system.MaxHistory = config.system.hasOwnProperty("MaxHistory") ? parseInt(config.system.MaxHistory) : 4096;
    config.system.MacAddress = config.system.hasOwnProperty("MacAddress") ? config.system.MacAddress.toUpperCase() : "";
    config.system.MaxZoneRunTime = config.system.hasOwnProperty("MaxZoneRunTime") ? parseInt(config.system.MaxZoneRunTime) : 3600; // 60mins HomeKit default

    // validate eveapp section - used for integration into EveHome iOS/iPadOS app
    if (config.system.hasOwnProperty("EveHome")) config.eveapp.Enabled = config.system.EveHome;
    if (config.system.hasOwnProperty("PauseTimeout")) config.eveapp.PauseTimeout = config.system.PauseTimeout;
    delete config.system.EveHome;   // Remove old config entry as migrated 
    delete config.system.PauseTimeout;   // Remove old config entry as migrated 
    config.eveapp.Enabled = config.eveapp.hasOwnProperty("Enabled") && typeof config.eveapp.Enabled == "boolean" ? config.eveapp.Enabled : false;
    config.eveapp.PauseTimeout = config.eveapp.hasOwnProperty("PauseTimeout") ? parseInt(config.eveapp.PauseTimeout) : 0;
    config.eveapp.Firmware = config.eveapp.hasOwnProperty("Firmware") ? parseInt(config.eveapp.Firmware) : 1208;    // Eve Aqua minimum firmware version
    config.eveapp.FlowRate = config.eveapp.hasOwnProperty("FlowRate") ? parseFloat(config.eveapp.FlowRate) : 18.0;   // Eve Aqua flow rate in L/Min. seems 18 is the default
    config.eveapp.Latitude = config.eveapp.hasOwnProperty("Latitude") ? parseFloat(config.eveapp.Latitude) : 0.0;
    config.eveapp.Longitude = config.eveapp.hasOwnProperty("Longitude") ? parseFloat(config.eveapp.Longitude) : 0.0;
    config.eveapp.Programs = (config.eveapp.hasOwnProperty("Programs") && typeof config.eveapp.Programs == 'object') ? config.eveapp.Programs : {};
    config.eveapp.Programs.Enabled = config.eveapp.Programs.hasOwnProperty("Enabled") && typeof config.eveapp.Programs.Enabled  == "boolean" ? config.eveapp.Programs.Enabled : false;
    
    // validate weather section
    config.weather.Enabled = config.weather.hasOwnProperty("Enabled") && typeof config.weather.Enabled == "boolean" ? config.weather.Enabled : false;
    config.weather.RainSensorPin = config.weather.hasOwnProperty("RainSensorPin") ? parseInt(config.weather.RainSensorPin) : 0;
    config.weather.WeatherAPIKey = config.weather.hasOwnProperty("WeatherAPIKey") ? config.weather.WeatherAPIKey : "";
    config.weather.WeatherLatLoc = config.weather.hasOwnProperty("WeatherLatLoc") ? config.weather.WeatherLatLoc : "";
    config.weather.WeatherLongLoc = config.weather.hasOwnProperty("WeatherLongLoc") ? config.weather.WeatherLongLoc : "";

    // validate zones section
    config.zones = (config.hasOwnProperty("zones") && typeof config.zones == 'object') ? config.zones : [];
    for (var index in config.zones) {
        config.zones[index].Name = (config.zones[index].hasOwnProperty("Name") ? config.zones[index].Name : "Zone " + (index + 1));
        config.zones[index].RelayPin = (config.zones[index].hasOwnProperty("RelayPin") ? parseInt(config.zones[index].RelayPin) : 0);
        config.zones[index].RunTime = (config.zones[index].hasOwnProperty("RunTime") && parseInt(config.zones[index].RunTime) > 0 ? parseInt(config.zones[index].RunTime) : 0);
        config.zones[index].Enabled = (config.zones[index].hasOwnProperty("Enabled") && typeof config.zones[index].Enabled == "boolean" ? config.zones[index].Enabled : false);
        config.zones[index].MasterValve = (config.zones[index].hasOwnProperty("MasterValve") && typeof config.zones[index].MasterValve == "boolean" ? config.zones[index].MasterValve : false);
    }

    // validate zone groups
    config.groups = (config.hasOwnProperty("groups") && typeof config.groups == 'object') ? config.groups : [];
    for (var index in config.groups) {
        config.groups[index].Name = (config.groups[index].hasOwnProperty("Name") ? config.groups[index].Name : "Zone Group" + (index + 1));
        config.groups[index].Enabled = (config.groups[index].hasOwnProperty("Enabled") && typeof config.groups[index].Enabled == "boolean" ? config.groups[index].Enabled : false);
        config.groups[index].RunTime = (config.groups[index].hasOwnProperty("RunTime") && parseInt(config.groups[index].RunTime) > 0 ? parseInt(config.groups[index].RunTime) : 0);
        config.groups[index].SeperateRunTime = (config.groups[index].hasOwnProperty("SeperateRunTime") && typeof config.groups[index].SeperateRunTime == "boolean" ? config.groups[index].SeperateRunTime : false); // If true, uses seperate runtime split evenly across zone members
        config.groups[index].Zones = (config.groups[index].hasOwnProperty("Zones") ? config.groups[index].Zones : []);

        // TODO - Make sure zone for the group is defined

     /*   for (var index2 in config.groups[index].Zones) {
            // Validate zone name in group
            var indexZone = config.zones.findIndex(({Name}) => Name === config.groups[index].Zones[index2]);
            if (indexZone == -1) config.groups[index].Zones.splice(index2, 1);
        } */
    }
    return config;
}

IrrigationSystemClass.prototype.saveConfiguration = function() {
    var config = this.loadConfiguration();  // Load saved config before updating
    // Update tank section

    // update system section
    config.system.PowerState = (this.getIrrigationSystemState() == true ? "on" : "off");

    // Update eveapp section
    config.eveapp.PauseTimeout = this.EveHome.pauseTimeout;
    config.eveapp.FlowRate = this.EveHome.Flowrate;
    config.eveapp.Latitude = this.EveHome.Latitude;
    config.eveapp.Longitude = this.EveHome.Longitude;
    config.eveapp.Firmware = this.EveHome.Firmware;
    config.eveapp.Programs.Enabled = this.EveHome.Programs.Enabled;
    config.eveapp.Programs.Schedules = this.EveHome.Programs.Schedules;
    
    // update weather section

    // Update zone and group details
    config.zones = [];
    config.groups = [];
    this.IrrigationZones.forEach(zone => {
        if (zone.GPIO_ValvePin != null) {
            // Zone is not a group
            config.zones.push({"Name": zone.Name, "Enabled": zone.Enabled, "RunTime": zone.Runtime, "RelayPin": zone.GPIO_ValvePin, "MasterValve": zone.UseMasterValve});
        }
        if (zone.GPIO_ValvePin == null) {
            // Zone is a group
            var tempBelongsToNames = [];
            zone.belongsTo.forEach(zoneID => {
                tempBelongsToNames.push(this.IrrigationZones[zoneID].Name);
            });
            config.groups.push({"Name": zone.Name, "Enabled": zone.Enabled, "RunTime": zone.Runtime, "SeperateRunTime": zone.UseGroupRuntime, "Zones": tempBelongsToNames});
        }
    });

    // Write updated config back
    fs.writeFileSync(__filename.split('_accessory.js')[0] + "_config.json", JSON.stringify(config, null, 3));
}


IrrigationSystemClass.prototype.addIrrigationSystem = function(HomeKitAccessory, thisServiceName, config) {
    this.accessory = HomeKitAccessory;
    this.IrrigationService = HomeKitAccessory.addService(Service.IrrigationSystem, thisServiceName, 1);

    if (config.system.PowerSwitch == true) {
        // create switch for a virtual "power button" to turn on/off irrigation system via HomeKit. If switched off, system will not open values/zones
        this.PowerSwitchService = HomeKitAccessory.addService(Service.Switch, "Power", 1);
        this.IrrigationService.addLinkedService(this.PowerSwitchService);

        // Setup HomeKit callbacks for included virtual power switch
        this.PowerSwitchService.getCharacteristic(Characteristic.On).on('set', (value, callback) => {this.__processActiveCharacteristic(this, value, callback, "switch")});
    } else {
        // Only use siri to turn on/off system
        this.IrrigationService.getCharacteristic(Characteristic.Active).on('set', (value, callback) => {this.__processActiveCharacteristic(this, value, callback, "system")});
    }

    HomeKitAccessory.setPrimaryService(this.IrrigationService);

    // Setup logging and link into EveHome if configured todo so
    this.historyService = new HomeKitHistory(HomeKitAccessory, {maxEntries: config.system.MaxHistory});
    this.EveHome = new EveHomeClass();
    this.EveHome.PauseTimeout = config.eveapp.PauseTimeout;
    this.EveHome.Flowrate = config.eveapp.FlowRate;
    this.EveHome.Latitude = config.eveapp.Latitude;
    this.EveHome.Longitude = config.eveapp.Longitude;
    this.EveHome.Firmware = config.eveapp.Firmware;
    this.EveHome.Programs = {};
    this.EveHome.Programs.Enabled = config.eveapp.Programs.Enabled;
    if (config.eveapp.Enabled == true) {
        this.EveHome.EveHomeAccessory = this.historyService.linkToEveHome(HomeKitAccessory, this.IrrigationService, {SetCommand: this.__EveHomeSetCommand.bind(this), 
                                                                                                                     GetCommand: this.__EveHomeGetCommand.bind(this), 
                                                                                                                     EveAqua_flowrate: config.eveapp.FlowRate,
                                                                                                                     EveAqua_firmware: config.eveapp.Firmware,
                                                                                                                     EveAqua_enableschedule: config.eveapp.Programs.Enabled
                                                                                                                    });
    }

    this.MaximumActiveZones = config.system.MaxRunningZones;
    this.MaxZoneRunTime = config.system.MaxZoneRunTime;

    console.log("Created irrigation system on '%s'", this.accessory.username);
}

IrrigationSystemClass.prototype.addMasterValve = function(configMasterPin) {
    if (configMasterPin != 0) {
        this.GPIO_MasterValvePin = configMasterPin;

        // Initialise the GPIO input/output PINs for the master valve
        GPIO.init({gpiomem: true}); // this only needs to be done once, but it's here each time anyway
        GPIO.init({mapping: 'gpio'}); // this only needs to be done once, but it's here each time anyway
        GPIO.open(this.GPIO_MasterValvePin, GPIO.OUTPUT, GPIO.LOW);

        console.log("Enabled master valve on '%s' using GPIO pin '%s'", this.accessory.username, this.GPIO_MasterValvePin);
    }
}

IrrigationSystemClass.prototype.addFlowSensor = function(configFlowSensorPin, configFlowSensorRate, configWaterLeakAlert) {
    if (configFlowSensorPin != 0 && configFlowSensorRate != 0) {
        this.GPIO_FlowSensorPin = configFlowSensorPin;
        this.SensorFlowFactor = configFlowSensorRate;

        // Initialise the GPIO input/output PINs for the master valve
        GPIO.init({gpiomem: true}); // this only needs to be done once, but it's here each time anyway
        GPIO.init({mapping: 'gpio'}); // this only needs to be done once, but it's here each time anyway
        GPIO.open(this.GPIO_FlowSensorPin, GPIO.INPUT, GPIO.PULL_DOWN);

        if (configWaterLeakAlert == true) {
            this.LeakSensorService = this.accessory.addService(Service.LeakSensor, "Water Leak", 1);
            this.IrrigationService.addLinkedService(this.LeakSensorService);
            this.LeakSensorService.getCharacteristic(Characteristic.LeakDetected).updateValue(Characteristic.LeakDetected.LEAK_NOT_DETECTED);
        }

        this.FlowPulseCount = 0;
        this.FlowPulseStop = 0;
        this.FlowPulseStart = Math.floor(Date.now());   // Time we started the pulse counter
        GPIO.poll(this.GPIO_FlowSensorPin, this.__WaterPulseCounter.bind(this), GPIO.POLL_HIGH);   // Start the pulse counter
        this.FlowTimer = setInterval(this.__WaterFlowStatus.bind(this), WATERFLOWTIMER);  // Check the water flow every 1second

        console.log("Enabled water flow sensor '%s' using GPIO pin '%s'", this.accessory.username, this.GPIO_FlowSensorPin, (configWaterLeakAlert == true ? "with leak alert" : ""));
    }
}
 
IrrigationSystemClass.prototype.addIrrigationZone = function(zoneDetails) {
    if (zoneDetails && typeof zoneDetails == 'object') {
        var tempZone = new ZoneClass();
        tempZone.Name = zoneDetails.Name;
        tempZone.GPIO_ValvePin = zoneDetails.RelayPin;
        tempZone.Runtime = zoneDetails.RunTime;
        tempZone.Enabled = zoneDetails.Enabled;
        tempZone.UseMasterValve = zoneDetails.MasterValve;
        tempZone.belongsTo = [];    // This is a zone, rather than a group of zones
        tempZone.UseGroupRuntime = false;   // This is a zone, rather than a group of zones

        tempZone.ValveService = this.accessory.addService(Service.Valve, tempZone.Name, (this.IrrigationZones.length + 1));
        tempZone.ValveService.getCharacteristic(Characteristic.ValveType).updateValue(Characteristic.ValveType.IRRIGATION);
        tempZone.ValveService.addCharacteristic(Characteristic.SetDuration);
        tempZone.ValveService.addCharacteristic(Characteristic.RemainingDuration);
        tempZone.ValveService.addCharacteristic(Characteristic.IsConfigured);
        tempZone.ValveService.addCharacteristic(Characteristic.ConfiguredName);

        tempZone.ValveService.getCharacteristic(Characteristic.ConfiguredName).updateValue(tempZone.Name);
        tempZone.ValveService.getCharacteristic(Characteristic.ServiceLabelIndex).updateValue(this.IrrigationZones.length + 1);

        // iOS 14 change, where default runtime list doesn't give default values for the scroll list, only 5 and 10mins
        // iOS 15 corrects this

        // setup default runtime if configured and ensure with in defined bounds of the characteristic 
        tempZone.ValveService.getCharacteristic(Characteristic.SetDuration).setProps({maxValue: this.MaxZoneRunTime});
        tempZone.ValveService.getCharacteristic(Characteristic.RemainingDuration).setProps({maxValue: this.MaxZoneRunTime});   
        tempZone.ValveService.getCharacteristic(Characteristic.SetDuration).updateValue(tempZone.Runtime);

        // Setup zone enabled or disabled
        // seems to be a bug in HomeKit/iOS 12 that this value doesn't change via home app.
        tempZone.ValveService.getCharacteristic(Characteristic.IsConfigured).updateValue((tempZone.Enabled == true) ? Characteristic.IsConfigured.CONFIGURED : Characteristic.IsConfigured.NOT_CONFIGURED);
        if (tempZone.Enabled == true) this.enabledZones++;  // Add to count of enabled zones

        // Initialise the GPIO input/output PINs for this valve
        GPIO.init({gpiomem: true}); // this only needs to be done once, but it's here each time anyway
        GPIO.init({mapping: 'gpio'}); // this only needs to be done once, but it's here each time anyway
        if (tempZone.GPIO_ValvePin != 0) GPIO.open(tempZone.GPIO_ValvePin, GPIO.OUTPUT, GPIO.LOW);

        this.IrrigationService.addLinkedService(tempZone.ValveService);
        this.IrrigationZones.push(tempZone);

        // Setup HomeKit callbacks
        tempZone.ValveService.getCharacteristic(Characteristic.Active).on('set', (value, callback) => {this.__processActiveCharacteristic(tempZone, value, callback, "valve")});
        tempZone.ValveService.getCharacteristic(Characteristic.ConfiguredName).on('set', (value, callback) => {this.setZoneName(tempZone, value, callback)});
        tempZone.ValveService.getCharacteristic(Characteristic.ConfiguredName).on('get', (callback) => {this.getZoneName(tempZone, callback)});
        tempZone.ValveService.getCharacteristic(Characteristic.IsConfigured).on('set', (value, callback) => {this.setZoneState(tempZone, value, callback)});
        tempZone.ValveService.getCharacteristic(Characteristic.IsConfigured).on('get', (callback) => {this.getZoneState(tempZone, callback)});
        tempZone.ValveService.getCharacteristic(Characteristic.SetDuration).on('set', (value, callback) => {this.setZoneRuntime(tempZone, value, callback)});
        tempZone.ValveService.getCharacteristic(Characteristic.SetDuration).on('get', (callback) => {this.getZoneRuntime(tempZone, callback)});

        console.log("Added irrigation zone '%s' on '%s' using GPIO pin '%s'", tempZone.Name, this.accessory.username, tempZone.GPIO_ValvePin);
    }
}

IrrigationSystemClass.prototype.addIrrigationGroup = function(groupDetails) {
    if (groupDetails && typeof groupDetails == 'object') {
        var tempZone = new ZoneClass();
        var zoneID = this.IrrigationZones.push(tempZone) - 1;

        this.IrrigationZones[zoneID].Name = groupDetails.Name;
        this.IrrigationZones[zoneID].GPIO_ValvePin = null;     // Means zone is a group
        this.IrrigationZones[zoneID].Enabled = groupDetails.Enabled;
        this.IrrigationZones[zoneID].UseGroupRuntime = groupDetails.SeperateRunTime;

        var tempRuntime = 0;
        groupDetails.Zones.forEach(zone => {
            for (var index in this.IrrigationZones) {
                if (this.IrrigationZones[index].Name.toUpperCase() == zone.toUpperCase()) {
                    // found the specified zone member as its zone
                    this.IrrigationZones[index].belongsTo.push(zoneID);  // store array index rather than group name.
                    this.IrrigationZones[zoneID].belongsTo.push(index);  // store array index rather than zone name.
                    tempRuntime = tempRuntime + this.IrrigationZones[index].Runtime;
                }
            }
        });
        this.IrrigationZones[zoneID].Runtime = groupDetails.SeperateRunTime == true ? groupDetails.RunTime : tempRuntime;   // What will be the total runtime for the group

        tempZone.ValveService = this.accessory.addService(Service.Valve, tempZone.Name, (zoneID + 1));
        tempZone.ValveService.getCharacteristic(Characteristic.ValveType).updateValue(Characteristic.ValveType.IRRIGATION);
        tempZone.ValveService.addCharacteristic(Characteristic.SetDuration);
        tempZone.ValveService.addCharacteristic(Characteristic.RemainingDuration);
        tempZone.ValveService.addCharacteristic(Characteristic.IsConfigured);
        tempZone.ValveService.addCharacteristic(Characteristic.ConfiguredName);

        tempZone.ValveService.getCharacteristic(Characteristic.ConfiguredName).updateValue(tempZone.Name);
        tempZone.ValveService.getCharacteristic(Characteristic.ServiceLabelIndex).updateValue((zoneID + 1));

        // setup default runtime if configured and ensure with in defined bounds of the characteristic 
        tempZone.ValveService.getCharacteristic(Characteristic.SetDuration).setProps({maxValue: (this.MaxZoneRunTime * (groupDetails.Zones.length + 1)) });
        tempZone.ValveService.getCharacteristic(Characteristic.RemainingDuration).setProps({maxValue: (this.MaxZoneRunTime * (groupDetails.Zones.length + 1)) });
        tempZone.ValveService.getCharacteristic(Characteristic.SetDuration).updateValue(tempZone.Runtime);

        // Setup zone enabled or disabled
        // seems to be a bug in HomeKit/iOS 12 that this value doesn't change via home app.
        tempZone.ValveService.getCharacteristic(Characteristic.IsConfigured).updateValue((tempZone.Enabled == true) ? Characteristic.IsConfigured.CONFIGURED : Characteristic.IsConfigured.NOT_CONFIGURED);
        if (tempZone.Enabled == true) this.enabledZones++;  // Add to count of enabled zones

        this.IrrigationService.addLinkedService(tempZone.ValveService);

        // Setup HomeKit callbacks
        tempZone.ValveService.getCharacteristic(Characteristic.Active).on('set', (value, callback) => {this.__processActiveCharacteristic(tempZone, value, callback, "valve")});
        tempZone.ValveService.getCharacteristic(Characteristic.ConfiguredName).on('set', (value, callback) => {this.setZoneName(tempZone, value, callback)});
        tempZone.ValveService.getCharacteristic(Characteristic.ConfiguredName).on('get', (callback) => {this.getZoneName(tempZone, callback)});
        tempZone.ValveService.getCharacteristic(Characteristic.IsConfigured).on('set', (value, callback) => {this.setZoneState(tempZone, value, callback)});
        tempZone.ValveService.getCharacteristic(Characteristic.IsConfigured).on('get', (callback) => {this.getZoneState(tempZone, callback)});
        tempZone.ValveService.getCharacteristic(Characteristic.SetDuration).on('set', (value, callback) => {this.setZoneRuntime(tempZone, value, callback)});
        tempZone.ValveService.getCharacteristic(Characteristic.SetDuration).on('get', (callback) => {this.getZoneRuntime(tempZone, callback)});
        console.log("Added irrigation group '%s' on '%s' with '%s'", tempZone.Name, this.accessory.username, groupDetails.Zones);
    }
}

IrrigationSystemClass.prototype.addWaterTank = function(tankHeight, minTankLevel, tankSensorTrigPin, tankSensorEchoPin) {
    var serviceIndex = this.WaterTanks.length;

    if (tankHeight != 0 && tankSensorTrigPin != 0 && tankSensorEchoPin != 0) {
        // Validate values
        if (minTankLevel < 0) minTankLevel = 0;
        if (minTankLevel > tankHeight) minTankLevel = tankHeight;

        // Store for later
        this.WaterTanks.push({"Height": tankHeight, "MinLevel": minTankLevel, "GPIO_SensorTrigPin": tankSensorTrigPin, "GPIO_SensorEchoPin" : tankSensorEchoPin});

        if (serviceIndex == 0) { 
            // First water tank we're adding, so add the level to the parent accessory
            this.IrrigationService.addCharacteristic(Characteristic.WaterLevel);
            this.__WaterTankLevel();    // Set inital level in HomeKit
        }
    
        console.log("Enabled a water tank level sensor on '%s' using GPIO pins '%s %s'", this.accessory.username, tankSensorTrigPin, tankSensorEchoPin);
    }
}

IrrigationSystemClass.prototype.addRainSensor = function(rainSensorType, /*,,,,,,,,, */) {
    switch (rainSensorType.toUpperCase()) {
        case "HW" : {
            if (arguments.length = 2 && arguments[1] != 0) {
                // Function args:
                // 1 - HW
                // 2 - Rain sensor GPIO pins
                this.RainSensorService = this.accessory.addService(Service.LeakSensor, "Rain Sensor", 2);
                this.IrrigationService.addLinkedService(this.RainSensorService);
                this.RainSensorService.getCharacteristic(Characteristic.LeakDetected).updateValue(Characteristic.LeakDetected.LEAK_NOT_DETECTED);   // No rain yet

                // Initialise the GPIO input/output PINs for this rain sensor input
                GPIO.init({gpiomem: true}); // this only needs to be done once, but it's here each time anyway
                GPIO.init({mapping: 'gpio'}); // this only needs to be done once, but it's here each time anyway
                this.GPIO_RainSensorPin = arguments[1];
                GPIO.open(this.GPIO_RainSensorPin, GPIO.INPUT);

                this.__RainSensorStatus();  // Inital update

                console.log("Enabled rain sensor on '%s' using GPIO pin '%s'", this.accessory.username, arguments[1]);
            }
            break;
        }
        
        case "ONLINE" : {
            if (arguments.length = 4 && arguments[1] != "" && arguments[2] != "" && arguments[3] != "") {
                // Function args:
                // 1 - ONLINE
                // 2 - API Key
                // 3 - Latitude location
                // 4 - Longtitude locatuion     
                this.RainSensorService = this.accessory.addService(Service.LeakSensor, "Weather Sensor", 2);
                this.IrrigationService.addLinkedService(this.RainSensorService);
                this.RainSensorService.getCharacteristic(Characteristic.LeakDetected).updateValue(Characteristic.LeakDetected.LEAK_NOT_DETECTED);   // No rain yet
        
                this.weatherAPI = arguments[1];
                this.weatherLat = arguments[2];
                this.weatherLong = arguments[3];
                this.__WeatherServiceStatus();  // Inital update

                console.log("Enabled online weather service on '%s'", this.accessory.username);
            }
            break;
        }
    }
}

IrrigationSystemClass.prototype.refreshHomeKit = function() {
    // setup the required timers for HomeKit refreshes
    if (this.WaterTanks.length >= 0) {
        // Have one or more water thanks configured, so Refresh water tank level in HomeKit every 60000ms or 1minute
        setInterval(this.__WaterTankLevel.bind(this), 60000);
    }
    if (this.RainSensorPin != 0 && this.RainSensorService != null) {
        setInterval(this.__RainSensorStatus.bind(this), 300000);  // Refresh rain sensor 300000ms or 5minutes 
    }
    if (this.RainSensorPin == 0 && this.RainSensorService != null) {
        setInterval(this.__WeatherServiceStatus.bind(this), 900000);  // Refresh weather status every 900000ms or 15minutes
    }
}

IrrigationSystemClass.prototype.getIrrigationSystemState = function(callback) { 
    if (typeof callback === 'function') callback(null, this.PowerState);  // do callback if defined
    return this.PowerState;
}

IrrigationSystemClass.prototype.setIrrigationSystemState = function(value, callback) {
    // Turns the irrigation system "virtually" on or off
    // If we're not using the virtual power switch and only using siri, we need to check if a valve going active trigger this

    // If turning off system, and any valves are opened, finish them running
    if (value == false || value == Characteristic.Active.INACTIVE) {
            this.IrrigationZones.forEach(zone => {
            if (zone.ValveService.getCharacteristic(Characteristic.Active).value == Characteristic.Active.ACTIVE) {
                this.setZoneActive(zone, Characteristic.Active.INACTIVE, null);
            }
        });
    }
    this.IrrigationService.getCharacteristic(Characteristic.ProgramMode).updateValue((value == true || value == Characteristic.Active.ACTIVE ? Characteristic.ProgramMode.PROGRAM_SCHEDULED_MANUAL_MODE_ : Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED));
    this.IrrigationService.getCharacteristic(Characteristic.Active).updateValue((value == true || value == Characteristic.Active.ACTIVE ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE));

    if(this.PowerSwitchService != null) {
        this.PowerSwitchService.getCharacteristic(Characteristic.On).updateValue((value == true || value == Characteristic.Active.ACTIVE ? true : false));
    }

    this.PowerState = this.IrrigationService.getCharacteristic(Characteristic.Active).value == Characteristic.Active.ACTIVE ? true : false;
    if (value == Characteristic.Active.ACTIVE || value == true) this.EveHome.pauseTimeout = 0;  // Clear timeout if systems is being turned on

    console.log("Irrigation system on '%s' turned '%s'", this.accessory.username, (value == true || value == Characteristic.Active.ACTIVE ? "On" : "Off"));

    this.saveConfiguration();   // Update configuration
    if (typeof callback === 'function') callback();  // do callback if defined
}

IrrigationSystemClass.prototype.setZoneState = function(context, value, callback) {
    // context = zoneObject
    context.Enabled = (value == Characteristic.IsConfigured.CONFIGURED) ? true : false; 
    context.ValveService.getCharacteristic(Characteristic.IsConfigured).updateValue(value);
    
    // Update enabled zone count
    if (value == Characteristic.IsConfigured.CONFIGURED) this.enabledZones++ 
    else this.enabledZones--;

    this.saveConfiguration();   // Update configuration

    if (typeof callback === 'function') callback();  // do callback if defined
}

IrrigationSystemClass.prototype.getZoneState = function(context, callback) {
    // context = zoneObject
    callback(null,  context.Enabled);
}

IrrigationSystemClass.prototype.setZoneActive = function(context, value, callback) {
    // Run/stop the requested irrigation zone
    // context = ZoneObject
    // value = Characteristic.Active.ACTIVE or Characteristic.Active.INACTIVE
    // callback = callback function
    var openValveCount = 0;
    var shortestRunTime = null;

    if (context.Enabled == true) {
        if (this.getIrrigationSystemState() == true && (value == Characteristic.Active.ACTIVE) && (context.ValveService.getCharacteristic(Characteristic.Active).value == Characteristic.Active.INACTIVE)) {
            // Request to turn on sprinkler and the irrigation system is active. We need to see how many sprinkers can be active at once, and ensure we do not exceed that amount
            // If we need to shut a sprinker off to enabled this new one, do to the one with the shortest run time left
            this.IrrigationZones.forEach(zone => {
                if (zone.ValveService.getCharacteristic(Characteristic.Active).value == Characteristic.Active.ACTIVE) {
                    // found another active sprinkler, so stop it if we exceed the max number of simultaneous running zones
                    openValveCount++;
                    if (shortestRunTime == null) {
                        shortestRunTime = zone; 
                    }
                    else if (zone.ValveService.getCharacteristic(Characteristic.RemainingDuration).value < shortestRunTime.ValveService.getCharacteristic(Characteristic.RemainingDuration).value) {
                        shortestRunTime = zone;
                    }
                    if (openValveCount >= this.MaximumActiveZones && shortestRunTime != null) {
                        // Since we're using the setValue callback, the actual closing of the valve will happen when this function is re-enter by HomeKit
                        this.setZoneActive(shortestRunTime, Characteristic.Active.INACTIVE, null);
                    }
                }
            });

            // Since turning on, reset water total for zone
            var tempTotalRuntime = 0;
            context.GroupRunningZone = null;
            context.WaterTotal = 0;
            if (this.historyService != null) this.historyService.addHistory(context.ValveService, {time: Math.floor(new Date() / 1000), status: 1, water: 0, duration: 0}); // Valve opened
       
            if (context.GPIO_ValvePin != null) {
                tempTotalRuntime = context.Runtime; // runtime for zone
                context.endTimerMS = Math.floor(Date.now() / 1000) + context.Runtime;    // Duration for zone
                this.__openValve((context.UseMasterValve == true ? this.GPIO_MasterValvePin : 0), context.GPIO_ValvePin, context.Name, "");
            }
            if (context.GPIO_ValvePin == null) {
                // since the zone is a group, start first "enabled" zone in the group
                context.endTimerMS = Math.floor(Date.now() / 1000) + context.Runtime;    // Duration for group
                context.GroupRunningZone = null;

                context.belongsTo.forEach(zoneID => {
                    if (this.IrrigationZones[zoneID].Enabled == true) {
                        if (context.GroupRunningZone == null) {
                            // Got the first "enabled" zone as part of the group
                            context.GroupRunningZone = zoneID;  // Store internal ID for group to run
                            this.IrrigationZones[zoneID].endTimerMS = Math.floor(Date.now() / 1000) + (context.UseGroupRuntime == true ? context.Runtime / context.belongsTo.length : this.IrrigationZones[zoneID].Runtime);
                            this.__openValve((this.IrrigationZones[zoneID].UseMasterValve == true ? this.GPIO_MasterValvePin : 0), this.IrrigationZones[zoneID].GPIO_ValvePin, this.IrrigationZones[zoneID].Name, context.Name);
                        }
                        tempTotalRuntime = tempTotalRuntime + (context.UseGroupRuntime == true ? context.Runtime / context.belongsTo.length : this.IrrigationZones[zoneID].Runtime);
                    }
                });
            }

            context.ValveService.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.ACTIVE);
            context.ValveService.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.IN_USE);
            context.ValveService.getCharacteristic(Characteristic.RemainingDuration).updateValue(tempTotalRuntime);
            context.RunningTimer = setInterval(this.__ZoneRunningTimer.bind(this), 100, context, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000) + tempTotalRuntime);
        } else if (this.getIrrigationSystemState() == false && (value == Characteristic.Active.ACTIVE) && (context.ValveService.getCharacteristic(Characteristic.Active).value == Characteristic.Active.INACTIVE) && this.getIrrigationSystemState() == false) {
            // Requested to turn on a valve, but the irrigation system is switched off.. work around need??
            setTimeout(function() {
                this.ValveService.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.INACTIVE);
                this.ValveService.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.NOT_IN_USE);
                this.ValveService.getCharacteristic(Characteristic.RemainingDuration).updateValue(0);
            }.bind(context), 500);    // Maybe able to reduce this from 500ms??? 
        } else if ((value == Characteristic.Active.INACTIVE) && (context.ValveService.getCharacteristic(Characteristic.Active).value == Characteristic.Active.ACTIVE)) {
            // Log water usage after zone turned off and reset water total
            if (this.historyService != null) this.historyService.addHistory(context.ValveService, {time: Math.floor(new Date() / 1000), status: 0, water: context.WaterTotal.toFixed(4), duration: context.ValveService.getCharacteristic(Characteristic.SetDuration).value});  // Valve closed
            context.WaterTotal = 0;
            
            clearInterval(context.RunningTimer);
            context.RunningTimer = null;
            if (context.GPIO_ValvePin != null) {
                context.endTimerMS = 0;
                this.__closeValve((context.UseMasterValve == true ? this.GPIO_MasterValvePin : 0), context.GPIO_ValvePin, context.Name, "");
            }
            if (context.GPIO_ValvePin == null) {
                if (context.GroupRunningZone != null) {
                    context.endTimerMS = 0;
                    this.IrrigationZones[context.GroupRunningZone].endTimerMS = 0;
                    this.__closeValve((this.IrrigationZones[context.GroupRunningZone].UseMasterValve == true ? this.GPIO_MasterValvePin : 0), this.IrrigationZones[context.GroupRunningZone].GPIO_ValvePin, this.IrrigationZones[context.GroupRunningZone].Name, context.Name);
                }
            }
            context.GroupRunningZone = null;
            context.ValveService.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.INACTIVE);
            context.ValveService.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.NOT_IN_USE);
            context.ValveService.getCharacteristic(Characteristic.RemainingDuration).updateValue(0);
        }
    }
    if (typeof callback === 'function') callback();  // do callback if defined
}

IrrigationSystemClass.prototype.setZoneName = function(context, value, callback) {
    // context = zoneObject
    context.Name = value;
    context.ValveService.getCharacteristic(Characteristic.ConfiguredName).updateValue(value);

    this.saveConfiguration();   // Update configuration
    callback();
}

IrrigationSystemClass.prototype.getZoneName = function(context, callback) {
    // context = zoneObject
    callback(null,  context.Name);
}

IrrigationSystemClass.prototype.setZoneRuntime = function(context, value, callback) {
    // context = zoneObject
    context.Runtime = value;
    context.ValveService.getCharacteristic(Characteristic.SetDuration).updateValue(value);

    context.belongsTo.forEach(zoneID => {
        if (context.GPIO_ValvePin != null && this.IrrigationZones[zoneID].UseGroupRuntime == false) {
            // Since zone is part of a group, re-calculate totals for any associated group the zone belongs too
            var tempRuntime = 0;
            this.IrrigationZones[zoneID].belongsTo.forEach(zone => {
                tempRuntime = tempRuntime + this.IrrigationZones[zone].Runtime;
            });

            // update runtime total for group
            this.IrrigationZones[zoneID].Runtime = tempRuntime;
            this.IrrigationZones[zoneID].ValveService.getCharacteristic(Characteristic.SetDuration).updateValue(tempRuntime);
        }

        if (context.GPIO_ValvePin == null && context.UseGroupRuntime == false) {
            // Since this zone is a group, and we're configured to use combined zone runtimes, divide new group runtime equally across all group members
            var tempRuntime = value / context.belongsTo.length;
            if (tempRuntime < 0) tempRuntime = 0;

            this.IrrigationZones[zoneID].Runtime = tempRuntime;
            this.IrrigationZones[zoneID].ValveService.getCharacteristic(Characteristic.SetDuration).updateValue(tempRuntime);
        }
    });

    this.saveConfiguration();   // Update configuration
    callback();
}

IrrigationSystemClass.prototype.getZoneRuntime = function(context, callback) {
    // context = zoneObject
    callback(null,  context.Runtime);
}

IrrigationSystemClass.prototype.__processActiveCharacteristic = function(context, value, callback, type) {
    // workaround for using hey siri to turn on/off system and valves triggering active avents along with system active event
    // Seems we get a system active event and valve events for all configured "enabled" valves when we ask siri to turn on/off
    // If we just turn on a valve if the system is not active, we get a "system" and "valve" event
    this.__activeCheck.push({"context": context, "value": value, "callback": callback, "type": type, "takeaction": true});

    if (this.__activeCheckTimer == null) {
        this.__activeCheckTimer = setTimeout(function() {
            var systemCount = this.__activeCheck.filter(({ type }) => type === "system" || type == "switch").length;
            var valveCount = this.__activeCheck.filter(({ type }) => type === "valve").length;

            this.__activeCheck.forEach((activeCheck, index) => {
                // Filter out events we dont want to action
                if (activeCheck.type == "system" && valveCount == 1) { 
                    // Turned on valve when system was off (inactive)
                    activeCheck.takeaction = false;
                }
                if (activeCheck.type == "valve" && (systemCount == 1 && this.enabledZones == valveCount)) {
                    // Siri action to turn on/off irrigation system, so make all valve actions as false
                    activeCheck.takeaction = false;
                }

                // Process callbacks
                if ((activeCheck.type == "system" || activeCheck.type == "switch") && activeCheck.takeaction == true) {
                    this.setIrrigationSystemState(activeCheck.value, activeCheck.callback);
                } else if ((activeCheck.type == "system" || activeCheck.type == "switch") && activeCheck.takeaction == false) {
                    activeCheck.callback(null); // process HomeKit callback without taking action
                }
                if (activeCheck.type == "valve" && activeCheck.takeaction == true) {

                    this.setZoneActive(activeCheck.context, activeCheck.value, activeCheck.callback);
                } else if (activeCheck.type == "valve" && activeCheck.takeaction == false) {
                    activeCheck.callback(null); // process HomeKit callback without taking action

                    // Workaround for active state of valves going to "waiting" when we dont want them to after the callback
                    setTimeout(function() {
                        this.ValveService.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.INACTIVE);
                        this.ValveService.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.NOT_IN_USE);
                        this.ValveService.getCharacteristic(Characteristic.RemainingDuration).updateValue(0);
                    }.bind(activeCheck.context), 500);   // Maybe able to reduce this from 500ms??? 
                }
            }); 

            this.__activeCheck = [];
            this.__activeCheckTimer = null;
        }.bind(this), 500);
    }
}

IrrigationSystemClass.prototype.__WaterPulseCounter = function(counterPin) {
    // Counts the pulses from the water flow sensor
    this.FlowPulseCount++;
}

IrrigationSystemClass.prototype.__WaterFlowStatus = function() {
    GPIO.poll(this.GPIO_FlowSensorPin, null);   // stop the pulse counter
    this.FlowPulseStop = Math.floor(Date.now());    // Time we stopped the pulse counter

    // We've got the number of pulses over a set period of time, so calculate flow rate and volume used in this period

    // Q (L/min) =  (F (Hz) / 1000) * factor (L/min)
    // V (L) = Q (L/Min) * (duration (min)
    var flowRate = (this.FlowPulseCount / ((this.FlowPulseStop - this.FlowPulseStart) / 1000)) * this.SensorFlowFactor;
    var flowVolume = flowRate * ((this.FlowPulseStop - this.FlowPulseStart) / 60000);
        
    var inactiveZones = 0;
    this.IrrigationZones.forEach(zone => {
        if (zone.RunningTimer != null) {
            zone.WaterTotal = zone.WaterTotal + flowVolume;  // Add total for the zone 
        } else {
            inactiveZones++;    // Add to inactive zone count
        }
    });

    // Add this flow rate/volume to the stored rolling values. We'll store the last 5 totals.
    if (this.FlowRates.length >= 5) this.FlowRates = [];
    this.FlowRates.push({flowRate, flowVolume});

    if (this.LeakSensorService != null && (Math.abs(Math.floor(Date.now() / 1000) - this.lastValveTime) >= 5) && this.FlowRates.length == 5) {
        // If we have a leak service setup, and the number of inactive zones equals configured zones and water is flowing, means a leak
        // Extra logic to not check for leaks within a few seconds (5secs ATM) of a valve opening or closing as water still not have settled in pipes
        var flowZeroCount = 0;
        for (var index in this.FlowRates) {
            if (this.FlowRates[this.FlowRates.length - 1].flowRate == 0) flowZeroCount++;
        }

        var newLeakStatus = ((inactiveZones == this.IrrigationZones.length && flowZeroCount == 0) ? Characteristic.LeakDetected.LEAK_DETECTED : Characteristic.LeakDetected.LEAK_NOT_DETECTED);
        if (this.LeakSensorService.getCharacteristic(Characteristic.LeakDetected).value != newLeakStatus) {
            // DEBUG
            console.log("DEBUG: old '%s' new '%s' zerocount %s (%s)", this.LeakSensorService.getCharacteristic(Characteristic.LeakDetected).value, newLeakStatus, flowZeroCount, this.FlowRates[0].flowRate, this.FlowRates[1].flowRate, this.FlowRates[2].flowRate, this.FlowRates[3].flowRate, this.FlowRates[4].flowRate);
            // DEBUG

            // Only update status HomeKit if required
            this.LeakSensorService.getCharacteristic(Characteristic.LeakDetected).updateValue(newLeakStatus);
            console.log("Irrigation system on '%s' reported leak status of '%s'", this.accessory.username, (newLeakStatus == Characteristic.LeakDetected.LEAK_DETECTED ? "Leak" : "No Leak"));
        }
    }

    this.FlowPulseCount = 0;
    this.FlowPulseStart = Math.floor(Date.now());   // Time we started the pulse counter
    GPIO.poll(this.GPIO_FlowSensorPin, this.__WaterPulseCounter.bind(this), GPIO.POLL_HIGH);   // Start the pulse counter
}

IrrigationSystemClass.prototype.__RainSensorStatus = function() {
    var currentRainSensor = GPIO.read(this.GPIO_RainSensorPin) ? Characteristic.LeakDetected.LEAK_NOT_DETECTED : Characteristic.LeakDetected.LEAK_DETECTED;
    if (this.RainSensorService.getCharacteristic(Characteristic.LeakDetected).value != currentRainSensor) {
        // "rain" sensor value changed, so update HomeKit
        this.RainSensorService.getCharacteristic(Characteristic.LeakDetected).updateValue(currentRainSensor);
    }
}

IrrigationSystemClass.prototype.__WeatherServiceStatus = function() {
    axios.get("https://api.darksky.net/forecast/" + this.weatherAPI + "/" + this.weatherLat + "," + this.weatherLong + "?units=si&exclude=minute,hourly", {timeout: 10000})
    .then(response => {
        if (response.status == 200) {
            if ((response.data.currently.precipProbability * 100) > 80) {
                // might be raining with probability over 80%
                console.log("Raining?? Weather data says current at '%s' with '%smm'", (response.data.currently.precipProbability * 100), (response.data.currently.precipIntensity * 10));
                this.RainSensorService.getCharacteristic(Characteristic.LeakDetected).updateValue(Characteristic.LeakDetected.LEAK_DETECTED);   // Raining ??
            } else {
                this.RainSensorService.getCharacteristic(Characteristic.LeakDetected).updateValue(Characteristic.LeakDetected.LEAK_NOT_DETECTED);   // No rain yet
            }
            //  console.log("-----------------------------------------------------------------------------------");
            //  console.log("Weather rain chance now: %s - %smm", (response.data.currently.precipProbability * 100), (response.data.currently.precipIntensity * 10));
            //  console.log("Weather rain chance 24hrs: %s - %smm", (response.data.daily.data[0].precipProbability * 100), (response.data.daily.data[0].precipIntensity * 10));
            //  console.log("Weather rain chance 48hrs: %s - %smm", (response.data.daily.data[1].precipProbability * 100), (response.data.daily.data[1].precipIntensity * 10));
            //  console.log("-----------------------------------------------------------------------------------");
        }
    })
    .catch(error => console.log("DEBUG: " + arguments.callee.name, AccessoryName, error.message));
}

IrrigationSystemClass.prototype.__WaterTankLevel = function() {
    // Gets the level of each water tank, averages and returns as total a percentage full across all tanks
    const scale = (num, in_min, in_max, out_min, out_max) => {
        if (num > in_max) num = in_max;
        if (num < in_min) num = in_min;
        return (num - in_min) * (out_max - out_min) / (in_max - in_min) + out_min;
    }
    const MINWORKABLE = 200;    // Minimum range for ultrasonic sensor in mm
    const MAXWORKABLE = 4500;   // maximum range for ultrasonic sensor in mm
    const NUMREADINGS = 5;      // Used to average readings
    var percentages = [];       // Array of measured percentages

    // get percentage full for each water tank
    this.WaterTanks.forEach(tank => {
        var actualDistance = 0;
        var averageDistance = 0;
        var percentageFull = 0;

        for (var index = 0; index < NUMREADINGS; index++) {
            const {spawnSync} = require("child_process");
            GPIO.msleep(1000);   // let system settle before calling
            var spawnProcess = spawnSync(process.cwd() + "/usonic_measure",[tank.GPIO_SensorTrigPin, tank.GPIO_SensorEchoPin]);
            if (spawnProcess['stdout']) {
                var response = spawnProcess.stdout.toString().toUpperCase();
                if (response == "OUT OF RANGE") {
                    // lets assume if we get an out of range measurement, we're below the minimin workable distance
                    actualDistance = MINWORKABLE;
                }
                if (response.split(":")[0] && response.split(":")[0] == "DISTANCE") {
                    // we have a distance measurement. formatted as "Distance: xxxx cm"
                    actualDistance  = response.split(" ")[1] * 10;  // Convert CM to MM
                    
                    // Baseline usonic measurement
                    if (actualDistance < MINWORKABLE) actualDistance = MINWORKABLE;
                    if (actualDistance > MAXWORKABLE) actualDistance = MAXWORKABLE;
                    if (actualDistance > tank.Height) actualDistance = tank.Height;
                }

                // Average readings
                averageDistance = averageDistance + actualDistance;
            }
        }
        averageDistance = averageDistance / NUMREADINGS;

        // Adjust the measured height if we have a minimum usable water level in tank, then scale
        // Since the minimum workable range might not be zero, scale the min usonic <> tank height into 0 <> tank height
        percentageFull = (((tank.Height - tank.MinLevel) - scale(averageDistance, MINWORKABLE, (tank.Height - tank.MinLevel), 0, (tank.Height - tank.MinLevel))) / (tank.Height - tank.MinLevel)) * 100;
    
        if (percentageFull < 0) percentageFull = 0;
        if (percentageFull > 100) percentageFull = 100;
        percentages.push({"distance": actualDistance, "percentage": percentageFull})
    });

    // Update water tanks percentage full in HomeKit
    var totalPercentageFull = 0;
    percentages.forEach(percentage => {
        totalPercentageFull += percentage.percentage;
    });
    totalPercentageFull = parseFloat((totalPercentageFull / percentages.length).toFixed(2));

    // Log total water percentage if different from previous reading and is less than 1% in difference
    // should help with erratic ultrasonic readings
    // Do we only work in whole percentages??
    if (this.lastWaterLevel == null || (Math.abs(totalPercentageFull - this.lastWaterLevel) <= 1)) {
        if (this.historyService != null) {
            // only log if past entry is 10mins or more ago or no entry found
            var historyEntry = this.historyService.lastHistory(Characteristic.WaterLevel);
            if (historyEntry == null || (typeof historyEntry == "object" && Math.abs(Math.floor(new Date() / 1000) - historyEntry.time) >= 600)) {
                this.historyService.addHistory(Characteristic.WaterLevel, {time: Math.floor(new Date() / 1000), level: totalPercentageFull});
            }
        }
        this.IrrigationService.getCharacteristic(Characteristic.WaterLevel).updateValue(totalPercentageFull);
    }
    this.lastWaterLevel = totalPercentageFull;  // Cache reading
}

IrrigationSystemClass.prototype.__ZoneRunningTimer = function(context, startTimerMS, endTimerMS) {
    if (context.GroupRunningZone != null) {
        // running a zone group, so track current zone and when completed, moved to next in group until no more enabled zones
        if (Math.floor(Date.now() / 1000) >= this.IrrigationZones[context.GroupRunningZone].endTimerMS) {
            // Reach end of zone runtime
            this.IrrigationZones[context.GroupRunningZone].endTimerMS = 0;
            this.__closeValve((this.IrrigationZones[context.GroupRunningZone].UseMasterValve == true ? this.GPIO_MasterValvePin : 0), this.IrrigationZones[context.GroupRunningZone].GPIO_ValvePin, this.IrrigationZones[context.GroupRunningZone].Name, context.Name);

            // find next enabled zone to start as part of the group
            var startIndex = context.belongsTo.indexOf(context.GroupRunningZone) + 1;
            context.GroupRunningZone = null;
            for (var index = startIndex; index < context.belongsTo.length; index++) {
                // still have more zones to run, so find next "enabled" zone in this group
                if (this.IrrigationZones[context.belongsTo[index]].Enabled == true && context.GroupRunningZone == null) {
                    context.GroupRunningZone = context.belongsTo[index];    // Store internal ID for group to run
                }
            }
            if (context.GroupRunningZone != null) {
                var tempZoneRuntime = context.UseGroupRuntime == true ? (context.Runtime / context.belongsTo.length) : this.IrrigationZones[context.GroupRunningZone].Runtime;
                this.IrrigationZones[context.GroupRunningZone].endTimerMS = Math.floor(Date.now() / 1000) + tempZoneRuntime;
                this.__openValve((this.IrrigationZones[context.GroupRunningZone].UseMasterValve == true ? this.GPIO_MasterValvePin : 0), this.IrrigationZones[context.GroupRunningZone].GPIO_ValvePin, this.IrrigationZones[context.GroupRunningZone].Name, context.Name);
            }
        }
    }
    context.ValveService.getCharacteristic(Characteristic.RemainingDuration).updateValue(endTimerMS - Math.floor(Date.now() / 1000));
    if (Math.floor(Date.now() / 1000) >= endTimerMS) {
        clearInterval(context.RunningTimer);
        context.RunningTimer = null;
        if (context.GPIO_ValvePin != null) {
            context.endTimerMS = 0;
            this.__closeValve((context.UseMasterValve == true ? this.GPIO_MasterValvePin : 0), context.GPIO_ValvePin, context.Name, "");
        }
        if (context.GPIO_ValvePin == null) {
            if (context.GroupRunningZone != null) {
                this.IrrigationZones[context.GroupRunningZone].endTimerMS = 0;
                this.__closeValve((this.IrrigationZones[context.GroupRunningZone].UseMasterValve == true ? this.GPIO_MasterValvePin : 0), this.IrrigationZones[context.GroupRunningZone].GPIO_ValvePin, this.IrrigationZones[context.GroupRunningZone].Name, context.Name);
            }
        }
        context.GroupRunningZone = null;
        context.ValveService.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.INACTIVE);
        context.ValveService.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.NOT_IN_USE);
        context.ValveService.getCharacteristic(Characteristic.RemainingDuration).updateValue(0);

        // Log water usage after zone turned off and reset water total
        if (this.historyService != null) this.historyService.addHistory(context.ValveService, {time: Math.floor(new Date() / 1000), status: 0, water: context.WaterTotal.toFixed(4), duration: context.ValveService.getCharacteristic(Characteristic.SetDuration).value});  // Valve closed
        context.WaterTotal = 0;
    }
}

IrrigationSystemClass.prototype.__openValve = function(GPIO_MasterPin, GPIO_ValvePin, zoneName, zoneGroup) {
    if (GPIO_MasterPin > 0) {
        GPIO.write(GPIO_MasterPin, GPIO.HIGH);  // Open master valve first if required
    }
    // Output a high signal on the GPIO, this will trigger the connected relay to open
    GPIO.write(GPIO_ValvePin, GPIO.HIGH);
    this.lastValveTime = Math.floor(Date.now() / 1000);    // Store time of valve opening

    if (zoneName != "" && zoneGroup == "") console.log("Irrigation zone '%s' on GPIO pin '%s' was turned 'On'", zoneName, GPIO_ValvePin);
    if (zoneGroup != "" && zoneName != "") console.log("Irrigation group '%s' using zone '%s' on GPIO pin '%s' was turned 'On'", zoneGroup, zoneName, GPIO_ValvePin);
}

IrrigationSystemClass.prototype.__closeValve = function(GPIO_MasterPin, GPIO_ValvePin, zoneName, zoneGroup) {
    // Output a low signal on the GPIO, this will trigger the connected relay to close. If there is a master valve configured, we'll close that after 
    var activeZones = 0;
    this.IrrigationZones.forEach(zone => {
        if (zone.RunningTimer != null) {
            activeZones++; // add to active zone count
        }
    });

    GPIO.write(GPIO_ValvePin, GPIO.LOW);

    // Only close master valve if all zones have finished being active
    if (GPIO_MasterPin > 0 && activeZones == 0) {
        GPIO.write(GPIO_MasterPin, GPIO.LOW);  // Close master valve last
    }
    this.lastValveTime = Math.floor(Date.now() / 1000);    // Store time of valve closing

    if (zoneName != "" && zoneGroup == "") console.log("Irrigation zone '%s' on GPIO pin '%s' was turned 'Off'", zoneName, GPIO_ValvePin);
    if (zoneGroup != "" && zoneName != "") console.log("Irrigation group '%s' using zone '%s' on GPIO pin '%s' was turned 'Off'", zoneGroup, zoneName, GPIO_ValvePin);
}

IrrigationSystemClass.prototype.__EveHomeGetCommand = function(data) {
    // Pass back extra data for Eve Aqua "get" process command
    data.firmware = this.EveHome.Firmware;
    data.flowrate = this.EveHome.Flowrate;
    data.enableschedule = this.EveHome.Programs.Enabled;
    return data;
}

IrrigationSystemClass.prototype.__EveHomeSetCommand = function(processed) {
    if (processed.hasOwnProperty("days")) {
        // EveHome suspension scene triggered from HomeKit
        // 0 days = pause for today
        // 1 day = pause for today and tomorrow
        // get remaining seconds to midnight in our timezone (as date.now() is GMT time), then work out delay             
        this.EveHome.PauseTimeout = Math.floor(Math.floor(Date.now() / 1000) + (((8.64e7 - (Date.now() - new Date().getTimezoneOffset() * 6e4) % 8.64e7) / 6e4) * 60) + (processed.days * 86400));    // Timeout date/time in seconds
        if (this.getIrrigationSystemState() == true) this.setIrrigationSystemState(Characteristic.Active.INACTIVE);  // turn off system since its on
        this.saveConfiguration();   // Update configuration

        console.log("Irrigation system on '%s' has watering paused for '%s'", this.accessory.username, (processed.days == 0 ? "today" : "today and tomorrow"));
    }

    if (processed.hasOwnProperty("flowrate")) {
        // Updated flowrate from Eve Home app
        this.EveHome.Flowrate = processed.flowrate;
        this.saveConfiguration();
    }

    if (processed.hasOwnProperty("enabled")) {
        // Scheduling on/off and/or timezone & location information
    }

    if (processed.hasOwnProperty("programs")) {
        processed.programs.forEach(program => {
        });
    }

    if (processed.hasOwnProperty("childlock")) {
    }
}

// General functions
function getSystemMACAddress(maxTries, retryDelay) {
    // todo - determine active connection, either wifi or ethernet.
    var systemMAC = "";
    var tryCount = 0;
    var networkInterfaces = os.networkInterfaces();

    while (tryCount <= maxTries && systemMAC == "") {
        Object.keys(networkInterfaces).forEach(interface => {
            networkInterfaces[interface].forEach(interface => {
                if ((interface.family.toUpperCase() == "IPV4" || interface.internal == true) && interface.mac != "00:00:00:00:00:00") {
                    // found a MAC address
                    systemMAC = interface.mac.toUpperCase(); 
                }
            });
        });
        if (systemMAC == "") {
            // Didn't get a MAC address, so pause for retry delay before trying again
            tryCount++;
            GPIO.sleep(retryDelay);
        }
    }
    return systemMAC;
}


// Startup code
var IrrigationSystem = new IrrigationSystemClass();
var config = IrrigationSystem.loadConfiguration();   // Load configuration, if configuration not present, defaults will be used

// Use the wifi mac address for the HomeKit username, unless overridden
if (config.system.MacAddress != "") {
    var AccessoryUsername = config.system.MacAddress;   // Use MacAddress as defined in configuration if not blank
} else {
    var AccessoryUsername = getSystemMACAddress(5, 30000);  // retry 5 times, and 30secs delay between each try
}
if (AccessoryUsername != "") {
    // Create the irrigation accessory
    var irrigationAccessory = exports.accessory = new Accessory(AccessoryName, uuid.generate("hap-nodejs:accessories:irrigation_" + AccessoryName));
    irrigationAccessory.username = AccessoryUsername; 
    irrigationAccessory.pincode = AccessoryPincode;
    irrigationAccessory.category = Accessory.Categories.SPRINKLER;  // Sprinkler type acessory
    irrigationAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, AccessoryManufacturer);
    irrigationAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Model, AccessoryModel);
    irrigationAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.SerialNumber, AccessorySerialNumber);
    irrigationAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, AccessoryFirmwareRevision);

    IrrigationSystem.addIrrigationSystem(irrigationAccessory, AccessoryName, config);

    // Create "physical zones" as defined in the config
    config.zones.forEach(zone => {
        IrrigationSystem.addIrrigationZone(zone);
    });

    // Create "virtual zones" from any associated grouping
    // A virtual zone is a grouping of on or more physical zones which get treated as a single zone for runnning/configuration
    config.groups.forEach(group => {
        IrrigationSystem.addIrrigationGroup(group);
    });

    IrrigationSystem.addFlowSensor(config.system.FlowSensorPin, config.system.FlowSensorRate, config.system.WaterLeakAlert);
    IrrigationSystem.addMasterValve(config.system.MasterValvePin);

    // Add in any defined water tanks
    config.tanks.forEach(tank => {
        tank.Enabled == true && IrrigationSystem.addWaterTank(tank.TankHeight, tank.MinimumLevel, tank.SensorTrig, tank.SensorEcho)
    });

    // Enable weather services if configured
    config.weather.Enabled == true && IrrigationSystem.addRainSensor("online", config.weather.WeatherAPIKey, config.weather.WeatherLatLoc, config.weather.WeatherLongLoc);
    config.weather.Enabled == true && IrrigationSystem.addRainSensor("hw", config.weather.RainSensorPin);    // Using hardware PIN (just a switch input hi/low

    // lastly, set virtual power status of irrigation system based on system saved state. 
    IrrigationSystem.setIrrigationSystemState(config.system.PowerState.toUpperCase() == "ON" && config.eveapp.PauseTimeout == 0 ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE, null);
    IrrigationSystem.refreshHomeKit();

    // Setup event timer for various functions
    // TODO - schedules??
    setInterval(function() {
        // Monitoring pausing of system and un-pause if needed
        if (this.EveHome.pauseTimeout != 0 && (Math.floor(Date.now() / 1000) >= this.EveHome.pauseTimeout)) {
            // Pause tomeout expired, so turn system back on
            this.setIrrigationSystemState(Characteristic.Active.ACTIVE);
            this.saveConfiguration();   // Update configuration
            console.log("Irrigation system on '%s' has watering resumed after pausing", this.accessory.username);
        }
    }.bind(IrrigationSystem), 5000);    // Every 5 seconds. maybe every second??
}
else {
    console.log("Failed to get system MAC for Irrigation System");
}


// cleanup if process stopped.. Mainly used to ensure valves are closed if process stops
var signals = { 'SIGINT': 2, 'SIGTERM': 15 };
Object.keys(signals).forEach(function (signal) {
    process.on(signal, function () {
        for (var index in IrrigationSystem.IrrigationZones) {
            GPIO.write(IrrigationSystem.IrrigationZones[index].GPIO_ValvePin, GPIO.LOW);
            GPIO.close(IrrigationSystem.IrrigationZones[index].GPIO_ValvePin);
        }
        if (IrrigationSystem.GPIO_MasterValvePin != 0) GPIO.close(IrrigationSystem.GPIO_MasterValvePin);    // Close master valve if present
    });
});
