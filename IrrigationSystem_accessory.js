// HAP-Nodejs irrigation accessory
// todo
// -- schedule override (perhaps via HomeKit switch)
// -- detect current usage and switch valves if too much drawn
// -- weather/rain sensor - perhaps override if rain due??
// -- flow meter - measure water usage
//
// done
// -- use system WIFI mac addr as AccessoryUsername
// -- low tank level distance (ie: minimun water level)

var JSONPackage = require('../package.json');
var Accessory = require('../').Accessory; 
var Service = require('../').Service;
var Characteristic = require('../').Characteristic;
var uuid = require('../').uuid;
var GPIO = require('rpio');
var fs = require('fs');
var os = require('os');

const configFileName = __filename.split('_')[0] + "_config.json";
var config = require(configFileName);

// Defines for the accessory
const AccessoryName =  "Irrigation System";             // name of accessory
const AccessoryPincode = "031-45-154";                  // pin code for pairing 
const AccessoryManufacturer = "n0rt0nthec4t";          // manufacturer (optional)
const AccessoryModel = "HomeKit Irrigation v2";         // model (optional)
const AccessorySerialNumber = "MH20190204";             // serial number (optional) 
const AccessoryFirmwareRevision = JSONPackage.version;  // firmware revision (optional)

// Create the "valve" object. 
function ValveClass() {
    this.__accessory = null;                // Parent accessory object
    this.__ValveService = null;             // HomeKit service for this valve
    this.__timerFunc = null;                // object to created timer for sprinkler runtime
    this.RunTimeS = 0;                      // Sprinkler runtime in seconds
    this.MaxRunTime = 0;                    // Max time sprinkler can run in seconds. 0 = HomeKit default (3600s)
    this.ZoneEnabled = false;               // Is the zone enabled
    this.GPIO_ValveRelay = 0;               // GPIO Pin for sprinkler valve control
    this.configIndex = null;
}

ValveClass.prototype = {
	addValve: function(HomeKitAccessory, thisServiceName, serviceNumber) {
        // Add this irrigation valve to the "master" accessory and set properties
        this.__accessory = HomeKitAccessory;
        this.__ValveService = HomeKitAccessory.addService(Service.Valve, thisServiceName, serviceNumber); 
        this.__ValveService.getCharacteristic(Characteristic.ValveType).setValue(Characteristic.ValveType.IRRIGATION);
        this.__ValveService.addCharacteristic(Characteristic.SetDuration);
        this.__ValveService.addCharacteristic(Characteristic.RemainingDuration);
        this.__ValveService.addCharacteristic(Characteristic.IsConfigured);
        
        // setup default runtime if configured and ensure within defined bounds of the characteristic 
        if (this.MaxRunTime > 0) {
            this.__ValveService.getCharacteristic(Characteristic.SetDuration).setProps({maxValue: this.MaxRunTime});   
        }
        if (this.RunTimeS > 0) {
            if (this.RunTimeS < this.__ValveService.getCharacteristic(Characteristic.SetDuration).props.minValue) this.RunTimeS = this.__ValveService.getCharacteristic(Characteristic.SetDuration).props.minValue;
            if (this.RunTimeS > this.__ValveService.getCharacteristic(Characteristic.SetDuration).props.maxValue) this.RunTimeS = this.__ValveService.getCharacteristic(Characteristic.SetDuration).props.maxValue;
            this.__ValveService.getCharacteristic(Characteristic.SetDuration).setValue(this.RunTimeS);
        }

        // Setup zone enabled or disabled
        // seems to be a bug in HomeKit/iOS 12 that this value doesnt change via home app.
        this.__ValveService.getCharacteristic(Characteristic.IsConfigured).setValue((this.ZoneEnabled == true) ? Characteristic.IsConfigured.CONFIGURED : Characteristic.IsConfigured.NOT_CONFIGURED);

        // Initialise the GPIO input/output PINs for this valve
        GPIO.init({gpiomem: true});
        GPIO.init({mapping: 'gpio'});
        if (this.GPIO_ValveRelay != 0) GPIO.open(this.GPIO_ValveRelay, GPIO.OUTPUT, GPIO.LOW);

        // Setup HomeKit callback to set the state of the sprinkler as the target
        this.__ValveService.getCharacteristic(Characteristic.Active).on('set', this.setActiveState.bind(this));

        // Setup set callbacks for the optional characteristics
        this.__ValveService.getCharacteristic(Characteristic.IsConfigured).on('set', this.setZoneEnabled.bind(this));
        this.__ValveService.getCharacteristic(Characteristic.IsConfigured).on('get', this.getZoneEnabled.bind(this));
        this.__ValveService.getCharacteristic(Characteristic.SetDuration).on('set', this.setDuration.bind(this));
        this.__ValveService.getCharacteristic(Characteristic.SetDuration).on('get', this.getDuration.bind(this));
        return this.__ValveService;   // Return object to this service
    },

    setZoneEnabled: function(value, callback) {
        this.ZoneEnabled = value;   
        this.__ValveService.getCharacteristic(Characteristic.IsConfigured).updateValue(value);

        // Save back to the config file
        config.zones[this.configIndex].Enabled = (value == Characteristic.IsConfigured.CONFIGURED ? true : false);
        fs.writeFileSync(configFileName, JSON.stringify(config, null, 3));

        callback();
    },

    getZoneEnabled: function(callback) {
        callback(null,  this.ZoneEnabled);
    },

    setDuration: function(durationS, callback) {
        this.RunTimeS = durationS;
        this.__ValveService.getCharacteristic(Characteristic.SetDuration).updateValue(durationS);
        if (this.__ValveService.getCharacteristic(Characteristic.Active).value == Characteristic.Active.ACTIVE) {
            // Sprinkler is running, so re-adjust timing
            clearInterval(this.__timerFunc);
            this.__ValveService.getCharacteristic(Characteristic.RemainingDuration).setValue(durationS);
            this.__timerFunc = setInterval(this.runningTimer.bind(this), 100, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000) + durationS);
        }

        // Save back to the config file
        config.zones[this.configIndex].DefaultRunTime = durationS;
        fs.writeFileSync(configFileName, JSON.stringify(config, null, 3));

        callback();
    },

    getDuration: function(callback) {
        callback(null,  this.RunTimeS);
    },

    setActiveState: function(state, callback) {
        var openValveCount = 0;
        var maxRunningValves = 1;
        var shortestRunTimeService = null;

        if (typeof config.system.MaxRunningZones !== 'undefined' && typeof config.system.MaxRunningZones === 'number') maxRunningValves = config.system.MaxRunningZones;
        if (maxRunningValves < 1) maxRunningValves = 1;

        if (this.__ValveService.getCharacteristic(Characteristic.IsConfigured).value == Characteristic.IsConfigured.CONFIGURED) {
            if ((state == Characteristic.Active.ACTIVE) && (this.__ValveService.getCharacteristic(Characteristic.Active).value == Characteristic.Active.INACTIVE)) {
                // Request to turn on sprinkler. We need to see how many sprinkers can be active at once, and ensure we do not exceed that amount
                // If we need to shut a sprinker off to enabled this new one, do so to the one with the shortest run time left
                for (var index in this.__accessory.services) {
                    if (this.__accessory.services[index].UUID == Service.Valve.UUID) {
                        var tmpValveService = this.__accessory.services[index];
                        if (tmpValveService.getCharacteristic(Characteristic.Active).value == Characteristic.Active.ACTIVE) {
                            // found another active sprinkler, so stop it if we exceed the max number of simultaneous running zones
                            openValveCount = openValveCount + 1;
                            if (shortestRunTimeService == null) {
                                shortestRunTimeService = tmpValveService; 
                            }
                            else if (tmpValveService.getCharacteristic(Characteristic.RemainingDuration).value < shortestRunTimeService.getCharacteristic(Characteristic.RemainingDuration).value) {
                                shortestRunTimeService = tmpValveService;
                            }
                            if (openValveCount >= maxRunningValves && shortestRunTimeService != null) {
                                // Since we're usign teh setValue callback, the actual closing of the valve will happen wehn this fucntion re-enter by HomeKit
                                shortestRunTimeService.getCharacteristic(Characteristic.Active).setValue(Characteristic.Active.INACTIVE);
                            }
                        }
                    }
                }

                this.openValve();
                this.__ValveService.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.ACTIVE);
                this.__ValveService.getCharacteristic(Characteristic.InUse).setValue(Characteristic.InUse.IN_USE);
                this.__ValveService.getCharacteristic(Characteristic.RemainingDuration).setValue(this.__ValveService.getCharacteristic(Characteristic.SetDuration).value);
                this.__timerFunc = setInterval(this.runningTimer.bind(this), 100, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000) + this.__ValveService.getCharacteristic(Characteristic.SetDuration).value);
            } else if ((state == Characteristic.Active.INACTIVE) && (this.__ValveService.getCharacteristic(Characteristic.Active).value == Characteristic.Active.ACTIVE)) {
                clearInterval(this.__timerFunc);
                this.closeValve();
                this.__ValveService.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.INACTIVE);
                this.__ValveService.getCharacteristic(Characteristic.InUse).setValue(Characteristic.InUse.NOT_IN_USE);
                this.__ValveService.getCharacteristic(Characteristic.RemainingDuration).setValue(0);
            }
        }
        callback();
    },

    runningTimer: function(startTimerMS, endTimerMS) {
        this.__ValveService.getCharacteristic(Characteristic.RemainingDuration).updateValue(endTimerMS - Math.floor(Date.now() / 1000));
        if (this.__ValveService.getCharacteristic(Characteristic.RemainingDuration).value <= 0) {
            clearInterval(this.__timerFunc);
            this.closeValve();
            this.__ValveService.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.INACTIVE);
            this.__ValveService.getCharacteristic(Characteristic.InUse).setValue(Characteristic.InUse.NOT_IN_USE);
            this.__ValveService.getCharacteristic(Characteristic.RemainingDuration).setValue(0);
        }
    },

    openValve: function() {
        // Outout a high signal on the GPIO, this will trigger the connected relay to open
        GPIO.write(this.GPIO_ValveRelay, GPIO.HIGH);
        console.log("Irrigation valve opened on '%s'", this.__ValveService.getCharacteristic(Characteristic.Name).value);
    },

    closeValve: function() {
        // Outout a low signal on the GPIO, this will trigger the connected relay to close
        GPIO.write(this.GPIO_ValveRelay, GPIO.LOW);
        console.log("Irrigation valve closed on '%s'", this.__ValveService.getCharacteristic(Characteristic.Name).value);
    }
}

// Use the wifi mac address for the HomeKit username
var AccessoryUsername = "";
var tempNetworkInfo = os.networkInterfaces().wlan0;
for (var index in tempNetworkInfo) {
    if (tempNetworkInfo[index].family.toUpperCase() == "IPV4") {
        AccessoryUsername = tempNetworkInfo[index].mac.toUpperCase(); 
    }
}
if (AccessoryUsername != "") {

    // Create the irrigation accessory
    var irrigationAccessory = exports.accessory = new Accessory(AccessoryName, uuid.generate("hap-nodejs:accessories:irrigation_" + AccessoryName));
    irrigationAccessory.username = AccessoryUsername; 
    irrigationAccessory.pincode = AccessoryPincode;
    irrigationAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, AccessoryManufacturer);
    irrigationAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Model, AccessoryModel);
    irrigationAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.SerialNumber, AccessorySerialNumber);
    irrigationAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, AccessoryFirmwareRevision);

    var irrigationService = irrigationAccessory.addService(Service.IrrigationSystem, AccessoryName);
    //irrigationService.getCharacteristic(Characteristic.ProgramMode).setValue(Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED);
    irrigationService.getCharacteristic(Characteristic.ProgramMode).setValue(Characteristic.ProgramMode.PROGRAM_SCHEDULED);

    // Create each "zone"/sprinkler as defined in the config
    if (typeof config.zones !== 'undefined')
    {
        var valveObjects = {};
        for (var index in config.zones) {
            valveObjects[index] = new ValveClass();
            valveObjects[index].GPIO_ValveRelay = typeof config.zones[index].relayPin !== 'undefined' && typeof config.zones[index].relayPin === 'number' ? config.zones[index].relayPin : 0;
            valveObjects[index].RunTimeS = typeof config.zones[index].DefaultRunTime !== 'undefined' && typeof config.zones[index].DefaultRunTime === 'number' ? config.zones[index].DefaultRunTime : 0;
            valveObjects[index].ZoneEnabled = typeof config.zones[index].Enabled !== 'undefined' && typeof config.zones[index].Enabled === 'boolean' ? config.zones[index].Enabled : false;
            valveObjects[index].MaxRunTime = typeof config.zones[index].MaxRunTime !== 'undefined' && typeof config.zones[index].MaxRunTime === 'number' ? config.zones[index].MaxRunTime : 3600;
            valveObjects[index].configIndex = index;
            if (valveObjects[index].addValve(irrigationAccessory, config.zones[index].name, index) != null) {
                valveObjects[index].__ValveService.getCharacteristic(Characteristic.Name).setValue(config.zones[index].name);
                irrigationService.addLinkedService(valveObjects[index].__ValveService);
                console.log("Setup irrigation zone '%s' on '%s' using relay pin '%s'", config.zones[index].name, irrigationAccessory.username, config.zones[index].relayPin);
            }
        }    
    }

    // Water level checking polling loop
    if (typeof config.tank.TankHeight !== 'undefined' && typeof config.tank.TankSensorTrigPin  !== 'undefined' && typeof config.tank.TankSensorEchoPin !== 'undefined') {
        if (typeof config.tank.TankHeight === 'number' && typeof config.tank.TankSensorTrigPin  === 'number' && typeof config.tank.TankSensorEchoPin === 'number') {
            if (config.tank.TankHeight > 0 && config.tank.TankSensorTrigPin != 0 && config.tank.TankSensorEchoPin) {
                console.log("Water tank level sensor enabled on '%s' using sensor pin '%s'", AccessoryUsername, config.tank.TankSensorTrigPin);

                irrigationService.addCharacteristic(Characteristic.WaterLevel);
                
                // Setup HomeKit callback to get waterlevel
                irrigationService.getCharacteristic(Characteristic.WaterLevel)
                    .on('get', function(callback) {
                    callback(null, getTankWaterLevel());
                });
            }
        }
    }
}
else {
    console.log("Failed to get system MAC for Irrigation System");
}

// Gets the level of the water tank and updates percentage full into HomeKit
function getTankWaterLevel() {
    const scale = (num, in_min, in_max, out_min, out_max) => {
        return (num - in_min) * (out_max - out_min) / (in_max - in_min) + out_min;
    }
    const minWorkable = 200;    // Minimum range for ultrasonic sensor in mm
    const maxWorkable = 4500;   // maximum range for ultrasonic sensor in mm
    var measuredDistance = 0;
    var percentageFull = 0;

    const {spawnSync} = require("child_process");
    const spawnProcess = spawnSync("python",["/home/pi/HAP-NodeJS/usonic_measure.py", config.tank.TankSensorTrigPin, config.tank.TankSensorEchoPin]);
    //const spawnProcess = spawnSync("/home/pi/HAP-NodeJS/usonic_measure",[config.tank.TankSensorTrigPin, config.tank.TankSensorEchoPin]);
    if (spawnProcess['stdout']) {
        measuredDistance = (spawnProcess.stdout.toString() * 10);   // Convert CM to MM
    }

    // Baseline usonic measurement
    if (measuredDistance < minWorkable) measuredDistance = minWorkable;
    if (measuredDistance > maxWorkable) measuredDistance = maxWorkable;
    if (measuredDistance > config.tank.TankHeight) measuredDistance = config.tank.TankHeight;

    // Adjust the meausred height if we a minimum usable water level in tank, then scale
    if (typeof config.tank.MinimumLevel !== 'undefined' && typeof config.tank.MinimumLevel === 'number' && config.tank.MinimumLevel > 0) {
        // Adjust the meausred height if we a minimum usable water level in tank, then scale
        // Since the minimum workable range migth not be zero, scale the mim <> tank heightinto 0 <> (tank height + minLevel)
        percentageFull = ((config.tank.TankHeight - scale(measuredDistance, minWorkable, config.tank.TankHeight, 0, (config.tank.TankHeight + config.tank.MinimumLevel))) / config.tank.TankHeight) * 100;
    } else {
        // Since the minimum workable range migth not be zero, scale the mim <> tank heightinto 0 <> tank height
        percentageFull = ((config.tank.TankHeight - scale(measuredDistance, minWorkable, config.tank.TankHeight, 0, config.tank.TankHeight)) / config.tank.TankHeight) * 100;
    }
    if (percentageFull < 0) percentageFull = 0;
    if (percentageFull > 100) percentageFull = 100;

    irrigationService.getCharacteristic(Characteristic.WaterLevel).updateValue(percentageFull);
    return percentageFull;
}

// claanup if process stopped.. Mainly used to ensure valves are closed
var signals = { 'SIGINT': 2, 'SIGTERM': 15 };
Object.keys(signals).forEach(function (signal) {
    process.on(signal, function () {
        for (var index in valveObjects) {
            GPIO.write(valveObjects[index].GPIO_ValveRelay, GPIO.LOW);
            GPIO.close(valveObjects[index].GPIO_ValveRelay);
        }
    });
});