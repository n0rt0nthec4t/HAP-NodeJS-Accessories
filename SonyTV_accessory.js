// HAP-Nodejs Sony Brava TV
// 
// https://pro-bravia.sony.net/develop/
//
// Mark Hulskamp
var Accessory = require('../').Accessory; 
var Service = require('../').Service;
var Characteristic = require('../').Characteristic;
var uuid = require('../').uuid;
var request = require('sync-request');

// Defines for the accessory
const AccessoryName =  "Television";                        // name of accessory
const AccessoryPincode = "031-45-154";                      // pin code for paring  

const SonyTVIP = "x.x.x.x";                                 // IP address for TV
const SonyTVPSK = "0000";                                   // PSK key


// Define some extra remote commands
Characteristic.RemoteKey.SETTINGS = 101;


// Create the TV system object. This can be used as the template for multiple aircons under the one accessory
function SonyTVClass() {
    this.__accessory = null;                    // Parent accessory object
    this.__TVService = null;                    // HomeKit service for the TV
    this.__SpeakerService = null;               // HomeKit service for the TV speaker
    this.__RemoteCommands = [];                 // List fo remote commands for this TV
    this.__TVInputs = [];                       // array of input objects.
    this.__timerFunc = null;                    // object to created update loop timer
    this.__waitSetInput = null;                 // cache input if selected while TV is off.. We'll set this input when TV is turned on
    this.__updatingHomeKit = false;
}

function InputClass() {
    this.__ID = null;
    this.__InputService = null;
    this.__uri = null;
}

SonyTVClass.prototype = {
    addTelevison: function(HomeKitAccessory, thisServiceName, serviceNumber) {
        console.log("Setup Sony Television '%s' on '%s'", thisServiceName, HomeKitAccessory.username);

        this.__accessory = HomeKitAccessory;
        this.__TVService = HomeKitAccessory.addService(Service.Television, thisServiceName, serviceNumber);
        this.__TVService.setCharacteristic(Characteristic.ConfiguredName, thisServiceName);
        this.__TVService.setCharacteristic(Characteristic.SleepDiscoveryMode, Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);

        // Add the TV speaker as a service
        this.__SpeakerService = HomeKitAccessory.addService(Service.TelevisionSpeaker);
        this.__SpeakerService.setCharacteristic(Characteristic.VolumeControlType, Characteristic.VolumeControlType.ABSOLUTE);
        //this.__SpeakerService.setCharacteristic(Characteristic.VolumeControlType, Characteristic.VolumeControlType.RELATIVE_WITH_CURRENT);

        // Setup call backs
        this.__TVService.getCharacteristic(Characteristic.Active).on('set', this.setPowerState.bind(this));
        this.__TVService.getCharacteristic(Characteristic.ActiveIdentifier).on('set', this.setActiveInput.bind(this));
        this.__TVService.getCharacteristic(Characteristic.RemoteKey).on('set', this.setRemoteKey.bind(this));
        this.__SpeakerService.getCharacteristic(Characteristic.VolumeSelector).on('set', this.setVolume.bind(this));
        this.__TVService.getCharacteristic(Characteristic.PowerModeSelection).on('set', this.accessTVSettings.bind(this));

        // Build list of inputs for both physcial and applicaions        
        this.__buildRemoteCmdList();
        this.__buildInputList();
        this.__buildApplicationList();

        // Force HomeKit update for inital state
        this.__SonyTVStatus();

        return this.__TVService;   // Return object to this service
    },

    setPowerState: function(state, callback)
    {
        this.__updatingHomeKit = true;
        
        // Turns on/off the TV
        var response = request("POST", "http://" + SonyTVIP + "/sony/system", {headers: {"X-Auth-PSK": SonyTVPSK}, json: {"method": "setPowerStatus", "id": 55, "params": [{"status": (state == Characteristic.Active.ACTIVE) ? true : false}], "version": "1.0"} });
        if (response.statusCode == 200) {
            console.log("Set power on Sony TV @" + SonyTVIP + " to " + ((state == Characteristic.Active.ACTIVE) ? "On" : "Off"));

            // Reflect active state for the speaker service also
            if (this.__SpeakerService != null) {
                this.__SpeakerService.getCharacteristic(Characteristic.Active).updateValue(state);
            }

            // See if we have a cached input to set if status is power on
            if (this.__waitSetInput != null && state == Characteristic.Active.ACTIVE) {
                this.__TVService.getCharacteristic(Characteristic.ActiveIdentifier).setValue(this.__waitSetInput);
                this.__waitSetInput = null;
            } 
            callback(); // set power state
        }
        this.__updatingHomeKit = false;
    },

    setActiveInput: function(inputID, callback)
    {
        this.__updatingHomeKit = true;

        // Switches inputs on the TV
        for (var index in this.__TVInputs) {
            // search thru the input list to work out which input is to be selected
            if (inputID == this.__TVInputs[index].__ID) {
                var response = request("POST", "http://" + SonyTVIP + "/sony/avContent", {headers: {"X-Auth-PSK": SonyTVPSK}, json: {"method": "setPlayContent", "id": 13, "params": [{"uri": this.__TVInputs[index].__uri}],  "version": "1.0"} });
                if (response.statusCode == 200 && typeof JSON.parse(response.body).result !== 'undefined') {
                    console.log("Set input on Sony TV @" + SonyTVIP + " to " + this.__TVInputs[index].__uri);
                } else {
                    // REST API post failed, so cache value we wanted to set
                    this.__waitSetInput = inputID;
                }
            }
        }

        this.__updatingHomeKit = false;
        callback(); // set input
    },

    setRemoteKey: function(value, callback) {
        if (this.__RemoteCommands[value] !== "undefined" && this.__RemoteCommands[value] != "") {
            var IRCCBodyRequest = '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:X_SendIRCC xmlns:u="urn:schemas-sony-com:service:IRCC:1"><IRCCCode>' + this.__RemoteCommands[value] + '</IRCCCode></u:X_SendIRCC></s:Body></s:Envelope>';
            var response = request("POST", "http://" + SonyTVIP + "/sony/IRCC", {headers: {"X-Auth-PSK": SonyTVPSK, "Content-Type": "text/xml", "soapaction": '"urn:schemas-sony-com:service:IRCC:1#X_SendIRCC"'}, body: IRCCBodyRequest });
            if (response.statusCode == 200) {
                callback(); // set input
            }
        }
    },

    setVolume: function(value, callback) {
        var response = request("POST", "http://" + SonyTVIP + "/sony/audio", {headers: {"X-Auth-PSK": SonyTVPSK}, json: {"method": "setAudioVolume", "id": 601, "params": [{"target": "speaker", "volume": (value == Characteristic.VolumeSelector.INCREMENT ? "+1" : "-1")}],  "version": "1.0"} });
        callback();
    },

    accessTVSettings: function(value, callback) {
        if (value == Characteristic.PowerModeSelection.SHOW && this.__RemoteCommands[Characteristic.RemoteKey.SETTINGS] !== "undefined" && this.__RemoteCommands[Characteristic.RemoteKey.SETTINGS] != "") {
            var IRCCBodyRequest = '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:X_SendIRCC xmlns:u="urn:schemas-sony-com:service:IRCC:1"><IRCCCode>' + this.__RemoteCommands[Characteristic.RemoteKey.SETTINGS] + '</IRCCCode></u:X_SendIRCC></s:Body></s:Envelope>';
            var response = request("POST", "http://" + SonyTVIP + "/sony/IRCC", {headers: {"X-Auth-PSK": SonyTVPSK, "Content-Type": "text/xml", "soapaction": '"urn:schemas-sony-com:service:IRCC:1#X_SendIRCC"'}, body: IRCCBodyRequest });
        }
        callback();
    },

    __buildRemoteCmdList: function() {
        // Create mapping of available remote commands so we can use in HomeKit remote app
        var response = request("POST", "http://" + SonyTVIP + "/sony/system", {headers: {"X-Auth-PSK": SonyTVPSK}, json: {"method": "getRemoteControllerInfo", "id": 1, "params": [""],  "version": "1.0"} });
        if (response.statusCode == 200 && typeof JSON.parse(response.body).result !== 'undefined') {
            var tempRemoteList = JSON.parse(response.body).result[1];
            this.__RemoteCommands = [];
            for (var index in tempRemoteList) {
                switch (tempRemoteList[index].name.toUpperCase()) {
                    case "REWIND" :
                    {
                        this.__RemoteCommands[Characteristic.RemoteKey.REWIND] = tempRemoteList[index].value;
                        break;
                    }

                    case "FORWARD" :
                    {
                        this.__RemoteCommands[Characteristic.RemoteKey.FAST_FORWARD] = tempRemoteList[index].value;
                        break;
                    }


                    case "NEXT" :
                    {
                        this.__RemoteCommands[Characteristic.RemoteKey.NEXT_TRACK] = tempRemoteList[index].value;
                        break;
                    }

                    case "PREV" :
                    {
                        this.__RemoteCommands[Characteristic.RemoteKey.PREVIOUS_TRACK] = tempRemoteList[index].value;
                        break;
                    }

                    case "UP" :
                    {
                        this.__RemoteCommands[Characteristic.RemoteKey.ARROW_UP] = tempRemoteList[index].value;
                        break;
                    }

                    case "DOWN" :
                    {
                        this.__RemoteCommands[Characteristic.RemoteKey.ARROW_DOWN] = tempRemoteList[index].value;
                        break;
                    }

                    case "LEFT" :
                    {
                        this.__RemoteCommands[Characteristic.RemoteKey.ARROW_LEFT] = tempRemoteList[index].value;
                        break;
                    }

                    case "RIGHT" :
                    {
                        this.__RemoteCommands[Characteristic.RemoteKey.ARROW_RIGHT] = tempRemoteList[index].value;
                        break;
                    }

                    case "CONFIRM" :
                    {
                        this.__RemoteCommands[Characteristic.RemoteKey.SELECT] = tempRemoteList[index].value;
                        break;
                    }

                    case "RETURN" :
                    {
                        this.__RemoteCommands[Characteristic.RemoteKey.BACK] = tempRemoteList[index].value;
                        break;
                    }

                    case "EXIT" :
                    {
                        this.__RemoteCommands[Characteristic.RemoteKey.EXIT] = tempRemoteList[index].value;
                        break;
                    }

                    case "PLAY" :
                    case "PAUSE" :
                    {
                        //tempSonyRemoteKeys[Characteristic.RemoteKey.PLAY_PAUSE] = tempRemoteList[index].value;
                        break;
                    }

                    case "DISPLAY" :
                    {
                        this.__RemoteCommands[Characteristic.RemoteKey.INFORMATION] = tempRemoteList[index].value;
                        break;
                    }

                    case "ACTIONMENU" :
                    {
                        this.__RemoteCommands[Characteristic.RemoteKey.SETTINGS] = tempRemoteList[index].value;
                        break;
                    }
                }
            }
        } 
    },

    __buildInputList: function() {
        // Build and setup HomeKit objects for the available inputs on the TV
        var response = request("POST", "http://" + SonyTVIP + "/sony/avContent", {headers: {"X-Auth-PSK": SonyTVPSK}, json: {"method": "getCurrentExternalInputsStatus", "id": 105, "params": [""], "version": "1.0"} });
        if (response.statusCode == 200 && typeof JSON.parse(response.body).result !== 'undefined') {
            var tempInputList = JSON.parse(response.body).result[0];
            for (var index in tempInputList) {
                this.__TVInputs[index] = new InputClass();
                this.__TVInputs[index].__InputService = this.__accessory.addService(Service.InputSource, tempInputList[index].title, index);
                this.__TVInputs[index].__uri = tempInputList[index].uri;
                this.__TVInputs[index].__ID = index;

                if (tempInputList[index].label != "") {
                    this.__TVInputs[index].__InputService.setCharacteristic(Characteristic.ConfiguredName, tempInputList[index].title + " (" + tempInputList[index].label + ")");
                }
    
                this.__TVInputs[index].__InputService.setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED);
                this.__TVInputs[index].__InputService.setCharacteristic(Characteristic.CurrentVisibilityState, Characteristic.CurrentVisibilityState.SHOWN);
                this.__TVInputs[index].__InputService.setCharacteristic(Characteristic.TargetVisibilityState, Characteristic.CurrentVisibilityState.SHOWN);    
                this.__TVInputs[index].__InputService.setCharacteristic(Characteristic.Identifier, index);

                // Determine the input type by the "icon" tag. Split after the "meta:" entry for the type
                switch(tempInputList[index].icon.split(":")[1].toUpperCase())
                {
                    case "HDMI" :
                    {
                        this.__TVInputs[index].__InputService.setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.HDMI);
                        break
                    }

                    case "COMPONENT" :
                    {
                        this.__TVInputs[index].__InputService.setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.COMPONENT_VIDEO);
                        break
                    }

                    case "COMPOSITE" :
                    {
                        this.__TVInputs[index].__InputService.setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.COMPOSITE_VIDEO);
                        break
                    }

                    case "SVIDEO" :
                    {
                        this.__TVInputs[index].__InputService.setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.S_VIDEO);
                        break
                    }

                    case "WIFIDISPLAY" :
                    {
                        this.__TVInputs[index].__InputService.setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.AIRPLAY);
                        break
                    }
                }
                this.__TVInputs[index].__InputService.getCharacteristic(Characteristic.TargetVisibilityState).on('set', this.HomeKitInputStatus.bind(this.__TVInputs[index]));
                this.__TVService.addLinkedService(this.__TVInputs[index].__InputService);
            }
            
            // Add an input(s) for any tuners. This doesnt appear in the list of external inputs, so we use another call to see whats defined        
            var response = request("POST", "http://" + SonyTVIP + "/sony/avContent", {headers: {"X-Auth-PSK": SonyTVPSK}, json: {"method": "getSourceList", "id": 1, "params": [{"scheme": "tv"}], "version": "1.0"} });
            if (response.statusCode == 200 && typeof JSON.parse(response.body).result !== 'undefined') {
                var tempInputList = JSON.parse(response.body).result[0];
                for (var index2 in tempInputList) {
                    index++;    // Use index from previous input list loop to increase here
                    this.__TVInputs[index] = new InputClass();
                    this.__TVInputs[index].__InputService = this.__accessory.addService(Service.InputSource, (tempInputList[index2].source.substr(0,4).toUpperCase() == "TV:D" ? "Digital Tuner" : "Tuner"), index);
                    this.__TVInputs[index].__uri = tempInputList[index2].source;
                    this.__TVInputs[index].__ID = index;
                    this.__TVInputs[index].__InputService.setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.TUNER);
                    this.__TVInputs[index].__InputService.setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED);
                    this.__TVInputs[index].__InputService.setCharacteristic(Characteristic.CurrentVisibilityState, Characteristic.CurrentVisibilityState.SHOWN);
                    this.__TVInputs[index].__InputService.setCharacteristic(Characteristic.TargetVisibilityState, Characteristic.CurrentVisibilityState.SHOWN);
                    this.__TVInputs[index].__InputService.setCharacteristic(Characteristic.Identifier, index);
                    this.__TVInputs[index].__InputService.getCharacteristic(Characteristic.TargetVisibilityState).on('set', this.HomeKitInputStatus.bind(this.__TVInputs[index]));
                    this.__TVService.addLinkedService(this.__TVInputs[index].__InputService);
                }
            }
        }
        else {
            console.log("Failed to get input list from Sony TV @", SonyTVIP);
        }     
    },

    HomeKitInputStatus: function(state, callback) {
        // Allow enabling/disble input section in homekit
        this.__InputService.getCharacteristic(Characteristic.CurrentVisibilityState).updateValue(state);
        this.__InputService.getCharacteristic(Characteristic.TargetVisibilityState).updateValue(state);
        callback();
    },

    __buildApplicationList: function() {
        // TODO
    },

    refreshHomeKit: function(refreshTimeMS) {
        // setup status check interval as defined
        if (this.__timerFunc != null) {
            // current update timer running, so cancel it.
            clearInterval(this.__timerFunc);
        }
        this.__timerFunc = setInterval(this.__SonyTVStatus.bind(this), refreshTimeMS); 
        console.log("Refresh status in HomeKit set for every '%s'ms", refreshTimeMS);
    },

    __SonyTVStatus: function() {
        const scale = (num, in_min, in_max, out_min, out_max) => {
            if (num > out_max) num = out_max;
            if (num < out_min) num = out_min;
            return (num - in_min) * (out_max - out_min) / (in_max - in_min) + out_min;
        }

        if (this.__updatingHomeKit == false) {
            // Get power status
            var response = request("POST", "http://" + SonyTVIP + "/sony/system", {headers: {"X-Auth-PSK": SonyTVPSK}, json: {"method": "getPowerStatus", "id": 50, "params": [""],  "version": "1.0"} });
            if (response.statusCode == 200 && typeof JSON.parse(response.body).result !== 'undefined') {
                this.__TVService.getCharacteristic(Characteristic.Active).updateValue((JSON.parse(response.body).result[0].status.toUpperCase() == "ACTIVE" ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE));

                if (JSON.parse(response.body).result[0].status.toUpperCase() == "ACTIVE" && this.__waitSetInput != null) {
                    // TVs been switched on externally to HomeKit and we have an "cached input value. We'll clear the cached value in this case and let teh loop below update the current state
                    this.__waitSetInput = null;
                }
            }
        }

        if (this.__updatingHomeKit == false) {
            // Get active input
            var response = request("POST", "http://" + SonyTVIP + "/sony/avContent", {headers: {"X-Auth-PSK": SonyTVPSK}, json: {"method": "getPlayingContentInfo", "id": 103, "params": [""],  "version": "1.0"} });
            if (response.statusCode == 200 && typeof JSON.parse(response.body).result !== 'undefined') {
                for (var index in this.__TVInputs) {
                    // search thru the input list to work out which input is to be selected
                    if ((JSON.parse(response.body).result[0].uri == this.__TVInputs[index].__uri) || (JSON.parse(response.body).result[0].source == "tv:dvbt" && JSON.parse(response.body).result[0].source == this.__TVInputs[index].__uri)) {
                        this.__TVService.getCharacteristic(Characteristic.ActiveIdentifier).updateValue(this.__TVInputs[index].__ID);
                    }
                }
            } else if (this.__waitSetInput != null) {
                // since we got an error requesting inputs, we assume TV is off.. So if we have an input waiting to be set with the physcial TV, update that to reflect in HomeKit
                this.__TVService.getCharacteristic(Characteristic.ActiveIdentifier).updateValue(this.__waitSetInput);
            }
        }
        
        if (this.__updatingHomeKit == false) {
            // get volume information
            var response = request("POST", "http://" + SonyTVIP + "/sony/avContent", {headers: {"X-Auth-PSK": SonyTVPSK}, json: {"method": "getVolumeInformation", "id": 33, "params": [""],  "version": "1.0"} });
            if (response.statusCode == 200 && typeof JSON.parse(response.body).result !== 'undefined') {
                var tempVolumeInfo = JSON.parse(response.body).result[0];
                for (var index in tempVolumeInfo)
                {
                    if (tempVolumeInfo[index].target.toUpperCase() == "SPEAKER")
                    {
                        // Scale volume
                        this.__SpeakerService.getCharacteristic(Characteristic.Volume).updateValue(scale(tempVolumeInfo[index].volume, tempVolumeInfo[index].minVolume, tempVolumeInfo[index].maxVolume, 0, 100));
                    }
                }
            }
        }
    }
}

var response = request("POST", "http://" + SonyTVIP + "/sony/system", {headers: {"X-Auth-PSK": SonyTVPSK}, json: {"method": "getSystemInformation", "id": 33, "params": [""], "version": "1.0"} });
if (response.statusCode == 200 && typeof JSON.parse(response.body).result !== 'undefined') {
    var SonyTVSystemInfo = JSON.parse(response.body).result[0];
    var SonyTV = new SonyTVClass();
    SonyTV.__accessory = exports.accessory = new Accessory(AccessoryName, uuid.generate("hap-nodejs:accessories:sony_"));
    SonyTV.__accessory.username = SonyTVSystemInfo.macAddr; // We'll use the TVs mac address for the HomeKit one 
    SonyTV.__accessory.pincode = AccessoryPincode;
    SonyTV.__accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, "Sony");
    SonyTV.__accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Model, SonyTVSystemInfo.model);
    SonyTV.__accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.SerialNumber, SonyTVSystemInfo.serial);
    SonyTV.__accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, SonyTVSystemInfo.generation);

    SonyTV.addTelevison(SonyTV.__accessory, AccessoryName, 1);
    SonyTV.refreshHomeKit(2000);    // Refresh HomeKit every 2 seconds
} else {
    console.log("failed to get details from Sony TV @", SonyTVIP);
}