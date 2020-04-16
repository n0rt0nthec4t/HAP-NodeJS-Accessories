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
// -- evehome aqua recording of water usage (fakegato-history) or someother history recording
//
// done
// -- use system WIFI mac addr as AccessoryUsername
// -- low tank level distance (ie: minimun water level)
// -- virtual power switch
// -- save changes to zone names
// -- restructured code
// -- save configuration changes in off-line file for when system restarted
// -- master valve support and configurable per zone
// -- hardware rain sensor input
// -- flow meter - measure water usage & leaking
// -- support more than one tank - agregate water levels between then all as one percentage
// -- Can use hey sito to turn off/on system or configure to have a vitual power switch
// -- updated to use npm version of hap-nodejs directory structure (11/4/2020) 
//
// bugs
// -- running as a service at system startup, MAC address isnt returned when no IP assigned to wifi. Maybe just lopp until assigned?. 
//    26/4/2019 -- Changed service startup to wait for network. Monitor
// -- If more than one zone is operating and zone switched off with master valve configuration will stop other zone. Need to change logic
//
// Version 11/4/2020
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

// Defines for the accessory
const AccessoryName =  "Irrigation System";             // name of accessory
const AccessoryPincode = "031-45-154";                  // pin code for pairing 
const AccessoryManufacturer = "Mark Hulskamp";          // manufacturer (optional)
const AccessoryModel = "HomeKit Irrigation v3";         // model (optional)
const AccessorySerialNumber = "MH20200411";             // serial number (optional) 
const AccessoryFirmwareRevision = JSONPackage.version;  // firmware revision (optional)

const WATERFLOWTIMER = 1000;                // Timer in ms for water flow testing

// Create the "valve" object. 
function ZoneClass() {
    this.ValveService = null;               // HomeKit service for this valve
    this.RunningTimer = null;               // timer for sprinkler runtime
    this.Name = "";                         // name of the zone
    this.Runtime = 0;                       // Zone runtime in seconds
    this.MaxRuntime = 0;                    // Maximum time zone can run in seconds. 0 = HomeKit default (3600s)
    this.Enabled = false;                   // Is the zone enabled
    this.GPIO_ValvePin = 0;                 // GPIO Pin for valve control
    this.WaterTotal = 0;                    // Accumlative water flow total in litres
    this.UseMasterValve = false;            // Does this zone need to use the master valve
}

// Create the irrigation system object. 
function IrrigationSystemClass() {
    this.accessory = null;                  // Parent accessory object
    this.IrrigationService = null;          // HomeKit service for this irrigation system
    this.PowerSwitchService = null;         // HomeKit service for "virtual" on/off switch
    this.MaximumActiveZones = 1;            // Maximum active/running zones at any one time
    
    this.PowerState = false;

    this.IrrigationZones = [];              // Array of irrigation zones (the valves)
    this.enabledZones = 0;                  // Numnber of enabled zones
    this.GPIO_MasterValvePin = 0;           // GPIO pin for master valve. 0 = no master valve enabled

    this.RainSensorService = null;          // HomeKit service for "virtual" rain sensor
    this.GPIO_RainSensorPin = 0;            // GPIO pin for hardware rain sensor input. 0 = disabled
    this.weatherAPI = "";                   // cached darksky.net weather API key
    this.weatherLat = "";                   // cached darksky.net weather Lat location
    this.weatherLong = "";                  // cached darksky.net weather Long location

    this.WaterTanks = [];                   // Array of water tanks under this system

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
}

IrrigationSystemClass.prototype = {
    loadConfiguration: function() {
        // Loads the configuration from disk and validates entries if present
        var config = {};

        if (fs.existsSync(__filename.split('_accessory.js')[0] + "_config.json")) {
            config = require(__filename.split('_accessory.js')[0] + "_config.json");
        }
        if (config.hasOwnProperty("tanks") == false) config.tanks = [];
        if (config.hasOwnProperty("system") == false) config.system = {};
        if (config.hasOwnProperty("weather") == false) config.weather = {};
        if (config.hasOwnProperty("zones") == false) config.zones = [];

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
            config.zones[index].MaxRunTime = (config.zones[index].hasOwnProperty("MaxRunTime") && parseInt(config.zones[index].MaxRunTime) > 0 ? parseInt(config.zones[index].MaxRunTime) : 3600);
            config.zones[index].MasterValve = (config.zones[index].hasOwnProperty("MasterValve") && typeof config.zones[index].MasterValve == "boolean" ? config.zones[index].MasterValve : false);
        }
        
        return config;
    },

    saveConfiguration: function() {
        var config = this.loadConfiguration();  // Load saved config before updating
        
        // Update tank section

        // update system section
        config.system.PowerState = (this.getIrrigationSystemState() == true ? "on" : "off");
        
        // update weather section

        // Update zone details
        config.zones = [];
        this.IrrigationZones.forEach(zone => {
            config.zones.push({"Name": zone.Name, "Enabled": zone.Enabled == 1 ? true : false, "MaxRunTime": zone.MaxRuntime, "RunTime": zone.Runtime, "RelayPin": zone.GPIO_ValvePin, "MasterValve": zone.UseMasterValve});
        });
 
        // Write updated config back
        fs.writeFileSync(__filename.split('_accessory.js')[0] + "_config.json", JSON.stringify(config, null, 3));
    },


    addIrrigationSystem: function(HomeKitAccessory, thisServiceName, configPowerSwitch) {
        this.accessory = HomeKitAccessory;
        this.IrrigationService = this.accessory.addService(Service.IrrigationSystem, thisServiceName, 1);

        if (configPowerSwitch == true) {
            // create switch for a virtual "power button" to turn on/off irrigation system via HomeKit. If switched off, system will not open values/zones
            this.PowerSwitchService = this.accessory.addService(Service.Switch, "Power", 1);
            this.IrrigationService.addLinkedService(this.PowerSwitchService);

            // Setup HomeKit callbacks for included virtual power switch
            this.PowerSwitchService.getCharacteristic(Characteristic.On).on('set', (value, callback) => {this.__processActiveCharacteristic(this, value, callback, "switch")});
        } else {
            // Only use siri to turn on/off system
            this.IrrigationService.getCharacteristic(Characteristic.Active).on('set', (value, callback) => {this.__processActiveCharacteristic(this, value, callback, "system")});
        }

        this.accessory.setPrimaryService(this.IrrigationService);

        console.log("Created irrigation system on '%s'", this.accessory.username);
    },

    addMasterValve: function(configMasterPin) {
        var retValue = false;

        if (configMasterPin != 0) {
            this.GPIO_MasterValvePin = configMasterPin;

            // Initialise the GPIO input/output PINs for the master valve
            GPIO.init({gpiomem: true}); // this only needs to be done once, but it's here each time anyway
            GPIO.init({mapping: 'gpio'}); // this only needs to be done once, but it's here each time anyway
            GPIO.open(this.GPIO_MasterValvePin, GPIO.OUTPUT, GPIO.LOW);

            console.log("Enabled master valve on '%s' using GPIO pin '%s'", this.accessory.username, this.GPIO_MasterValvePin);
            retValue = true;    // Setup OK
        }
        return retValue;
    },

    addFlowSensor: function(configFlowSensorPin, configFlowSensorRate, configWaterLeakAlert) {
        var retValue = false;
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
            retValue = true;    // Setup OK
        }
        return retValue;
    },
 
    addIrrigationZone: function(zoneDetails) {
        var retValue = false;
        var tempZone;

        if (zoneDetails && typeof zoneDetails == 'object') {
            tempZone = new ZoneClass();
            tempZone.Name = zoneDetails.Name;
            tempZone.GPIO_ValvePin = zoneDetails.RelayPin;
            tempZone.Runtime = zoneDetails.RunTime;
            tempZone.Enabled = zoneDetails.Enabled;
            tempZone.MaxRuntime = zoneDetails.MaxRunTime;
            tempZone.UseMasterValve = zoneDetails.MasterValve;

            tempZone.ValveService = this.accessory.addService(Service.Valve, zoneDetails.Name, (this.IrrigationZones.length + 1));
            tempZone.ValveService.getCharacteristic(Characteristic.ValveType).updateValue(Characteristic.ValveType.IRRIGATION);
            tempZone.ValveService.addCharacteristic(Characteristic.SetDuration);
            tempZone.ValveService.addCharacteristic(Characteristic.RemainingDuration);
            tempZone.ValveService.addCharacteristic(Characteristic.IsConfigured);
            tempZone.ValveService.addCharacteristic(Characteristic.ConfiguredName);
    
            tempZone.ValveService.getCharacteristic(Characteristic.ConfiguredName).updateValue(zoneDetails.Name);
            tempZone.ValveService.getCharacteristic(Characteristic.ServiceLabelIndex).updateValue(this.IrrigationZones.length + 1);
            
            // setup default runtime if configured and ensure within defined bounds of the characteristic 
            if (tempZone.MaxRuntime > 0) {
                tempZone.ValveService.getCharacteristic(Characteristic.SetDuration).setProps({maxValue: tempZone.MaxRuntime});   
            }
            if (tempZone.Runtime > 0) {
                if (tempZone.RunTime < tempZone.ValveService.getCharacteristic(Characteristic.SetDuration).props.minValue) tempZone.Runtime = tempZone.ValveService.getCharacteristic(Characteristic.SetDuration).props.minValue;
                if (tempZone.RunTime > tempZone.ValveService.getCharacteristic(Characteristic.SetDuration).props.maxValue) tempZone.Runtime = tempZone.ValveService.getCharacteristic(Characteristic.SetDuration).props.maxValue;
                tempZone.ValveService.getCharacteristic(Characteristic.SetDuration).updateValue(tempZone.Runtime);
            }
    
            // Setup zone enabled or disabled
            // seems to be a bug in HomeKit/iOS 12 that this value doesnt change via home app.
            tempZone.ValveService.getCharacteristic(Characteristic.IsConfigured).updateValue((tempZone.Enabled == true) ? Characteristic.IsConfigured.CONFIGURED : Characteristic.IsConfigured.NOT_CONFIGURED);
            if (tempZone.Enabled == true) this.enabledZones++;  // Add to count of enabled zones
    
            // Initialise the GPIO input/output PINs for this valve
            GPIO.init({gpiomem: true}); // this only needs to be done once, but it's here each time anyway
            GPIO.init({mapping: 'gpio'}); // this only needs to be done once, but it's here each time anyway
            if (tempZone.GPIO_ValvePin != 0) GPIO.open(tempZone.GPIO_ValvePin, GPIO.OUTPUT, GPIO.LOW);

            this.IrrigationService.addLinkedService(tempZone.ValveService);
            this.IrrigationZones.push(tempZone);
    
            // Setup HomeKit callbacks
            //tempZone.ValveService.getCharacteristic(Characteristic.Active).on('set', (value, callback) => {this.setZoneActive(tempZone, value, callback)});
            tempZone.ValveService.getCharacteristic(Characteristic.Active).on('set', (value, callback) => {this.__processActiveCharacteristic(tempZone, value, callback, "valve")});
            tempZone.ValveService.getCharacteristic(Characteristic.ConfiguredName).on('set', (value, callback) => {this.setZoneName(tempZone, value, callback)});
            tempZone.ValveService.getCharacteristic(Characteristic.IsConfigured).on('set', (value, callback) => {this.setZoneState(tempZone, value, callback)});
            tempZone.ValveService.getCharacteristic(Characteristic.IsConfigured).on('get', (callback) => {this.getZoneState(tempZone, callback)});
            tempZone.ValveService.getCharacteristic(Characteristic.SetDuration).on('set', (value, callback) => {this.setZoneRuntime(tempZone, value, callback)});
            tempZone.ValveService.getCharacteristic(Characteristic.SetDuration).on('get', (callback) => {this.getZoneRuntime(tempZone, callback)});
    
            console.log("Added irrigation zone '%s' on '%s' using GPIO pin '%s'", tempZone.Name, this.accessory.username, tempZone.GPIO_ValvePin);
            retValue = true;    // Setup OK
        }
        return retValue;
    },

    addWaterTank: function(tankHeight, minTankLevel, tankSensorTrigPin, tankSensorEchoPin) {
        var retValue = false;
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
            retValue = true;    // Setup OK
        }
        return retValue;
    },

    addRainSensor: function(rainSensorType, /*,,,,,,,,, */) {
        var retValue = false;

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
                    retValue = true;    // Setup OK
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
                    retValue = true;    // Setup OK
                }
                break;
            }
        }
        
        return retValue
    },

    refreshHomeKit: function() {
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
    },

    getIrrigationSystemState: function(callback) { 
        if (typeof callback === 'function') callback(null, this.PowerState);  // do callback if defined
        return this.PowerState;
    },

    setIrrigationSystemState: function(value, callback) {
        // Turns the irrigation system "virtually" on or off
        // If we're not using the virtual power switch and only using siri, we need to check if a valve going active trigger this

        // If turning off system, and any valves are opened, finish them running
        if (value == Characteristic.Active.INACTIVE) {
                this.IrrigationZones.forEach(zone => {
                if (zone.ValveService.getCharacteristic(Characteristic.Active).value == Characteristic.Active.ACTIVE) {
                    this.setZoneActive(zone, Characteristic.Active.INACTIVE, null);
                }
            });
        }
        this.IrrigationService.getCharacteristic(Characteristic.ProgramMode).updateValue((value == true ? Characteristic.ProgramMode.PROGRAM_SCHEDULED_MANUAL_MODE_ : Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED));
        this.IrrigationService.getCharacteristic(Characteristic.Active).updateValue((value == true ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE));

        if(this.PowerSwitchService != null) {
            this.PowerSwitchService.getCharacteristic(Characteristic.On).updateValue(value);
        }

        this.PowerState = this.IrrigationService.getCharacteristic(Characteristic.Active).value == Characteristic.Active.ACTIVE ? true : false;

        console.log("Irrigation system on '%s' turned '%s'", this.accessory.username, (value == true ? "On" : "Off"));

        // Save configuration
        this.saveConfiguration();
        if (typeof callback === 'function') callback();  // do callback if defined
    },

    setZoneState: function(context, value, callback) {
        // context = zoneObject
        context.Enabled = (value == Characteristic.IsConfigured.CONFIGURED) ? true : false; 
        context.ValveService.getCharacteristic(Characteristic.IsConfigured).updateValue(value);
        
        // Update enabled zone count
        if (value == Characteristic.IsConfigured.CONFIGURED) this.enabledZones++ 
        else this.enabledZones--;

        // Save configuration
        this.saveConfiguration();

        if (typeof callback === 'function') callback();  // do callback if defined
    },

    getZoneState: function(context, callback) {
        // context = zoneObject
        callback(null,  context.Enabled);
    },

    setZoneActive: function(context, value, callback) {
        // Run/stop the requested irrigation zone
        // context = ZoneObject
        // value = Characteristic.Active.ACTIVE or Characteristic.Active.INACTIVE
        // callback = callback function
        var openValveCount = 0;
        var shortestRunTime = null;
  
        if (context.ValveService.getCharacteristic(Characteristic.IsConfigured).value == Characteristic.IsConfigured.CONFIGURED) {
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

                // TESTING flow usage
                context.WaterTotal = 0;
                // TESTING flow usage

                this.__openValve((context.UseMasterValve == true ? this.GPIO_MasterValvePin : 0), context.GPIO_ValvePin, context.Name);
                context.ValveService.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.ACTIVE);
                context.ValveService.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.IN_USE);
                context.ValveService.getCharacteristic(Characteristic.RemainingDuration).updateValue(context.ValveService.getCharacteristic(Characteristic.SetDuration).value);
                context.RunningTimer = setInterval(this.__ZoneRunningTimer.bind(this), 100, context, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000) + context.ValveService.getCharacteristic(Characteristic.SetDuration).value);
            } else if (this.getIrrigationSystemState() == false && (value == Characteristic.Active.ACTIVE) && (context.ValveService.getCharacteristic(Characteristic.Active).value == Characteristic.Active.INACTIVE) && this.getIrrigationSystemState() == false) {
                // Requested to turn on a valve, but the irrigation system is switched off.. work around need??
                setTimeout(function() {
                    this.ValveService.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.INACTIVE);
                    this.ValveService.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.NOT_IN_USE);
                    this.ValveService.getCharacteristic(Characteristic.RemainingDuration).updateValue(0);
                }.bind(context), 500);    // Maybe able to reduce this from 500ms??? 
            } else if ((value == Characteristic.Active.INACTIVE) && (context.ValveService.getCharacteristic(Characteristic.Active).value == Characteristic.Active.ACTIVE)) {
                
                // TESTING flow usage
                console.log("'%s' used '%sL' over '%ss'", context.Name, context.WaterTotal.toFixed(4), (context.ValveService.getCharacteristic(Characteristic.SetDuration).value - context.ValveService.getCharacteristic(Characteristic.RemainingDuration).value));
                context.WaterTotal = 0;
                // TESTING flow usage
                
                clearInterval(context.RunningTimer);
                context.RunningTimer = null;
                this.__closeValve((context.UseMasterValve == true ? this.GPIO_MasterValvePin : 0), context.GPIO_ValvePin, context.Name);
                context.ValveService.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.INACTIVE);
                context.ValveService.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.NOT_IN_USE);
                context.ValveService.getCharacteristic(Characteristic.RemainingDuration).updateValue(0);
            }
        }
        if (typeof callback === 'function') callback();  // do callback if defined
    },

    setZoneName(context, value, callback) {
        // context = zoneObject
        context.Name = value;
        context.ValveService.getCharacteristic(Characteristic.ConfiguredName).updateValue(value);

        // Save configuration
        this.saveConfiguration();

        callback();
    },

    setZoneRuntime: function(context, value, callback) {
        // context = zoneObject
        context.Runtime = value;
        context.ValveService.getCharacteristic(Characteristic.SetDuration).updateValue(value);
        if (context.ValveService.getCharacteristic(Characteristic.Active).value == Characteristic.Active.ACTIVE) {
            // Sprinkler is running, so re-adjust timing
            clearInterval(context.RunningTimer);
            context.RunningTimer = null;
            context.ValveService.getCharacteristic(Characteristic.RemainingDuration).updateValue(value);
            context.RunningTimer = setInterval(this.__ZoneRunningTimer.bind(this), 100, context, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000) + value);
        }

        // Save configuration
        this.saveConfiguration();

        callback();
    },

    getZoneRuntime: function(context, callback) {
        // context = zoneObject
        callback(null,  context.Runtime);
    },

    __processActiveCharacteristic(context, value, callback, type) {
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

                        // Workaround for active state of valves going to "waiting" when we dont want them too after the callback
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
    },

    __WaterPulseCounter: function(counterPin) {
        // Counts the pulses from the water flow sensor
        this.FlowPulseCount++;
    },

    __WaterFlowStatus: function() {
        GPIO.poll(this.GPIO_FlowSensorPin, null);   // stop the pulse counter
        this.FlowPulseStop = Math.floor(Date.now());    // Time we stopped the pulse counter

        // We've got the number of pulses over a set period of time, so calculate flow rate and volume used in this period

        // Q (L/min) =  (F (Hz) / 1000) * factor (L/min)
        // V (L) = Q (L/Min) * (duration (min)
        var flowRate = (this.FlowPulseCount / ((this.FlowPulseStop - this.FlowPulseStart) / 1000)) * this.SensorFlowFactor;
        var flowVolume = flowRate * ((this.FlowPulseStop - this.FlowPulseStart) / 60000);
           
        var inactiveZoneCount = 0;
        this.IrrigationZones.forEach(zone => {
            if (zone.ValveService.getCharacteristic(Characteristic.Active).value == Characteristic.Active.ACTIVE) {
                zone.WaterTotal = zone.WaterTotal + flowVolume;  // Add total for the zone 
                // todo
                // -- evehome aqua recording of water usage (fakegato-history)
                // maybe need to total up water usage for more than a 1 sec period.. or maybe when valve closes just add to history then
            } else {
                inactiveZoneCount++;
            }
        });

        // Add this flow rate/volume to the stored rolling values. We'll store the last 5 totals.
        if (this.FlowRates.length >= 5) this.FlowRates = [];
        this.FlowRates.push({flowRate, flowVolume});

        if (this.LeakSensorService != null && (Math.floor(Date.now() - this.lastValveTime >= 5000)) && this.FlowRates.length == 5) {
            // If we have a leak service setup, and the number of inactive zones equals configured zones and water is flowing, means a leak
            // Extra logic to not check for leaks within a few seconds (5secs ATM) of a valve opening or closing as water still not have settled in pipes
            var flowZeroCount = 0;
            for (var index in this.FlowRates) {
                if (this.FlowRates[this.FlowRates.length - 1].flowRate == 0) flowZeroCount++;
            }

            var newLeakStatus = ((inactiveZoneCount == this.IrrigationZones.length && flowZeroCount == 0) ? Characteristic.LeakDetected.LEAK_DETECTED : Characteristic.LeakDetected.LEAK_NOT_DETECTED);
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
    },

    __RainSensorStatus: function() {
        var currentRainSensor = GPIO.read(this.GPIO_RainSensorPin) ? Characteristic.LeakDetected.LEAK_NOT_DETECTED : Characteristic.LeakDetected.LEAK_DETECTED;
        if (this.RainSensorService.getCharacteristic(Characteristic.LeakDetected).value != currentRainSensor) {
            // "rain" sensor value changed, so update HomeKit
            this.RainSensorService.getCharacteristic(Characteristic.LeakDetected).updateValue(currentRainSensor);
        }
    },

    __WeatherServiceStatus: function() {
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
    },

    __WaterTankLevel: function() {
        // Gets the level of each water tank, averages and returns as total a percentage full across all tanks
        const scale = (num, in_min, in_max, out_min, out_max) => {
            if (num > in_max) num = in_max;
            if (num < in_min) num = in_min;
            return (num - in_min) * (out_max - out_min) / (in_max - in_min) + out_min;
        }
        const minWorkable = 200;    // Minimum range for ultrasonic sensor in mm
        const maxWorkable = 4500;   // maximum range for ultrasonic sensor in mm
        var percentages = [];       // Array of measured percentages

        // get percentage full for each water tank
        this.WaterTanks.forEach(tank => {
            var measuredDistance = 0;
            var percentageFull = 0;

            const {spawnSync} = require("child_process");
            GPIO.msleep(500);   // let system settle before calling
            var spawnProcess = spawnSync("/home/pi/HAP-NodeJS/usonic_measure",[tank.GPIO_TankSensorPin, tank.GPIO_SensorEchoPin]);
            if (spawnProcess['stdout']) {
                measuredDistance = (spawnProcess.stdout.toString() * 10);   // Convert CM to MM
            }

            // Baseline usonic measurement
            if (measuredDistance < minWorkable) measuredDistance = minWorkable;
            if (measuredDistance > maxWorkable) measuredDistance = maxWorkable;
            if (measuredDistance > tank.Height) measuredDistance = tank.Height;

            // Adjust the measured height if we have a minimum usable water level in tank, then scale
            // Since the minimum workable range might not be zero, scale the min usonic <> tank height into 0 <> tank height
            percentageFull = (((tank.Height - tank.MinLevel) - scale(measuredDistance, minWorkable, (tank.Height - tank.MinLevel), 0, (tank.Height - tank.MinLevel))) / (tank.Height - tank.MinLevel)) * 100;
        
            if (percentageFull < 0) percentageFull = 0;
            if (percentageFull > 100) percentageFull = 100;
            percentages.push({"distance": measuredDistance, "percentage": percentageFull})
        });

        // Update water tanks percentage full in HomeKit
        var totalPercentageFull = 0;
        percentages.forEach(percentage => {
            totalPercentageFull += percentage.percentage;
        });
        totalPercentageFull = totalPercentageFull / percentages.length;
        this.IrrigationService.getCharacteristic(Characteristic.WaterLevel).updateValue(totalPercentageFull);

        return totalPercentageFull;
    },

    __ZoneRunningTimer: function(context, startTimerMS, endTimerMS) {
        context.ValveService.getCharacteristic(Characteristic.RemainingDuration).updateValue(endTimerMS - Math.floor(Date.now() / 1000));
        if (context.ValveService.getCharacteristic(Characteristic.RemainingDuration).value <= 0) {
            clearInterval(context.RunningTimer);
            context.RunningTimer = null;
            this.__closeValve((context.UseMasterValve == true ? this.GPIO_MasterValvePin : 0), context.GPIO_ValvePin, context.Name);
            context.ValveService.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.INACTIVE);
            context.ValveService.getCharacteristic(Characteristic.InUse).updateValue(Characteristic.InUse.NOT_IN_USE);
            context.ValveService.getCharacteristic(Characteristic.RemainingDuration).updateValue(0);

            // TESTING flow usage
            console.log("'%s' used '%sL' over '%ss'", context.Name, context.WaterTotal.toFixed(4), context.ValveService.getCharacteristic(Characteristic.SetDuration).value);
            context.WaterTotal = 0;
            // TESTING flow usage
        }
    },

    __openValve: function(GPIO_MasterPin, GPIO_ValvePin, zoneName) {
        if (GPIO_MasterPin > 0) {
            GPIO.write(GPIO_MasterPin, GPIO.HIGH);  // Open master valve first if required
        }
        // Output a high signal on the GPIO, this will trigger the connected relay to open
        GPIO.write(GPIO_ValvePin, GPIO.HIGH);
        this.lastValveTime = Math.floor(Date.now());    // Store time of valve opening
        console.log("Irrigation zone '%s' on GPIO pin '%s' was turned 'On'", zoneName, GPIO_ValvePin);
    },

    __closeValve: function(GPIO_MasterPin, GPIO_ValvePin, zoneName) {
        // Output a low signal on the GPIO, this will trigger the connected relay to close. If there is a master valve configured, we'll close that after 
        GPIO.write(GPIO_ValvePin, GPIO.LOW);
        if (GPIO_MasterPin > 0) {
            GPIO.write(GPIO_MasterPin, GPIO.LOW);  // Close master valve last
        }
        this.lastValveTime = Math.floor(Date.now());    // Store time of valve closing
        console.log("Irrigation zone '%s' on GPIO pin '%s' was turned 'Off'", zoneName, GPIO_ValvePin);
    }
}

// Use the wifi mac address for the HomeKit username
// todo - determine active connection, either wifi or ethernet
var AccessoryUsername = "";
var networkInterfaces = os.networkInterfaces();
Object.keys(networkInterfaces).forEach(interface => {
    networkInterfaces[interface].forEach(interface => {
        if (interface.family.toUpperCase() == "IPV4" || interface.internal == true) {
        // found mac 
            AccessoryUsername = interface.mac.toUpperCase(); 
        }
    });
});

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

    var IrrigationSystem = new IrrigationSystemClass();
    var config = IrrigationSystem.loadConfiguration();   // Load configuration, if configuration not present, defaults will be used
    IrrigationSystem.addIrrigationSystem(irrigationAccessory, AccessoryName, config.system.PowerSwitch);

    // Create each "zone"/sprinkler as defined in the config
    config.zones.forEach(zone => {
        IrrigationSystem.addIrrigationZone(zone);
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
    IrrigationSystem.setIrrigationSystemState(config.system.PowerState.toUpperCase() == "ON" ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE, null);
    IrrigationSystem.refreshHomeKit();
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


