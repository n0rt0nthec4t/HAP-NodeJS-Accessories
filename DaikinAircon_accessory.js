// HAP-Nodejs Daikin Aircon
//
// Daikin A/C control https://github.com/ael-code/daikin-control
// https://github.com/Apollon77/daikin-controller

var Accessory = require('../').Accessory; 
var Service = require('../').Service;
var Characteristic = require('../').Characteristic;
var uuid = require('../').uuid;
var request = require('sync-request');


// Defines for the accessory
const AccessoryName =  "Air Conditioner";               // name of accessory
const AccessoryPincode = "031-45-154";                  // pin code for paring 
const AccessoryManufacturer = "Daikin";             	// manufacturer (optional)
const AccessoryModel = "Some Model";                    // model (optional)
const AccessorySerialNumber = "Some Serial";                // serial number (optional)

const DaikinIP = "xxx.xxx.xxx.xxx";                        // IP for the Daikin system


// Create the "aircon" object. This can be used as the template for multiple aircons under the one accessory
function AirconditionerClass() {
    this.__accessory = null;                    // Parent accessory object
    this.__HeaterCoolerService = null;          // HomeKit service for this Airconditioner
    this.__DehumidService = null;               // HomeKit service for the dehumidifier of the airconditioner
    this.__FanService = null;                   // HomeKit service for the fan mode of the airconditioner
    this.__airconIP = null;                    // URL to communicate with the air-con
    this.__timerFunc = null;                    // object to created update loop timer
    this.__HomeKitUpdating = false;             // flag that we're processing HomeKit updates
    this.__cacheAirconFanSpeed = null;
    this.__cacheAirconFanMode = null;
    this.__cacheAirconCoolTemp = null;
    this.__cacheAirconHeatTemp = null;
    this.__cacheFanSpeed = null;
    this.__cacheFanMode = null;
}

AirconditionerClass.prototype = {
    addAirconditioner: function(HomeKitAccessory, thisServiceName, serviceNumber) {
        console.log("Setup Air-conditioner '%s' on '%s'", thisServiceName, HomeKitAccessory.username);

        this.__airconIP = DaikinIP;

		// Add this aircon to the "master" accessory and set properties
        this.__HeaterCoolerService = HomeKitAccessory.addService(Service.HeaterCooler, thisServiceName, serviceNumber);
        this.__HeaterCoolerService.addOptionalCharacteristic(Characteristic.SwingMode);
        this.__HeaterCoolerService.addOptionalCharacteristic(Characteristic.RotationSpeed);

        // Limit prop ranges
        this.__HeaterCoolerService.getCharacteristic(Characteristic.CoolingThresholdTemperature).setProps({minStep: 1}, {minValue: 18}, {maxValue: 31});
        this.__HeaterCoolerService.getCharacteristic(Characteristic.HeatingThresholdTemperature).setProps({minStep: 1}, {minValue: 18}, {maxValue: 31});
        this.__HeaterCoolerService.getCharacteristic(Characteristic.RotationSpeed).setProps({minStep: 1}, {minValue: 0}, {maxValue: 100});  
     
        // Setup set callbacks for characteristics
        this.__HeaterCoolerService.getCharacteristic(Characteristic.SwingMode).on('set', this.setAirconditionerFanMode.bind(this));
        this.__HeaterCoolerService.getCharacteristic(Characteristic.RotationSpeed).on('set', this.setAirconditionerFanSpeed.bind(this));
        this.__HeaterCoolerService.getCharacteristic(Characteristic.TargetHeaterCoolerState).on('set', this.setHeaterCoolerMode.bind(this));
        this.__HeaterCoolerService.getCharacteristic(Characteristic.Active).on('set', this.setHeaterCoolerOnOff.bind(this));
        this.__HeaterCoolerService.getCharacteristic(Characteristic.CoolingThresholdTemperature).on('set', this.setCoolingTemperature.bind(this));
        this.__HeaterCoolerService.getCharacteristic(Characteristic.HeatingThresholdTemperature).on('set', this.setHeatingTemperature.bind(this));

        return this.__HeaterCoolerService;   // Return object to this service
    },

    addDehumidifier: function(HomeKitAccessory, thisServiceName, serviceNumber) {
        console.log("Setup Air-conditioner (Dehumidifier mode) '%s' on '%s'", thisServiceName, HomeKitAccessory.username);

        this.__airconIP = DaikinIP;

		// Add this dehumifier to the "master" accessory and set properties
        this.__DehumidService = HomeKitAccessory.addService(Service.HumidifierDehumidifier, thisServiceName, serviceNumber);
        this.__DehumidService.addOptionalCharacteristic(Characteristic.SwingMode);

        // Limit prop ranges
        this.__DehumidService.getCharacteristic(Characteristic.RotationSpeed).setProps({minStep: 1}, {minValue: 0}, {maxValue: 100});  
        this.__DehumidService.getCharacteristic(Characteristic.TargetHumidifierDehumidifierState).setProps({validValues: [Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER]});    
     
        // Setup set callbacks for characteristics
        this.__DehumidService.getCharacteristic(Characteristic.SwingMode).on('set', this.setDehumidifierFanMode.bind(this));
        this.__DehumidService.getCharacteristic(Characteristic.RotationSpeed).on('set', this.setDehumidifierFanSpeed.bind(this));
        this.__DehumidService.getCharacteristic(Characteristic.Active).on('set', this.setDehumidifierOnOff.bind(this));

        return this.__DehumidService;   // Return object to this service
    },

    addFan: function(HomeKitAccessory, thisServiceName, serviceNumber) {
        console.log("Setup Air-conditioner (Fan mode) '%s' on '%s'", thisServiceName, HomeKitAccessory.username);

        this.__airconIP = DaikinIP;

		// Add this aircon to the "master" accessory and set properties
        this.__FanService = HomeKitAccessory.addService(Service.Fanv2, thisServiceName, serviceNumber);
        this.__FanService.addOptionalCharacteristic(Characteristic.SwingMode);
        this.__FanService.addOptionalCharacteristic(Characteristic.RotationSpeed);

        // Limit prop ranges
        this.__FanService.getCharacteristic(Characteristic.RotationSpeed).setProps({minStep: 1}, {minValue: 0}, {maxValue: 100});  
         
        // Setup set callbacks for characteristics
        this.__FanService.getCharacteristic(Characteristic.SwingMode).on('set', this.setFanMode.bind(this));
        this.__FanService.getCharacteristic(Characteristic.RotationSpeed).on('set', this.setFanSpeed.bind(this));
        this.__FanService.getCharacteristic(Characteristic.Active).on('set', this.setFanOnOff.bind(this));

        return this.__FanService;   // Return object to this service
    },

    setAirconditionerFanMode: function(value, callback) {
        // Sets the fan swing mode for the aircon.. either "off" or "3D"
        this.__HomeKitUpdating = true;  // Flag updating HomeKit, so update loop doesnt switch back
        var f_dir = value == Characteristic.SwingMode.SWING_ENABLED ? 3 : 0;    // 3D = 3, 0 = off
        setDaikinOption(this.__airconIP, "f_dir", f_dir);
        callback();
        this.__HomeKitUpdating = false;
    },

    setAirconditionerFanSpeed: function(value, callback) {
        // sets the speed of the fan by using the HomeKit rotatonspeed scale
        this.__HomeKitUpdating = true;  // Flag updating HomeKit, so update loop doesnt switch back
        var f_rate = convertHomeKitToDaikinFanSpeed(value);
        setDaikinOption(this.__airconIP, "f_rate", f_rate);
        callback();
        this.__HomeKitUpdating = false;
    },

    setHeaterCoolerMode: function(value, callback) {
        this.__HomeKitUpdating = true;  // Flag updating HomeKit, so update loop doesnt switch back
        this.__setDaikinState(1, value);
         callback();
        this.__HomeKitUpdating = false;
    },

    setCoolingTemperature: function(value, callback) {
        var Temperature = value;

        this.__HomeKitUpdating = true;  // Flag updating HomeKit, so update loop doesnt switch back
        if (this.__HeaterCoolerService.getCharacteristic(Characteristic.TargetHeaterCoolerState).value == Characteristic.TargetHeaterCoolerState.AUTO) {
            // Since in auto mode, recalculate the average
            var Temperature = ((value + this.__HeaterCoolerService.getCharacteristic(Characteristic.HeatingThresholdTemperature).value) / 2).toFixed(0);
            this.__cacheAirconCoolTemp = value;
        } else {
            // Not in auto mode, so no need to cache the cool temp for the update loop display
            this.__cacheAirconCoolTemp = null;
        }
        setDaikinOption(this.__airconIP, "stemp", Temperature);
        callback();
        this.__HomeKitUpdating = false;
    },

    setHeatingTemperature: function(value, callback) {
        var Temperature = value;

        this.__HomeKitUpdating = true;  // Flag updating HomeKit, so update loop doesnt switch back
        if (this.__HeaterCoolerService.getCharacteristic(Characteristic.TargetHeaterCoolerState).value == Characteristic.TargetHeaterCoolerState.AUTO) {
            // Since in auto mode, recalculate the average
            var Temperature = ((value + this.__HeaterCoolerService.getCharacteristic(Characteristic.CoolingThresholdTemperature).value) / 2).toFixed(0);
            this.__cacheAirconHeatTemp = value;
        } else {
            // Not in auto mode, so no need to cache the heat temp for the update loop display
            this.__cacheAirconHeatTemp = null;
        }
        setDaikinOption(this.__airconIP, "stemp", Temperature);
        callback();
        this.__HomeKitUpdating = false;
    },

    setHeaterCoolerOnOff: function(value, callback) {
        this.__HomeKitUpdating = true;  // Flag updating HomeKit, so update loop doesnt switch back
        if (value != this.__HeaterCoolerService.getCharacteristic(Characteristic.Active).value) {
            // really changing active state - Seems that when rotationspeed characteristic is changed via HomeKit, this on.set still gets triggered
            this.__setDaikinState(value, this.__HeaterCoolerService.getCharacteristic(Characteristic.TargetHeaterCoolerState).value);
        }
        callback();
        this.__HomeKitUpdating = false;
    },

    setDehumidifierFanMode: function(value, callback, context) {
        // Sets the fan swing mode for the aircon.. either "off" or "3D"
        this.__HomeKitUpdating = true;  // Flag updating HomeKit, so update loop doesnt switch back
        var f_dir = value == Characteristic.SwingMode.SWING_ENABLED ? 3 : 0;    // 3D = 3, 0 = off

        // Work out the current mode to see if we delay update until this mode is active on the aircon or do now
        if (this.__DehumidService.getCharacteristic(Characteristic.Active).value == Characteristic.Active.ACTIVE) {
            setDaikinOption(this.__airconIP, "f_dir", f_dir);
            this.__cacheDehumidFanMode = null;
        } else {
            // Since the aircon isnt active, cache for later
            this.__cacheDehumidFanMode = f_dir;
        }
        callback();
        this.__HomeKitUpdating = false;
    },

    setDehumidifierFanSpeed: function(value, callback, context) {
        // sets the speed of the fan by using the HomeKit rotatonspeed scale
        this.__HomeKitUpdating = true;  // Flag updating HomeKit, so update loop doesnt switch back
        var f_rate = convertHomeKitToDaikinFanSpeed(value);

        // Work out the current mode to see if we delay update until this mode is active on the aircon or do now
        if (this.__DehumidService.getCharacteristic(Characteristic.Active).value == Characteristic.Active.ACTIVE) {
            setDaikinOption(this.__airconIP, "f_rate", f_rate);
            this.__cacheDehumidFanSpeed = null;
        } else {
            // Since the aircon isnt active, cache for later
            this.__cacheDehumidFanSpeed= f_rate;
        }
        callback();
        this.__HomeKitUpdating = false;
    },

    setDehumidifierOnOff: function(value, callback) {
        this.__HomeKitUpdating = true;  // Flag updating HomeKit, so update loop doesnt switch back
        var RotationSpeed = convertHomeKitToDaikinFanSpeed(this.__DehumidService.getCharacteristic(Characteristic.RotationSpeed).value);
        var SwingMode = (this.__DehumidService.getCharacteristic(Characteristic.SwingMode).value == Characteristic.SwingMode.SWING_ENABLED ? "3" : "0");
        var PowerMode = (value == Characteristic.Active.ACTIVE ? 1 : 0);
        
        if (PowerMode == Characteristic.Active.ACTIVE) {
            if (this.__AirconService != null) this.__AirconService.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.INACTIVE);
            if (this.__FanService != null) this.__FanService.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.INACTIVE);
        }
        if (PowerMode != this.__DehumidService.getCharacteristic(Characteristic.Active).value) {
            // really changing active state - Seems that when rotationspeed characteristic is changed via HomeKit, this on.set still gets triggered)
            var response = request("GET", "http://" + this.__airconIP + "/aircon/set_control_info?pow=" + PowerMode + "&mode=2&stemp=M&shum=AUTO&f_dir=" + SwingMode + "&f_rate=" + RotationSpeed);
            if (response.statusCode == 200) {
                console.log("Daikin Set to| Pwr: '%s' Mode: '2 (Dry)' Fan: '%s' Swing '%s'", PowerMode, RotationSpeed, SwingMode);
            }
        }
        callback();
        this.__HomeKitUpdating = false;
    },

    setFanMode: function(value, callback) {
        // Sets the fan swing mode for the aircon.. either "off" or "3D"
        this.__HomeKitUpdating = true;  // Flag updating HomeKit, so update loop doesnt switch back
        var f_dir = value == Characteristic.SwingMode.SWING_ENABLED ? 3 : 0;    // 3D = 3, 0 = off

        // Work out the current mode to see if we delay update until this mode is active on the aircon or do now
        if (this.__FanService.getCharacteristic(Characteristic.Active).value == Characteristic.Active.ACTIVE) {
            setDaikinOption(this.__airconIP, "f_dir", f_dir);
            this.__cacheFanMode = null;
        } else {
            // Since the aircon isnt active, cache for later
            this.__cacheFanMode = f_dir;
        }
        callback();
        this.__HomeKitUpdating = false;
    },

    setFanSpeed: function(value, callback) {
        // sets the speed of the fan by using the HomeKit rotatonspeed scale
        this.__HomeKitUpdating = true;  // Flag updating HomeKit, so update loop doesnt switch back
        var f_rate = convertHomeKitToDaikinFanSpeed(value);

        // Work out the current mode to see if we delay update until this mode is active on the aircon or do now
        if (this.__FanService.getCharacteristic(Characteristic.Active).value == Characteristic.Active.ACTIVE) {
            setDaikinOption(this.__airconIP, "f_rate", f_rate);
            this.__cacheFanSpeed = null;
        } else {
            // Since the aircon isnt active, cache for later
            this.__cacheFanSpeed = f_rate;
        }
        callback();
        this.__HomeKitUpdating = false;
    },

    setFanOnOff: function(value, callback) {
        this.__HomeKitUpdating = true;  // Flag updating HomeKit, so update loop doesnt switch back
        var RotationSpeed = convertHomeKitToDaikinFanSpeed(this.__FanService.getCharacteristic(Characteristic.RotationSpeed).value);
        var SwingMode = (this.__FanService.getCharacteristic(Characteristic.SwingMode).value == Characteristic.SwingMode.SWING_ENABLED ? "3" : "0");
        var PowerMode = (value == Characteristic.Active.ACTIVE ? 1 : 0);

        // Check to see if we've switch from another servcie to this, and mark them as inactive if this is going active
        if (PowerMode == Characteristic.Active.ACTIVE) {
            if (this.__AirconService != null) this.__AirconService.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.INACTIVE);
            if (this.__DehumidService != null) this.__DehumidService.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.INACTIVE);
        }
        if (PowerMode != this.__FanService.getCharacteristic(Characteristic.Active).value) {
            // really changing active state - Seems that when rotationspeed characteristic is changed via HomeKit, this on.set still gets triggered)
            var response = request("GET", "http://" + this.__airconIP + "/aircon/set_control_info?pow=" + PowerMode + "&mode=6&stemp=--&shum=--&f_dir=" + SwingMode + "&f_rate=" + RotationSpeed);
            if (response.statusCode == 200) {
                console.log("Daikin Set to| Pwr: '%s' Mode: '6 (Fan)' Fan: '%s' Swing '%s'", PowerMode, RotationSpeed, SwingMode);
            }
        }
        callback();
        this.__HomeKitUpdating = false;
    },

    refreshHomeKit: function(refreshTimeMS) {
        // setup aircon status check interval for every 2000ms (2 seconds)
        if (this.__timerFunc != null) {
            // current update timer running, so cancel it.
            clearInterval(this.__timerFunc);
        }
        // setup aircon status check interval as defined
        this.__timerFunc = setInterval(this.__getDaikinState.bind(this), refreshTimeMS); 
        console.log("Refresh status in HomeKit set for every '%s'ms", refreshTimeMS);
    },

    __setDaikinState: function(power, mode) {
        // power = 0 (off)
        // power = 1 (on)

        var RotationSpeed = convertHomeKitToDaikinFanSpeed(this.__HeaterCoolerService.getCharacteristic(Characteristic.RotationSpeed).value);
        var SwingMode = (this.__HeaterCoolerService.getCharacteristic(Characteristic.SwingMode).value == Characteristic.SwingMode.SWING_ENABLED ? "3" : "0");
        var PowerMode = (power == Characteristic.Active.ACTIVE ? 1 : 0);
        var Temperature = "--";

        switch (mode) {
            case Characteristic.TargetHeaterCoolerState.AUTO :
                AirconMode = 0; // Auto
                      
             // we'll use the average temperature between cool and heat for the target auto tempature. This is because the daikin only supports a single target temp in auto mode
                var Temperature = ((this.__HeaterCoolerService.getCharacteristic(Characteristic.CoolingThresholdTemperature).value + this.__HeaterCoolerService.getCharacteristic(Characteristic.HeatingThresholdTemperature).value) / 2).toFixed(0);
                break;

            case Characteristic.TargetHeaterCoolerState.COOL :
                AirconMode = 3; // Cool
                Temperature = this.__HeaterCoolerService.getCharacteristic(Characteristic.CoolingThresholdTemperature).value;
                this.__cacheAirconCoolTemp = null;
                break;

            case Characteristic.TargetHeaterCoolerState.HEAT :
                AirconMode = 4; // Heat
                Temperature = this.__HeaterCoolerService.getCharacteristic(Characteristic.HeatingThresholdTemperature).value;
                this.__cacheAirconHeatTemp = null;
                break;
        }
        var response = request("GET", "http://" + this.__airconIP + "/aircon/set_control_info?pow=" + PowerMode + "&mode=" + AirconMode + "&stemp=" + Temperature + "&shum=0&f_dir=" + SwingMode + "&f_rate=" + RotationSpeed);
        if (response.statusCode == 200) {
            console.log("Daikin Set to| Pwr: '%s' Mode: '%s' Temp: '%s' Fan: '%s' Swing '%s'", PowerMode, AirconMode, Temperature, RotationSpeed, SwingMode);
        }
    },

    __getDaikinState: function() {
        var daikinACInfo;
        var daikinSensorInfo;

        if (this.__HomeKitUpdating == false) {
            var response = request("GET", "http://" + DaikinIP + "/aircon/get_control_info");
            if (response.statusCode == 200) {
                var daikinACInfo = JSON.parse(convertDaikinToJSON(response.body.toString('utf8')));

                var response = request("GET", "http://" + DaikinIP + "/aircon/get_sensor_info");
                if (response.statusCode == 200) {
                    // Update HomeKit status
                    var daikinSensorInfo = JSON.parse(convertDaikinToJSON(response.body.toString('utf8')));

                    if (this.__HeaterCoolerService != null) {
                        this.__HeaterCoolerService.getCharacteristic(Characteristic.CurrentTemperature).updateValue(daikinSensorInfo.htemp);
                        this.__HeaterCoolerService.getCharacteristic(Characteristic.CoolingThresholdTemperature).updateValue((this.__cacheAirconCoolTemp == null) ? daikinACInfo.dt3 : this.__cacheAirconCoolTemp);   // cooling temp
                        this.__HeaterCoolerService.getCharacteristic(Characteristic.HeatingThresholdTemperature).updateValue((this.__cacheAirconHeatTemp == null) ? daikinACInfo.dt4 : this.__cacheAirconHeatTemp);   // heating temp
                        
                        // Need some way to work out the heat/cool limits if in auto mode and the target temp changed via the aircon renote....??????
                    }

                    if (this.__DehumidService != null) {
                        if (this.__cacheDehumidFanMode== null) {
                            this.__DehumidService.getCharacteristic(Characteristic.SwingMode).updateValue(Number(daikinACInfo.dfd2) == 3 ? Characteristic.SwingMode.SWING_ENABLED : Characteristic.SwingMode.SWING_DISABLED);
                        } else {
                            this.__DehumidService.getCharacteristic(Characteristic.SwingMode).updateValue(this.__cacheDehumidFanMode); // Cached change
                        }
                        if (this.__cacheDehumidFanSpeed == null) {
                            this.__DehumidService.getCharacteristic(Characteristic.RotationSpeed).updateValue(convertDaikinFanSpeedToHomeKit(daikinACInfo.dfr2));       
                        } else {
                            this.__DehumidService.getCharacteristic(Characteristic.RotationSpeed).updateValue(this.__cacheDehumidFanSpeed); // Cached change
                        }
                        this.__DehumidService.getCharacteristic(Characteristic.CurrentRelativeHumidity).updateValue(Number(daikinSensorInfo.hhum)); // doesnt seem a valid value, but we'll leave here
                        this.__DehumidService.getCharacteristic(Characteristic.TargetHumidifierDehumidifierState).updateValue(Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER);
                    }

                    if (this.__FanService != null) {
                        if (this.__cacheFanMode== null) {
                            this.__FanService.getCharacteristic(Characteristic.SwingMode).updateValue(Number(daikinACInfo.dfd6) == 3 ? Characteristic.SwingMode.SWING_ENABLED : Characteristic.SwingMode.SWING_DISABLED);
                        } else {
                            this.__FanService.getCharacteristic(Characteristic.SwingMode).updateValue(this.__cacheFanMode); // Cached change
                        }
                        if (this.__cacheFanSpeed == null) {
                            this.__FanService.getCharacteristic(Characteristic.RotationSpeed).updateValue(convertDaikinFanSpeedToHomeKit(daikinACInfo.dfr6));  
                        } else {
                            this.__FanService.getCharacteristic(Characteristic.RotationSpeed).updateValue(this.__cacheFanSpeed); // Cached change
                        }
                    }

                    // Set aircon mode/power/current status
                    switch (Number(daikinACInfo.mode)) {
                        case 0 :
                        case 1 :
                        case 7 :
                            // AUTO mode
                            if (this.__HeaterCoolerService != null) {
                                this.__HeaterCoolerService.getCharacteristic(Characteristic.TargetHeaterCoolerState).updateValue(Characteristic.TargetHeaterCoolerState.AUTO);
                                this.__HeaterCoolerService.getCharacteristic(Characteristic.Active).updateValue(Number(daikinACInfo.pow) == 1 ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
                                this.__HeaterCoolerService.getCharacteristic(Characteristic.SwingMode).updateValue(Number(daikinACInfo.f_dir) == 3 ? Characteristic.SwingMode.SWING_ENABLED : Characteristic.SwingMode.SWING_DISABLED);
                                this.__HeaterCoolerService.getCharacteristic(Characteristic.RotationSpeed).updateValue(convertDaikinFanSpeedToHomeKit(daikinACInfo.f_rate));
                                // Are we heating or cooling? Use current temp vs target temp to work this out
                                if (daikinSensorInfo.htemp > daikinACInfo.stemp) {
                                    // current temp is greater then target tenmp, so assume we're cooling
                                    this.__HeaterCoolerService.getCharacteristic(Characteristic.CurrentHeaterCoolerState).updateValue(Characteristic.CurrentHeaterCoolerState.COOLING);
                                } else if (daikinSensorInfo.htemp < daikinACInfo.stemp) {
                                    // current temp is less than target temp, so assume we're heating
                                    this.__HeaterCoolerService.getCharacteristic(Characteristic.CurrentHeaterCoolerState).updateValue(Characteristic.CurrentHeaterCoolerState.HEATING);
                                } else this.__HeaterCoolerService.getCharacteristic(Characteristic.CurrentHeaterCoolerState).updateValue(Characteristic.CurrentHeaterCoolerState.IDLE);
                            }
                            if (this.__DehumidService != null) this.__DehumidService.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.INACTIVE);
                            if (this.__FanService != null) this.__FanService.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.INACTIVE);
                            break;

                        case 2:
                            // De-humidifier mode
                            if (this.__HeaterCoolerService != null) {
                                this.__HeaterCoolerService.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.INACTIVE);
                                this.__HeaterCoolerService.getCharacteristic(Characteristic.CurrentHeaterCoolerState).updateValue(Characteristic.CurrentHeaterCoolerState.IDLE);
                            }
                            if (this.__DehumidService != null) {
                                this.__DehumidService.getCharacteristic(Characteristic.Active).updateValue(Number(daikinACInfo.pow) == 1 ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
                                this.__DehumidService.getCharacteristic(Characteristic.CurrentHumidifierDehumidifierState).updateValue(Number(daikinACInfo.pow) == 1 ? Characteristic.CurrentHumidifierDehumidifierState.DEHUMIDIFYING : Characteristic.CurrentHumidifierDehumidifierState.INACTIVE);
                            }
                            if (this.__FanService != null) this.__FanService.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.INACTIVE);
                            break;

                        case 3:
                            // Cool mode
                            if (this.__HeaterCoolerService != null) {
                                this.__HeaterCoolerService.getCharacteristic(Characteristic.TargetHeaterCoolerState).updateValue(Characteristic.TargetHeaterCoolerState.COOL);
                                this.__HeaterCoolerService.getCharacteristic(Characteristic.Active).updateValue(Number(daikinACInfo.pow) == 1 ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
                                this.__HeaterCoolerService.getCharacteristic(Characteristic.CurrentHeaterCoolerState).updateValue(Characteristic.CurrentHeaterCoolerState.COOLING);
                                this.__HeaterCoolerService.getCharacteristic(Characteristic.SwingMode).updateValue(Number(daikinACInfo.f_dir) == 3 ? Characteristic.SwingMode.SWING_ENABLED : Characteristic.SwingMode.SWING_DISABLED);
                                this.__HeaterCoolerService.getCharacteristic(Characteristic.RotationSpeed).updateValue(convertDaikinFanSpeedToHomeKit(daikinACInfo.f_rate));
                            }
                            if (this.__DehumidService != null) this.__DehumidService.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.INACTIVE);
                            if (this.__FanService != null) this.__FanService.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.INACTIVE);
                            break;

                        case 4:
                            // Heat mode
                            if (this.__HeaterCoolerService != null) {
                                this.__HeaterCoolerService.getCharacteristic(Characteristic.TargetHeaterCoolerState).updateValue(Characteristic.TargetHeaterCoolerState.HEAT);
                                this.__HeaterCoolerService.getCharacteristic(Characteristic.Active).updateValue(Number(daikinACInfo.pow) == 1 ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
                                this.__HeaterCoolerService.getCharacteristic(Characteristic.CurrentHeaterCoolerState).updateValue(Characteristic.CurrentHeaterCoolerState.HEATING);
                                this.__HeaterCoolerService.getCharacteristic(Characteristic.SwingMode).updateValue(Number(daikinACInfo.f_dir) == 3 ? Characteristic.SwingMode.SWING_ENABLED : Characteristic.SwingMode.SWING_DISABLED);
                                this.__HeaterCoolerService.getCharacteristic(Characteristic.RotationSpeed).updateValue(convertDaikinFanSpeedToHomeKit(daikinACInfo.f_rate));
                            }
                            if (this.__DehumidService != null) this.__DehumidService.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.INACTIVE);
                            if (this.__FanService != null) this.__FanService.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.INACTIVE);
                            break;

                        case 6:
                            // Fan mode
                            if (this.__HeaterCoolerService != null) {
                                this.__HeaterCoolerService.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.INACTIVE);
                                this.__HeaterCoolerService.getCharacteristic(Characteristic.CurrentHeaterCoolerState).updateValue(Characteristic.CurrentHeaterCoolerState.IDLE);
                            }
                            if (this.__FanService != null) {
                                this.__FanService.getCharacteristic(Characteristic.Active).updateValue(Number(daikinACInfo.pow) == 1 ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
                            }
                            break;
                    }
                }
            }
        }
    }
}

function setDaikinOption(DaikinIP, keyname, keyvalue) {
    // Mandatory parmeters to set daikin control options are:
    // pow
    // mode
    // stemp
    // shum
    // f_rate
    // f_dir
    var response = request("GET", "http://" + DaikinIP + "/aircon/get_control_info");
    if (response.statusCode == 200) {
        var daikinACInfo = JSON.parse(convertDaikinToJSON(response.body.toString('utf8')));
        var controlString = "";
        keyname = keyname.toLowerCase();
        controlString = ((keyname == "pow") ? "pow=" + keyvalue : "pow=" + daikinACInfo.pow)
                        + ((keyname == "mode") ? "&mode=" + keyvalue : "&mode=" + daikinACInfo.mode)
                        + ((keyname == "stemp") ? "&stemp=" + keyvalue : "&stemp=" + daikinACInfo.stemp)
                        + ((keyname == "shum") ? "&shum=" + keyvalue : "&shum=" + daikinACInfo.shum)
                        + ((keyname == "f_rate") ? "&f_rate=" + keyvalue : "&f_rate=" + daikinACInfo.f_rate)
                        + ((keyname == "f_dir") ? "&f_dir=" + keyvalue : "&f_dir=" + daikinACInfo.f_dir);
        if (keyname != "pow" && keyname != "mode" && keyname != "stemp" && keyname != "shum" && keyname != "f_rate" && keyname != "f_dir") controlString = controlString + "&" + keyname + "=" + keyvalue;
        var response = request("GET", "http://" + DaikinIP + "/aircon/set_control_info?" + controlString);
        if (response.statusCode == 200) {
            console.log("set daikin option '%s' to '%s'", keyname, keyvalue);
        }
    }  
}

function convertDaikinToJSON(httpinput) {
	// Daikin systems respond with HTTP response strings, not JSON objects. JSON is much easier to
	// parse, so we convert it with some RegExp here.
	return "{\"" + httpinput.replace(new RegExp("\=", 'g'), "\":\"").replace(new RegExp("\,", 'g'), "\",\"") + "\"}";
}

function convertDaikinFanSpeedToHomeKit(daikinFanSpeed) {
    var HomeKitValue = 100; // auto by default
    if (Number(daikinFanSpeed) == 3) HomeKitValue = 17; // lvl1
    if (Number(daikinFanSpeed) == 4) HomeKitValue = 33; // lvl2
    if (Number(daikinFanSpeed) == 5) HomeKitValue = 50; // lvl3
    if (Number(daikinFanSpeed) == 6) HomeKitValue = 67; // lvl4
    if (Number(daikinFanSpeed) == 7) HomeKitValue = 83; // lvl5
    if (daikinFanSpeed.toUpperCase() == "A") HomeKitValue = 100; // auto
    return HomeKitValue;
}

function convertHomeKitToDaikinFanSpeed(HomeKitValue) {
    var f_rate = "A";   // Auto my default
    if (HomeKitValue >= 1 && HomeKitValue <= 17) f_rate = "3";      // lvl1
    if (HomeKitValue >= 18 && HomeKitValue <= 33) f_rate = "4";     // lvl2
    if (HomeKitValue >= 34 && HomeKitValue <= 50) f_rate = "5";     // lvl3
    if (HomeKitValue >= 51 && HomeKitValue <= 67) f_rate = "6";     // lvl4
    if (HomeKitValue >= 68 && HomeKitValue <= 83) f_rate = "7";     // lvl5
    if (HomeKitValue >= 84 && HomeKitValue <= 100) f_rate = "A";    // Auto
    return f_rate
}

var response = request("GET", "http://" + DaikinIP + "/common/basic_info");
if (response.statusCode == 200) {
    var daikinInfo = JSON.parse(convertDaikinToJSON(response.body.toString('utf8')));

    // Create the main airconditioner accessory and associated accessories 
    var daikinAircon = new AirconditionerClass();
    daikinAircon.__accessory = exports.accessory = new Accessory(AccessoryName, uuid.generate("hap-nodejs:accessories:daikin"));
    daikinAircon.__accessory.username = daikinInfo.mac.substr(0,2) + ":" + daikinInfo.mac.substr(2,2) + ":" + daikinInfo.mac.substr(4,2) + ":" + daikinInfo.mac.substr(6,2) + ":" + daikinInfo.mac.substr(8,2) + ":" + daikinInfo.mac.substr(10,2);; 
    daikinAircon.__accessory.pincode = AccessoryPincode;
    daikinAircon.__accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, AccessoryManufacturer);
    daikinAircon.__accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Model, AccessoryModel);
    daikinAircon.__accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.SerialNumber, AccessorySerialNumber);
    daikinAircon.__accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, daikinInfo.ver.replace("_", "."));

    daikinAircon.addAirconditioner(daikinAircon.__accessory, "Air Conditioner", 1);
    daikinAircon.addDehumidifier(daikinAircon.__accessory, "Dehumidifier", 1);
    daikinAircon.addFan(daikinAircon.__accessory, "Fan", 1);
    daikinAircon.refreshHomeKit(2000);
}
