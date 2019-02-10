// HAP-Nodejs Nest Thermostat
// Integration of hydronic system for heating and daikin A/C for cooling centrally controlled from Nest 
//
// Daikin A/C control https://github.com/ael-code/daikin-control
// Nest REST Streaming https://developers.nest.com/guides/api/rest-streaming-guide
// Nest REST API https://developers.nest.com/guides/api/architecture-overview
//
// Version 4/2/2019

var JSONPackage = require('../package.json');
var Accessory = require('../').Accessory; 
var Service = require('../').Service;
var Characteristic = require('../').Characteristic;
var uuid = require('../').uuid;
var request = require('sync-request');
var storage = require('node-persist');
var EventSource = require('eventsource');

// Defines for the accessory
const AccessoryName =  "Thermostat";                    // name of accessory
const AccessoryPincode = "031-45-154";                  // pin code for paring 
const AccessoryUsername = "69:34:CC:5A:13:7A";          // MAC like address used by HomeKit to differentiate accessories. 
const AccessoryManufacturer = "Nest";             	    // manufacturer (optional)
const AccessoryModel = "Thermostat";                  // model (optional)
const AccessorySerialNumber = "123456789";       // serial number (optional) 
const AccessoryFirmwareRevision = JSONPackage.version;  // firmware revision (optional)

const NestClientID = "xxxxxxxxx";    // From Nest Dev portal
const NestClientSecret = "xxxx";           // from Nest Dev Portal
const NestPIN = "xxxxxx";                                     // Nest PIN

const DaikinURL = "http://xx.xx.xx.xx";                  // URL for Diakin system


// Create the "thermostat" object. This can be used as the template for multiple thermostat under the one accessory
function ThermostatClass() {
    this.__accessory = null;                    // Parent accessory object
    this.__ThermostatService = null;            // HomeKit service for this thermostat
    this.__OccupancyService = null;
    this.__HomeKitUpdating = false;             // flag that we're processing HomeKit updates
    this.__nestID = null;
    this.__nestAccessToken = null;
    this.__nestAPIURL = null;
    this.__nestCanHeat = null;
    this.__nestCanCool = null;
    this.__nestHasFan = null;
    this.__cachedHVACState = "";                // Cached hvac mode
    this.__waitSetTargetTemp = null;            // used if nest thermpostat off and target temp adjusted by HomeKit, set when thermostat on to this
    this.__waitSetTargetTempLow = null;         // used if nest thermpostat off and target temp adjusted by HomeKit, set when thermostat on to this
    this.__waitSetTargetTempHigh = null;        // used if nest thermpostat off and target temp adjusted by HomeKit, set when thermostat on to this
}

ThermostatClass.prototype = {
    addThermostat: function(HomeKitAccessory, thisServiceName, serviceNumber) {
        console.log("Setup Thermostat '%s' on '%s'", thisServiceName, HomeKitAccessory.username);

		// Add this thermostat to the "master" accessory and set properties
        this.__ThermostatService = HomeKitAccessory.addService(Service.Thermostat, thisServiceName, serviceNumber);
        this.__ThermostatService.addCharacteristic(Characteristic.CurrentRelativeHumidity)

        if (this.__nestCanCool == false && this.__nestCanHeat == true)
        {
            // Can heat only, so set values allowed for mode off/heat
            this.__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.HEAT]});
            this.__ThermostatService.removeCharacteristic(Characteristic.CoolingThresholdTemperature);
            this.__ThermostatService.removeCharacteristic(Characteristic.HeatingThresholdTemperature);
        } else if (this.__nestCanCool == true && this.__nestCanHeat == false) {
            // Can cool only
            this.__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.COOL]});
            this.__ThermostatService.removeCharacteristic(Characteristic.CoolingThresholdTemperature);
            this.__ThermostatService.removeCharacteristic(Characteristic.HeatingThresholdTemperature);
        } else if (this.__nestCanCool == true && this.__nestCanHeat == true) {
            // heat and cool - but we dont support auto mode due to two different systems interefaced (hydronic and A/C)
            this.__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.HEAT, Characteristic.TargetHeatingCoolingState.COOL]});
            this.__ThermostatService.removeCharacteristic(Characteristic.CoolingThresholdTemperature);
            this.__ThermostatService.removeCharacteristic(Characteristic.HeatingThresholdTemperature);
            //this.__ThermostatService.addCharacteristic(Characteristic.CoolingThresholdTemperature);
            //this.__ThermostatService.addCharacteristic(Characteristic.HeatingThresholdTemperature);
        } else if (this.__nestCanCool == false && this.__nestCanHeat == false) {
            // only off mode
            this.__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF]});
            this.__ThermostatService.removeCharacteristic(Characteristic.CoolingThresholdTemperature);
            this.__ThermostatService.removeCharacteristic(Characteristic.HeatingThresholdTemperature);
        }
 
        // Limit prop ranges
        this.__ThermostatService.getCharacteristic(Characteristic.CurrentTemperature).setProps({minStep: 0.5});
        this.__ThermostatService.getCharacteristic(Characteristic.TargetTemperature).setProps({minStep: 0.5}, {minValue: 9}, {maxValue: 32});
        this.__ThermostatService.getCharacteristic(Characteristic.CoolingThresholdTemperature).setProps({minStep: 0.5}, {minValue: 9}, {maxValue: 32});
        this.__ThermostatService.getCharacteristic(Characteristic.HeatingThresholdTemperature).setProps({minStep: 0.5}, {minValue: 9}, {maxValue: 32});

        // Setup set callbacks for characteristics
        this.__ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).on('set', this.setTempatureUnits.bind(this));
        this.__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).on('set', this.setHeatingCoolingMode.bind(this));
        this.__ThermostatService.getCharacteristic(Characteristic.TargetTemperature).on('set', this.setTargetTemperature.bind(this));

        this.__ThermostatService.getCharacteristic(Characteristic.CoolingThresholdTemperature).on('set', this.setTargetTemperatureLow.bind(this));
        this.__ThermostatService.getCharacteristic(Characteristic.HeatingThresholdTemperature).on('set', this.setTargetTemperatureHigh.bind(this));
        return this.__ThermostatService;   // Return object to this service
    },

    setTempatureUnits: function(value, callback) {
        setNestThermostatValue(this.__nestAPIURL, this.__nestAccessToken, this.__nestID, "temperature_scale", value == Characteristic.TemperatureDisplayUnits.CELSIUS ? "C" : "F");
        callback();
    },

    setHeatingCoolingMode: function(value, callback) {
        var tempMode = "";

        switch (value) {
            case Characteristic.TargetHeatingCoolingState.HEAT: {
                tempMode = "heat";
                break;
            }

            case Characteristic.TargetHeatingCoolingState.COOL: {
                tempMode = "cool";
                break; 
            }

            case Characteristic.TargetHeatingCoolingState.AUTO: {
                // Work around for "Hey Siri, turn on my thermostat". Appears to automatically, request mode as "auto", but we need to see what nest device supports
                if (this.__nestCanCool == true && this.__nestCanHeat == true) {
                    tempMode = "heat-cool";
                    //this.__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).updateValue(Characteristic.TargetHeatingCoolingState.AUTO);
                    //this.__ThermostatService.addCharacteristic(Characteristic.CoolingThresholdTemperature);
                    //this.__ThermostatService.addCharacteristic(Characteristic.HeatingThresholdTemperature);
                } else if (this.__nestCanCool == true && this.__nestCanHeat == false) {
                    tempMode = "cool";
                    this.__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).updateValue(Characteristic.TargetHeatingCoolingState.COOL);
                    this.__ThermostatService.removeCharacteristic(Characteristic.CoolingThresholdTemperature);
                    this.__ThermostatService.removeCharacteristic(Characteristic.HeatingThresholdTemperature);
                } else if (this.__nestCanCool == false && this.__nestCanHeat == true) {
                    tempMode = "heat";
                    this.__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).updateValue(Characteristic.TargetHeatingCoolingState.HEAT);
                    this.__ThermostatService.removeCharacteristic(Characteristic.CoolingThresholdTemperature);
                    this.__ThermostatService.removeCharacteristic(Characteristic.HeatingThresholdTemperature);
                } else {
                    tempMode = "off"
                    this.__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).updateValue(Characteristic.TargetHeatingCoolingState.OFF);
                    this.__ThermostatService.removeCharacteristic(Characteristic.CoolingThresholdTemperature);
                    this.__ThermostatService.removeCharacteristic(Characteristic.HeatingThresholdTemperature);
                }
                break;
            }

            case Characteristic.TargetHeatingCoolingState.OFF: {
                tempMode = "off";
                break;
            }
        }
        setNestThermostatValue(this.__nestAPIURL, this.__nestAccessToken, this.__nestID, "hvac_mode", tempMode);
        callback();
    },

    setTargetTemperature: function(value, callback) {
        if (this.__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).value != Characteristic.TargetHeatingCoolingState.OFF) {
            setNestThermostatValue(this.__nestAPIURL, this.__nestAccessToken, this.__nestID, "target_temperature_c", value);
        } else {
            // Since the nest thermostat is off, cache this figure to update target temp when teh nest thermpstat is switched on
            this.__waitSetTargetTemp = value;
        }
        callback();
    },

    setTargetTemperatureLow: function(value, callback) {
        if (this.__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).value != Characteristic.TargetHeatingCoolingState.OFF) {
            setNestThermostatValue(this.__nestAPIURL, this.__nestAccessToken, this.__nestID, "target_temperature_low_c", value);
        } else {
            // Since the nest thermostat is off, cache this figure to update target temp when teh nest thermpstat is switched on
            this.__waitSetTargetTempLow = value;
        }
        callback();
    },


    setTargetTemperatureHigh: function(value, callback) {
        if (this.__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).value != Characteristic.TargetHeatingCoolingState.OFF) {
            setNestThermostatValue(this.__nestAPIURL, this.__nestAccessToken, this.__nestID, "target_temperature_high_c", value);
        } else {
            // Since the nest thermostat is off, cache this figure to update target temp when teh nest thermpstat is switched on
            this.__waitSetTargetTempHigh = value;
        }
        callback();
    }
}

function getNestAccessToken() {
    var tempAccessToken = null;

    // Get Nest Access Token. This allows us to communiated with Nest account
    storage.initSync(); //start persistent storage

    if (typeof storage.getItem("nestAccessToken") === "undefined") {
        // Get access token from Nest
        var response = request("POST", "https://api.home.nest.com/oauth2/access_token?code="+NestPIN+"&client_id="+NestClientID+"&client_secret="+NestClientSecret+"&grant_type=authorization_code", {Headers: {}, body: ""});
        if (response.statusCode == 200) {
            tempAccessToken = JSON.parse(response.body).access_token;
            storage.setItem("nestAccessToken", tempAccessToken);
        } else {
            console.log("Error getting access token: Code %s", response.statusCode);
        }
    } else {
        // We have an alreadt stored toke, so retrive
        tempAccessToken = storage.getItem("nestAccessToken");
    }
    return tempAccessToken;
}

function setNestThermostatValue(nestAPIURL, nestAccessToken, nestDeviceID, nestKey, value) {
    var retValue = null;
    if (nestAccessToken != null && nestAccessToken != "" && nestKey != null && nestKey != "") {
        var response = request("PUT", nestAPIURL + "/devices/thermostats/"+nestDeviceID, {headers: {"Authorization": "Bearer "+nestAccessToken}, json: {[nestKey]: value} });
        if (response.statusCode == 200) {
            retValue = value;
            console.log("Set value of '%s' to '%s", nestKey, value);
        }
    }
    return retValue;
}

function getNestThermostatValue(nestAPIURL, nestAccessToken, nestDeviceID, nestKey) {
    var nestValue = null;
    if (nestAccessToken != null && nestAccessToken != "" && nestKey != null && nestKey != "") {
        var response = request("GET", nestAPIURL + "/devices/thermostats/"+nestDeviceID+"/"+nestKey,{headers: {"Authorization": "Bearer "+nestAccessToken} });
        if (response.statusCode == 200) {
            nestValue = JSON.parse(response.body);
        }
    } 
    return nestValue;
}

function setDaikinParms(daikinPwr, daikinMode, daikinTemp, daikinHumid, daikinFanSpeed, daikinFanMode) {
    var response = request("GET", DaikinURL + "/aircon/set_control_info?pow=" + daikinPwr + "&mode=" + daikinMode + "&stemp=" + daikinTemp + "&shum=" + daikinHumid + "&f_rate=" + daikinFanSpeed + "&f_dir=" + daikinFanMode);
    if (response.statusCode == 200) {
        console.log("Aircon set to Pwr: '%s' Mode: '%s' Temp: '%s' Fan Mode: '%s' Fan Speed: '%s'", daikinPwr, daikinMode, daikinTemp, daikinFanMode, daikinFanSpeed);
    }
}

var nestAccessToken = null;
var nestThermostats = [];
nestAccessToken = getNestAccessToken();
if (nestAccessToken != null) {
    // Got an access token to communicate with Nest
    console.log("Got access token: '%s'", nestAccessToken);
}

if (nestAccessToken != null && nestAccessToken != "") {
    var response = request("GET", "https://developer-api.nest.com/devices?auth="+nestAccessToken);
    if (response.statusCode == 200) {
        let tempThermostats = JSON.parse(response.body).thermostats;
        for (var index in tempThermostats) {
            // Create thermostat accessory for each discovered nest
            nestThermostats[index] = new ThermostatClass();
            nestThermostats[index].__accessory = exports.accessory = new Accessory(AccessoryName, uuid.generate("hap-nodejs:accessories:nest_" + tempThermostats[index].device_id));
            nestThermostats[index].__accessory.username = AccessoryUsername; 
            nestThermostats[index].__accessory.pincode = AccessoryPincode;
            nestThermostats[index].__accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, AccessoryManufacturer);
            nestThermostats[index].__accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Model, AccessoryModel);
            nestThermostats[index].__accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.SerialNumber, AccessorySerialNumber);
            nestThermostats[index].__accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, tempThermostats[index].software_version);

            // Get valus from Nest before we call to create the accessories under the accessory
            nestThermostats[index].__nestAPIURL = new URL(response.url).origin; // URL we actually talk to nest one.. Saves redirects
            nestThermostats[index].__nestAccessToken = nestAccessToken;
            nestThermostats[index].__nestID = tempThermostats[index].device_id;
            nestThermostats[index].__nestCanCool = tempThermostats[index].can_cool;
            nestThermostats[index].__nestCanHeat = tempThermostats[index].can_heat;
            nestThermostats[index].__nestHasFan = tempThermostats[index].has_fan;
            nestThermostats[index].__cachedHVACState = "";    // we'l update the cached state during the REST API stream 

            // Create the thermostat
            nestThermostats[index].__ThermostatService = nestThermostats[index].addThermostat(nestThermostats[index].__accessory, tempThermostats[index].name_long, 1);
        }    
    }
}

// We'll use teh nest REST streaming API to set status on HomeKit accessories
var nestRESTStream = new EventSource("https://developer-api.nest.com/", {"headers": {"Authorization": 'Bearer ' + nestAccessToken}});

nestRESTStream.addEventListener('put', function(event) {
    console.log("Received Nest REST Stream data update");
    var tempThermostats = JSON.parse(event.data).data.devices.thermostats;  // path in returned JSON for thermostats, now update settings
    for (var index in tempThermostats) {
        for (var index2 in nestThermostats) {
            if (tempThermostats[index].device_id == nestThermostats[index2].__nestID) {
                // Matched from JSON, so update
                nestThermostats[index2].__ThermostatService.getCharacteristic(Characteristic.CurrentRelativeHumidity).updateValue(tempThermostats[index].humidity);
                nestThermostats[index2].__ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).updateValue(tempThermostats[index].temperature_scale.toUpperCase() == "C" ? Characteristic.TemperatureDisplayUnits.CELSIUS : Characteristic.TemperatureDisplayUnits.FAHRENHEIT);
                nestThermostats[index2].__ThermostatService.getCharacteristic(Characteristic.CurrentTemperature).updateValue(tempThermostats[index].ambient_temperature_c);

                if (nestThermostats[index2].__waitSetTargetTemp != null) {
                    // been waiting to set target temp, but only do so if thermostat is changed from off state. Reflected cached HomeKit value otherwise
                    nestThermostats[index2].__ThermostatService.getCharacteristic(Characteristic.TargetTemperature).updateValue(nestThermostats[index2].__waitSetTargetTemp);
                    if (tempThermostats[index].hvac_mode.toUpperCase() != "OFF") {
                        setNestThermostatValue(nestThermostats[index2].__nestAPIURL, nestThermostats[index2].__nestAccessToken, nestThermostats[index2].__nestID, "target_temperature_c", nestThermostats[index2].__waitSetTargetTemp);
                        nestThermostats[index2].__waitSetTargetTemp = null;
                    }
                } else if (nestThermostats[index2].__waitSetTargetTemp == null) {
                    nestThermostats[index2].__ThermostatService.getCharacteristic(Characteristic.TargetTemperature).updateValue(tempThermostats[index].target_temperature_c);
                }

                // update cooling/heating modes
                nestThermostats[index2].__nestCanCool = tempThermostats[index].can_cool;
                nestThermostats[index2].__nestCanHeat = tempThermostats[index].can_heat;
                nestThermostats[index2].__nestHasFan = tempThermostats[index].has_fan;
                if (tempThermostats[index].can_cool == false && tempThermostats[index].can_heat == true)
                {
                    // Can heat only, so set values allowed for mode off/heat
                    nestThermostats[index2].__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.HEAT]});
                    nestThermostats[index2].__ThermostatService.removeCharacteristic(Characteristic.CoolingThresholdTemperature);
                    nestThermostats[index2].__ThermostatService.removeCharacteristic(Characteristic.HeatingThresholdTemperature);
                } else if (tempThermostats[index].can_cool == true && tempThermostats[index].can_heat == false) {
                    // Can cool only
                    nestThermostats[index2].__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.COOL]});
                    nestThermostats[index2].__ThermostatService.removeCharacteristic(Characteristic.CoolingThresholdTemperature);
                    nestThermostats[index2].__ThermostatService.removeCharacteristic(Characteristic.HeatingThresholdTemperature);
                } else if (tempThermostats[index].can_cool == true && tempThermostats[index].can_heat == true) {
                    // heat and cool - but since we have hydronic and a A/C, we dont support auto mode
                    nestThermostats[index2].__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.HEAT, Characteristic.TargetHeatingCoolingState.COOL]});
                    nestThermostats[index2].__ThermostatService.removeCharacteristic(Characteristic.CoolingThresholdTemperature);
                    nestThermostats[index2].__ThermostatService.removeCharacteristic(Characteristic.HeatingThresholdTemperature);
                    //nestThermostats[index2].__ThermostatService.addCharacteristic(Characteristic.CoolingThresholdTemperature);
                    //nestThermostats[index2].__ThermostatService.addCharacteristic(Characteristic.HeatingThresholdTemperature);
                } else if (tempThermostats[index].can_cool == false && tempThermostats[index].can_heat == false) {
                    // only off mode
                    nestThermostats[index2].__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF]});
                    nestThermostats[index2].__ThermostatService.removeCharacteristic(Characteristic.CoolingThresholdTemperature);
                    nestThermostats[index2].__ThermostatService.removeCharacteristic(Characteristic.HeatingThresholdTemperature);
                }

                // Update current mode
                switch(tempThermostats[index].hvac_mode.toUpperCase()) {
                    case "HEAT": {
                        nestThermostats[index2].__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).updateValue(Characteristic.TargetHeatingCoolingState.HEAT);
                        break;
                    }

                    case "COOL": {
                        nestThermostats[index2].__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).updateValue(Characteristic.TargetHeatingCoolingState.COOL);
                        break;
                    }

                    case "HEAT-COOL": {
                        nestThermostats[index2].__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).updateValue(Characteristic.TargetHeatingCoolingState.AUTO);
                        nestThermostats[index2].__ThermostatService.getCharacteristic(Characteristic.CoolingThresholdTemperature).updateValue(tempThermostats[index].target_temperature_low_c);
                        nestThermostats[index2].__ThermostatService.getCharacteristic(Characteristic.HeatingThresholdTemperature).updateValue(tempThermostats[index].target_temperature_high_c);
                        break;
                    }

                    case "OFF": {
                        nestThermostats[index2].__ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).updateValue(Characteristic.TargetHeatingCoolingState.OFF);
                        break;
                    }
                }

                // Update current state
                if (tempThermostats[index].has_fan == true && tempThermostats[index].fan_timer_active == true) {
                    // Assign that the fan is running as a "mode", but seems to be a bug in the nest API, that fan active can be true when timeout has been reached
                    // so we need to check the fan_timer_timeout to see if 
                    if (tempThermostats[index].hvac_state.toUpperCase() == "OFF" && new Date(tempThermostats[index].fan_timer_timeout).getTime() != 0) {
                        tempThermostats[index].hvac_state = "FAN"; 
                    } else if (tempThermostats[index].fan_timer_active == true && new Date(tempThermostats[index].fan_timer_timeout).getTime() == 0) {
                        // Fix up Nest API bug
                        setNestThermostatValue(nestThermostats[index2].__nestAPIURL, nestThermostats[index2].__nestAccessToken, nestThermostats[index2].__nestID, "fan_timer_active", false);
                    }
                } 

                switch(tempThermostats[index].hvac_state.toUpperCase()) {
                    case "HEATING": {
                        if (nestThermostats[index2].__nestCanHeat == true) {
                            // Currently heating, so stop aircon if running and thermostat supports cooling
                            if (nestThermostats[index2].__nestCanCool == true) {
                                if (nestThermostats[index2].__cachedHVACState.toUpperCase() != "HEATING") {
                                    setDaikinParms(0, 3, nestThermostats[index2].__ThermostatService.getCharacteristic(Characteristic.TargetTemperature).value, 0, "A", 3);
                                }
                            }
                            nestThermostats[index2].__ThermostatService.getCharacteristic(Characteristic.CurrentHeatingCoolingState).updateValue(Characteristic.CurrentHeatingCoolingState.HEAT);
                        }
                        break;
                    }

                    case "COOLING": {
                        if (nestThermostats[index2].__nestCanCool == true) {
                            // Switched to cooling mode, so start up aircon
                            setDaikinParms(1, 3, nestThermostats[index2].__ThermostatService.getCharacteristic(Characteristic.TargetTemperature).value, 0, "A", 3);
                            nestThermostats[index2].__ThermostatService.getCharacteristic(Characteristic.CurrentHeatingCoolingState).updateValue(Characteristic.CurrentHeatingCoolingState.COOL);
                        }
                        break;
                    }

                    case "OFF": {
                        // Currently cooling/heating, but switched to off, so stop aircon if running
                        if (nestThermostats[index2].__nestCanCool == true) {
                            if (nestThermostats[index2].__cachedHVACState.toUpperCase() != "OFF") {
                                // switching from another hVAC state to Off, so turn off aircon. This should allow manual oeration of the aircon without ther thermostat periodiclly
                                // turning it off during updates. First run of thermostat may do this though.....fix???
                                setDaikinParms(0, 3, nestThermostats[index2].__ThermostatService.getCharacteristic(Characteristic.TargetTemperature).value, 0, "A", 3);
                            }
                        }
                        nestThermostats[index2].__ThermostatService.getCharacteristic(Characteristic.CurrentHeatingCoolingState).updateValue(Characteristic.CurrentHeatingCoolingState.OFF);
                        break;
                    }

                    case "FAN": {
                        // Fan configured. work out status of fan from thermostat and start/stop on the Daikin as required
                        if (nestThermostats[index2].__nestHasFan == true) {
                            setDaikinParms(1, 6, "--", "--", "A", 3);

                            // Report to HomeKit current mode is "OFF" as there is no seprate FAN linked.
                            nestThermostats[index2].__ThermostatService.getCharacteristic(Characteristic.CurrentHeatingCoolingState).updateValue(Characteristic.CurrentHeatingCoolingState.OFF);
                        }
                        // TODO --- Something later to update HomeKit for a fan going. Proberly needs a fan servce or something.
                        break;
                    }
                }

                // Updated cached HVAC state
                nestThermostats[index2].__cachedHVACState = tempThermostats[index].hvac_state;
            }
        }
    }
});

nestRESTStream.addEventListener('open', function(event) {
    console.log('Connection opened for nest REST Streaming');
});

nestRESTStream.addEventListener('auth_revoked', function(event) {
    console.log('Authentication token was revoked.');
    // Re-authenticate your user here.
});

nestRESTStream.addEventListener('error', function(event) {
    if (event.readyState == EventSource.CLOSED) {
        console.error('Connection was closed!', event);
        // TODO --- Re-open connection if it was closed
    } else {
        console.error('An unknown error occurred: ', event);
    }
}, false);
