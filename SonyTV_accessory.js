// HAP-Nodejs Sony Brava TV
// 
// https://pro-bravia.sony.net/develop/
//
var JSONPackage = require('../package.json')
var Accessory = require('../').Accessory; 
var Service = require('../').Service;
var Characteristic = require('../').Characteristic;
var uuid = require('../').uuid;
var request = require('sync-request');

// Defines for the accessory
const AccessoryName =  "Sony Bravia TV";                    // name of accessory
const AccessoryPincode = "031-45-154";                      // pin code for paring  

const SonyTVIP = "xxx.xxx.xxx";                              // IP address for TV
const SonyTVPSK = "0000";                                   // PSK key



// Create the TV system object. This can be used as the template for multiple aircons under the one accessory
function SonyTVClass() {
    this.__accessory = null;                    // Parent accessory object
    this.__TVService = null;                    // HomeKit service for the TV
    this.__SpeakerService = null;               // HomeKit service for the TV speaker
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
                if (response.statusCode == 200) {
                    if (typeof JSON.parse(response.body).result !== 'undefined') {
                        console.log("Set input on Sony TV @" + SonyTVIP + " to " + this.__TVInputs[index].__uri);
                    } else {
                        // REST API post failed, mosy likely due to display off, so cache value we wanted to set
                        this.__waitSetInput = inputID;
                    }
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
        var tempSonyRemoteKey = "";
        switch (value) {
            case Characteristic.RemoteKey.REWIND :
            {
                tempSonyRemoteKey = 'AAAAAgAAAJcAAAAbAw==';
                break;
            }

            case Characteristic.RemoteKey.FAST_FORWARD :
            {
                tempSonyRemoteKey = 'AAAAAgAAAJcAAAAcAw==';
                break;
            }

            case Characteristic.RemoteKey.NEXT_TRACK :
            {
                tempSonyRemoteKey = 'AAAAAgAAAJcAAAA9Aw==';
                break;
            }

            case Characteristic.RemoteKey.PREVIOUS_TRACK :
            {
                tempSonyRemoteKey = 'AAAAAgAAAJcAAAA8Aw==';
                break;
            }

            case Characteristic.RemoteKey.ARROW_UP :
            {
                tempSonyRemoteKey = 'AAAAAQAAAAEAAAB0Aw==';
                break;
            }

            case Characteristic.RemoteKey.ARROW_DOWN :
            {
                tempSonyRemoteKey = 'AAAAAQAAAAEAAAB1Aw==';
                break;
            }

            case Characteristic.RemoteKey.ARROW_LEFT :
            {
                tempSonyRemoteKey = 'AAAAAQAAAAEAAAA0Aw==';
                break;
            }

            case Characteristic.RemoteKey.ARROW_RIGHT :
            {
                tempSonyRemoteKey = 'AAAAAQAAAAEAAAAzAw==';
                break;
            }
            case Characteristic.RemoteKey.SELECT : 
            {
                tempSonyRemoteKey = 'AAAAAQAAAAEAAABlAw==';
                break;
            }

            case Characteristic.RemoteKey.BACK :
            {
                tempSonyRemoteKey = 'AAAAAgAAAJcAAAAjAw==';
                break;
            }

            case Characteristic.RemoteKey.EXIT :
            {
                tempSonyRemoteKey = 'AAAAAQAAAAEAAABjAw==';
                break;
            }

            case Characteristic.RemoteKey.PLAY_PAUSE :
            {
                //Play”	“AAAAAgAAAJcAAAAaAw==”
                //“Pause”	“AAAAAgAAAJcAAAAZAw==”
                break;
            }

            case Characteristic.RemoteKey.INFORMATION :
            {
                tempSonyRemoteKey = 'AAAAAQAAAAEAAAA6Aw==';
                break;
            }
        }
        if (tempSonyRemoteKey != "") {
            var IRCCBodyRequest = '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:X_SendIRCC xmlns:u="urn:schemas-sony-com:service:IRCC:1"><IRCCCode>' + tempSonyRemoteKey + '</IRCCCode></u:X_SendIRCC></s:Body></s:Envelope>';
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
        if (value == Characteristic.PowerModeSelection.SHOW) {
            var IRCCBodyRequest = '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:X_SendIRCC xmlns:u="urn:schemas-sony-com:service:IRCC:1"><IRCCCode>AAAAAgAAAMQAAABLAw==</IRCCCode></u:X_SendIRCC></s:Body></s:Envelope>';
            var response = request("POST", "http://" + SonyTVIP + "/sony/IRCC", {headers: {"X-Auth-PSK": SonyTVPSK, "Content-Type": "text/xml", "soapaction": '"urn:schemas-sony-com:service:IRCC:1#X_SendIRCC"'}, body: IRCCBodyRequest });
        }
        //Home	AAAAAQAAAAEAAABgAw==
        //Options	AAAAAgAAAJcAAAA2Aw==
        //ActionMenu	AAAAAgAAAMQAAABLAw==
        callback();
    },

    __buildInputList: function() {
        // Build and setup HomeKit objects for the available inputs on the TV
        var response = request("POST", "http://" + SonyTVIP + "/sony/avContent", {headers: {"X-Auth-PSK": SonyTVPSK}, json: {"method": "getCurrentExternalInputsStatus", "id": 105, "params": [""], "version": "1.1"} });
        if (response.statusCode == 200) {
            var tempInputList = JSON.parse(response.body).result[0];
            for (var index in tempInputList) {
                this.__TVInputs[index] = new InputClass();
                this.__TVInputs[index].__InputService = this.__accessory.addService(Service.InputSource, tempInputList[index].title, index);
                this.__TVInputs[index].__uri = tempInputList[index].uri;
                this.__TVInputs[index].__ID = index;

                if (tempInputList[index].label != "") {
                    //this.__TVInputs[index].__InputService.setCharacteristic(Characteristic.ConfiguredName, tempInputList[index].label);
                    this.__TVInputs[index].__InputService.setCharacteristic(Characteristic.ConfiguredName, tempInputList[index].title + " (" + tempInputList[index].label + ")");
                }
      
                this.__TVInputs[index].__InputService.setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED);
                this.__TVInputs[index].__InputService.setCharacteristic(Characteristic.Identifier, index);

                // Determine teh input type by the "icon" tag. Split after the "meta:" entry for the type
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
                this.__TVService.addLinkedService(this.__TVInputs[index].__InputService);
            }
            
            // Add an input for the tuner. This doesnt appear in the list of external inputs
            index++;
            this.__TVInputs[index] = new InputClass();
            this.__TVInputs[index].__InputService = this.__accessory.addService(Service.InputSource, "Digital Tuner", index);
            this.__TVInputs[index].__uri = "tv:dvbt";
            this.__TVInputs[index].__ID = index;
            this.__TVInputs[index].__InputService.setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.TUNER);
            this.__TVInputs[index].__InputService.setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED);
            this.__TVInputs[index].__InputService.setCharacteristic(Characteristic.Identifier, index);
            this.__TVService.addLinkedService(this.__TVInputs[index].__InputService);
        }
        else {
            console.log("Failed to get input list from Sony TV @", SonyTVIP);
        }     
    },

    __buildApplicationList: function() {

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
        if (this.__updatingHomeKit == false) {
            // Get power status
            var response = request("POST", "http://" + SonyTVIP + "/sony/system", {headers: {"X-Auth-PSK": SonyTVPSK}, json: {"method": "getPowerStatus", "id": 50, "params": [""],  "version": "1.0"} });
            if (response.statusCode == 200) {
                if (typeof JSON.parse(response.body).result !== 'undefined') {
                    this.__TVService.getCharacteristic(Characteristic.Active).updateValue((JSON.parse(response.body).result[0].status.toUpperCase() == "ACTIVE" ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE));

                    if (JSON.parse(response.body).result[0].status.toUpperCase() == "ACTIVE" && this.__waitSetInput != null) {
                        // TVs been switched on externally to HomeKit and we have an "cached input value. We'll clear the cached value in this case and let teh loop below update the current state
                        this.__waitSetInput = null;
                    }
                }
            }
        }

        if (this.__updatingHomeKit == false) {
            // Get active input
            var response = request("POST", "http://" + SonyTVIP + "/sony/avContent", {headers: {"X-Auth-PSK": SonyTVPSK}, json: {"method": "getPlayingContentInfo", "id": 103, "params": [""],  "version": "1.0"} });
            if (response.statusCode == 200) {
                if (typeof JSON.parse(response.body).result !== 'undefined') {
                    for (var index in this.__TVInputs) {
                        // search thru the input list to work out which input is to be selected
                        if ((JSON.parse(response.body).result[0].uri == this.__TVInputs[index].__uri) || (JSON.parse(response.body).result[0].source == "tv:dvbt" && JSON.parse(response.body).result[0].source == this.__TVInputs[index].__uri)) {
                            this.__TVService.getCharacteristic(Characteristic.ActiveIdentifier).updateValue(this.__TVInputs[index].__ID);
                        }
                    }
                }
                else if (this.__waitSetInput != null) {
                    // since we got an error requesting inputs, we assume TV is off.. So if we have an input waiting to be set with the physcial TV, update that to reflect in HomeKit
                    this.__TVService.getCharacteristic(Characteristic.ActiveIdentifier).updateValue(this.__waitSetInput);
                }
            }
        }
        
        if (this.__updatingHomeKit == false) {
            // get volume information
            var response = request("POST", "http://" + SonyTVIP + "/sony/avContent", {headers: {"X-Auth-PSK": SonyTVPSK}, json: {"method": "getVolumeInformation", "id": 33, "params": [""],  "version": "1.0"} });
            if (response.statusCode == 200) {
                if (typeof JSON.parse(response.body).result !== 'undefined') {
                    var tempVolumeInfo = JSON.parse(response.body).result[0];
                    for (var index in tempVolumeInfo)
                    {
                        if (tempVolumeInfo[index].target.toUpperCase() == "SPEAKER")
                        {
                            this.__SpeakerService.getCharacteristic(Characteristic.Volume).updateValue(tempVolumeInfo[index].volume);
                        }
                    }
                }
            }
        }
    }
}

var response = request("POST", "http://" + SonyTVIP + "/sony/system", {headers: {"X-Auth-PSK": SonyTVPSK}, json: {"method": "getSystemInformation", "id": 33, "params": [""], "version": "1.0"} });
if (response.statusCode == 200) {
    var SonyTVSystemInfo = JSON.parse(response.body).result[0];
    var SonyTV = new SonyTVClass();
    SonyTV.__accessory = exports.accessory = new Accessory(AccessoryName, uuid.generate("hap-nodejs:accessories:sony_"));
    SonyTV.__accessory.username = SonyTVSystemInfo.macAddr; // We'll use the TVs mac address for the HomeKit one 
    SonyTV.__accessory.pincode = AccessoryPincode;
    SonyTV.__accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, "Sony");
    SonyTV.__accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Model, SonyTVSystemInfo.model);
    SonyTV.__accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.SerialNumber, SonyTVSystemInfo.serial);
    SonyTV.__accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, JSONPackage.version);

    
    SonyTV.addTelevison(SonyTV.__accessory, AccessoryName, 1);
    SonyTV.refreshHomeKit(2000);    // Refresh HomeKit every 2 seconds
} else {
    console.log("failed to get details from Sony TV @", SonyTVIP);
}