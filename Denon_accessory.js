// HAP-Nodejs Denon AVR AMP
// 
// https://github.com/subutux/denonavr/blob/master/CommandEndpoints.txt
// https://github.com/scarface-4711/denonavr
// https://www.heimkinoraum.de/upload/files/product/IP_Protocol_AVR-Xx100.pdf
//
var JSONPackage = require('../package.json')
var Accessory = require('../').Accessory; 
var Service = require('../').Service;
var Characteristic = require('../').Characteristic;
var uuid = require('../').uuid;
var request = require('sync-request');
var parseString = require('xml2js').parseString;

// Defines for the accessory
const AccessoryName =  "Amplifier";                     // default name of accessory
const AccessoryPincode = "031-45-154";                  // pin code for paring  

const DenonIP = "x.x.x.x";                              // IP address for AMP



// Create the AMP system object.
function DenonClass() {
    this.__accessory = null;                    // Parent accessory object
    this.__AMPService = null;                   // HomeKit service for the AMP.. We'll use the TV service
    this.__SpeakerService = null;               // HomeKit service for the AMP volume
    this.__AVInputs = [];                       // array of input objects.
    this.__timerFunc = null;                    // object to created update loop timer
    this.__updatingHomeKit = false;
}

function InputClass() {
    this.__ID = null;
    this.__InputService = null;
    this.__Name = null;
    this.__SelectName = null;
}

DenonClass.prototype = {
    addAmplifier: function(HomeKitAccessory, thisServiceName, serviceNumber) {
        console.log("Setup Amplifier '%s' on '%s'", thisServiceName, HomeKitAccessory.username);

        this.__accessory = HomeKitAccessory;
        this.__AMPService = HomeKitAccessory.addService(Service.Television, thisServiceName, serviceNumber);
        this.__AMPService.setCharacteristic(Characteristic.ConfiguredName, thisServiceName);
        this.__AMPService.setCharacteristic(Characteristic.SleepDiscoveryMode, Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);

        // Add the AMP volume as a service
        this.__SpeakerService = HomeKitAccessory.addService(Service.TelevisionSpeaker);
        this.__SpeakerService.setCharacteristic(Characteristic.VolumeControlType, Characteristic.VolumeControlType.ABSOLUTE);

        // Setup call backs
        this.__AMPService.getCharacteristic(Characteristic.Active).on('set', this.setPowerState.bind(this));
        this.__AMPService.getCharacteristic(Characteristic.ActiveIdentifier).on('set', this.setActiveInput.bind(this));
        this.__AMPService.getCharacteristic(Characteristic.RemoteKey).on('set', this.setRemoteKey.bind(this));
        this.__SpeakerService.getCharacteristic(Characteristic.VolumeSelector).on('set', this.setVolume.bind(this));
        this.__AMPService.getCharacteristic(Characteristic.PowerModeSelection).on('set', this.accessAMPSettings.bind(this));

        // Build list of inputs for both physcial and applicaions
        this.__buildInputList();

        // Force HomeKit update for inital state
        this.__DenonStatus();

        return this.__AMPService;   // Return object to this service
    },

    setPowerState: function(state, callback)
    {
        this.__updatingHomeKit = true;
        
        // Turns on/off the Amplifier main zone
        var powerState = (state) ? 'ON' : 'OFF';
        //var zoneName = (zone == 2) ? "ZONE2" : "MAIN+ZONE";
        var zoneName = "MAIN+ZONE";
        var response = request("GET", "http://" + DenonIP + "/MainZone/index.put.asp?cmd0=PutZone_OnOff/" + powerState + "&cmd1=aspMainZone_WebUpdateStatus/&ZoneName=" + zoneName);
        if (response.statusCode == 200) {
               console.log("Set power on Amplifier @" + DenonIP + " to " + ((state == Characteristic.Active.ACTIVE) ? "On" : "Off"));

            // Reflect active state for the speaker service also
            if (this.__SpeakerService != null) {
                this.__SpeakerService.getCharacteristic(Characteristic.Active).updateValue(state);
            }

            // See if we have a cached input to set if status is power on
            if (this.__waitSetInput != null && state == Characteristic.Active.ACTIVE) {
                this.__AMPService.getCharacteristic(Characteristic.ActiveIdentifier).setValue(this.__waitSetInput);
                this.__waitSetInput = null;
            } 
            callback(); // set power state
        }
        this.__updatingHomeKit = false;
    },

    setActiveInput: function(inputID, callback)
    {
        this.__updatingHomeKit = true;

        //var zoneName = (zone == 2) ? "ZONE2" : "MAIN+ZONE";
        var zoneName = "MAIN+ZONE";

        // Switches inputs on the amplifier
        for (var index in this.__AVInputs) {
            // search thru the input list to work out which input is to be selected
            if (inputID == this.__AVInputs[index].__ID) {
                var response = request("GET", "http://" + DenonIP + "/MainZone/index.put.asp?cmd0=PutZone_InputFunction/" + this.__AVInputs[index].__SelectName + "&cmd1=aspMainZone_WebUpdateStatus/&ZoneName=" + zoneName);
                if (response.statusCode == 200) {
                }
            }
        }

        this.__updatingHomeKit = false;
        callback(); // set input
    },

    setRemoteKey: function(value, callback) {
        var tempRemoteKey = "";
        switch (value) {
            case Characteristic.RemoteKey.REWIND :
            {
                tempRemoteKey = '';
                break;
            }

            case Characteristic.RemoteKey.FAST_FORWARD :
            {
                tempRemoteKey = '';
                break;
            }

            case Characteristic.RemoteKey.NEXT_TRACK :
            {
                tempRemoteKey = 'NS9D';
                break;
            }

            case Characteristic.RemoteKey.PREVIOUS_TRACK :
            {
                tempRemoteKey = 'NS9E';
                break;
            }

            case Characteristic.RemoteKey.ARROW_UP :
            {
                tempRemoteKey = 'MNCUP';
                break;
            }

            case Characteristic.RemoteKey.ARROW_DOWN :
            {
                tempRemoteKey = 'MNCDN';
                break;
            }

            case Characteristic.RemoteKey.ARROW_LEFT :
            {
                tempRemoteKey = 'MNCLT';
                break;
            }

            case Characteristic.RemoteKey.ARROW_RIGHT :
            {
                tempRemoteKey = 'MNCRT';
                break;
            }
            case Characteristic.RemoteKey.SELECT : 
            {
                tempRemoteKey = 'MNENT';
                break;
            }

            case Characteristic.RemoteKey.BACK :
            {
                tempRemoteKey = 'MNRTN';
                break;
            }

            case Characteristic.RemoteKey.EXIT :
            {
                tempRemoteKey = 'MNRTN';
                break;
            }

            case Characteristic.RemoteKey.PLAY_PAUSE :
            {
                tempRemoteKey = 'NS94';
                // need a way to "toggle" between these
                //“Enter (Play/Pause)” Control		94	<CR>	NS94<CR>
                //cli.command('play').action(()=> denon.command('NS9A'));
                //cli.command('pause').action(()=> denon.command('NS9B'));
                break;
            }

            case Characteristic.RemoteKey.INFORMATION :
            {
                tempRemoteKey = 'MNINF';
                break;
            }
        }
        if (tempRemoteKey != "") {
            var response = request("GET", "http://" + DenonIP + "/goform/formiPhoneAppDirect.xml/?" + tempRemoteKey);
            if (response.statusCode == 200) {
            }
        }
        callback();
    },

    setVolume: function(value, callback) {
        //var zoneName = (zone == 2) ? "ZONE2" : "MAIN+ZONE";
        var zoneName = "MAIN+ZONE";
        var response = request("GET", "http://" + DenonIP + "/MainZone/index.put.asp?cmd0=PutMasterVolumeBtn/" + (value == Characteristic.VolumeSelector.INCREMENT ? ">" : "<") + "&ZoneName=" + zoneName);
        if (response.statusCode == 200) {
        } 
        callback();
    },

    accessAMPSettings: function(value, callback) {
        if (value == Characteristic.PowerModeSelection.SHOW) {
            var response = request("GET", "http://" + DenonIP + "/goform/formiPhoneAppDirect.xml/?MNMEN%20ON");
            if (response.statusCode == 200) {
            } 
        }
        callback();
    },

    __buildInputList: function() {
        var response = request("POST", "http://" + DenonIP + "/goform/AppCommand.xml", {body: '<?xml version="1.0" encoding="utf-8"?> <tx><cmd id="1">GetRenameSource</cmd> <cmd id="1">GetDeletedSource</cmd></tx>'});
        if (response.statusCode == 200) {
            var thisObject = this;  // needed to know this for the next function
            parseString(response.getBody(), function (err, result) {
                
                // build list of inputs
                for (var index in result.rx.cmd[0].functionrename[0].list) {
                    thisObject.__AVInputs[index] = new InputClass();
                    thisObject.__AVInputs[index].__InputService = thisObject.__accessory.addService(Service.InputSource, result.rx.cmd[0].functionrename[0].list[index].name[0].trim(), index);
                    thisObject.__AVInputs[index].__Name = result.rx.cmd[0].functionrename[0].list[index].name[0].trim();
                    thisObject.__AVInputs[index].__ID = index;
    
                    thisObject.__AVInputs[index].__InputService.setCharacteristic(Characteristic.ConfiguredName, result.rx.cmd[0].functionrename[0].list[index].rename[0].trim());
                    thisObject.__AVInputs[index].__InputService.setCharacteristic(Characteristic.Identifier, index);

                    switch(result.rx.cmd[0].functionrename[0].list[index].name[0].trim().toUpperCase()) {
                        case "CD" : {
                            thisObject.__AVInputs[index].__InputService.setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.HDMI);
                            thisObject.__AVInputs[index].__SelectName = "CD";
                            break;
                        }

                        case "CBL/SAT" : {
                            thisObject.__AVInputs[index].__InputService.setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.HDMI);
                            thisObject.__AVInputs[index].__SelectName = "SAT/CBL";
                            break;
                        }

                        case "DVD" : {
                            thisObject.__AVInputs[index].__InputService.setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.HDMI);
                            thisObject.__AVInputs[index].__SelectName = "DVD";
                            break;
                        }

                        case "BLU-RAY" : {
                            thisObject.__AVInputs[index].__InputService.setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.HDMI);
                            thisObject.__AVInputs[index].__SelectName = "BD";
                            break;
                        }

                        case "GAME" : {
                            thisObject.__AVInputs[index].__InputService.setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.HDMI);
                            thisObject.__AVInputs[index].__SelectName = "GAME";
                            break;
                        }

                        case "AUX1" : {
                            thisObject.__AVInputs[index].__InputService.setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.HDMI);
                            thisObject.__AVInputs[index].__SelectName = "AUX1";
                            break;
                        }

                        case "AUX2" : {
                            thisObject.__AVInputs[index].__InputService.setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.HDMI);
                            thisObject.__AVInputs[index].__SelectName = "AUX2";
                            break;
                        }

                        case "MEDIA PLAYER" : {
                            thisObject.__AVInputs[index].__InputService.setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.HDMI);
                            thisObject.__AVInputs[index].__SelectName = "MPLAY";
                            break;
                        }
    
                        case "IPOD/USB" : {
                            thisObject.__AVInputs[index].__InputService.setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.USB);
                            thisObject.__AVInputs[index].__SelectName = "USB/IPOD";
                            break;
                        }
    
                        case "TUNER" : {
                            thisObject.__AVInputs[index].__InputService.setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.TUNER);
                            thisObject.__AVInputs[index].__SelectName = "TUNER";
                            break;
                        }
    
                        case "TV AUDIO" : {
                            thisObject.__AVInputs[index].__InputService.setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.OTHER);
                            thisObject.__AVInputs[index].__SelectName = "TV";
                            break;
                        }
    
                        case "NETWORK" : {
                            thisObject.__AVInputs[index].__InputService.setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.AIRPLAY);
                            thisObject.__AVInputs[index].__SelectName = "NET";
                            break;
                        }

                        case "BLUETOOTH" : {
                            thisObject.__AVInputs[index].__InputService.setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.AIRPLAY);
                            thisObject.__AVInputs[index].__SelectName = "BT";
                            break;
                        }
    
                        case "SPOTIFYCONNECT" : {
                            thisObject.__AVInputs[index].__InputService.setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.APPLICATION);
                            thisObject.__AVInputs[index].__SelectName = "SPOTIFY";
                            break;
                        }        
                    }
    
                    // Loop through to see if this input is "hidden" on the denon. Mark as shown or hidden depending on configuration
                    thisObject.__AVInputs[index].__InputService.setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED);
  
                    for (var index2 in result.rx.cmd[1].functiondelete[0].list) {
                        if (result.rx.cmd[1].functiondelete[0].list[index2].name == result.rx.cmd[0].functionrename[0].list[index].name[0]) {
                           thisObject.__AVInputs[index].__InputService.setCharacteristic(Characteristic.CurrentVisibilityState, (parseInt(result.rx.cmd[1].functiondelete[0].list[index2].use) == 1 ? Characteristic.CurrentVisibilityState.SHOWN : Characteristic.CurrentVisibilityState.HIDDEN));
                           thisObject.__AVInputs[index].__InputService.setCharacteristic(Characteristic.TargetVisibilityState, (parseInt(result.rx.cmd[1].functiondelete[0].list[index2].use) == 1 ? Characteristic.CurrentVisibilityState.SHOWN : Characteristic.CurrentVisibilityState.HIDDEN));
                        }
                    } 
                    thisObject.__AVInputs[index].__InputService.getCharacteristic(Characteristic.TargetVisibilityState).on('set', thisObject.HomeKitInputStatus.bind(thisObject.__AVInputs[index]));
                    thisObject.__AMPService.addLinkedService(thisObject.__AVInputs[index].__InputService);
                }
            });
        }
        else {
            console.log("Failed to get input list from Amplifier @", DenonIP);
        }     
    },

    HomeKitInputStatus: function(state, callback) {
        // Allow enabling/disble input section in homekit
        this.__InputService.getCharacteristic(Characteristic.CurrentVisibilityState).updateValue(state);
        this.__InputService.getCharacteristic(Characteristic.TargetVisibilityState).updateValue(state);

        // TODO
        // -- if enabling/disablign inputs in HomeKit, refected status on action AMP (if possible)
        callback();
    },

    refreshHomeKit: function(refreshTimeMS) {
        // setup status check interval as defined
        if (this.__timerFunc != null) {
            // current update timer running, so cancel it.
            clearInterval(this.__timerFunc);
        }
        this.__timerFunc = setInterval(this.__DenonStatus.bind(this), refreshTimeMS); 
        console.log("Refresh status in HomeKit set for every '%s'ms", refreshTimeMS);
    },

    __DenonStatus: function() {
        const scale = (num, in_min, in_max, out_min, out_max) => {
            if (num > out_max) num = out_max;
            if (num < out_min) num = out_min;
            return (num - in_min) * (out_max - out_min) / (in_max - in_min) + out_min;
        }

        thisObject = this;

        if (this.__updatingHomeKit == false) {
            var response = request("GET", "http://" + DenonIP + "/goform/formMainZone_MainZoneXmlStatusLite.xml");
            if (response.statusCode == 200) {
                parseString(response.getBody(), function (err, result) {
                    thisObject.__AMPService.getCharacteristic(Characteristic.Active).updateValue(result.item.Power[0].value[0].toUpperCase() == 'ON' ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);

                    for (var index in thisObject.__AVInputs) {
                        // search through the input list to work out which input is to be selected
                        if (result.item.InputFuncSelect[0].value[0].toUpperCase() == thisObject.__AVInputs[index].__SelectName.toUpperCase()) {
                            thisObject.__AMPService.getCharacteristic(Characteristic.ActiveIdentifier).updateValue(thisObject.__AVInputs[index].__ID);
                        }
                    }
                    
                    // Update speaker volume to reflect what AMP says, scaling from -80.5 <> 18db to 0 <> 100 for HomeKit
                    thisObject.__SpeakerService.getCharacteristic(Characteristic.Volume).updateValue(scale(parseInt(result.item.MasterVolume[0].value[0]), -80.5, 18, 0, 100));
                });
            }
        }    
    }
}

var response = request("GET", "http://" + DenonIP + "/goform/Deviceinfo.xml");
if (response.statusCode == 200) {
    var tempBrandCode = 0; // 0 for Denon, 1 for Marantz
    var tempModel = "Denon";
    var tempMacAddress = "";
    parseString(response.getBody(), function (err, result) {
        tempBrandCode = parseInt(result.Device_Info.BrandCode); // 0 for Denon, 1 for Marantz
        tempMacAddress = result.Device_Info.MacAddress[0].substr(0,2) + ":" + result.Device_Info.MacAddress[0].substr(2,2) + ":" + result.Device_Info.MacAddress[0].substr(4,2) + ":" + result.Device_Info.MacAddress[0].substr(6,2) + ":" + result.Device_Info.MacAddress[0].substr(8,2) + ":" + result.Device_Info.MacAddress[0].substr(10,2);
        tempModel = result.Device_Info.ModelName[0].replace(/[*]/g, "");
    });

    if (tempMacAddress != "") {
        var DenonAVR = new DenonClass();
        DenonAVR.__accessory = exports.accessory = new Accessory(AccessoryName, uuid.generate("hap-nodejs:accessories:denon_"));
        DenonAVR.__accessory.username = tempMacAddress; // We'll use the Amps mac address for the HomeKit one 
        DenonAVR.__accessory.pincode = AccessoryPincode;
        DenonAVR.__accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, (tempBrandCode == 1 ? "Marantz" : "Denon"));
        DenonAVR.__accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Model, tempModel);
        DenonAVR.__accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.SerialNumber, "MH20190204");
        DenonAVR.__accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, JSONPackage.version);

        DenonAVR.addAmplifier( DenonAVR.__accessory, (tempBrandCode == 1 ? "Marantz Amplifier" : "Denon Amplifier"), 1);
        DenonAVR.refreshHomeKit(2000);    // Refresh HomeKit every 2 seconds
    } else {
        console.log("failed to get MAC address from Amplifier @", DenonIP);
    }
} else {
    console.log("failed to get details from Amplifier @", DenonIP);
}